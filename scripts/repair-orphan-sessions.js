#!/usr/bin/env node
/**
 * Recover session attribution for orphan milestone records.
 *
 * Why these exist: until 0.5.0 the skills resolved the active session from
 * `CLAUDE_SESSION_ID`, a variable Claude Code never sets (the real one is
 * `CLAUDE_CODE_SESSION_ID`). Records written by /wrapup and /investigate got
 * `session_id: "unknown"`, which then defeated the transcript lookup and left
 * `transcript_path` empty. The synthesis paragraph survived; the conversation
 * behind it became unreachable from /remember.
 *
 * This walks those orphans back to their session by project + time overlap.
 *
 * The matching policy here is deliberately STRICTER than enrich-sessions.js.
 * That tool accepts a time-only match when no project matches, which is fine
 * for backfilled git commits. It is not fine here: with several concurrent
 * sessions, a time-only match is a coin flip, and a wrong session id is worse
 * than a missing one — it points /remember at an unrelated transcript and
 * presents it as this session's territory. So: project match required,
 * ambiguity refused, transcript verified on disk before it is written.
 *
 * Dry run by default. Nothing is modified without --write.
 *
 * Usage:
 *   node scripts/repair-orphan-sessions.js                    # report only
 *   node scripts/repair-orphan-sessions.js --verbose          # + per-record detail
 *   node scripts/repair-orphan-sessions.js --json
 *   node scripts/repair-orphan-sessions.js --write
 *   node scripts/repair-orphan-sessions.js --write --reindex
 *   node scripts/repair-orphan-sessions.js --file <path>
 */
import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'fs';
import { execSync } from 'child_process';
import { buildSessionWindows, defaultPaths, toSortedList } from './session-windows.js';
import { isResolved } from './sentinels.js';
import { createMatcher } from './session-match.js';

const args = process.argv.slice(2);
const valueAfter = (flag, fallback) => {
  const idx = args.indexOf(flag);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : fallback;
};
const DO_WRITE = args.includes('--write');
const DO_REINDEX = args.includes('--reindex');
const AS_JSON = args.includes('--json');
const VERBOSE = args.includes('--verbose');

const paths = defaultPaths();
const TARGET = valueAfter('--file', paths.milestones);
const SAMPLE = Number.parseInt(valueAfter('--sample', '8'), 10) || 8;

if (!existsSync(TARGET)) {
  console.error(`No such file: ${TARGET}`);
  process.exit(2);
}

const isOrphan = (record) => !isResolved(record.session_id || record.session);

// ─── Build windows from everything that IS attributed ───

const { sessions } = buildSessionWindows({
  sources: [paths.changelog, paths.milestones],
  transcriptDirs: [paths.transcripts],
  collectStamps: true,
});
const sessionList = toSortedList(sessions);

// Matching policy lives in session-match.js so the backfill cannot drift from
// the repair. --near-minutes tunes how close a candidate must have been.
const NEAR_MS = Number.parseInt(valueAfter('--near-minutes', '10'), 10) * 60_000;
const findSession = createMatcher(sessionList, { nearMs: NEAR_MS, isResolved });

// A recovered session id is only half the value. Confirm the transcript is
// actually on disk and actually covers this moment before pointing at it —
// otherwise the repair just swaps one dead end for a misleading one.
function transcriptFor(session, timestamp) {
  const path = session.transcriptPath;
  if (!path || !existsSync(path)) return { path: '', reason: 'missing' };
  if (session.transcriptStart && session.transcriptEnd) {
    if (timestamp < session.transcriptStart || timestamp > session.transcriptEnd) {
      return { path: '', reason: 'out_of_range' };
    }
  }
  return { path, reason: 'ok' };
}

const deeplinkFor = (path, provider) =>
  (provider === 'claude' && path ? `claude-history://session/${encodeURIComponent(path)}` : '');

const providerFor = (path, existing) => {
  if (isResolved(existing)) return existing;
  if (path.includes('/.codex/')) return 'codex';
  if (path.includes('/.claude/')) return 'claude';
  return existing || 'unknown';
};

// ─── Walk the target, line by line ───
// Only repaired lines are reserialized; every other line is passed through
// byte-for-byte so the diff is exactly the repair.

const rawLines = readFileSync(TARGET, 'utf-8').split('\n');
const outLines = [...rawLines];

const stats = {
  total: 0,
  attributed: 0,
  orphans: 0,
  repaired_full: 0,
  repaired_session_only: 0,
  ambiguous: 0,
  unrecoverable: 0,
  no_project: 0,
};
const samples = { repaired: [], ambiguous: [], unrecoverable: [] };
const repairedIds = [];

