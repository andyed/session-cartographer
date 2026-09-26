// Recall telemetry in the Memory Desk: the served/access join, the window
// listing with its Unattributed group, and parity with the two other readers
// of the same logs (Internals and the session digest).
process.env.CARTOGRAPHER_SEMANTIC = '0';
for (const name of ['CARTOGRAPHER_SESSION_ID', 'CLAUDE_SESSION_ID', 'CLAUDE_CODE_SESSION_ID', 'CODEX_SESSION_ID']) delete process.env[name];

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const fixtureRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'carto-recall-')));
process.env.CARTOGRAPHER_DEV_DIR = fixtureRoot;
process.on('exit', () => fs.rmSync(fixtureRoot, { recursive: true, force: true }));

const { buildRecallIndex } = await import('../../scripts/recall-join.js');
const { createRecallSource, listRecallCalls, parseTurnId, qdrantPointId } = await import('../../explorer/server/memory-recall.js');
const { createMemoryHandler } = await import('../../explorer/server/memory.js');
const { aggregateInternalsRecords } = await import('../../explorer/server/internals-aggregate.js');

const now = Date.parse('2026-09-26T12:00:00Z');
const HOUR = 3600000;
const iso = (ms) => new Date(ms).toISOString();

// ── Fixture ──────────────────────────────────────────────────────────────
// call-a: attributed, 12 results, one repeated across ladders, deep use at 12.
// call-b: served with session "" (the 2026-09-26 majority case); one legacy
//         exact mark placed on it, one no_session mark that names no call.
// call-c: session "unknown", a sentinel that must not become a phantom session.
// call-z: zero results; exists only in the search-call log.
// call-old: attributed, three days old, outside a 24h window.
const served = [];
const serve = (call, rows, fields) => rows.forEach(([rank, eventId, source = 'changelog']) => served.push({
  timestamp: iso(fields.t), call_id: call, purpose: 'remember', provider: 'claude', backend: 'explorer', query: fields.query,
  session_id: fields.session, event_id: eventId, rank, source, project: 'alpha',
}));
serve('call-a', [
  [1, 'evt-a1'], [2, 'evt-a2'], [3, 'turn-sess-9-4', 'semantic'], [4, 'evt-a4'], [5, 'evt-a5'], [6, 'evt-a6'],
  [7, 'evt-a7'], [8, 'evt-a8'], [9, 'evt-a9'], [10, 'evt-a10'], [11, 'evt-a11'], [12, 'evt-a12'],
  [13, 'evt-a1', 'semantic'], // same event from a second ladder: one result, not two
], { t: now - 2 * HOUR, session: 'sess-1', query: 'turbo facts decision' });
serve('call-b', [[1, 'evt-b1'], [2, 'evt-b2']], { t: now - HOUR, session: '', query: 'unattributed recall' });
serve('call-c', [[1, 'evt-c1']], { t: now - HOUR / 2, session: 'unknown', query: 'sentinel session' });
serve('call-old', [[1, 'evt-a1']], { t: now - 72 * HOUR, session: 'sess-1', query: 'older question' });
served.forEach((row) => { if (row.call_id === 'call-b' || row.call_id === 'call-c') row.provider = 'unknown'; });
served.find((row) => row.call_id === 'call-old').purpose = 'focus';

const searchCalls = [
  { timestamp: iso(now - 90 * 60000), call_id: 'call-z', purpose: 'remember', session_id: 'sess-1', provider: 'claude', query: 'nothing matches', result_count: 0, selected_backend: 'explorer' },
];

