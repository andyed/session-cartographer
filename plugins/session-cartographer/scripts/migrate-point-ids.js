#!/usr/bin/env node
// migrate-point-ids.js — move Qdrant points onto the unified SHA-256 point ID.
//
// Before 0.6.1 two incompatible derivations coexisted: POSIX cksum (index-event.sh,
// 32-bit) and a djb2 truncated to 31 bits (embed-events.js). Same event indexed by
// different paths landed at different points, and both spaces were small enough that
// collisions silently overwrote unrelated events on upsert.
//
// Vectors are read back from Qdrant, so nothing is re-embedded. Run the writers'
// code change FIRST so new events land on the new scheme and are never orphaned.
//
// Usage: node scripts/migrate-point-ids.js [--apply] [--batch 500]

import { createHash } from 'crypto';
const QDRANT = process.env.CARTOGRAPHER_QDRANT_URL || 'http://localhost:6333';
const COLLECTION = process.env.CARTOGRAPHER_COLLECTION || 'session-cartographer';
const APPLY = process.argv.includes('--apply');
const BATCH = Number((process.argv[process.argv.indexOf('--batch') + 1]) || 500);

const newId = (eid) =>
  parseInt(createHash('sha256').update(eid).digest('hex').slice(0, 13), 16);

// legacy derivations, to confirm a point is on an old scheme before moving it
const POLY = 0x04c11db7;
const TAB = Array.from({ length: 256 }, (_, i) => {
  let c = i << 24;
  for (let k = 0; k < 8; k++) c = (c & 0x80000000) ? ((c << 1) ^ POLY) >>> 0 : (c << 1) >>> 0;
  return c >>> 0;
});
function cksum(str) {
  const buf = Buffer.from(str, 'utf8');
  let crc = 0;
  for (const b of buf) crc = (((crc << 8) >>> 0) ^ TAB[((crc >>> 24) & 0xff) ^ b]) >>> 0;
  let n = buf.length;
  while (n) { crc = (((crc << 8) >>> 0) ^ TAB[((crc >>> 24) & 0xff) ^ (n & 0xff)]) >>> 0; n >>>= 8; }
  return (~crc) >>> 0;
}
function djb2(str) {
  let h = 0n;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5n) - h) + BigInt(str.charCodeAt(i));
    h &= 0x7fffffffffffffffn;
  }
  return Number(h & 0x7fffffffn);
}

async function q(path, body, method = 'POST') {
  const r = await fetch(`${QDRANT}/collections/${COLLECTION}${path}`, {
    method, headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error(`${path} -> ${r.status} ${await r.text()}`);
  return r.json();
}

(async () => {
  const stats = { seen: 0, already: 0, cksum: 0, djb2: 0, unknown: 0, noEid: 0,
                  moved: 0, collided: 0, deleted: 0 };
  const targets = new Map();      // newId -> event_id, to catch collisions in the NEW space
  let offset = null;

  for (;;) {
    const res = await q('/points/scroll', {
      limit: BATCH, with_payload: true, with_vector: true,
      ...(offset ? { offset } : {}),
    });
    const pts = res.result.points;
    offset = res.result.next_page_offset;
    if (!pts.length) break;

    const upserts = [], removals = [];
    for (const p of pts) {
      stats.seen++;
      const eid = p.payload && p.payload.event_id;
      if (!eid) { stats.noEid++; continue; }
      const want = newId(eid);

      if (targets.has(want) && targets.get(want) !== eid) stats.collided++;
      targets.set(want, eid);

      if (p.id === want) { stats.already++; continue; }
      if (p.id === cksum(eid)) stats.cksum++;
      else if (p.id === djb2(eid)) stats.djb2++;
      else { stats.unknown++; continue; }   // unrecognised scheme: leave untouched

      upserts.push({ id: want, vector: p.vector, payload: p.payload });
      removals.push(p.id);
    }

    if (APPLY && upserts.length) {
      await q('/points?wait=true', { points: upserts }, 'PUT');
      await q('/points/delete?wait=true', { points: removals });
      stats.moved += upserts.length;
      stats.deleted += removals.length;
    } else {
      stats.moved += upserts.length;
    }

    process.stderr.write(`\r  scanned ${stats.seen}  moved ${stats.moved}   `);
    if (!offset) break;
  }

  process.stderr.write('\n\n');
  const mode = APPLY ? 'APPLIED' : 'DRY RUN (no writes)';
  console.log(`=== migrate-point-ids: ${mode} ===`);
  console.log(`  points scanned         ${stats.seen}`);
  console.log(`  already on new scheme  ${stats.already}`);
  console.log(`  on cksum (32-bit)      ${stats.cksum}`);
  console.log(`  on djb2  (31-bit)      ${stats.djb2}`);
  console.log(`  unrecognised scheme    ${stats.unknown}   (left untouched)`);
  console.log(`  missing event_id       ${stats.noEid}   (left untouched)`);
  console.log(`  distinct new ids       ${targets.size}`);
  console.log(`  NEW-SPACE COLLISIONS   ${stats.collided}`);
  console.log(`  ${APPLY ? 'moved' : 'would move'}             ${stats.moved}`);
  if (APPLY) console.log(`  old points deleted     ${stats.deleted}`);
})().catch(e => { console.error('\nFAILED:', e.message); process.exit(1); });
