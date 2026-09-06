#!/usr/bin/env node
/**
 * Remove contentless session-end milestones from the event logs.
 *
 * Why these exist: `log-session-milestones.sh` stamped `transcript_path`
 * verbatim from the host payload, which is the path the host INTENDS for a
 * session rather than a promise the file was written. Sessions ending with
 * reason "other" — the abnormal-exit path — routinely leave no transcript.
 *
 * Measured on a 15,000-row session-milestones.jsonl:
 *
 *   session_end_other rows                          9,862
 *     dead transcript + zero logged activity        7,646   <- removed here
 *     dead transcript + real logged activity           79   <- KEPT
 *     resolvable transcript                         2,137   <- KEPT
 *
 * The 7,646 are 51% of the entire log and carry nothing recallable: no
 * conversation to open, no events to join to, nothing indexed. They still rank
 * in /remember at salience 0.5 and dilute `.carto/profile.md`.
 *
 * Removal policy is deliberately narrow. A row is dropped only when ALL hold:
 *   1. milestone matches session_end_*;
 *   2. its transcript_path is absent or does not resolve on disk;
 *   3. its session_event_count is 0 or missing.
 *
 * Condition 3 is what makes this safe. 79 rows had a dead transcript over real
 * work — a lost transcript, not an empty session — and they are kept. Only the
 * intersection of "nothing reachable" and "nothing done" is discarded. Rows
 * carrying an authored wrapup (`decisions`, `key_insight`, or milestone
 * session_wrapup) are never touched regardless of the other conditions.
 *
 * Dry run by default. Nothing is modified without --write, and --write copies
 * each file to a dated .bak first.
 *
 * Usage:
 *   node scripts/prune-contentless-milestones.js               # report only
 *   node scripts/prune-contentless-milestones.js --json
 *   node scripts/prune-contentless-milestones.js --write
 *   node scripts/prune-contentless-milestones.js --file <path>
 *   node scripts/prune-contentless-milestones.js --qdrant          # report points
 *   node scripts/prune-contentless-milestones.js --qdrant --write  # delete them
 *
 * Qdrant carries its own copy of these rows, so pruning the log alone leaves
 * semantic recall still serving them. --qdrant removes that side under the
 * identical predicate.
 */
import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { fileURLToPath } from 'url';

const args = process.argv.slice(2);
const DO_WRITE = args.includes('--write');
const AS_JSON = args.includes('--json');
const DO_QDRANT = args.includes('--qdrant');
const fileArg = args.indexOf('--file');
const DEV = process.env.CARTOGRAPHER_DEV_DIR || join(homedir(), 'Documents/dev');
const QDRANT = process.env.CARTOGRAPHER_QDRANT_URL || 'http://localhost:6333';
const COLLECTION = process.env.CARTOGRAPHER_COLLECTION || 'session-cartographer';

const TARGETS = fileArg !== -1 && args[fileArg + 1]
  ? [args[fileArg + 1]]
  : [join(DEV, 'session-milestones.jsonl')];

/** An authored wrapup is never noise, whatever its transcript looks like. */
function isAuthored(r) {
  return r.milestone === 'session_wrapup'
    || (Array.isArray(r.decisions) && r.decisions.length > 0)
    || (typeof r.key_insight === 'string' && r.key_insight.length > 0);
}

/** The removal predicate. Kept in one place so log and Qdrant cannot diverge. */
export function isContentless(r) {
  if (!r || typeof r.milestone !== 'string') return false;
  if (!r.milestone.startsWith('session_end_')) return false;
  if (isAuthored(r)) return false;
  const t = r.transcript_path || '';
  const reachable = t !== '' && existsSync(t);
  if (reachable) return false;
  const count = r.session_event_count;
  return count === 0 || count === undefined || count === null;
}

// Executing on import would run the tool — and with --write in an importing
// process's argv, would delete data as a side effect of a `import` statement.
// The predicate above is the only thing meant to be importable.
async function main() {
  const summary = { scanned: 0, removed: 0, kept_activity: 0, kept_reachable: 0, files: [] };

  for (const TARGET of (DO_QDRANT ? [] : TARGETS)) {
    if (!existsSync(TARGET)) {
      if (!AS_JSON) console.log(`skip ${TARGET} (not found)`);
      continue;
    }
    const lines = readFileSync(TARGET, 'utf8').split('\n').filter(Boolean);
    const out = [];
    let removed = 0;
    for (const line of lines) {
      let row;
      try { row = JSON.parse(line); } catch { out.push(line); continue; }
      summary.scanned++;
      if (isContentless(row)) { removed++; continue; }
      if (String(row.milestone || '').startsWith('session_end_')) {
        const t = row.transcript_path || '';
        if (t && existsSync(t)) summary.kept_reachable++;
        else if (row.session_event_count > 0) summary.kept_activity++;
      }
      out.push(line);
    }
    summary.removed += removed;
    summary.files.push({ file: TARGET, rows: lines.length, removed, remaining: out.length });
    if (DO_WRITE && removed > 0) {
      const backup = `${TARGET}.bak-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`;
      copyFileSync(TARGET, backup);
      writeFileSync(TARGET, out.join('\n') + '\n');
      if (!AS_JSON) console.log(`  wrote ${TARGET} (${removed} removed; backup ${backup})`);
    }
  }

  if (DO_QDRANT) {
    let cursor = null, scanned = 0;
    const doomed = [];
    do {
      const res = await fetch(`${QDRANT}/collections/${COLLECTION}/points/scroll`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ limit: 1000, offset: cursor, with_payload: true }),
      });
      if (!res.ok) { console.error(`qdrant scroll failed: ${res.status}`); process.exit(1); }
      const j = await res.json();
      for (const p of j.result.points) {
        scanned++;
        const pl = p.payload || {};
        // Qdrant payloads carry `summary`, not `description`; the predicate only
        // reads fields both sides share.
        if (isContentless(pl)) doomed.push(p.id);
      }
      cursor = j.result.next_page_offset;
    } while (cursor);
    summary.scanned = scanned;
    summary.removed = doomed.length;
    if (DO_WRITE && doomed.length) {
      const del = await fetch(`${QDRANT}/collections/${COLLECTION}/points/delete?wait=true`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ points: doomed }),
      });
      if (!del.ok) { console.error(`qdrant delete failed: ${del.status}`); process.exit(1); }
    }
  }

  if (AS_JSON) {
    console.log(JSON.stringify({ ...summary, wrote: DO_WRITE, target: DO_QDRANT ? 'qdrant' : 'logs' }, null, 2));
  } else {
    console.log(`\ncontentless session-end milestones (${DO_QDRANT ? 'qdrant' : 'logs'})`);
    console.log(`  scanned                 ${summary.scanned}`);
    console.log(`  removable               ${summary.removed}`);
    if (!DO_QDRANT) {
      console.log(`  kept — real activity    ${summary.kept_activity}`);
      console.log(`  kept — transcript ok    ${summary.kept_reachable}`);
    }
    if (!DO_WRITE) console.log('\n  DRY RUN — re-run with --write to apply.');
  }

}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
