#!/usr/bin/env node
/**
 * qdrant-collection.js — The one definition of a bootstrapped collection:
 * the collection itself plus the two payload indexes the semantic leg
 * depends on.
 *
 * semanticSearch() (explorer/server/search.js) scopes every query with a
 * `project` should-clause and a `timestamp` range clause. Without payload
 * indexes Qdrant evaluates those filters by scanning payloads: measured
 * 2026-10-07 on 157k points (Qdrant 1.12.1), a project-filtered search cost
 * 200–420 ms server time and a timestamp range 100–170 ms, against 3–6 ms
 * unfiltered. That was the dominant cost in the semantic stage of /api/recall
 * and why some recalls blew the 4000 ms Turbo budget. With a `keyword` index
 * on `project` and a `datetime` index on `timestamp` the same filtered
 * searches cost 4–16 ms with identical top-50 results. Building each index
 * took ~1.1 s once.
 *
 * Creating an index that already exists is a no-op: Qdrant answers 200
 * `acknowledged` in ~15 ms (measured on the same collection). The GET-first
 * check below is still worth doing — the hook path runs per event and should
 * not issue two writes each time.
 *
 * Usage (CLI face, for shell scripts and skills):
 *   node scripts/qdrant-collection.js ensure-indexes [--json]
 *   node scripts/qdrant-collection.js ensure [--recreate] [--json]
 *
 * Environment:
 *   CARTOGRAPHER_QDRANT_URL  — Qdrant endpoint (default: http://localhost:6333)
 *   CARTOGRAPHER_COLLECTION  — collection name (default: session-cartographer)
 */

import { fileURLToPath } from 'node:url';

export const DEFAULT_QDRANT_URL = 'http://localhost:6333';
export const DEFAULT_COLLECTION = 'session-cartographer';
export const VECTOR_SIZE = 1024; // mxbai-embed-large-v1

/** The payload fields the semantic leg filters on, with the schema each needs. */
export const PAYLOAD_INDEXES = Object.freeze([
  Object.freeze({ field: 'project', schema: 'keyword' }),
  Object.freeze({ field: 'timestamp', schema: 'datetime' }),
]);

function settings(opts = {}) {
  return {
    qdrantUrl: (opts.qdrantUrl || process.env.CARTOGRAPHER_QDRANT_URL || DEFAULT_QDRANT_URL).replace(/\/+$/, ''),
    collection: opts.collection || process.env.CARTOGRAPHER_COLLECTION || DEFAULT_COLLECTION,
    fetch: opts.fetch || globalThis.fetch,
    log: opts.log || (() => {}),
  };
}

/**
 * Which of PAYLOAD_INDEXES a GET /collections/<name> response does not list.
 * `payload_schema` is keyed by field with `data_type`; a field indexed under
 * a different schema counts as missing so the caller can see the mismatch
 * (creation then fails loudly rather than silently serving the wrong index).
 */
export function missingPayloadIndexes(collectionInfo) {
  const schema = collectionInfo?.result?.payload_schema ?? collectionInfo?.payload_schema ?? {};
  return PAYLOAD_INDEXES.filter(({ field, schema: wanted }) => schema?.[field]?.data_type !== wanted);
}

async function readCollection({ qdrantUrl, collection, fetch }) {
  const res = await fetch(`${qdrantUrl}/collections/${collection}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GET /collections/${collection} -> ${res.status} ${await safeText(res)}`);
  return res.json();
}

async function safeText(res) {
  try { return await res.text(); } catch { return ''; }
}

/**
 * Create every payload index the collection is missing. Reads payload_schema
 * first so an already-indexed collection issues no writes, then PUTs each
 * missing index. Returns { present, created, failed } by field name; a
 * failure is reported, not thrown, unless `strict` is set — the hook path
 * must still index its event when an index build is refused.
 */
export async function ensurePayloadIndexes(opts = {}) {
  const s = settings(opts);
  const info = await readCollection(s);
  if (!info) throw new Error(`Collection ${s.collection} does not exist at ${s.qdrantUrl}`);
  const missing = missingPayloadIndexes(info);
  const present = PAYLOAD_INDEXES.filter((ix) => !missing.includes(ix)).map((ix) => ix.field);
  const created = [];
  const failed = [];
  for (const { field, schema } of missing) {
    const res = await s.fetch(`${s.qdrantUrl}/collections/${s.collection}/index`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ field_name: field, field_schema: schema }),
    });
    if (res.ok) {
      created.push(field);
      s.log(`Created payload index: ${s.collection}.${field} (${schema})`);
      continue;
    }
    const detail = `${res.status} ${await safeText(res)}`.trim();
    failed.push({ field, schema, error: detail });
    if (opts.strict) throw new Error(`Failed to create payload index ${field} (${schema}): ${detail}`);
    s.log(`Payload index ${s.collection}.${field} (${schema}) not created: ${detail}`);
  }
  return { collection: s.collection, present, created, failed };
}

/**
 * Create the collection if absent (or unconditionally after a delete with
 * `recreate`), then ensure its payload indexes. Returns
 * { collection, created_collection, indexes } where `indexes` is the
 * ensurePayloadIndexes() result. A failed index build throws here: a batch
 * indexer that proceeds without the indexes leaves every later recall paying
 * the scan, which is the state this module exists to prevent.
 */
export async function ensureCollection(opts = {}) {
  const s = settings(opts);
  const vectorSize = opts.vectorSize || VECTOR_SIZE;
  let createdCollection = false;

  if (opts.recreate) {
    await s.fetch(`${s.qdrantUrl}/collections/${s.collection}`, { method: 'DELETE' });
  }
  const existing = opts.recreate ? null : await readCollection(s);
  if (!existing) {
    const res = await s.fetch(`${s.qdrantUrl}/collections/${s.collection}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ vectors: { size: vectorSize, distance: 'Cosine' } }),
    });
    if (!res.ok) throw new Error(`Failed to create collection ${s.collection}: ${res.status} ${await safeText(res)}`);
    createdCollection = true;
    s.log(`Created collection: ${s.collection}`);
  }

  const indexes = await ensurePayloadIndexes({ ...opts, strict: true });
  return { collection: s.collection, created_collection: createdCollection, indexes };
}

async function cli(argv) {
  const verb = argv.find((a) => !a.startsWith('--')) || 'ensure-indexes';
  const json = argv.includes('--json');
  const log = json ? () => {} : (line) => console.error(line);
  let result;
  if (verb === 'ensure-indexes') {
    result = await ensurePayloadIndexes({ log });
  } else if (verb === 'ensure') {
    result = await ensureCollection({ log, recreate: argv.includes('--recreate') });
  } else {
    console.error(`Unknown verb: ${verb}. Use ensure-indexes or ensure.`);
    return 64;
  }
  if (json) console.log(JSON.stringify(result));
  else {
    const ix = result.indexes || result;
    console.log(`${ix.collection}: present=${ix.present.join(',') || '-'} created=${ix.created.join(',') || '-'}`
      + (ix.failed.length ? ` failed=${ix.failed.map((f) => `${f.field}:${f.error}`).join(';')}` : ''));
  }
  return (result.indexes || result).failed.length ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  cli(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => { console.error(err.message); process.exit(75); },
  );
}