const mark = (fields) => ({ timestamp: iso(now - 10 * 60000), timestamp_ms: now - 10 * 60000, purpose: 'remember', source: 'result_used', access_batch_id: 'touch-1', access_ordinal: 1, ...fields });
const access = [
  mark({ event_id: 'evt-a12', call_id: 'call-a', requested_call_id: 'call-a', session_id: 'sess-1', provider: 'claude', attribution_status: 'explicit' }),
  mark({ event_id: 'evt-a1', call_id: 'call-a', requested_call_id: 'call-a', session_id: 'sess-1', provider: 'claude', attribution_status: 'explicit', source: 'result_fetched' }),
  // Written before the writer recorded a status: exact, but unlabeled.
  mark({ event_id: 'evt-a2', call_id: 'call-a', session_id: 'sess-1' }),
  // The agent named call-a, but call-a never served this event.
  mark({ event_id: 'evt-never', requested_call_id: 'call-a', session_id: 'sess-1', attribution_status: 'invalid_call' }),
  // The agent named a call that does not exist at all.
  mark({ event_id: 'evt-x', requested_call_id: 'call-missing', session_id: 'sess-1', attribution_status: 'invalid_call' }),
  // Served by call-b, but the mark names no call: it must not be credited to call-b.
  mark({ event_id: 'evt-b1', session_id: '', provider: 'unknown', attribution_status: 'no_session' }),
  mark({ event_id: 'evt-b2', call_id: 'call-b', session_id: '' }),
];

const corpusEvents = [
  ...['a1', 'a2', 'a4', 'a5', 'a6', 'a8', 'a9', 'a10', 'a11', 'a12'].map((id, i) => ({
    event_id: `evt-${id}`, timestamp: iso(now - 30 * HOUR + i * 60000), session_id: i % 2 ? 'sess-3' : 'sess-2',
    session_title: i % 2 ? 'Tune the reranker' : 'Library facets', project: 'alpha', provider: i % 2 ? 'codex' : 'claude',
    type: 'git_commit', summary: `Commit for ${id}`,
  })),
  { event_id: 'evt-b1', timestamp: iso(now - 5 * HOUR), session_id: 'sess-2', project: 'alpha', type: 'tool_bash', summary: 'b1 work' },
  { event_id: 'evt-b2', timestamp: iso(now - 5 * HOUR), session_id: 'sess-2', project: 'alpha', type: 'tool_bash', summary: 'b2 work' },
  { event_id: 'evt-never', timestamp: iso(now - 6 * HOUR), session_id: 'sess-2', project: 'alpha', type: 'tool_bash', summary: 'marked but never served' },
  // sess-9 exists only as ordinary events; its transcript turn is not in the corpus.
  { event_id: 'sess-9-start', timestamp: iso(now - 50 * HOUR), session_id: 'sess-9', project: 'beta', provider: 'claude', type: 'tool_bash', summary: 'beta start' },
  { event_id: 'sess-9-end', timestamp: iso(now - 48 * HOUR), session_id: 'sess-9', project: 'beta', provider: 'claude', type: 'tool_bash', summary: 'beta end' },
  // sess-1's own activity, so the digest has a session to describe.
  { event_id: 'sess-1-work', timestamp: iso(now - 2 * HOUR), session_id: 'sess-1', project: 'alpha', provider: 'claude', type: 'tool_bash', summary: 'sess-1 work' },
];

