#!/usr/bin/env node
/**
 * embed-events.js — Index JSONL event logs into Qdrant for semantic search.
 *
 * Reads changelog.jsonl, research-log.jsonl, and session-milestones.jsonl,
 * embeds summaries via an OpenAI-compatible embedding endpoint, and upserts
 * into a Qdrant collection.
 *
 * Usage:
 *   node scripts/embed-events.js [--reindex]
 *
 * Environment:
 *   CARTOGRAPHER_DEV_DIR      — log directory (default: ~/Documents/dev)
 *   CARTOGRAPHER_EMBED_URL    — embedding endpoint (default: http://localhost:8890/v1/embeddings)
 *   CARTOGRAPHER_EMBED_MODEL  — model name (default: mxbai-embed-large)
 *   CARTOGRAPHER_QDRANT_URL   — Qdrant endpoint (default: http://localhost:6333)
 *   CARTOGRAPHER_COLLECTION   — collection name (default: session-cartographer)
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const DEV_DIR = process.env.CARTOGRAPHER_DEV_DIR || join(homedir(), 'Documents', 'dev');
const EMBED_URL = process.env.CARTOGRAPHER_EMBED_URL || 'http://localhost:8890/v1/embeddings';
const EMBED_MODEL = process.env.CARTOGRAPHER_EMBED_MODEL || 'mxbai-embed-large';
const QDRANT_URL = process.env.CARTOGRAPHER_QDRANT_URL || 'http://localhost:6333';
const COLLECTION = process.env.CARTOGRAPHER_COLLECTION || 'session-cartographer';
const VECTOR_SIZE = 1024; // mxbai-embed-large-v1
const BATCH_SIZE = 20;
const REINDEX = process.argv.includes('--reindex');

const FILES = [
  { path: join(DEV_DIR, 'changelog.jsonl'), source: 'changelog' },
  { path: join(DEV_DIR, 'research-log.jsonl'), source: 'research' },
  { path: join(DEV_DIR, 'session-milestones.jsonl'), source: 'milestones' },
];

function readJsonl(filePath) {
  if (!existsSync(filePath)) return [];
  return readFileSync(filePath, 'utf-8')
    .split('\n')
    .filter(line => line.trim())
    .map(line => {
      try { return JSON.parse(line); }
      catch { return null; }
    })
    .filter(Boolean);
}

function eventToText(event, source) {
  const parts = [];
  if (event.summary) parts.push(event.summary);
  if (event.description) parts.push(event.description);
  if (event.url) parts.push(event.url);
  if (event.query) parts.push(`Search: ${event.query}`);
  if (event.prompt) parts.push(event.prompt);
  if (event.title) parts.push(event.title);
  if (event.project) parts.push(`project: ${event.project}`);
  const text = parts.join(' | ') || `${source} event`;
  // Truncate to ~200 words to stay under 512-token context (subword tokenization inflates count)
  return text.split(/\s+/).slice(0, 200).join(' ');
}

function eventId(event) {
  return event.event_id || `${event.timestamp}-${event.type || event.milestone || 'unknown'}`;
}

// Stable numeric hash from string for Qdrant point ID
function hashToInt(str) {
  let hash = 0n;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5n) - hash) + BigInt(str.charCodeAt(i));
    hash &= 0x7FFFFFFFFFFFFFFFn; // keep positive 64-bit
  }
  return Number(hash & 0x7FFFFFFFn); // fit in u32 range
}

async function getEmbeddings(texts) {
  const response = await fetch(EMBED_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: EMBED_MODEL, input: texts }),
  });
  if (!response.ok) {
    throw new Error(`Embedding request failed: ${response.status} ${await response.text()}`);
  }
  const data = await response.json();
  return data.data.map(d => d.embedding);
}

async function ensureCollection() {
  // Check if collection exists
  const res = await fetch(`${QDRANT_URL}/collections/${COLLECTION}`);
  if (res.ok && !REINDEX) return;

  if (REINDEX) {
    // Delete and recreate
    await fetch(`${QDRANT_URL}/collections/${COLLECTION}`, { method: 'DELETE' });
  }

  // Create collection
  const createRes = await fetch(`${QDRANT_URL}/collections/${COLLECTION}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      vectors: { size: VECTOR_SIZE, distance: 'Cosine' },
    }),
  });
  if (!createRes.ok) {
    throw new Error(`Failed to create collection: ${await createRes.text()}`);
  }
  console.log(`Created collection: ${COLLECTION}`);
}

async function getExistingIds() {
  if (REINDEX) return new Set();
  const res = await fetch(`${QDRANT_URL}/collections/${COLLECTION}/points/scroll`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ limit: 100000, with_payload: false, with_vector: false }),
  });
  if (!res.ok) return new Set();
  const data = await res.json();
  return new Set((data.result?.points || []).map(p => p.id));
}

async function upsertBatch(points) {
  const res = await fetch(`${QDRANT_URL}/collections/${COLLECTION}/points`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ points }),
  });
  if (!res.ok) {
    throw new Error(`Upsert failed: ${await res.text()}`);
  }
}

async function main() {
  // Check services are running
  try {
    await fetch(QDRANT_URL);
  } catch {
    console.error(`Qdrant not reachable at ${QDRANT_URL}`);
    process.exit(1);
  }
  try {
    await fetch(EMBED_URL.replace('/v1/embeddings', '/health'));
  } catch {
    console.error(`Embedding server not reachable at ${EMBED_URL}`);
    process.exit(1);
  }

  await ensureCollection();
  const existingIds = await getExistingIds();

  // Collect all events
  let allEvents = [];
  for (const { path, source } of FILES) {
    const events = readJsonl(path);
    for (const event of events) {
      const eid = eventId(event);
      const numericId = hashToInt(eid);
      if (existingIds.has(numericId)) continue;
      allEvents.push({
        id: numericId,
        text: eventToText(event, source),
        payload: {
          event_id: eid,
          source,
          timestamp: event.timestamp,
          type: event.type || event.milestone,
          project: event.project,
          summary: event.summary || event.description,
          url: event.url,
          deeplink: event.deeplink,
          transcript_path: event.transcript_path,
        },
      });
    }
  }

  // Deduplicate by numeric ID (hash collisions)
  const seen = new Set();
  allEvents = allEvents.filter(e => {
    if (seen.has(e.id)) return false;
    seen.add(e.id);
    return true;
  });

  if (allEvents.length === 0) {
    console.log('No new events to index.');
    return;
  }

  console.log(`Indexing ${allEvents.length} new events...`);

  // Process in batches
  let indexed = 0;
  for (let i = 0; i < allEvents.length; i += BATCH_SIZE) {
    const batch = allEvents.slice(i, i + BATCH_SIZE);
    const texts = batch.map(e => e.text);

    let embeddings;
    try {
      embeddings = await getEmbeddings(texts);
    } catch (err) {
      // If batch fails, try one at a time (skip oversized events)
      console.error(`\n  Batch failed, retrying individually: ${err.message}`);
      for (let j = 0; j < batch.length; j++) {
        try {
          const [vec] = await getEmbeddings([batch[j].text]);
          await upsertBatch([{ id: batch[j].id, vector: vec, payload: batch[j].payload }]);
          indexed++;
        } catch {
          console.error(`\n  Skipped oversized event: ${batch[j].payload.event_id}`);
        }
      }
      process.stdout.write(`\r  ${indexed}/${allEvents.length}`);
      continue;
    }

    const points = batch.map((event, idx) => ({
      id: event.id,
      vector: embeddings[idx],
      payload: event.payload,
    }));

    await upsertBatch(points);
    indexed += points.length;
    process.stdout.write(`\r  ${indexed}/${allEvents.length}`);
  }

  console.log(`\nDone. ${indexed} events indexed into ${COLLECTION}.`);
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
