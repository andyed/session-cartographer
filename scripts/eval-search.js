#!/usr/bin/env node
// eval-search.js — Evaluate search quality against labeled truth data.
//
// Runs each truth query through these arms, each pinned to one engine:
//   1. grep    raw transcript search — baseline
//   2. bm25    portable CLI, keyword only (CARTOGRAPHER_TURBO=0, semantic off)
//   3. hybrid  portable CLI, keyword + semantic (CARTOGRAPHER_TURBO=0)
//   4. api     hybridSearch in-process — the engine Turbo runs — with the
//              same decay settings (--api; it loads the whole corpus)
//
// Compares results against demo/truth/<query-id>.json labels, scored by
// scripts/truth-score.js (which scripts/age-curve.js shares for its topical
// cases). Reports precision@k, judged precision, graded gain, session recall,
// noise breakdown, the source mix behind each arm, and latency.
//
// Usage:
//   node scripts/eval-search.js                    # shipped ranking
//   node scripts/eval-search.js --lambda 0         # the decay-off arm
//   node scripts/eval-search.js --lookup-max 0     # decay without the lookup exemption
//   node scripts/eval-search.js --api --verbose    # add the in-process arm; per-result detail
//   node scripts/eval-search.js --arms bm25,api --truth ~/Documents/dev/session-cartographer/demo/truth
//
// What it measures is the configuration it is given. Until 2026-10-16 it forced
// CARTOGRAPHER_DECAY_LAMBDA=0, which made its numbers describe a ranking no one
// ran, and it called the CLI without --no-turbo, so with Turbo enabled the bm25
// and hybrid arms were both answered by the warm server — whose decay and
// semantic settings are its own environment's, not this harness's — and
// compared the server with itself. Now each arm names its engine, and the
// decay settings (CARTOGRAPHER_DECAY_LAMBDA, CARTOGRAPHER_DECAY_LOOKUP_MAX, or
// --lambda / --lookup-max) reach every arm. Telemetry is not written: served
// and search-call rows go to /dev/null, and session variables are unset so
// delta serving cannot shrink later queries' result sets.
//
// Two more silent failures were closed on 2026-10-17. A CLI call that failed
// or hit its timeout scored as an empty result list, so a slow machine read as
// a precision drop (5 of 9 queries once reported 0/0/0 that way); it is now an
// engine error, counted and excluded from the means. And the CLI arms parsed
// the text format, which put a reuse tag into the event id and cut summaries
// at 200 characters before word-overlap matching; they read --format jsonl now.
//
// The labels are dated: they were written in April 2026 against sessions from
// that time, so every labeled-relevant record is now months old and newer work
// on the same topic is unjudged. Any time decay lowers plain precision here
// partly for that reason alone (measured 2026-08-14: P@5 0.40 with decay off,
// 0.11 on). Judged precision, over labeled results only, is the check.