const writeJsonl = (file, rows) => fs.writeFileSync(file, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
const paths = {
  served: path.join(fixtureRoot, 'served-log.jsonl'),
  access: path.join(fixtureRoot, 'access-ledger.jsonl'),
  searchCalls: path.join(fixtureRoot, 'search-calls.jsonl'),
  indexErrors: path.join(fixtureRoot, 'index-errors.jsonl'),
};
writeJsonl(paths.served, served);
writeJsonl(paths.access, access);
writeJsonl(paths.searchCalls, searchCalls);
writeJsonl(path.join(fixtureRoot, 'changelog.jsonl'), corpusEvents);

const index = buildRecallIndex({ servedRows: served, accessRows: access, searchCallRows: searchCalls });
const window24h = { from: now - 24 * HOUR, through: now };

function invoke(handler, url) {
  return new Promise((resolve, reject) => {
    let status;
    handler({ url, method: 'GET' }, {
      writeHead(code) { status = code; },
      end(raw) { resolve({ status, body: JSON.parse(raw) }); },
    }).then((handled) => { if (!handled) resolve({ handled: false }); }, reject);
  });
}
const handlerWith = (options = {}) => createMemoryHandler({ getEvents: () => corpusEvents, now: () => now, recallSource: createRecallSource({ paths }), ...options });

// ── The join ─────────────────────────────────────────────────────────────

test('a result is marked used only by an exact (call_id, event_id) result_used row', () => {
  const call = index.calls.get('call-a');
  assert.equal(call.served, 12, 'the repeated evt-a1 is one served result');
  assert.equal(call.used, 2);
  assert.deepEqual(call.used_ranks, [2, 12]);
  assert.equal(call.deepest_used_rank, 12, 'consumption at rank 12 stays visible as a tuning signal');
  assert.equal(call.fetched, 1, 'a --get fetch is reported, but not as a use');

  const byId = new Map(call.rows.map((row) => [row.event_id, row]));
  assert.equal(byId.get('evt-a12').used[0].attribution_status, 'explicit');
  assert.equal(byId.get('evt-a2').used[0].attribution_status, null, 'a pre-status mark is not relabelled');
  assert.equal(byId.get('evt-a1').used.length, 0);
  assert.equal(byId.get('evt-a1').fetched.length, 1);
});

test('marks that name no served pair are kept, never credited to a row', () => {
  const callA = index.calls.get('call-a');
  assert.deepEqual(callA.stray.map((m) => [m.event_id, m.attribution_status]), [['evt-never', 'invalid_call']]);
  assert.equal(callA.rows.some((row) => row.event_id === 'evt-never'), false);

  const callB = index.calls.get('call-b');
  const b1 = callB.rows.find((row) => row.event_id === 'evt-b1');
  assert.equal(b1.used.length, 0, 'a no_session mark on an event call-b served is not inferred onto call-b');
  assert.equal(callB.used, 1, 'the exact legacy mark on evt-b2 still places');

  assert.deepEqual(index.unplaced.map((m) => [m.event_id, m.attribution_status]).sort(), [['evt-b1', 'no_session'], ['evt-x', 'invalid_call']]);
});

// ── The window listing ───────────────────────────────────────────────────

test('the window lists every call, with no-session calls in an explicit unattributed count', () => {
  const listing = listRecallCalls({ index, coverage: {} }, window24h);

  // Independent count from the raw fixture, not from the module under test.
  const inWindow = (t) => t >= window24h.from && t <= window24h.through;
  const expected = new Set([...served, ...searchCalls].filter((row) => inWindow(Date.parse(row.timestamp))).map((row) => row.call_id));
  assert.deepEqual(listing.calls.map((c) => c.call_id).sort(), [...expected].sort());
  assert.equal(listing.totals.calls, expected.size);

  // The fixture must exercise the defect: if unattributed calls were dropped,
  // these counts would differ, so the assertions above would fail.
  const unattributedInFixture = listing.calls.filter((c) => c.session_id === null);
  assert.ok(unattributedInFixture.length >= 2, 'fixture must hold no-session calls in the window');
  assert.notEqual(listing.calls.filter((c) => c.session_id !== null).length, listing.totals.calls);

  assert.equal(listing.totals.unattributed, 2);
  assert.equal(listing.totals.attributed, 2);
  assert.equal(listing.totals.sessions, 1, '"unknown" is a sentinel, not a second session');
  assert.equal(listing.calls.some((c) => c.session_id === 'unknown'), false);
  assert.equal(listing.calls.find((c) => c.call_id === 'call-z').served, 0, 'zero-result calls stay listed');
  assert.deepEqual(listing.calls.map((c) => c.call_id), ['call-c', 'call-b', 'call-z', 'call-a'], 'newest first');
});

test('unplaced marks in the window are counted by status', () => {
  const listing = listRecallCalls({ index, coverage: {} }, window24h);
  assert.deepEqual(listing.unplaced.by_status, { invalid_call: 1, no_session: 1 });
  assert.equal(listing.totals.stray_marks, 1);
  assert.equal(listing.totals.used, 3);
});

test('a session request spans the whole session unless a window is given', () => {
  const all = listRecallCalls({ index, coverage: {} }, { session: 'sess-1' });
  assert.deepEqual(all.calls.map((c) => c.call_id), ['call-z', 'call-a', 'call-old']);
  const windowed = listRecallCalls({ index, coverage: {} }, { session: 'sess-1', ...window24h });
  assert.deepEqual(windowed.calls.map((c) => c.call_id), ['call-z', 'call-a']);
  assert.deepEqual(all.purposes, { remember: 2, focus: 1 });
  const focus = listRecallCalls({ index, coverage: {} }, { session: 'sess-1', purpose: 'focus' });
  assert.deepEqual(focus.calls.map((c) => c.call_id), ['call-old']);
});

// ── Parity with the other two readers ────────────────────────────────────

test('Internals counts the same calls and the same used results', () => {
  const internals = aggregateInternalsRecords({ servedRows: served, accessRows: access, searchCallRows: searchCalls, window: 'all', purpose: 'all', nowMs: now });
  assert.equal(internals.utility.calls, index.calls.size);
  const used = [...index.calls.values()].reduce((sum, call) => sum + call.used, 0);
  assert.equal(internals.utility.explicitUse.usedRows, used);
  assert.equal(internals.utility.explicitUse.callsWithUse, [...index.calls.values()].filter((call) => call.used > 0).length);
});

test('the session digest reports the same recall as the desk', () => {
  const env = { ...process.env, CARTOGRAPHER_DEV_DIR: fixtureRoot, CARTOGRAPHER_CHANGELOG: path.join(fixtureRoot, 'changelog.jsonl'),
    CARTOGRAPHER_SERVED_LOG: paths.served, CARTOGRAPHER_ACCESS_LEDGER: paths.access, CARTOGRAPHER_SEARCH_CALL_LOG: paths.searchCalls };
  const digest = JSON.parse(execFileSync(process.execPath, [path.join(root, 'scripts/session-digest.js'), '--session', 'sess-1', '--json', '--no-git'], { env, encoding: 'utf8' }));
  const desk = listRecallCalls({ index, coverage: {} }, { session: 'sess-1' });
  assert.deepEqual(
    { calls: digest.recall.calls, served: digest.recall.served, used: digest.recall.used },
    { calls: desk.totals.calls, served: desk.totals.served, used: desk.totals.used },
  );
  assert.deepEqual(digest.recall.used_event_ids.sort(), ['evt-a12', 'evt-a2']);
});

// ── Endpoints ────────────────────────────────────────────────────────────

test('/api/memory/recall returns the window with the unattributed group and resolved unplaced marks', async () => {
  const { status, body } = await invoke(handlerWith(), '/api/memory/recall');
  assert.equal(status, 200);
  assert.equal(body.totals.calls, 4);
  assert.equal(body.totals.unattributed, 2);
  const b1 = body.unplaced.marks.find((m) => m.event_id === 'evt-b1');
  assert.equal(b1.summary, 'b1 work');
  assert.equal(b1.attribution_status, 'no_session');
  assert.equal(b1.marked_by_session, null);
  assert.equal(b1.session_id, 'sess-2', 'the result\'s own episode, not the marker\'s');
});

test('/api/memory/recall/call joins ranked rows to the corpus and keeps unresolved ids', async () => {
  const { status, body } = await invoke(handlerWith(), '/api/memory/recall/call?call=call-a');
  assert.equal(status, 200);
  assert.equal(body.rows.length, 12);
  assert.deepEqual(body.rows.map((row) => row.rank), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);

  const byId = new Map(body.rows.map((row) => [row.event_id, row]));
  const a12 = byId.get('evt-a12');
  assert.equal(a12.resolution, 'corpus');
  assert.equal(a12.summary, 'Commit for a12');
  assert.equal(a12.session_id, 'sess-3');
  assert.equal(a12.session_title, 'Tune the reranker');
  assert.equal(a12.provider, 'codex');
  assert.equal(a12.used[0].attribution_status, 'explicit');
  assert.ok(a12.session_range.from <= a12.event_timestamp && a12.event_timestamp <= a12.session_range.through);

  const gone = byId.get('evt-a7');
  assert.ok(gone, 'an id the corpus no longer holds is listed');
  assert.equal(gone.resolution, null);
  assert.equal(gone.rank, 7);

  const turn = byId.get('turn-sess-9-4');
  assert.equal(turn.resolution, 'turn-id');
  assert.equal(turn.session_id, 'sess-9');
  assert.deepEqual(turn.session_range, { from: now - 50 * HOUR, through: now - 48 * HOUR }, 'the episode link bounds the session\'s whole life');

  assert.deepEqual(body.resolution, { corpus: 10, index: 0, turn_id: 1, unresolved: 1, index_status: 'disabled' });
  assert.deepEqual(body.stray_marks.map((m) => [m.event_id, m.attribution_status, m.marked_by_session, m.summary]),
    [['evt-never', 'invalid_call', 'sess-1', 'marked but never served']]);
});

test('ids missing from the corpus resolve from the semantic index, guarded against point-id collisions', async () => {
  const lookups = [];
  const lookupIndexed = async (ids) => {
    lookups.push(ids);
    return { status: 'available', events: [
      { event_id: 'turn-sess-9-4', timestamp: iso(now - 49 * HOUR), session: 'sess-9', project: 'beta', summary: 'Turn text from the index' },
    ] };
  };
  const { body } = await invoke(handlerWith({ lookupIndexed }), '/api/memory/recall/call?call=call-a');
  assert.deepEqual(lookups, [['turn-sess-9-4', 'evt-a7']], 'only ids the corpus lacks are looked up');
  const turn = body.rows.find((row) => row.event_id === 'turn-sess-9-4');
  assert.equal(turn.resolution, 'index');
  assert.equal(turn.summary, 'Turn text from the index');
  assert.equal(turn.session_id, 'sess-9');
  assert.equal(body.rows.find((row) => row.event_id === 'evt-a7').resolution, null);
});

test('recall endpoints validate input and write nothing', async () => {
  const before = [paths.served, paths.access, paths.searchCalls].map((file) => fs.statSync(file)).map((s) => [s.size, s.mtimeMs]);
  const handler = handlerWith();
  assert.equal((await invoke(handler, '/api/memory/recall/call?call=call-nope')).status, 404);
  assert.equal((await invoke(handler, '/api/memory/recall/call?call=a%20b')).status, 400);
  assert.equal((await invoke(handler, '/api/memory/recall/call')).status, 400);
  assert.equal((await invoke(handler, '/api/memory/recall?session=bad%20id')).status, 400);
  assert.equal((await invoke(handler, `/api/memory/recall?from=${iso(now - 91 * 24 * HOUR)}&through=${iso(now)}`)).status, 422);
  assert.equal((await invoke(handler, '/api/memory/recall?purpose=(none)')).status, 200);
  assert.equal((await invoke(handler, '/api/memory/recall?limit=0')).status, 400);
  const limited = await invoke(handler, '/api/memory/recall?limit=1');
  assert.equal(limited.body.calls.length, 1);
  assert.equal(limited.body.truncated, 3, 'a truncated listing says how many calls it left out');
  const after = [paths.served, paths.access, paths.searchCalls].map((file) => fs.statSync(file)).map((s) => [s.size, s.mtimeMs]);
  assert.deepEqual(after, before);
});

test('turn ids name their session; point ids match the indexer', () => {
  assert.deepEqual(parseTurnId('turn-0559fb36-eb75-4d12-8326-a0a1069831e6-30'), { provider: 'claude', session_id: '0559fb36-eb75-4d12-8326-a0a1069831e6', turn: 30 });
  assert.deepEqual(parseTurnId('turn-codex-019ffe93-f554-71b0-bacc-2043577e8f67-32'), { provider: 'codex', session_id: '019ffe93-f554-71b0-bacc-2043577e8f67', turn: 32 });
  assert.equal(parseTurnId('evt-abc'), null);
  // index-event.sh's cartographer_point_id, spelled in shell.
  const id = 'turn-0559fb36-eb75-4d12-8326-a0a1069831e6-30';
  const hex = execFileSync('/bin/sh', ['-c', `printf '%s' "$1" | shasum -a 256 2>/dev/null || printf '%s' "$1" | sha256sum`, 'sh', id], { encoding: 'utf8' }).slice(0, 13);
  assert.equal(qdrantPointId(id), parseInt(hex, 16));
});
