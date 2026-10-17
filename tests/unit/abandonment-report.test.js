/**
 * tests/unit/abandonment-report.test.js
 *
 * scripts/abandonment-report.js credits a recall call with implicit use when
 * the agent's output after it repeats distinctive tokens from one served
 * summary, beyond what shuffled calls' summaries share with the same output.
 * The detector has to do two things, and the fixture has to prove both are
 * hard:
 *
 *   - fire when the answer quotes its own call's summary (a sha, a file, an
 *     identifier and a number from the rank-3 result), at that rank;
 *   - stay quiet when the same answer is scored against a decoy call's
 *     results, although every decoy shares the project's vocabulary with the
 *     answer. A bag-of-words overlap fires on every decoy here (asserted), so
 *     the quiet verdict comes from the detector's filters, not the fixture.
 *
 * It must also refuse credit for tokens the agent saw elsewhere first, before
 * the recall or in a tool result after it. Every fixture runs the CLI's own
 * path: transcript JSONL → normalizeTranscript → locateRecall → readWindow →
 * servedResults → judgeLocated.
 *
 * The gate tests hold the probe's first-access MRR to the canonical
 * aggregator on a fixture where a naive ordering gives a different number,
 * and run runGate against hit-rate-report.js itself.
 *
 * Run with: node --test tests/unit/abandonment-report.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { aggregateInternalsRecords } from '../../explorer/server/internals-aggregate.js';
import {
  buildCallTable, displayedExcerpts, judgeLocated, locateRecall, mrrOf, parseTranscriptText,
  readWindow, runGate, servedResults, snapshotTelemetry, tokenize,
} from '../../scripts/abandonment-report.js';

const IMPLICIT = new Set(['unmarked_use', 'good_abandonment']);
const PROJECT = 'widget-web';

// ─── Fixture builders ────────────────────────────────────────────────────────

let clock = Date.parse('2026-10-01T12:00:00Z');
const tick = () => new Date((clock += 1000)).toISOString();

function claudeJsonl(steps) {
  const rows = [];
  for (const step of steps) {
    if (step.prompt !== undefined) {
      rows.push({ type: 'user', timestamp: tick(), message: { role: 'user', content: step.prompt } });
    } else if (step.call) {
      rows.push({ type: 'assistant', timestamp: tick(), message: { content: [{ type: 'tool_use', id: step.call.id, name: step.call.name, input: step.call.input }] } });
      rows.push({ type: 'user', timestamp: tick(), message: { content: [{ type: 'tool_result', tool_use_id: step.call.id, content: [{ type: 'text', text: step.call.output }] }] } });
    } else if (step.text) {
      rows.push({ type: 'assistant', timestamp: tick(), message: { content: [{ type: 'text', text: step.text }] } });
    }
  }
  return rows.map((row) => JSON.stringify(row)).join('\n');
}

function recallOutput(callId, query, summaries) {
  const lines = [`recall "${query}" — ${summaries.length} results · call_id ${callId} · turbo 120 ms`];
  summaries.forEach((summary, index) => {
    lines.push(`${String(index + 1).padStart(2)}. 2026-09-2${index} · ${PROJECT} · claude · git_commit · ${summary.text} · ${summary.event_id}`);
  });
  return lines.join('\n');
}

/**
 * One located call, built the way probe() builds it. `before` steps run
 * between the prompts and the recall; `after` steps follow its result.
 */
function locatedCall({ callId, session, query, summaries, prompts = ['earlier work on the shard cache', 'the cache keeps leaking at the shard edge — what was the fix?'], before = [], after = [] }) {
  const steps = [
    ...prompts.map((prompt) => ({ prompt })),
    ...before,
    { call: { id: `toolu_${callId}`, name: 'mcp__cartographer__recall', input: { query }, output: recallOutput(callId, query, summaries) } },
    ...after,
  ];
  const entries = parseTranscriptText(claudeJsonl(steps));
  const call = {
    call_id: callId, session_id: session, query, purpose: 'mcp', provider: 'claude', timestamp: clock,
    rows: summaries.map((summary, index) => ({ event_id: summary.event_id, rank: index + 1, project: PROJECT, accesses: [] })),
  };
  const found = locateRecall(entries, callId);
  assert.ok(found.index >= 0, `fixture call ${callId} must be locatable`);
  const window = readWindow(entries, found.index);
  window.subagent = false;
  return { call, window, results: servedResults(call, window) };
}

// The answer quotes four facts that only the rank-3 summary carries.
const ANSWER = 'Found it: the fix landed as 4f9c2e1 in eviction-guard.mjs, which pins warm_cache_ttl at 0.437 so the cache stops leaking at the shard edge.';
const QUERY = 'cache leak shard edge fix';

