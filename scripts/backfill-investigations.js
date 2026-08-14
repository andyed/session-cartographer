#!/usr/bin/env node
/**
 * Make /investigate hypotheses searchable.
 *
 * The investigate skill writes root-cause diagnoses to
 * `.carto/events/YYYY-MM.jsonl`. Nothing reads that file. `cartographer-search.sh`
 * searches changelog, research-log, session-milestones, and tool-use-log —
 * `.carto/events/` is not in the set — and the skill never calls
 * `index-event.sh`, so the records never reach Qdrant either. The skill's own
 * description claims it "logs it to the event log for later recall"; recall was
 * impossible on every path.
 *
 * Three independent breaks, all fixed here:
 *   1. Wrong file        → normalized records are appended to changelog.jsonl
 *   2. Wrong field names → `id`/`ts` become `event_id`/`timestamp`
 *   3. Unreachable text  → symptom + hypothesis are joined into `summary`,
 *                          which is first in the field-extraction chain
 *
 * The skill's jq block has also been paraphrased rather than executed verbatim,
 * producing four record shapes across 63 records (`investigation`,
 * `DebugHypothesis`, `diagnosis`, `investigation_hypothesis`, plus variants
 * keyed on `payload` or `files`/`tags`). All are normalized to one shape.
 *
 * Idempotent: event_ids are deterministic and existing ids are skipped, so
 * rerunning after new investigations only appends the new ones.
 *
 * Usage:
 *   node scripts/backfill-investigations.js              # dry run
 *   node scripts/backfill-investigations.js --verbose
 *   node scripts/backfill-investigations.js --write
 *   node scripts/backfill-investigations.js --write --index
 */
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { buildSessionWindows, defaultPaths, toSortedList } from './session-windows.js';
import { createMatcher } from './session-match.js';
import { isResolved, firstResolved } from './sentinels.js';

const args = process.argv.slice(2);
const valueAfter = (flag, fallback) => {
  const idx = args.indexOf(flag);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : fallback;
};
const DO_WRITE = args.includes('--write');
const DO_INDEX = args.includes('--index');
const VERBOSE = args.includes('--verbose');
const AS_JSON = args.includes('--json');

const paths = defaultPaths();
const EVENTS_DIR = valueAfter('--events-dir', path.join(paths.dev, '.carto', 'events'));
const TARGET = valueAfter('--target', paths.changelog);

if (!fs.existsSync(EVENTS_DIR)) {
  console.error(`No investigate event directory at ${EVENTS_DIR}`);
  process.exit(2);
}

// ─── Read the raw investigate records ───

const raw = [];
for (const file of fs.readdirSync(EVENTS_DIR).sort()) {
  if (!file.endsWith('.jsonl')) continue;
  const full = path.join(EVENTS_DIR, file);
  for (const line of fs.readFileSync(full, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { raw.push({ ...JSON.parse(line), _file: file }); } catch { /* skip */ }
  }
}

if (raw.length === 0) {
  console.error(`No parseable records in ${EVENTS_DIR}`);
  process.exit(1);
}

// The pipeline is TSV/line-based: a newline inside a summary splits the row and
// the fragments mis-parse as rank/key/timestamp. Flatten at the source, and
// handle the literal backslash-n that survived earlier hooks' escaping.
const flatten = (text) => String(text || '')
  .replace(/\\n|\\t/g, ' ')
  .replace(/[\n\r\t]+/g, ' ')
  .replace(/\s{2,}/g, ' ')
  .trim();

const INVESTIGATION_TYPES = new Set([
  'investigation', 'investigation_hypothesis', 'diagnosis', 'DebugHypothesis',
]);

function normalize(record) {
  const type = record.type || '';
  if (!INVESTIGATION_TYPES.has(type)) return null;

  const timestamp = record.ts || record.timestamp;
  if (!timestamp) return null;

  const symptom = flatten(record.symptom || record.summary || '');
  const hypothesis = flatten(
    record.hypothesis
    || (typeof record.payload === 'string' ? record.payload : '')
    || (record.payload ? JSON.stringify(record.payload) : '')
  );
  if (!symptom && !hypothesis) return null;

  // `summary` is first in the extraction chain, so it must carry the text that
  // makes the record findable — both the symptom someone would search for and
  // the diagnosis they actually want back.
  const summary = flatten(
    `Investigated: ${symptom}${hypothesis ? ` — ${hypothesis}` : ''}`
  );

  return {
    event_id: String(record.id || record.event_id || ''),
    timestamp,
    type: 'investigation',
    provider: firstResolved([record.provider], 'unknown'),
    project: firstResolved([record.project], 'unknown'),
    cwd: record.cwd || '',
    session_id: isResolved(record.session_id) ? record.session_id : '',
    summary,
    symptom,
    hypothesis,
    root_cause_layer: record.root_cause_layer || '',
    // Deliberate diagnoses sit between a /wrapup milestone (0.9) and a feature
    // commit (0.7): expensive to re-derive, but scoped to one bug.
    salience: 0.8,
    source_file: record._file,
    backfilled_by: 'backfill-investigations',
  };
}

const normalized = raw.map(normalize).filter(Boolean);

// Deterministic ids so reruns are idempotent. Most records already carry one;
// the few that do not get a stable id derived from timestamp + project.
const seenIds = new Set();
for (const event of normalized) {
  if (!event.event_id || seenIds.has(event.event_id)) {
    const slug = `${event.timestamp}-${event.project}`.replace(/[^A-Za-z0-9]/g, '').toLowerCase();
    event.event_id = `evt-inv-${slug.slice(-16)}`;
  }
  seenIds.add(event.event_id);
}

// ─── Skip anything already in the target ───

const existingIds = new Set();
if (fs.existsSync(TARGET)) {
  for (const line of fs.readFileSync(TARGET, 'utf8').split('\n')) {
    if (!line) continue;
    const m = line.match(/"event_id"\s*:\s*"([^"]+)"/);
    if (m) existingIds.add(m[1]);
  }
}
const fresh = normalized.filter((e) => !existingIds.has(e.event_id));

