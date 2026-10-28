#!/usr/bin/env node
// Assign stable event_ids to records that never got one.
//
// Two backfills predating the id convention left 2,441 rows in the searched
// logs with no event_id. Both search engines paper over that with a POSITIONAL
// synthetic key — bm25-search.awk falls back to `src "-" source_fnr`, bm25.js
// to `${_source}-${docs.size}` — so the same record answers to a different id
// on each engine, and to a different id again after the next append. Nothing
// can be fetched, touched, or threaded through an id that moves, and a result
// carrying no real id fails the recall response contract outright.
//
// The id is derived from the record's own content, so it is identical on every
// engine and stable across appends. Rows that already have an id are never
// touched.
//
// Default is a dry run. `--write` takes a backup first, rewrites atomically,
// and verifies the row count is unchanged before replacing the original.
import fs from 'node:fs';
import path from 'node:path';
import { stableEventId } from '../explorer/server/stable-event-id.js';
import { replaceJsonl, snapshotJsonl } from './jsonl-lock.js';

const DEV = process.env.CARTOGRAPHER_DEV_DIR || path.join(process.env.HOME, 'Documents', 'dev');
const WRITE = process.argv.includes('--write');

// Only the logs the search path actually reads, and only ones we own.
// ~/.claude/history.jsonl also carries id-less rows, but it is Claude Code's
// file, not Cartographer's — we do not rewrite another tool's data.
const LOGS = ['changelog.jsonl', 'research-log.jsonl', 'session-milestones.jsonl', 'tool-use-log.jsonl'];

// The digest itself lives in explorer/server/stable-event-id.js. It is shared
// because build-prompt-history.js mints ids for the same corpus, and a
// projector that spelled an id differently from this backfill would re-add
// records the backfill had already identified. One definition, two callers.

// Collision safety needs the ids that already exist across every log, not just
// the one being rewritten.
const existing = new Set();
for (const name of LOGS) {
  const file = path.join(DEV, name);
  if (!fs.existsSync(file)) continue;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    try {
      const id = JSON.parse(line).event_id;
      if (typeof id === 'string' && id) existing.add(id);
    } catch {}
  }
}

let totalAssigned = 0;
let totalCollisions = 0;
const report = [];

for (const name of LOGS) {
  const file = path.join(DEV, name);
  if (!fs.existsSync(file)) continue;

  const raw = snapshotJsonl(file);
  const original = raw.toString('utf8');
  const lines = original.split('\n');
  const out = [];
  let assigned = 0;
  let unparsed = 0;
  const samples = [];

  for (const line of lines) {
    if (line === '') { out.push(line); continue; }
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      unparsed++;
      out.push(line); // never drop a line we cannot read
      continue;
    }
    if (typeof record.event_id === 'string' && record.event_id !== '') {
      out.push(line);
      continue;
    }

    let id = stableEventId(record);
    if (existing.has(id)) {
      // Two records with byte-identical content and timestamp. Disambiguate
      // deterministically rather than minting a random id, so a re-run of this
      // script produces the same result.
      let n = 1;
      let candidate = `${id}-${n}`;
      while (existing.has(candidate)) candidate = `${id}-${++n}`;
      id = candidate;
      totalCollisions++;
    }
    existing.add(id);
    assigned++;
    // Reassemble with event_id first so the rewritten rows read like the others.
    // Drop any pre-existing key before spreading: a record carrying an explicit
    // `event_id: ""` would otherwise overwrite the id we just minted, and the
    // row would come back out of the migration exactly as unreachable as it
    // went in.
    const { event_id: _discarded, ...rest } = record;
    const rebuilt = JSON.stringify({ event_id: id, ...rest });
    if (samples.length < 3) samples.push(`${id}  ${(record.summary || record.topic || record.query || record.url || record.description || record.symptom || record.note || '').slice(0, 62)}`);
    out.push(rebuilt);
  }

  report.push({ name, rows: lines.filter((l) => l !== '').length, assigned, unparsed, samples });
  totalAssigned += assigned;

  if (WRITE && assigned > 0) {
    const backup = `${file}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    fs.writeFileSync(backup, raw);

    const rewritten = out.join('\n');
    const before = original.split('\n').filter((l) => l !== '').length;
    const after = rewritten.split('\n').filter((l) => l !== '').length;
    if (before !== after) {
      throw new Error(`${name}: row count changed ${before} -> ${after}; refusing to write. Backup at ${backup}`);
    }

    // These logs take roughly a write a minute across concurrent sessions, and
    // hooks append while this runs. replaceJsonl takes the rewrite lock, checks
    // that the file still begins with what was read here (another rewriter's
    // work is never clobbered), and carries every row appended since across
    // (scripts/jsonl-lock.js).
    const moved = replaceJsonl(file, { original: raw, body: rewritten });
    const carried = moved.carried_rows + moved.late_rows + moved.spooled_rows;

    // At least that many: sessions keep appending once the lock is released.
    const finalRows = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l !== '').length;
    if (finalRows < before + carried) {
      throw new Error(`${name}: post-write row count ${finalRows} < expected ${before + carried}. Backup at ${backup}`);
    }
    report[report.length - 1].carried = carried;
    report[report.length - 1].backup = backup;
  }
}

console.log(WRITE ? '=== backfill-event-ids: WRITE ===' : '=== backfill-event-ids: dry run (pass --write to apply) ===');
for (const row of report) {
  console.log(`${row.name.padEnd(26)} rows=${String(row.rows).padEnd(8)} assign=${String(row.assigned).padEnd(6)} unparsed=${row.unparsed}${row.backup ? `  backup=${path.basename(row.backup)}` : ''}${row.carried ? `  concurrent-appends-carried=${row.carried}` : ''}`);
  for (const sample of row.samples) console.log(`    ${sample}`);
}
console.log(`total assigned: ${totalAssigned}${totalCollisions ? `  (content collisions disambiguated: ${totalCollisions})` : ''}`);
if (!WRITE && totalAssigned > 0) console.log('nothing written.');
