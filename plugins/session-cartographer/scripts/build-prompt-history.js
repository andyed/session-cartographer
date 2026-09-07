#!/usr/bin/env node
// build-prompt-history.js — project Claude Code's prompt history into an event
// log Cartographer owns.
//
// WHY THIS EXISTS
//
// ~/.claude/history.jsonl holds every prompt the user has typed into Claude
// Code — 18,103 of them on this machine. Claude Code expires transcripts after
// roughly 30 days; a sample of 60 history rows found 27% whose session
// transcript is already gone. For those ~4,900 records this file is the only
// surviving evidence of what was asked.
//
// It is nevertheless unreachable. Its rows carry no event_id, so both search
// engines fall back to a POSITIONAL synthetic key — bm25-search.awk to
// `src "-" fnr`, bm25.js to `${_source}-${docs.size}` — which changes on every
// append and differs between engines, and the recall response contract rejects
// a result with no real id outright.
//
// We cannot fix that at the source: ~/.claude/history.jsonl is Claude Code's
// file, not ours, and rewriting another tool's data is off the table (the same
// line backfill-event-ids.js draws). So we project it, once and incrementally,
// into $CARTOGRAPHER_DEV_DIR/prompt-history.jsonl — a log we own, in the shape
// the searched logs already use. cartographer-search.sh already reads that
// path as the "prompts" keyword source and returns immediately when it is
// absent, so this projector is the only missing half.
//
// NOT CODEX. Deliberately. 48 of 50 sampled Codex prompts are still recoverable
// from archived rollouts and are already turn-indexed; adding that source would
// be 96% duplication.
//
// Usage:
//   node scripts/build-prompt-history.js            # dry run (default)
//   node scripts/build-prompt-history.js --write    # append new rows
//
// Environment:
//   CARTOGRAPHER_DEV_DIR                 — output directory (default ~/Documents/dev)
//   CARTOGRAPHER_CLAUDE_HISTORY          — source file (default ~/.claude/history.jsonl)
//   CARTOGRAPHER_CLAUDE_TRANSCRIPTS_DIR  — transcript store (default ~/.claude/projects)
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { stableEventId } from '../explorer/server/stable-event-id.js';

const HOME = os.homedir();
const DEV = process.env.CARTOGRAPHER_DEV_DIR || path.join(HOME, 'Documents', 'dev');
const SOURCE = process.env.CARTOGRAPHER_CLAUDE_HISTORY || path.join(HOME, '.claude', 'history.jsonl');
const TRANSCRIPTS = process.env.CARTOGRAPHER_CLAUDE_TRANSCRIPTS_DIR
  || process.env.CARTOGRAPHER_TRANSCRIPTS_DIR
  || path.join(HOME, '.claude', 'projects');
const OUT = path.join(DEV, 'prompt-history.jsonl');
const WRITE = process.argv.includes('--write');


// A wrong time unit is the failure mode that looks like success: seconds read
// as milliseconds park every record in 1970, milliseconds read as seconds park
// them past the year 50000, and either way the rows index cleanly and sort
// wrong forever. Assert the era instead of trusting the unit.
const MIN_YEAR = 2024;
const MAX_YEAR = 2030;

// Every projected row is a user prompt: uniformly interesting, never a
// milestone. A flat mid-range value keeps them from crowding out ranked events
// while still letting them surface when they are the only surviving record.
const SALIENCE = 0.6;

/**
 * Collapse a prompt to one line.
 *
 * Hard project invariant: the search pipeline is TSV/line-based, and a summary
 * containing a newline splits a TSV row — the fragments then mis-parse as
 * rank/key/timestamp, rank coerces to 0, and the wreckage outranks every real
 * result. 1,176 of the 18,103 source prompts contain \n, \r, or \t, so this is
 * the common case, not the edge case. Flatten at the source, as every other
 * writer in the system does.
 */
export function flattenSummary(text) {
  return String(text).replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim();
}

/** Epoch milliseconds (number or numeric string) → ISO 8601 UTC, or null. */
export function toIsoUtc(raw) {
  const ms = typeof raw === 'number' ? raw : Number(String(raw ?? '').trim());
  if (!Number.isFinite(ms)) return null;
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return null;
  const year = date.getUTCFullYear();
  if (year < MIN_YEAR || year > MAX_YEAR) return null;
  return `${date.toISOString().slice(0, 19)}Z`;
}