// ─── Attribute the orphans ───

const { sessions } = buildSessionWindows({
  sources: [paths.changelog, paths.milestones],
  transcriptDirs: [paths.transcripts],
  collectStamps: true,
});
const matchSession = createMatcher(toSortedList(sessions), { isResolved });

const stats = {
  raw: raw.length,
  normalized: normalized.length,
  skipped_non_investigation: raw.length - normalized.length,
  already_present: normalized.length - fresh.length,
  to_append: fresh.length,
  had_session: 0,
  session_recovered: 0,
  session_ambiguous: 0,
  session_unrecoverable: 0,
  transcript_linked: 0,
};

for (const event of fresh) {
  if (isResolved(event.session_id)) {
    stats.had_session += 1;
  } else {
    const { match, ambiguous } = matchSession(event.timestamp, event.project, event.cwd);
    if (ambiguous) { stats.session_ambiguous += 1; }
    else if (match) { event.session_id = match.sid; stats.session_recovered += 1; }
    else { stats.session_unrecoverable += 1; }
  }

  // Only point at a transcript that exists and covers the moment. A repair that
  // yields another unreadable path has bought nothing.
  const session = isResolved(event.session_id) ? sessions.get(event.session_id) : null;
  if (session?.transcriptPath && fs.existsSync(session.transcriptPath)) {
    const { transcriptStart: ts0, transcriptEnd: ts1 } = session;
    if (!ts0 || !ts1 || (event.timestamp >= ts0 && event.timestamp <= ts1)) {
      event.transcript_path = session.transcriptPath;
      if (event.provider === 'claude' || session.transcriptPath.includes('/.claude/')) {
        event.deeplink = `claude-history://session/${encodeURIComponent(session.transcriptPath)}`;
      }
      stats.transcript_linked += 1;
    }
  }
}

// ─── Report ───

if (AS_JSON) {
  console.log(JSON.stringify({ events_dir: EVENTS_DIR, target: TARGET, stats }, null, 2));
} else {
  console.log(`\nSource:  ${EVENTS_DIR}`);
  console.log(`Target:  ${TARGET}\n`);
  console.log(`  records read                 ${stats.raw}`);
  console.log(`  normalized as investigations ${stats.normalized}`);
  if (stats.skipped_non_investigation) {
    console.log(`  skipped (not investigations) ${stats.skipped_non_investigation}`);
  }
  console.log(`  already in target            ${stats.already_present}`);
  console.log(`  to append                    ${stats.to_append}\n`);
  console.log(`  session already attributed   ${stats.had_session}`);
  console.log(`  session recovered            ${stats.session_recovered}`);
  console.log(`  session ambiguous — refused  ${stats.session_ambiguous}`);
  console.log(`  session unrecoverable        ${stats.session_unrecoverable}`);
  console.log(`  transcript linked            ${stats.transcript_linked}`);

  if (VERBOSE) {
    console.log('\n  sample:');
    for (const e of fresh.slice(0, 3)) {
      console.log(`    ${e.timestamp}  ${e.project}  ${e.session_id || '(no session)'}`);
      console.log(`      ${e.summary.slice(0, 150)}…`);
    }
  }
}

if (!DO_WRITE) {
  if (!AS_JSON) console.log(`\nDry run — nothing written. Pass --write to append ${fresh.length} event(s).`);
  process.exit(0);
}

if (fresh.length === 0) {
  if (!AS_JSON) console.log('\nNothing to append.');
  process.exit(0);
}

// Append only. The changelog is the shared event stream; rewriting it here
// would put this script in conflict with every hook writing concurrently.
const payload = `${fresh.map((e) => JSON.stringify(e)).join('\n')}\n`;
fs.appendFileSync(TARGET, payload);
if (!AS_JSON) console.log(`\nAppended ${fresh.length} event(s) to ${TARGET}`);

if (DO_INDEX) {
  const root = path.dirname(new URL('.', import.meta.url).pathname.replace(/\/$/, ''));
  let ok = 0;
  const failed = [];
  for (const event of fresh) {
    try {
      execSync('bash scripts/index-event.sh', {
        input: JSON.stringify(event),
        cwd: root,
        stdio: ['pipe', 'ignore', 'ignore'],
      });
      ok += 1;
    } catch {
      failed.push(event.event_id);
    }
  }
  console.log(failed.length
    ? `Indexed ${ok}, failed ${failed.length} (see .carto/index-errors.jsonl)`
    : `Indexed ${ok} event(s)`);
}
