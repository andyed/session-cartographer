#!/usr/bin/env node
/**
 * Repair stale Codex transcript_path values across the event logs.
 *
 * Why these exist: Codex does not delete a finished session, it MOVES it from
 * ~/.codex/sessions/<yyyy>/<mm>/<dd>/ into the flat ~/.codex/archived_sessions/.
 * The hooks stamp transcript_path at event time, so every record written before
 * a session was archived now points at a path that no longer resolves — while
 * the transcript itself is still fully readable a directory away.
 *
 * That is a silent recall failure, not an error: /remember surfaces the event,
 * the agent stats the recorded path, finds nothing, and reports the transcript
 * as aged out. The conversation behind the result is reachable the whole time.
 *
 * Repair policy is deliberately narrow. A path is rewritten only when:
 *   1. the recorded path does not exist, AND
 *   2. exactly one file with that basename exists under the archive root.
 * Basename match is exact and the archive is flat, so there is no ambiguity to
 * resolve and no heuristic to get wrong. Anything else is left alone and
 * counted, because a wrong transcript_path is worse than a missing one — it
 * points /remember at someone else's conversation and presents it as yours.
 *
 * Claude paths are never touched: Claude Code deletes on its cleanupPeriodDays
 * schedule rather than archiving, so a missing Claude transcript is genuinely
 * gone and rewriting it would be a lie.
 *
 * Dry run by default. Nothing is modified without --write.
 *
 * Usage:
 *   node scripts/repair-transcript-paths.js                 # report only
 *   node scripts/repair-transcript-paths.js --verbose
 *   node scripts/repair-transcript-paths.js --json
 *   node scripts/repair-transcript-paths.js --write
 *   node scripts/repair-transcript-paths.js --file <path>
 *   node scripts/repair-transcript-paths.js --qdrant          # report Qdrant payloads
 *   node scripts/repair-transcript-paths.js --qdrant --write  # repair them
 *
 * The event logs are only half the corpus. Semantic results are served from
 * Qdrant payloads, which carry their own copy of transcript_path — so repairing
 * the logs alone leaves every semantic hit still pointing at the pre-archive
 * path. --qdrant repairs that side under the same one-file/one-basename policy.
 */
import { readFileSync, writeFileSync, existsSync, copyFileSync, readdirSync, statSync } from 'fs';
import { join, basename } from 'path';
import { homedir } from 'os';
import { defaultPaths } from './session-windows.js';

const args = process.argv.slice(2);
const valueAfter = (flag, fallback) => {
  const idx = args.indexOf(flag);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : fallback;
};
const DO_WRITE = args.includes('--write');
const AS_JSON = args.includes('--json');
const VERBOSE = args.includes('--verbose');
const DO_QDRANT = args.includes('--qdrant');
const QDRANT = process.env.CARTOGRAPHER_QDRANT_URL || 'http://localhost:6333';
const COLLECTION = process.env.CARTOGRAPHER_COLLECTION || 'session-cartographer';

const paths = defaultPaths();
const HOME = homedir();
const CODEX_SESSIONS = process.env.CARTOGRAPHER_CODEX_TRANSCRIPTS_DIR || join(HOME, '.codex/sessions');
const CODEX_ARCHIVED = process.env.CARTOGRAPHER_CODEX_ARCHIVED_DIR || join(HOME, '.codex/archived_sessions');

const TARGETS = args.includes('--file')
  ? [valueAfter('--file', '')]
  : ['changelog.jsonl', 'research-log.jsonl', 'session-milestones.jsonl', 'tool-use-log.jsonl']
      .map(f => join(paths.dev, f));

// One directory read for the whole run. The archive is flat, so a basename is a
// unique key; building the index once turns per-record repair into a map hit
// instead of a filesystem walk over ~900 files per record.
const archiveIndex = new Map();
if (existsSync(CODEX_ARCHIVED)) {
  for (const name of readdirSync(CODEX_ARCHIVED)) {
    if (!name.endsWith('.jsonl')) continue;
    if (archiveIndex.has(name)) { archiveIndex.set(name, null); continue; } // ambiguous → refuse
    archiveIndex.set(name, join(CODEX_ARCHIVED, name));
  }
}

const stats = { scanned: 0, ok: 0, repaired: 0, unresolved: 0, claudeMissing: 0, noPath: 0, raced: 0 };
const samples = [];
const perFile = [];