/**
 * True when the prompt is a bare slash command — an interface action rather
 * than a thing the user was trying to do. 563 rows in the corpus are exactly
 * this: /clear, /exit, /compact, /login, /resume. They record that a control
 * was operated, not any intent worth recovering months later. A length floor
 * pruned none of them (the shortest is /help at 5 characters), so the test is
 * arguments, not length.
 *
 * A command WITH arguments is kept: `/remember the shader fix` and
 * `/focus psychodeli` carry the intent the bare form lacks. /wrapup is dropped
 * with the rest because the synthesis it produces is already in the log as a
 * milestone at salience 0.9 — far richer than the six characters that invoked it.
 */
export function isJunkSlashCommand(summary) {
  if (!summary.startsWith('/')) return false;
  const [, ...rest] = summary.split(' ');
  return !rest.some((token) => token !== '');
}

/**
 * Map session id → transcript path, by listing the transcript store once.
 *
 * Deriving the path from the project directory's name encoding would be a
 * guess; listing what is actually on disk is a fact, and it doubles as the
 * survival check — a session with no file here is one whose transcript Claude
 * Code has already expired, which is exactly the population this projector
 * exists to preserve.
 */
function indexTranscripts(root) {
  const bySession = new Map();
  let projectDirs;
  try {
    projectDirs = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return bySession; // no store on this machine; every row simply omits the key
  }
  for (const dir of projectDirs) {
    if (!dir.isDirectory()) continue;
    const full = path.join(root, dir.name);
    let files;
    try {
      files = fs.readdirSync(full);
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue;
      const sid = file.slice(0, -'.jsonl'.length);
      if (!bySession.has(sid)) bySession.set(sid, path.join(full, file));
    }
  }
  return bySession;
}

/**
 * Build the projected record for one history row, or a skip reason.
 * @returns {{record: object} | {skip: string}}
 */
export function projectRow(row, transcriptIndex) {
  if (!row || typeof row !== 'object') return { skip: 'unparsed' };

  const summary = flattenSummary(row.display ?? '');
  if (summary === '') return { skip: 'empty' };
  if (isJunkSlashCommand(summary)) return { skip: 'slash-command' };

  const timestamp = toIsoUtc(row.timestamp);
  if (timestamp === null) return { skip: 'bad-timestamp' };

  // The id must survive transcript expiry. transcript_path is a fact about the
  // filesystem today, not about the prompt: a transcript deleted next month
  // would otherwise re-mint a different id for the same record and duplicate
  // it. Hash the prompt, then attach the path.
  //
  // `project` is a raw basename here, and deliberately so, even though the
  // hooks resolve theirs through cartographer_project / `--git-common-dir` so a
  // worktree files under its parent repo. That resolver reads the filesystem,
  // and anything that reads the filesystem cannot feed an id: a worktree pruned
  // next month would flip the resolved project, re-mint the id, and re-append
  // every prompt from that session. A basename is a pure function of the source
  // row and is therefore stable forever. The cost is the worktree-attribution
  // bug, and the corpus already carries its repair — records whose project IS
  // the basename of their cwd are exactly the signature
  // migrate-project-attribution.js repoints. Measured 2026-09-07: 18 distinct
  // cwds in history.jsonl, none of them worktrees, so the debt is currently
  // zero rows.
  const identity = {
    timestamp,
    type: 'prompt',
    summary,
    session_id: typeof row.sessionId === 'string' && row.sessionId ? row.sessionId : undefined,
    project: typeof row.project === 'string' && row.project ? path.basename(row.project) : undefined,
    cwd: typeof row.project === 'string' && row.project ? row.project : undefined,
  };

  const record = {
    event_id: stableEventId(identity),
    timestamp,
    type: 'prompt',
    provider: 'claude',
    summary,
  };
  // Absence is spelled by omitting the key, never by the string "unknown" —
  // see the sentinel rule in CLAUDE.md. A truthy sentinel groups as an identity
  // and silently merges every unattributed record into one phantom entity.
  if (identity.project) record.project = identity.project;
  if (identity.cwd) record.cwd = identity.cwd;
  if (identity.session_id) record.session_id = identity.session_id;

  const transcript = identity.session_id ? transcriptIndex.get(identity.session_id) : undefined;
  if (transcript) record.transcript_path = transcript;

  record.salience = SALIENCE;
  return { record };
}