function actualSummaries() {
  return [
    { event_id: 'evt-act1', text: 'Tuned the read-through layer so the cache warms faster on the shard' },
    { event_id: 'evt-act2', text: 'Eviction sweep raised for the shard; leaking still visible at the edge' },
    { event_id: 'evt-act3', text: '[fix] Commit 4f9c2e1d8b7a6f5e4d3c2b1a09f8e7d6c5b4a3f2: fix(shard): eviction-guard.mjs pins warm_cache_ttl at 0.437 so the cache stops leaking | files: shard/eviction-guard.mjs' },
    { event_id: 'evt-act4', text: 'Edge routing for the shard map' },
    { event_id: 'evt-act5', text: 'Cache sizing research for the dashboard' },
  ];
}

// Thirty calls from other sessions in the same project: every summary shares
// the answer's project vocabulary (cache, shard, edge, leaking, fix) and two
// words the prompt never used (landed, stops), and none carries its facts.
function donorCalls() {
  return Array.from({ length: 30 }, (_, i) => {
    const sha = (0xa1b2c3d + i * 7919).toString(16).padStart(7, '0');
    const summaries = Array.from({ length: 5 }, (__, rank) => ({
      event_id: `evt-d${i}r${rank + 1}`,
      text: rank === 0
        ? `[fix] Commit ${sha}0000000000000000000000000000000000: fix(shard): the cache ttl fix landed, leaking stops at the edge, eviction pass ${i} | files: shard/evict-${i}.mjs`
        : `Shard cache edge note ${i}-${rank}: a leaking fix landed and the churn stops; read-through review`,
    }));
    return locatedCall({
      callId: `call-donor-${i}`, session: `session-donor-${i}`, query: `shard cache ttl ${i}`, summaries,
      after: [{ text: 'Nothing in history settles this; reading the eviction code next.' }],
    });
  });
}

function judge(entry, options = {}) {
  const population = [entry, ...donorCalls()];
  judgeLocated(population, { donors: 30, decoys: 5, seed: 'fixture', ...options });
  return { entry, donors: population.slice(1) };
}

// ─── The overlap detector ────────────────────────────────────────────────────

test('fixture is hard: a bag-of-words overlap fires on every decoy', () => {
  const answer = new Set(tokenize(ANSWER).keys());
  for (const donor of donorCalls()) {
    const best = Math.max(...donor.results.map((result) => [...tokenize(result.text).keys()].filter((key) => answer.has(key)).length));
    assert.ok(best >= 2, `${donor.call.call_id} must share at least two plain tokens with the answer (got ${best})`);
  }
});

test('fires when the next text quotes its own summary, at that summary\'s rank', () => {
  const { entry } = judge(locatedCall({
    callId: 'call-actual', session: 'session-actual', query: QUERY, summaries: actualSummaries(),
    after: [{ text: ANSWER }],
  }));
  assert.equal(entry.verdict.category, 'good_abandonment');
  assert.equal(entry.verdict.rank, 3);
  for (const key of ['4f9c2e1', 'eviction-guard.mjs', 'warm_cache_ttl', '0.437']) {
    assert.ok(entry.scores.text.shared.includes(key), `expected ${key} in ${entry.scores.text.shared}`);
  }
  assert.ok(entry.verdict.p.text <= 0.05, `p ${entry.verdict.p.text}`);
  assert.ok(Math.max(...entry.nulls.text) < 2, 'no shuffled call shares two distinctive tokens with the answer');
});

test('stays quiet when the same answer meets a decoy call\'s results', () => {
  const { entry, donors } = judge(locatedCall({
    callId: 'call-actual', session: 'session-actual', query: QUERY, summaries: actualSummaries(),
    after: [{ text: ANSWER }],
  }));
  assert.equal(entry.decoys.length, 5);
  for (const decoy of entry.decoys) assert.ok(!IMPLICIT.has(decoy.category), `decoy ${decoy.decoy_call_id} was credited`);
  // The donors' own answers name none of their facts: quiet with their own results too.
  for (const donor of donors) assert.ok(!IMPLICIT.has(donor.verdict.category), `${donor.call.call_id} was credited`);
});