rawLines.forEach((line, i) => {
  if (!line.trim()) return;
  let record;
  try { record = JSON.parse(line); } catch { return; }
  stats.total += 1;

  if (!isOrphan(record)) { stats.attributed += 1; return; }
  stats.orphans += 1;

  if (!isResolved(record.project)) {
    stats.no_project += 1;
    stats.unrecoverable += 1;
    return;
  }

  const { match, ambiguous, via, gapSeconds } = findSession(
    record.timestamp, record.project, record.cwd
  );

  if (ambiguous) {
    stats.ambiguous += 1;
    if (samples.ambiguous.length < SAMPLE) {
      samples.ambiguous.push({
        event_id: record.event_id,
        timestamp: record.timestamp,
        project: record.project,
        candidates: ambiguous.length,
        candidate_ids: ambiguous.slice(0, 4).map((s) => s.sid.slice(0, 8)),
      });
    }
    return;
  }

  if (!match) {
    stats.unrecoverable += 1;
    if (samples.unrecoverable.length < SAMPLE) {
      samples.unrecoverable.push({
        event_id: record.event_id,
        timestamp: record.timestamp,
        project: record.project,
      });
    }
    return;
  }

  const transcript = transcriptFor(match, record.timestamp);
  const provider = providerFor(transcript.path || match.transcriptPath || '', record.provider);

  record.session_id = match.sid;
  record.provider = provider;
  if (transcript.path) {
    record.transcript_path = transcript.path;
    const link = deeplinkFor(transcript.path, provider);
    if (link) record.deeplink = link;
    stats.repaired_full += 1;
  } else {
    // Session recovered, conversation gone (or moved). Leave transcript_path
    // empty rather than writing a path that will not open.
    stats.repaired_session_only += 1;
  }
  record.repaired_by = 'repair-orphan-sessions';

  outLines[i] = JSON.stringify(record);
  repairedIds.push(record.event_id);

  if (samples.repaired.length < SAMPLE) {
    samples.repaired.push({
      event_id: record.event_id,
      timestamp: record.timestamp,
      project: record.project,
      session: match.sid.slice(0, 8),
      via,
      gap_s: gapSeconds ?? null,
      transcript: transcript.reason,
    });
  }
});

// ─── Report ───

const repaired = stats.repaired_full + stats.repaired_session_only;
const rate = (n) => (stats.orphans === 0 ? '—' : `${((n / stats.orphans) * 100).toFixed(1)}%`);

if (AS_JSON) {
  console.log(JSON.stringify({ file: TARGET, stats, samples, wrote: DO_WRITE }, null, 2));
} else {
  console.log(`\nFile:        ${TARGET}`);
  console.log(`Records:     ${stats.total} (${stats.attributed} already attributed)`);
  console.log(`Orphans:     ${stats.orphans}\n`);
  console.log(`  recoverable, transcript verified   ${stats.repaired_full}  (${rate(stats.repaired_full)})`);
  console.log(`  recoverable, transcript gone       ${stats.repaired_session_only}  (${rate(stats.repaired_session_only)})`);
  console.log(`  ambiguous — refused                ${stats.ambiguous}  (${rate(stats.ambiguous)})`);
  console.log(`  unrecoverable                      ${stats.unrecoverable}  (${rate(stats.unrecoverable)})`);
  if (stats.no_project) console.log(`    …of which had no project           ${stats.no_project}`);

  if (VERBOSE) {
    for (const [label, rows] of Object.entries(samples)) {
      if (!rows.length) continue;
      console.log(`\n  ${label} (first ${rows.length}):`);
      for (const r of rows) console.log(`    ${JSON.stringify(r)}`);
    }
  }
}

// ─── Write ───

if (!DO_WRITE) {
  if (!AS_JSON) {
    console.log(`\nDry run — nothing written. Pass --write to repair ${repaired} record(s).`);
    if (!VERBOSE) console.log('Add --verbose to inspect sample matches before committing.');
  }
  process.exit(0);
}

if (repaired === 0) {
  if (!AS_JSON) console.log('\nNothing to repair.');
  process.exit(0);
}

const backup = `${TARGET}.bak-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`;
copyFileSync(TARGET, backup);
writeFileSync(TARGET, outLines.join('\n'));

if (!AS_JSON) {
  console.log(`\nBackup:  ${backup}`);
  console.log(`Updated: ${TARGET} (${repaired} repaired)`);
}

if (DO_REINDEX) {
  console.log('Re-indexing repaired events...');
  const failures = [];
  for (const id of repairedIds) {
    const line = outLines.find((l) => l.includes(`"${id}"`));
    if (!line) continue;
    try {
      execSync('bash scripts/index-event.sh', {
        input: line,
        cwd: new URL('..', import.meta.url).pathname,
        stdio: ['pipe', 'ignore', 'ignore'],
      });
    } catch {
      failures.push(id);
    }
  }
  console.log(failures.length
    ? `Reindex: ${repairedIds.length - failures.length} ok, ${failures.length} failed (see .carto/index-errors.jsonl)`
    : `Reindex: ${repairedIds.length} events`);
}