for (const TARGET of (DO_QDRANT ? [] : TARGETS)) {
  if (!TARGET || !existsSync(TARGET)) {
    if (!AS_JSON) console.error(`skip (not found): ${TARGET}`);
    continue;
  }
  // Andy runs several concurrent agent sessions and the hooks append to these
  // logs on every tool use. A read-modify-write therefore races live writers:
  // anything appended between the read and the write would be silently dropped.
  // Record the size we read, and refuse to write if the file grew.
  const sizeAtRead = statSync(TARGET).size;
  const lines = readFileSync(TARGET, 'utf8').split('\n');
  const out = [];
  let fileRepaired = 0;

  for (const line of lines) {
    if (!line.trim()) { out.push(line); continue; }
    let rec;
    try { rec = JSON.parse(line); } catch { out.push(line); continue; }

    const p = rec.transcript_path;
    if (!p) { stats.noPath++; out.push(line); continue; }
    stats.scanned++;

    if (existsSync(p)) { stats.ok++; out.push(line); continue; }

    // Missing. Only Codex paths are repairable.
    if (!p.startsWith(CODEX_SESSIONS) && !p.includes('/.codex/')) {
      stats.claudeMissing++; out.push(line); continue;
    }

    const hit = archiveIndex.get(basename(p));
    if (!hit) { stats.unresolved++; out.push(line); continue; }

    stats.repaired++; fileRepaired++;
    if (samples.length < 8) samples.push({ event_id: rec.event_id, from: p, to: hit });
    if (VERBOSE) console.error(`  ${rec.event_id || '(no id)'}\n    ${p}\n → ${hit}`);
    rec.transcript_path = hit;
    out.push(JSON.stringify(rec));
  }

  perFile.push({ file: TARGET, repaired: fileRepaired });

  if (DO_WRITE && fileRepaired > 0) {
    const sizeNow = statSync(TARGET).size;
    if (sizeNow !== sizeAtRead) {
      stats.raced++;
      console.error(`  SKIPPED ${TARGET}: grew ${sizeAtRead} → ${sizeNow} bytes during the run (a live session is appending). Re-run when quiet.`);
    } else {
      const backup = `${TARGET}.bak-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`;
      copyFileSync(TARGET, backup);
      writeFileSync(TARGET, out.join('\n'));
      if (!AS_JSON) console.log(`  wrote ${TARGET} (${fileRepaired} repaired; backup ${backup})`);
    }
  }
}

if (DO_QDRANT) {
  const qs = { scanned: 0, broken: 0, fixable: 0, updated: 0, unresolved: 0 };
  const byTarget = new Map(); // resolved path → [point ids]
  let offset = null;
  for (;;) {
    const body = {
      limit: 2000,
      with_payload: ['transcript_path'],
      filter: { must: [{ key: 'transcript_path', match: { text: 'codex/sessions' } }] },
    };
    if (offset !== null) body.offset = offset;
    const res = await fetch(`${QDRANT}/collections/${COLLECTION}/points/scroll`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }).then(r => r.json()).catch(() => null);
    const pts = res?.result?.points || [];
    for (const pt of pts) {
      const tp = pt.payload?.transcript_path;
      if (!tp) continue;
      qs.scanned++;
      if (existsSync(tp)) continue;
      qs.broken++;
      const hit = archiveIndex.get(basename(tp));
      if (!hit) { qs.unresolved++; continue; }
      qs.fixable++;
      if (!byTarget.has(hit)) byTarget.set(hit, []);
      byTarget.get(hit).push(pt.id);
    }
    offset = res?.result?.next_page_offset;
    if (!offset || !pts.length) break;
  }

  // Points from one session share one resolved path, so grouping turns ~6k
  // single-point updates into one call per archived session.
  if (DO_WRITE) {
    for (const [target, ids] of byTarget) {
      for (let i = 0; i < ids.length; i += 500) {
        const chunk = ids.slice(i, i + 500);
        const ok = await fetch(`${QDRANT}/collections/${COLLECTION}/points/payload?wait=true`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ payload: { transcript_path: target }, points: chunk }),
        }).then(r => r.ok).catch(() => false);
        if (ok) qs.updated += chunk.length;
      }
    }
  }

  if (AS_JSON) console.log(JSON.stringify({ qdrant: qs, sessions: byTarget.size, wrote: DO_WRITE }, null, 2));
  else {
    console.log('\nQdrant payload repair');
    console.log(`  points with a codex/sessions path : ${qs.scanned}`);
    console.log(`  broken (file not at that path)    : ${qs.broken}`);
    console.log(`  fixable from archive              : ${qs.fixable}  across ${byTarget.size} sessions`);
    console.log(`  broken and unresolved             : ${qs.unresolved}`);
    if (DO_WRITE) console.log(`  UPDATED                           : ${qs.updated}`);
    else console.log('\n  DRY RUN — re-run with --qdrant --write to apply.');
  }
  process.exit(0);
}

if (AS_JSON) {
  console.log(JSON.stringify({ stats, perFile, samples, wrote: DO_WRITE }, null, 2));
} else {
  console.log('\nTranscript path repair');
  console.log(`  records with a transcript_path : ${stats.scanned}`);
  console.log(`  path resolves as recorded      : ${stats.ok}`);
  console.log(`  REPAIRABLE (codex → archive)   : ${stats.repaired}`);
  console.log(`  codex, missing and unresolved  : ${stats.unresolved}`);
  console.log(`  claude, genuinely gone         : ${stats.claudeMissing}`);
  if (samples.length) {
    console.log('\n  sample:');
    for (const s of samples.slice(0, 4)) console.log(`    ${s.event_id}\n      ${s.from}\n   →  ${s.to}`);
  }
  if (stats.raced) console.log(`\n  ${stats.raced} file(s) skipped: appended to mid-run. Re-run when sessions are quiet.`);
  // The Turbo watcher (explorer/server/jsonl.js) tracks byte offsets and only
  // ever reads the tail: it detects truncation, but an in-place rewrite of
  // history is invisible to it. A warm server therefore keeps serving the
  // pre-repair paths indefinitely, with nothing to signal the staleness.
  if (DO_WRITE && stats.repaired > 0) {
    console.log('\n  NOTE: restart the Turbo server if one is warm — its watcher is');
    console.log('        append-only and will keep serving the pre-repair paths.');
  }
  if (!DO_WRITE) console.log('\n  DRY RUN — re-run with --write to apply.');
}