// Three safeguards stand between a decoy and a credit: distinctive tokens
// (rarity among the summaries), the shuffled baseline, and the exclusion of
// tokens the conversation already held. The fixture's decoys share two words
// with the answer that the prompt never used, so only the first two are in play.
test('each safeguard alone keeps the decoys quiet; with both off they fire', () => {
  const decoyCredits = (options) => {
    const { entry } = judge(locatedCall({
      callId: 'call-actual', session: 'session-actual', query: QUERY, summaries: actualSummaries(),
      after: [{ text: ANSWER }],
    }), options);
    return entry.decoys.filter((decoy) => IMPLICIT.has(decoy.category)).length;
  };
  const noFilter = { wordDfCap: Infinity, shapeDfCap: Infinity, minShared: 1 };
  const noBaseline = { alpha: 1 };
  assert.equal(decoyCredits({}), 0);
  assert.equal(decoyCredits(noFilter), 0, 'the shuffled baseline alone must hold');
  assert.equal(decoyCredits(noBaseline), 0, 'the distinctive-token filter alone must hold');
  // The fixture can produce false positives: a detector with neither credits every decoy.
  assert.equal(decoyCredits({ ...noFilter, ...noBaseline }), 5);
});

test('a fact the agent saw before the recall earns no credit', () => {
  const { entry } = judge(locatedCall({
    callId: 'call-prior', session: 'session-prior', query: QUERY, summaries: actualSummaries(),
    before: [{ call: { id: 'toolu_read0', name: 'Read', input: { file_path: 'shard/eviction-guard.mjs' }, output: 'export const warm_cache_ttl = 0.437; // 4f9c2e1' } }],
    after: [{ text: ANSWER }],
  }));
  assert.ok(entry.scores.text.score < 2, `shared ${entry.scores.text.shared}`);
  assert.ok(!IMPLICIT.has(entry.verdict.category));
});

test('following the summary\'s file is unmarked use; the text read from it is not good abandonment', () => {
  const { entry } = judge(locatedCall({
    callId: 'call-follow', session: 'session-follow', query: QUERY, summaries: actualSummaries(),
    after: [
      { call: { id: 'toolu_read1', name: 'Read', input: { file_path: '/repo/shard/eviction-guard.mjs' }, output: 'export const warm_cache_ttl = 0.437; // 4f9c2e1' } },
      { text: ANSWER },
    ],
  }));
  assert.equal(entry.verdict.category, 'unmarked_use');
  assert.equal(entry.verdict.via, 'tool_tokens');
  assert.equal(entry.verdict.rank, 3);
  // The facts the answer quotes arrived in the file read first, so the text
  // channel cannot claim them. The file name it typed into the Read stays its own.
  for (const key of ['4f9c2e1', 'warm_cache_ttl', '0.437']) {
    assert.ok(!entry.scores.text.shared.includes(key), `${key} credited to the text: ${entry.scores.text.shared}`);
  }
});

test('a tool call naming a served event_id is unmarked use at that rank', () => {
  const { entry } = judge(locatedCall({
    callId: 'call-handle', session: 'session-handle', query: QUERY, summaries: actualSummaries(),
    after: [
      { call: { id: 'toolu_get', name: 'Bash', input: { command: 'bash cartographer-search.sh --get evt-act4' }, output: '(1 fetched, 0 missing)' } },
      { text: 'Checked the one record; moving on.' },
    ],
  }));
  assert.equal(entry.verdict.category, 'unmarked_use');
  assert.equal(entry.verdict.via, 'handle');
  assert.equal(entry.verdict.rank, 4);
});

test('turn one without a cue is no_need; a cue or a subagent makes it bad abandonment', () => {
  const unused = (overrides) => judge(locatedCall({
    callId: 'call-unused', session: 'session-unused', query: QUERY, summaries: actualSummaries(),
    after: [{ text: 'Starting on the eviction code.' }], ...overrides,
  })).entry;
  assert.equal(unused({ prompts: ['make the cache warm faster'] }).verdict.category, 'no_need');
  assert.equal(unused({ prompts: ['did we already fix the cache leak at the edge?'] }).verdict.category, 'bad_abandonment');
  assert.equal(unused({ prompts: ['<command-name>/remember</command-name> <command-args>cache leak</command-args>'] }).verdict.category, 'bad_abandonment');
  const later = unused({ prompts: ['make the cache warm faster', 'and the edge?'] });
  assert.equal(later.verdict.category, 'bad_abandonment');
  const sub = locatedCall({ callId: 'call-sub', session: 'session-sub', query: QUERY, summaries: actualSummaries(), prompts: ['audit the eviction code'], after: [{ text: 'Reading.' }] });
  sub.window.subagent = true;
  assert.equal(judge(sub).entry.verdict.category, 'bad_abandonment');
});

// ─── Transcripts ─────────────────────────────────────────────────────────────

