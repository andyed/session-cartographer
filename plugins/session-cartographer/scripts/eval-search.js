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
// Compares results against demo/truth/<query-id>.json labels.
// Reports precision@k, recall, noise breakdown, and latency.
//
// Usage:
//   node scripts/eval-search.js                    # shipped ranking
//   node scripts/eval-search.js --lambda 0         # the decay-off arm
//   node scripts/eval-search.js --lookup-max 0     # decay without the lookup exemption
//   node scripts/eval-search.js --api --verbose    # add the in-process arm; per-result detail
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

import { existsSync, readFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { execFileSync, execSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const TRUTH_DIR = join(ROOT, 'demo', 'truth');
const SEARCH_SCRIPT = join(ROOT, 'scripts', 'cartographer-search.sh');
const VERBOSE = process.argv.includes('--verbose');
const API_ARM = process.argv.includes('--api');

function flagValue(name) {
  const i = process.argv.indexOf(name);
  if (i < 0) return undefined;
  const value = process.argv[i + 1];
  if (value === undefined || !/^[0-9.]+$/.test(value)) {
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

// ─── Load truth data ───

// demo/truth/ is gitignored: the labels name real sessions, so they exist only
// in the maintainer's own checkout.
if (!existsSync(TRUTH_DIR)) {
  console.error(`No truth labels at ${TRUTH_DIR} (gitignored; present only in the maintainer's checkout).`);
  process.exit(2);
}
const truthFiles = readdirSync(TRUTH_DIR).filter(f => f.endsWith('.json'));
const queries = truthFiles.map(f => JSON.parse(readFileSync(join(TRUTH_DIR, f), 'utf-8')));

console.log(`Loaded ${queries.length} truth queries\n`);

// ─── Search runners ───

function runSearch(query, mode) {
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
  const args = [SEARCH_SCRIPT, query, '--limit', '50', '--all', '--no-turbo'];

  if (mode === 'bm25') {
    env.CARTOGRAPHER_SEMANTIC = '0';
  } else if (mode === 'grep') {
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
      const sessionIds = sessions.map(p => {
        const base = p.split('/').pop().replace('.jsonl', '');
        return base;
      });
      return { sessions: new Set(sessionIds), events: [], elapsed, rawCount: sessions.length };
    } catch {
      return { sessions: new Set(), events: [], elapsed: performance.now() - start, rawCount: 0 };
    }
  }

  const start = performance.now();
  try {
    const out = execFileSync('bash', args, { encoding: 'utf-8', timeout: 120000, env });
    const elapsed = performance.now() - start;
    return parseSearchOutput(out, elapsed);
  } catch {
    return { sessions: new Set(), events: [], elapsed: performance.now() - start, rawCount: 0 };
  }
}

// The api arm: hybridSearch in this process, over the same five logs. Loaded
// once — a corpus load costs about a second — and only when asked for.
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
  const res = await apiEngine.hybridSearch(apiEngine.index, query, {});
  const elapsed = performance.now() - start;
  const events = res.items.slice(0, 50).map((item) => ({
    timestamp: item.timestamp || '',
    sources: item._sources || '',
    event_id: item.event_id || '',
    summary: String(item.summary || item.description || item.prompt || '').split('\n')[0],
    session: item.session_id || item.session || '',
    project: item.project || '',
  }));
  return { sessions: new Set(events.map((e) => e.session).filter(Boolean)), events, elapsed, rawCount: events.length };
}

function parseSearchOutput(output, elapsed) {
  const lines = output.split('\n');
  const events = [];
  const sessions = new Set();
  let currentEvent = null;

  for (const line of lines) {
    // Result line: [timestamp] [sources] event_id
    if (line.match(/^\[20/)) {
      if (currentEvent) events.push(currentEvent);
      const srcMatch = line.match(/\[([^\]]+)\]\s+\[([^\]]+)\]\s+(.+)/);
      currentEvent = {
        timestamp: srcMatch?.[1] || '',
        sources: srcMatch?.[2] || '',
        event_id: srcMatch?.[3]?.trim() || '',
        summary: '',
        session: '',
        project: '',
      };
    } else if (currentEvent) {
      // Metadata lines
      const sessionMatch = line.match(/^\s+session:\s+(.+)/);
      const projectMatch = line.match(/^\s+project:\s+(.+)/);
      const summaryLine = line.match(/^\s+\S/);

      if (sessionMatch) {
        currentEvent.session = sessionMatch[1].trim();
        sessions.add(currentEvent.session);
      } else if (projectMatch) {
        currentEvent.project = projectMatch[1].trim();
      } else if (summaryLine && !currentEvent.summary) {
        currentEvent.summary = line.trim();
      }
    }
  }
  if (currentEvent) events.push(currentEvent);

  return { sessions, events, elapsed, rawCount: events.length };
}

// ─── Scoring ───

function scoreResults(truthQuery, searchResult, mode) {
  const truthEvents = truthQuery.events || [];
  const truthSessions = truthQuery.sessions || {};

  // Session recall: how many known-relevant sessions did we find?
  const relevantSessionIds = Object.entries(truthSessions)
    .filter(([, v]) => v.relevant)
    .map(([k]) => k);

  let sessionRecall = 0;
  if (relevantSessionIds.length > 0) {
    const found = relevantSessionIds.filter(sid =>
      [...searchResult.sessions].some(s => s.includes(sid.slice(0, 12)) || sid.includes(s.slice(0, 12)))
    );
    sessionRecall = found.length / relevantSessionIds.length;
  }

  // For grep mode, we can only measure session recall and speed
  if (mode === 'grep') {
    return {
      mode,
      query: truthQuery.query,
      sessionRecall,
      sessionsFound: searchResult.sessions.size,
      relevantSessions: relevantSessionIds.length,
      elapsed: searchResult.elapsed,
      rawCount: searchResult.rawCount,
    };
  }

  // Precision@k: what fraction of top-k are relevant (grade > 0)?
  const k5 = Math.min(5, searchResult.events.length);
  const k10 = Math.min(10, searchResult.events.length);
  const k20 = Math.min(20, searchResult.events.length);

  // Match search results to truth labels.
  //
  // Two signals, checked in order:
  //
  // 1. Explicit event-level match via word-overlap against truth.events.
  //    Required when truth.events contains noise exemplars (grade 0) — those
  //    are specifically called out as "the query matches this but it's wrong"
  //    and must override the session-level inference below.
  //
  // 2. Session-level fallback. If the event's session is in truth.sessions
  //    with relevant:true, credit it with a grade based on the session role
  //    (primary=3, secondary=2, other=1). This catches all the legitimate
  //    results that the word-overlap matcher misses because commit summaries
  //    (Commit abc123: feat: ... | files: ...) don't lexically match the
  //    human-written truth event summaries.
  //
  // The old matcher was word-overlap only, which scored P@5=0 even on queries
  // where session recall was 100%. The session fallback is essential for
  // queries whose truth.events are written against transcript content but
  // whose indexed events are commit summaries.
  function tokenize(s) {
    return (s || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(w => w.length > 2);
  }

  const STOP = new Set(['the','and','for','this','that','with','from','was','are','not','but','has','had','have','will','been','can','its','all','also','into','let','now','then','done','just']);

  function sessionRoleGrade(role) {
    if (role === 'primary') return 3;
    if (role === 'secondary') return 2;
    return 1;
  }

  function matchTruth(event, truthEvents, truthSessions) {
    const eTokens = new Set(tokenize(event.summary).filter(w => !STOP.has(w)));

    // 1. Explicit event-level match (word overlap). Wins when present because
    //    it can assign grade:0 to known noise.
    if (eTokens.size > 0) {
      let bestMatch = null;
      let bestScore = 0;
      for (const te of truthEvents) {
        const tTokens = tokenize(te.summary).filter(w => !STOP.has(w));
        if (tTokens.length === 0) continue;
        const overlap = tTokens.filter(w => eTokens.has(w)).length;
        const score = overlap / tTokens.length;
        if (score > bestScore && score >= 0.5) {
          bestScore = score;
          bestMatch = te;
        }
      }
      if (bestMatch) return bestMatch;
    }

    // 2. Session-level fallback: if the event lives in a relevant session,
    //    credit it. Role → grade mapping preserves the primary/secondary
    //    distinction from the truth file.
    const eventSid = event.session || '';
    if (eventSid && truthSessions) {
      for (const [sid, info] of Object.entries(truthSessions)) {
        if (!info.relevant) continue;
        // Prefix match in both directions — session IDs may be truncated in
        // either source (matches the sessionRecall strategy above).
        const prefix = 12;
        if (sid.includes(eventSid.slice(0, prefix)) ||
            eventSid.includes(sid.slice(0, prefix))) {
          return {
            grade: sessionRoleGrade(info.role),
            noise: null,
            summary: `[session:${sid.slice(0, 8)} ${info.role || 'relevant'}]`,
          };
        }
      }
    }

    return null;
  }

  let relevant5 = 0, relevant10 = 0, relevant20 = 0;
  const noiseBreakdown = {};
  const details = [];

  for (let i = 0; i < Math.min(20, searchResult.events.length); i++) {
    const event = searchResult.events[i];
    const truth = matchTruth(event, truthEvents, truthSessions);

    const isRelevant = truth ? truth.grade > 0 : false;
    const noise = truth?.noise || (isRelevant ? null : 'unlabeled');

    if (i < k5 && isRelevant) relevant5++;
    if (i < k10 && isRelevant) relevant10++;
    if (i < k20 && isRelevant) relevant20++;

    if (noise) {
      noiseBreakdown[noise] = (noiseBreakdown[noise] || 0) + 1;
    }

    if (VERBOSE) {
      details.push({
        rank: i + 1,
        relevant: isRelevant,
        grade: truth?.grade ?? '?',
        noise,
        summary: (event.summary || '').slice(0, 60),
        sources: event.sources,
      });
    }
  }

  return {
    mode,
    query: truthQuery.query,
    precision5: k5 > 0 ? relevant5 / k5 : 0,
    precision10: k10 > 0 ? relevant10 / k10 : 0,
    precision20: k20 > 0 ? relevant20 / k20 : 0,
    sessionRecall,
    sessionsFound: searchResult.sessions.size,
    relevantSessions: relevantSessionIds.length,
    elapsed: searchResult.elapsed,
    rawCount: searchResult.rawCount,
    noiseBreakdown,
    details,
  };
}

// ─── Run evaluation ───

const MODES = ['grep', 'bm25', 'hybrid', ...(API_ARM ? ['api'] : [])];
const allScores = [];

const shown = Object.entries(RANKING_ENV).map(([k, v]) => `${k}=${v}`).join(' ');
console.log(`Ranking: ${shown || 'engine defaults (shipped)'}; arms: ${MODES.join(', ')}\n`);

for (const truth of queries) {
  console.log(`── ${truth.query} ──`);
  console.log(`   Intent: ${truth.intent}`);
  console.log(`   Relevant sessions: ${Object.entries(truth.sessions).filter(([,v]) => v.relevant).length}`);
  console.log('');

  for (const mode of MODES) {
    process.stdout.write(`   ${mode.padEnd(8)} `);
    const result = mode === 'api' ? await runApiSearch(truth.query) : runSearch(truth.query, mode);
    const score = scoreResults(truth, result, mode);
    allScores.push(score);

    if (mode === 'grep') {
      console.log(
        `sessions: ${String(score.sessionsFound).padStart(4)} | ` +
        `recall: ${(score.sessionRecall * 100).toFixed(0).padStart(3)}% | ` +
        `${score.elapsed.toFixed(0).padStart(6)}ms`
      );
    } else {
      console.log(
        `P@5: ${score.precision5.toFixed(2)} | P@10: ${score.precision10.toFixed(2)} | P@20: ${score.precision20.toFixed(2)} | ` +
        `recall: ${(score.sessionRecall * 100).toFixed(0).padStart(3)}% (${score.sessionsFound} sessions) | ` +
        `${score.elapsed.toFixed(0).padStart(6)}ms`
      );

      if (Object.keys(score.noiseBreakdown).length > 0) {
        const noise = Object.entries(score.noiseBreakdown)
          .sort((a, b) => b[1] - a[1])
          .map(([k, v]) => `${k}:${v}`)
          .join(', ');
        console.log(`            noise: ${noise}`);
      }
    }

    if (VERBOSE && score.details) {
      for (const d of score.details) {
        const mark = d.relevant ? '✓' : '✗';
        const gradeStr = d.grade === '?' ? '?' : d.grade;
        console.log(`            ${String(d.rank).padStart(2)}. ${mark} [${gradeStr}] [${d.sources}] ${d.summary}`);
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

// Aggregate by mode
for (const mode of MODES) {
  const modeScores = allScores.filter(s => s.mode === mode);
  const avgElapsed = modeScores.reduce((a, s) => a + s.elapsed, 0) / modeScores.length;
  const avgRecall = modeScores.reduce((a, s) => a + s.sessionRecall, 0) / modeScores.length;

  if (mode === 'grep') {
    const avgSessions = modeScores.reduce((a, s) => a + s.sessionsFound, 0) / modeScores.length;
    console.log(`${mode.padEnd(8)}  recall: ${(avgRecall * 100).toFixed(0)}%  sessions: ${avgSessions.toFixed(0)}  speed: ${avgElapsed.toFixed(0)}ms`);
  } else {
    const avgP5 = modeScores.reduce((a, s) => a + s.precision5, 0) / modeScores.length;
    const avgP10 = modeScores.reduce((a, s) => a + s.precision10, 0) / modeScores.length;
    const avgP20 = modeScores.reduce((a, s) => a + s.precision20, 0) / modeScores.length;
    console.log(`${mode.padEnd(8)}  P@5: ${avgP5.toFixed(2)}  P@10: ${avgP10.toFixed(2)}  P@20: ${avgP20.toFixed(2)}  recall: ${(avgRecall * 100).toFixed(0)}%  speed: ${avgElapsed.toFixed(0)}ms`);

    // Aggregate noise
    const totalNoise = {};
    for (const s of modeScores) {
      for (const [k, v] of Object.entries(s.noiseBreakdown || {})) {
        totalNoise[k] = (totalNoise[k] || 0) + v;
      }
    }
    if (Object.keys(totalNoise).length > 0) {
      const noise = Object.entries(totalNoise)
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `${k}:${v}`)
        .join(', ');
      console.log(`          noise: ${noise}`);
    }
  }
}

console.log('');
console.log('Noise types: single_word_match, semantic_drift, compaction_parrot, unlabeled');
