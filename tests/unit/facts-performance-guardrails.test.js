// The facts verbs are folds, not indexes, and docs/FACTS.md justifies that with
// a measurement: a full linear pass over 127k resident events costs 12-22 ms,
// under 2% of Turbo's 1500 ms request budget. Until now that claim had no
// regression guard (FACTS.md listed it as "not yet a regression test"), so a
// change that made a fold quadratic — a findIndex inside the loop, a per-event
// registry expansion — would ship unnoticed and only surface as a slow pulse.
//
// The bound is deliberately loose (10x a slow CI runner's expected cost) so the
// test fails on a complexity regression, not on a busy machine. The composition
// assertion beside it is the one that matters: the count must equal what an
// independent scan of the same rows says, or a fast wrong fold passes.
//
// Hermetic per docs/TESTING.md: the session-id chain is cleared, DEV_DIR is a
// temp directory set before jsonl.js is imported, and the semantic leg is off.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

for (const name of ['CARTOGRAPHER_SESSION_ID', 'CLAUDE_SESSION_ID', 'CLAUDE_CODE_SESSION_ID', 'CODEX_SESSION_ID']) {
  delete process.env[name];
}
process.env.CARTOGRAPHER_SEMANTIC = '0';
const FIXTURE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-facts-perf-'));
process.env.CARTOGRAPHER_DEV_DIR = FIXTURE_DIR;
process.on('exit', () => { try { fs.rmSync(FIXTURE_DIR, { recursive: true, force: true }); } catch {} });

const { executeFacts } = await import('../../explorer/server/facts.js');
const { readAllEvents, LOG_FILES } = await import('../../explorer/server/jsonl.js');
const { buildIndex } = await import('../../explorer/server/bm25.js');

const COUNT = 40_000;
const DAY = 86_400_000;
const now = Date.now();
const projects = ['alpha', 'beta', 'gamma', 'delta-repo', 'epsilon'];
let inWindow = 0;
const rows = Array.from({ length: COUNT }, (_, i) => {
  // Every 100th row lands in the last 24h; the rest spread over a year.
  const recent = i % 100 === 0;
  if (recent) inWindow++;
  const ts = recent ? now - (i % 97) * 60_000 : now - DAY - (i % 365) * DAY - (i % 1000) * 1000;
  return {
    event_id: `evt-${i}`,
    timestamp: new Date(ts).toISOString(),
    type: i % 7 === 0 ? 'commit' : 'tool_file_edit',
    provider: i % 3 === 0 ? 'codex' : 'claude',
    project: projects[i % projects.length],
    session_id: `sess-${i % 4000}`,
    summary: `fold fixture row ${i} token${i % 500}`,
  };
});
fs.writeFileSync(LOG_FILES.changelog, `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`);
for (const key of ['research', 'milestones', 'tool-use', 'prompts']) fs.writeFileSync(LOG_FILES[key], '');

const events = readAllEvents();
const index = buildIndex(events);
const ctx = { events, index };
const opts = { corpusRoot: FIXTURE_DIR, logFiles: LOG_FILES };
const BUDGET_MS = 1500; // CARTOGRAPHER_TURBO_TIMEOUT_MS default
const BOUND_MS = 400;   // ~10x the expected cost of a 40k fold on a slow runner

test('a 24h census is a linear fold that stays far inside the Turbo budget', () => {
  const since = new Date(now - DAY).toISOString();
  const started = performance.now();
  const response = executeFacts(ctx, { contract_version: 1, verb: 'census', call_id: 'guard-census', since }, opts);
  const elapsed = performance.now() - started;

  assert.equal(response.facts.events, inWindow, 'census must count exactly the rows an independent scan puts in the window');
  assert.equal(response.facts.windowed_out, COUNT - inWindow);
  assert.ok(elapsed < BOUND_MS, `24h census over ${COUNT} events took ${elapsed.toFixed(1)} ms (bound ${BOUND_MS} ms, budget ${BUDGET_MS} ms)`);
});

test('tempo and a whole-corpus census fold every event within the same bound', () => {
  const started = performance.now();
  const tempo = executeFacts(ctx, { contract_version: 1, verb: 'tempo', call_id: 'guard-tempo' }, opts);
  const census = executeFacts(ctx, { contract_version: 1, verb: 'census', call_id: 'guard-census-all' }, opts);
  const elapsed = performance.now() - started;

  assert.equal(census.facts.events, COUNT);
  assert.equal(census.corpus_events, COUNT);
  assert.equal(tempo.facts.projects_total, projects.length, 'one tempo series per project');
  assert.equal(tempo.facts.projects.reduce((sum, s) => sum + s.total, 0), COUNT, 'tempo totals must reconcile to the corpus');
  assert.ok(elapsed < 2 * BOUND_MS, `tempo + full census over ${COUNT} events took ${elapsed.toFixed(1)} ms (bound ${2 * BOUND_MS} ms)`);
});

test('a delta resume reads only the appended tail, not the whole corpus', () => {
  const baseline = executeFacts(ctx, { contract_version: 1, verb: 'delta', call_id: 'guard-delta-0' }, opts);
  assert.deepEqual(baseline.facts.events, []);

  const appended = Array.from({ length: 25 }, (_, i) => JSON.stringify({
    event_id: `evt-appended-${i}`, timestamp: new Date().toISOString(), type: 'milestone',
    provider: 'claude', project: 'alpha', session_id: 'sess-append', summary: `appended ${i}`,
  }));
  fs.appendFileSync(LOG_FILES.milestones, `${appended.join('\n')}\n`);

  const started = performance.now();
  const resumed = executeFacts(ctx, { contract_version: 1, verb: 'delta', call_id: 'guard-delta-1', cursor: baseline.facts.cursor }, opts);
  const elapsed = performance.now() - started;

  assert.equal(resumed.facts.returned, 25, 'the cursor must report exactly the appended rows');
  assert.equal(resumed.facts.read, 25, 'a resume must read the tail only — reading the whole corpus means the cursor is a timestamp in disguise');
  assert.ok(elapsed < BOUND_MS, `delta resume took ${elapsed.toFixed(1)} ms (bound ${BOUND_MS} ms)`);
});

test('utcDay returns the same string as toISOString for every day it is asked about', async () => {
  const { utcDay } = await import('../../explorer/server/event-time.js');
  const reference = (ms) => new Date(ms).toISOString().slice(0, 10);
  const probes = [0, -1, -DAY, DAY - 1, DAY, now, now - 400 * DAY, Date.UTC(2024, 1, 29, 23, 59, 59, 999),
    Date.UTC(2024, 2, 1), Date.UTC(1999, 11, 31, 23, 59, 59, 999), Date.UTC(2000, 0, 1)];
  for (let i = 0; i < 5000; i++) probes.push(now - Math.floor(i * 1234567.89));
  for (const ms of probes) assert.equal(utcDay(ms), reference(ms), `utcDay(${ms})`);
});