test('Codex rollouts: event prompts, escaped command output, and the recall located by call_id', () => {
  const output = '=== Searching for: \\"cache leak\\" ===\\n\\n(call_id: call-20261001T120000-777; carry to --get/--touch)\\n\\n[2026-09-20T10:00:00Z] [semantic] evt-cx1\\n   eviction-guard.mjs pins warm_cache_ttl\\n  project: widget-web\\n';
  const rows = [
    { type: 'session_meta', timestamp: '2026-10-01T11:59:00Z', payload: { instructions: 'agent rules' } },
    { type: 'response_item', timestamp: '2026-10-01T11:59:01Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>cwd</environment_context>' }] } },
    { type: 'event_msg', timestamp: '2026-10-01T11:59:02Z', payload: { type: 'user_message', message: 'what fixed the cache leak?' } },
    { type: 'response_item', timestamp: '2026-10-01T11:59:03Z', payload: { type: 'custom_tool_call', call_id: 'c1', name: 'exec', input: 'cartographer-search.sh "cache leak"' } },
    { type: 'response_item', timestamp: '2026-10-01T12:00:01Z', payload: { type: 'custom_tool_call_output', call_id: 'c1', output: [{ type: 'input_text', text: `{"output":"${output}"}` }] } },
    { type: 'response_item', timestamp: '2026-10-01T12:00:05Z', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'eviction-guard.mjs pins it.' }] } },
  ];
  const entries = parseTranscriptText(rows.map((row) => JSON.stringify(row)).join('\n'));
  assert.deepEqual(entries.map((entry) => entry.kind), ['context', 'context', 'prompt', 'call', 'result', 'text']);
  const found = locateRecall(entries, 'call-20261001T120000-777');
  assert.deepEqual(found, { index: 4, by: 'call_id' });
  const window = readWindow(entries, found.index);
  assert.equal(window.promptsBefore, 1);
  const excerpt = displayedExcerpts(window.recallText, ['evt-cx1']).get('evt-cx1');
  assert.match(excerpt, /eviction-guard\.mjs pins warm_cache_ttl/);
});