import { join, dirname, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { execFileSync, execSync } from 'child_process';
import { eventFromCliRow, eventFromItem, loadTruth, scoreTruth } from './truth-score.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const SEARCH_SCRIPT = join(ROOT, 'scripts', 'cartographer-search.sh');
const VERBOSE = process.argv.includes('--verbose');
const API_ARM = process.argv.includes('--api');
// The CLI costs ~25 s a query on a 200k-event corpus and several times that on
// a loaded machine. The old 120 s budget expired on a busy one.
const CLI_TIMEOUT_MS = 600e3;

function argValue(name) {
  const i = process.argv.indexOf(name);
  if (i < 0) return undefined;
  const value = process.argv[i + 1];
  if (value === undefined || value.startsWith('--')) {
    console.error(`${name} needs a value`);
    process.exit(2);
  }
  return value;
}

function flagValue(name) {
  const value = argValue(name);
  if (value !== undefined && !/^[0-9.]+$/.test(value)) {
    console.error(`${name} needs a non-negative number`);
    process.exit(2);
  }
  return value;
}

// One decay configuration for every arm. Unset means each engine's default,
// which is the shipped ranking.
const RANKING_ENV = {};
for (const [flag, key] of [['--lambda', 'CARTOGRAPHER_DECAY_LAMBDA'], ['--lookup-max', 'CARTOGRAPHER_DECAY_LOOKUP_MAX']]) {
  const value = flagValue(flag) ?? process.env[key];
  if (value !== undefined && value !== '') RANKING_ENV[key] = value;
}
// The in-process arm reads these at call time from its own environment.
Object.assign(process.env, RANKING_ENV);

const ALL_ARMS = ['grep', 'bm25', 'hybrid', 'api'];
const MODES = (argValue('--arms') || ['grep', 'bm25', 'hybrid', ...(API_ARM ? ['api'] : [])].join(','))
  .split(',').filter(Boolean);
for (const mode of MODES) {
  if (!ALL_ARMS.includes(mode)) {
    console.error(`unknown arm '${mode}' (${ALL_ARMS.join(', ')})`);
    process.exit(2);
  }
}

// ─── Load truth data ───

// demo/truth/ is gitignored: the labels name real sessions, so they exist only
// in the maintainer's own checkout. A worktree has none; --truth points at it.
const TRUTH_DIR = resolve(argValue('--truth') || join(ROOT, 'demo', 'truth'));
const queries = loadTruth(TRUTH_DIR);
if (!queries) {
  console.error(`No truth labels at ${TRUTH_DIR} (gitignored; present only in the maintainer's checkout; pass --truth DIR).`);
  process.exit(2);
}

console.log(`Loaded ${queries.length} truth queries from ${TRUTH_DIR}\n`);

// ─── Search runners ───

function runSearch(query, mode) {
  if (mode === 'grep') {
    // grep: just count unique sessions from raw transcript search
    const start = performance.now();
    try {
      const out = execSync(
        `grep -rl "${query}" ~/.claude/projects/ 2>/dev/null | sed 's|/subagents/.*||' | sort -u`,
        { encoding: 'utf-8', timeout: 120000 }
      );
      const elapsed = performance.now() - start;
      const sessions = out.trim().split('\n').filter(Boolean);
      // Extract session IDs from paths
      const events = sessions.map((p) => ({ session: p.split('/').pop().replace('.jsonl', '') }));
      return { events, elapsed };
    } catch {
      return { events: [], elapsed: performance.now() - start };
    }
  }

  const env = { ...process.env, ...RANKING_ENV };
  // Delta serving suppresses event_ids already returned this session. An eval
  // that inherits a live session id scores later queries against a shrinking
  // result set and reports a precision drop that is pure measurement artifact.
  for (const key of ['CARTOGRAPHER_SESSION_ID', 'CLAUDE_SESSION_ID',
    'CLAUDE_CODE_SESSION_ID', 'CODEX_SESSION_ID']) delete env[key];
  // An evaluation is not a recall: its served rows would feed hit-rate reports
  // and its call rows the Internals latency cohorts. The access ledger is left
  // alone — it is only written by --touch, which this never passes, and it is
  // read for promote-on-reuse, which is part of the ranking being measured.
  env.CARTOGRAPHER_SERVED_LOG = '/dev/null';
  env.CARTOGRAPHER_SEARCH_CALL_LOG = '/dev/null';
  // Pin the engine. Without --no-turbo an enabled Turbo answers both CLI arms.
  env.CARTOGRAPHER_TURBO = '0';
  if (mode === 'bm25') env.CARTOGRAPHER_SEMANTIC = '0';
  const args = [SEARCH_SCRIPT, query, '--limit', '50', '--format', 'jsonl', '--all', '--no-turbo'];

  const start = performance.now();
  let out;
  try {
    out = execFileSync('bash', args, { encoding: 'utf-8', timeout: CLI_TIMEOUT_MS, env, maxBuffer: 64 * 1024 * 1024 });
  } catch (error) {
    // Exit 1 with no output is "no results", a measurement. Anything else —
    // a timeout, a crash — is not a ranking and must not score as one.
    if (error.status !== 1 || error.signal) {
      return { events: [], elapsed: performance.now() - start, error: String(error.message || error).split('\n')[0] };
    }
    out = String(error.stdout || '');
  }
  const elapsed = performance.now() - start;
  const events = out.split('\n').filter((l) => l.startsWith('{')).map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter((row) => row && row.event_id).map(eventFromCliRow);
  return { events, elapsed };
}

// The api arm: hybridSearch in this process, over the same five logs. Loaded
// once — a corpus load costs a few seconds — and only when asked for.
let apiEngine = null;
async function runApiSearch(query) {
  if (!apiEngine) {
    const load = (rel) => import(pathToFileURL(join(ROOT, rel)).href);
    const [{ readAllEvents }, { buildIndex }, { hybridSearch }] = await Promise.all([
      load('explorer/server/jsonl.js'), load('explorer/server/bm25.js'), load('explorer/server/search.js'),
    ]);
    apiEngine = { hybridSearch, index: buildIndex(readAllEvents()) };
  }
  const start = performance.now();
  let res = await apiEngine.hybridSearch(apiEngine.index, query, {});
  // A failed leg makes this arm keyword-only for that query, with nothing in
  // the means to say so. On 2026-10-17 the first attempt failed for 4, then 8,
  // of the 9 queries, each the first call after a CLI arm had run for 20-60 s,
  // and a retry 2 s later succeeded every time. Turbo's own recalls in
  // search-calls.jsonl show no failures, and back-to-back or idle-gap probes
  // did not reproduce it, so the cause is unexplained. Retry once, and report
  // what still failed.
  if (res.semanticStatus === 'unavailable') {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    res = await apiEngine.hybridSearch(apiEngine.index, query, {});
  }
  return { events: res.items.slice(0, 50).map(eventFromItem), elapsed: performance.now() - start,
    semanticStatus: res.semanticStatus || null };
}

// Which ladders contributed, counted over the top 20. A hybrid arm with no
// semantic row is a keyword arm with a different name (docs/TESTING.md).
function sourceMix(events) {
  const mix = {};
  for (const e of events.slice(0, 20)) {
    for (const s of String(e.sources || '').split('+').filter(Boolean)) mix[s] = (mix[s] || 0) + 1;
  }
  return mix;
}

const fmtMix = (mix) => Object.entries(mix).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join(', ');

// ─── Run evaluation ───

const allScores = [];

const shown = Object.entries(RANKING_ENV).map(([k, v]) => `${k}=${v}`).join(' ');
console.log(`Ranking: ${shown || 'engine defaults (shipped)'}; arms: ${MODES.join(', ')}\n`);

for (const truth of queries) {
  console.log(`── ${truth.query} ──`);
  console.log(`   Intent: ${truth.intent}`);
  console.log(`   Relevant sessions: ${Object.entries(truth.sessions).filter(([, v]) => v.relevant).length}`);
  console.log('');

  for (const mode of MODES) {
    process.stdout.write(`   ${mode.padEnd(8)} `);
    const result = mode === 'api' ? await runApiSearch(truth.query) : runSearch(truth.query, mode);
    const score = { mode, query: truth.query, elapsed: result.elapsed, error: result.error || null,
      semanticStatus: result.semanticStatus || null,
      mix: sourceMix(result.events), ...scoreTruth(truth, result.events, { details: VERBOSE }) };
    allScores.push(score);

    if (score.error) {
      console.log(`ENGINE ERROR (excluded from the means): ${score.error.slice(0, 160)}`);
    } else if (mode === 'grep') {
      console.log(
        `sessions: ${String(score.sessionsFound).padStart(4)} | ` +
        `recall: ${(score.sessionRecall * 100).toFixed(0).padStart(3)}% | ` +
        `${score.elapsed.toFixed(0).padStart(6)}ms`
      );
    } else {
      console.log(
        `P@5: ${score.precision5.toFixed(2)} | P@10: ${score.precision10.toFixed(2)} | P@20: ${score.precision20.toFixed(2)} | ` +
        `judged P@10: ${score.judgedP10.toFixed(2)} (${score.judged} judged) | gain@10: ${score.gain10.toFixed(2)} | ` +
        `recall: ${(score.sessionRecall * 100).toFixed(0).padStart(3)}% (${score.sessionsFound} sessions) | ` +
        `${score.elapsed.toFixed(0).padStart(6)}ms`
      );
      console.log(`            sources@20: ${fmtMix(score.mix) || 'none'}${result.semanticStatus ? ` | semantic: ${result.semanticStatus}` : ''}`);
      if (Object.keys(score.noiseBreakdown).length > 0) {
        console.log(`            noise: ${fmtMix(score.noiseBreakdown)}`);
      }
    }

    if (VERBOSE) {
      for (const d of score.details) {
        console.log(`            ${String(d.rank).padStart(2)}. ${d.relevant ? '✓' : '✗'} [${d.grade}] [${d.sources}] ${d.summary}`);
      }
    }
  }
  console.log('');
}

// ─── Summary table ───

console.log('═══════════════════════════════════════════════════════════════════════');
console.log('SUMMARY');
console.log('═══════════════════════════════════════════════════════════════════════');
console.log('');

const mean = (rows, key) => rows.reduce((a, s) => a + s[key], 0) / (rows.length || 1);
for (const mode of MODES) {
  const all = allScores.filter((s) => s.mode === mode);
  const modeScores = all.filter((s) => !s.error);
  const errors = all.length - modeScores.length;
  const keywordOnly = modeScores.filter((s) => s.semanticStatus === 'unavailable').length;
  const errNote = (errors ? `  ENGINE ERRORS: ${errors} of ${all.length} queries excluded` : '')
    + (keywordOnly ? `  SEMANTIC LEG FAILED on ${keywordOnly} of ${modeScores.length} queries (keyword-only there)` : '');

  if (mode === 'grep') {
    console.log(`${mode.padEnd(8)}  recall: ${(mean(modeScores, 'sessionRecall') * 100).toFixed(0)}%  sessions: ${mean(modeScores, 'sessionsFound').toFixed(0)}  speed: ${mean(modeScores, 'elapsed').toFixed(0)}ms${errNote}`);
    continue;
  }
  console.log(`${mode.padEnd(8)}  P@5: ${mean(modeScores, 'precision5').toFixed(2)}  P@10: ${mean(modeScores, 'precision10').toFixed(2)}  `
    + `P@20: ${mean(modeScores, 'precision20').toFixed(2)}  judged P@10: ${mean(modeScores, 'judgedP10').toFixed(2)}  `
    + `gain@10: ${mean(modeScores, 'gain10').toFixed(2)}  recall: ${(mean(modeScores, 'sessionRecall') * 100).toFixed(0)}%  `
    + `speed: ${mean(modeScores, 'elapsed').toFixed(0)}ms${errNote}`);

  const totalMix = {};
  const totalNoise = {};
  for (const s of modeScores) {
    for (const [k, v] of Object.entries(s.mix)) totalMix[k] = (totalMix[k] || 0) + v;
    for (const [k, v] of Object.entries(s.noiseBreakdown || {})) totalNoise[k] = (totalNoise[k] || 0) + v;
  }
  console.log(`          sources@20: ${fmtMix(totalMix) || 'none'}`);
  if (Object.keys(totalNoise).length > 0) console.log(`          noise: ${fmtMix(totalNoise)}`);
}

console.log('');
console.log('Noise types: single_word_match, semantic_drift, compaction_parrot, unlabeled');