function main() {
  if (!fs.existsSync(SOURCE)) {
    console.error(`build-prompt-history: no source at ${SOURCE}`);
    process.exit(1);
  }

  // Already-projected ids. Idempotence is by id, not by line count: the source
  // is append-only in practice, but a re-run after an edit or a partial write
  // must still add exactly the rows that are missing.
  const seen = new Set();
  let existingRows = 0;
  if (fs.existsSync(OUT)) {
    for (const line of fs.readFileSync(OUT, 'utf8').split('\n')) {
      if (!line) continue;
      existingRows++;
      try {
        const id = JSON.parse(line).event_id;
        if (typeof id === 'string' && id) seen.add(id);
      } catch {}
    }
  }

  const transcriptIndex = indexTranscripts(TRANSCRIPTS);

  const skipped = { unparsed: 0, empty: 0, 'slash-command': 0, 'bad-timestamp': 0, duplicate: 0 };
  const fresh = [];
  const samples = [];
  let scanned = 0;
  let withTranscript = 0;
  let withoutTranscript = 0;

  for (const line of fs.readFileSync(SOURCE, 'utf8').split('\n')) {
    if (line === '') continue;
    scanned++;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      skipped.unparsed++;
      continue;
    }
    const result = projectRow(row, transcriptIndex);
    if (result.skip) {
      skipped[result.skip] = (skipped[result.skip] || 0) + 1;
      continue;
    }
    const { record } = result;
    // Covers both "already in the output file" and "the same prompt appears
    // twice in this batch" — two identical prompts in one session at the same
    // millisecond are one record, not two.
    if (seen.has(record.event_id)) {
      skipped.duplicate++;
      continue;
    }
    seen.add(record.event_id);
    if (record.transcript_path) withTranscript++; else withoutTranscript++;
    if (samples.length < 3) samples.push(`${record.event_id}  ${record.summary.slice(0, 62)}`);
    fresh.push(JSON.stringify(record));
  }

  console.log(WRITE ? '=== build-prompt-history: WRITE ===' : '=== build-prompt-history: dry run (pass --write to apply) ===');
  console.log(`source:     ${SOURCE}`);
  console.log(`output:     ${OUT}${existingRows ? `  (${existingRows} rows already projected)` : ''}`);
  console.log(`scanned:    ${scanned}`);
  console.log(`projected:  ${fresh.length}`);
  console.log(`  transcript resolved:  ${withTranscript}`);
  console.log(`  transcript expired:   ${withoutTranscript}  <- records this log is the only copy of`);
  console.log('skipped:');
  for (const [reason, count] of Object.entries(skipped)) {
    if (count) console.log(`  ${reason.padEnd(14)} ${count}`);
  }
  for (const sample of samples) console.log(`    ${sample}`);

  if (!WRITE) {
    console.log('nothing written.');
    return;
  }
  if (fresh.length === 0) {
    console.log('nothing to append.');
    return;
  }

  // Append-only, and never onto a truncated last line: a log whose tail lacks a
  // newline would otherwise get the first new record welded onto it, producing
  // one unparseable row and losing two.
  let prefix = '';
  if (fs.existsSync(OUT)) {
    const size = fs.statSync(OUT).size;
    if (size > 0) {
      const fd = fs.openSync(OUT, 'r');
      const tail = Buffer.alloc(1);
      fs.readSync(fd, tail, 0, 1, size - 1);
      fs.closeSync(fd);
      if (tail.toString() !== '\n') prefix = '\n';
    }
  }
  fs.appendFileSync(OUT, prefix + fresh.join('\n') + '\n');
  console.log(`appended ${fresh.length} rows to ${OUT}`);
  console.log('semantic index: run scripts/embed-events.js to make these reachable by vector search.');
}

// Importable for tests; only the CLI invocation runs the projection.
const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main();