test('output without a call_id is located by its header and time, or by the call that ran it', () => {
  const at = Date.parse('2026-08-21T03:55:54Z');
  const iso = (offset) => new Date(at + offset).toISOString();
  const rows = [
    { type: 'user', timestamp: iso(-60_000), message: { content: 'is the flicker back?' } },
    { type: 'assistant', timestamp: iso(-2_000), message: { content: [{ type: 'tool_use', id: 'toolu_a', name: 'Bash', input: { command: 'cartographer-search.sh "flicker"' } }] } },
    { type: 'user', timestamp: iso(1_000), message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_a', content: '=== Searching for: "flicker" ===\n[2026-08-20T02:00:11Z] [semantic] evt-f1\n  render loop jitter' }] } },
    { type: 'assistant', timestamp: iso(400_000), message: { content: [{ type: 'tool_use', id: 'toolu_b', name: 'Bash', input: { command: 'cartographer-search.sh "flicker" | grep -E "^\\[" | head' } }] } },
    { type: 'user', timestamp: iso(401_000), message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_b', content: '[2026-08-20T02:00:11Z] [semantic] evt-f1' }] } },
  ];
  const entries = parseTranscriptText(rows.map((row) => JSON.stringify(row)).join('\n'));
  assert.deepEqual(locateRecall(entries, 'call-old-1', { query: 'flicker', timestampMs: at }), { index: 2, by: 'query_time' });
  // The second run was piped through grep: no header, so the call that ran it is the match.
  assert.deepEqual(locateRecall(entries, 'call-old-2', { query: 'flicker', timestampMs: at + 400_000, taken: new Set([2]) }), { index: 4, by: 'query_call' });
  // Outside the window nothing matches.
  assert.deepEqual(locateRecall(entries, 'call-old-3', { query: 'flicker', timestampMs: at + 3_600_000 }), { index: -1, by: null });
});

// ─── The gate path ───────────────────────────────────────────────────────────

const served = (call, ranks, extra = {}) => ranks.map((rank) => ({
  call_id: call, event_id: `e${rank}`, rank, purpose: 'remember', session_id: 's1', timestamp: '2026-10-01T00:00:00Z', ...extra,
}));
const access = (call, rank, ms, extra = {}) => ({
  call_id: call, event_id: `e${rank}`, source: 'result_used', timestamp_ms: ms, timestamp: new Date(ms).toISOString(), ...extra,
});

function gateFixture() {
  const servedRows = [
    ...served('c1', [1, 2, 3, 4, 5]),
    ...served('c2', [1, 2, 3, 4]),
    ...served('c3', [1, 2, 3]),
    ...served('c4', [1, 2, 3]),
    ...served('c5', [1, 2, 3]),
    ...served('c7', [1, 2], { purpose: 'manual' }),
    { event_id: 'e1', rank: 1, query: 'legacy row, no call or purpose' },
    { call_id: 'c1', event_id: 'e3', rank: 9, purpose: 'remember' }, // a repeat: the first (rank 3) stands
  ];
  const accessRows = [
    access('c1', 3, 1_000),
    access('c2', 4, 1_000, { source: 'result_fetched' }), access('c2', 2, 2_000), // time decides: rank 4
    access('c3', 3, 3_000, { access_batch_id: 'b1', access_ordinal: 1 }), access('c3', 1, 3_000, { access_batch_id: 'b1', access_ordinal: 2 }), // ordinal decides: rank 3
    access('c4', 2, 4_000, { access_batch_id: 'b2', access_ordinal: 1 }), access('c4', 3, 4_000, { access_batch_id: 'b3', access_ordinal: 1 }), // undecidable
  ];
  const searchCallRows = [
    { call_id: 'c6', purpose: 'remember', timestamp: '2026-10-01T00:00:00Z', result_count: 0 },
    { call_id: 'c8', purpose: 'mcp', timestamp: '2026-10-01T00:00:00Z', result_count: 0 },
  ];
  return { servedRows, accessRows, searchCallRows };
}

test('the probe\'s first-access MRR equals the canonical aggregator, on a fixture where naive ordering does not', () => {
  const rows = gateFixture();
  const canonical = aggregateInternalsRecords({
    servedRows: rows.servedRows.filter((row) => row.call_id && row.purpose === 'remember'),
    accessRows: rows.accessRows,
    searchCallRows: rows.searchCallRows.filter((row) => row.call_id && row.purpose === 'remember'),
    window: 'all',
    purpose: 'all',
  }).utility;
  const calls = [...buildCallTable({ ...rows, purposes: new Set(['remember']) }).values()];
  const mine = mrrOf(calls);
  assert.equal(mine.calls, canonical.calls);
  assert.equal(mine.ordered, canonical.orderedCalls);
  assert.ok(Math.abs(mine.mrr - canonical.firstAccessMrr) < 1e-12, `${mine.mrr} vs ${canonical.firstAccessMrr}`);
  assert.equal(mine.ordered, 5); // c1 c2 c3 c5 c6; c4 is undecidable
  assert.ok(Math.abs(mine.mrr - (1 / 3 + 1 / 4 + 1 / 3) / 5) < 1e-12);

  // Without this, the equality above could hold for an ordering that ignores
  // time and batch ordinals: the best accessed rank gives another number.
  const naive = calls.reduce((sum, call) => {
    const ranks = call.rows.filter((row) => row.accesses.length).map((row) => row.rank);
    return sum + (ranks.length ? 1 / Math.min(...ranks) : 0);
  }, 0) / calls.length;
  assert.notEqual(naive.toFixed(6), mine.mrr.toFixed(6));

  // Credit reaches only calls with no access row.
  const credited = mrrOf(calls, { credit: new Map([['c5', 2], ['c1', 1]]) });
  assert.equal(credited.credited, 1);
  assert.ok(Math.abs(credited.mrr - (1 / 3 + 1 / 4 + 1 / 3 + 1 / 2) / 5) < 1e-12);
});

test('runGate passes against hit-rate-report.js on the same snapshot, and fails when the probe reads other rows', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-abandonment-gate-'));
  try {
    const rows = gateFixture();
    const live = {};
    for (const [name, list] of [['served', rows.servedRows], ['access', rows.accessRows], ['searchCalls', rows.searchCallRows]]) {
      live[name] = path.join(dir, `${name}-live.jsonl`);
      fs.writeFileSync(live[name], `${list.map((row) => JSON.stringify(row)).join('\n')}\n`);
    }
    const snapshotDir = fs.mkdtempSync(path.join(dir, 'snap-'));
    const snapshot = snapshotTelemetry(live, snapshotDir);
    const pass = runGate(snapshot, rows);
    assert.equal(pass.gate.status, 'ok', JSON.stringify(pass.gate));
    assert.equal(pass.gate.checks[0].source_path, 'utility.firstAccessMrr');

    // Drop one access row from what the probe reads: the shipped number no longer comes back.
    const drifted = { ...rows, accessRows: rows.accessRows.slice(1) };
    const fail = runGate(snapshot, drifted);
    assert.equal(fail.gate.status, 'FAILED');
    // The snapshot is a copy: the live files are untouched.
    assert.equal(fs.readFileSync(live.access, 'utf8').trim().split('\n').length, rows.accessRows.length);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
