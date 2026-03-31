#!/usr/bin/env node
// eval-search.js — Evaluate search quality against labeled truth data.
//
// Runs each truth query through three modes:
//   1. grep (raw transcript search — baseline)
//   2. BM25 (keyword only, no Qdrant)
//   3. Hybrid (BM25 + semantic fusion)
//
// Compares results against demo/truth/<query-id>.json labels.
// Reports precision@k, recall, noise breakdown, and latency.
//
// Usage:
//   node scripts/eval-search.js              # run evaluation
//   node scripts/eval-search.js --verbose    # show per-result detail

import { readFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const TRUTH_DIR = join(ROOT, 'demo', 'truth');
const SEARCH_SCRIPT = join(ROOT, 'scripts', 'cartographer-search.sh');
const VERBOSE = process.argv.includes('--verbose');

// ─── Load truth data ───

const truthFiles = readdirSync(TRUTH_DIR).filter(f => f.endsWith('.json'));
const queries = truthFiles.map(f => JSON.parse(readFileSync(join(TRUTH_DIR, f), 'utf-8')));

console.log(`Loaded ${queries.length} truth queries\n`);

// ─── Search runners ───

function runSearch(query, mode) {
  const env = { ...process.env };
  const args = [`"${query}"`, '--limit', '50'];

  if (mode === 'bm25') {
    env.CARTOGRAPHER_QDRANT_URL = 'http://localhost:1'; // disable semantic
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
    const out = execSync(
      `bash "${SEARCH_SCRIPT}" ${args.join(' ')}`,
      { encoding: 'utf-8', timeout: 120000, env }
    );
    const elapsed = performance.now() - start;
    return parseSearchOutput(out, elapsed);
  } catch {
    return { sessions: new Set(), events: [], elapsed: performance.now() - start, rawCount: 0 };
  }
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
  // Strategy: tokenize both summaries, compute word overlap ratio.
  // A truth label matches if enough distinctive words overlap.
  function tokenize(s) {
    return (s || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(w => w.length > 2);
  }

  const STOP = new Set(['the','and','for','this','that','with','from','was','are','not','but','has','had','have','will','been','can','its','all','also','into','let','now','then','done','just']);

  function matchTruth(event, truthEvents) {
    const eTokens = new Set(tokenize(event.summary).filter(w => !STOP.has(w)));
    if (eTokens.size === 0) return null;

    let bestMatch = null;
    let bestScore = 0;

    for (const te of truthEvents) {
      const tTokens = tokenize(te.summary).filter(w => !STOP.has(w));
      if (tTokens.length === 0) continue;

      const overlap = tTokens.filter(w => eTokens.has(w)).length;
      const score = overlap / tTokens.length; // what fraction of truth tokens found in result

      if (score > bestScore && score >= 0.5) { // at least half the truth words must match
        bestScore = score;
        bestMatch = te;
      }
    }

    return bestMatch;
  }

  let relevant5 = 0, relevant10 = 0, relevant20 = 0;
  const noiseBreakdown = {};
  const details = [];

  for (let i = 0; i < Math.min(20, searchResult.events.length); i++) {
    const event = searchResult.events[i];
    const truth = matchTruth(event, truthEvents);

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

const MODES = ['grep', 'bm25', 'hybrid'];
const allScores = [];

for (const truth of queries) {
  console.log(`── ${truth.query} ──`);
  console.log(`   Intent: ${truth.intent}`);
  console.log(`   Relevant sessions: ${Object.entries(truth.sessions).filter(([,v]) => v.relevant).length}`);
  console.log('');

  for (const mode of MODES) {
    process.stdout.write(`   ${mode.padEnd(8)} `);
    const result = runSearch(truth.query, mode);
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
