// Recall calls recorded without a session (Codex gives an MCP child none),
// attributed at read time from the Codex rollout that minted their call id.
// The record is never changed: session_id, used and fetched stay what the
// logs say, and the transcript's answer is reported beside them.
process.env.CARTOGRAPHER_SEMANTIC = '0';
for (const name of ['CARTOGRAPHER_SESSION_ID', 'CLAUDE_SESSION_ID', 'CLAUDE_CODE_SESSION_ID', 'CODEX_SESSION_ID']) delete process.env[name];

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

const fixtureRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'carto-call-evidence-')));
process.env.CARTOGRAPHER_DEV_DIR = fixtureRoot;
process.on('exit', () => fs.rmSync(fixtureRoot, { recursive: true, force: true }));

const { buildRecallIndex, sessionRecallSummary } = await import('../../scripts/recall-join.js');
const { canReadZstd, foldCallEvidence, listCodexRollouts, rolloutLineEvidence, scanRollout } = await import('../../scripts/codex-call-evidence.js');
const { createRecallSource, listRecallCalls, loadRecall } = await import('../../explorer/server/memory-recall.js');
const { createCallEvidenceSource } = await import('../../explorer/server/call-evidence.js');
const { createMemoryHandler } = await import('../../explorer/server/memory.js');

const now = Date.parse('2026-09-26T12:00:00Z');
const HOUR = 3600000;
const iso = (ms) => new Date(ms).toISOString();

const A = '01a00000-aaaa-7000-8000-00000000000a'; // the session that made the calls
const B = '01a00000-bbbb-7000-8000-00000000000b'; // its subagent: inherits A's call ids
const C = '01a00000-cccc-7000-8000-00000000000c'; // carries a copy of another thread's history

// ── Rollouts ─────────────────────────────────────────────────────────────
// The shapes are the ones Codex Desktop 0.163–0.167 writes: one event_msg /
// item_completed row per MCP tool call, arguments and result text included.
let ordinal = 0;
const toolRow = (thread, tool, args, text) => JSON.stringify({
  timestamp: iso(now - HOUR), ordinal: ordinal++, type: 'event_msg',
  payload: { type: 'item_completed', thread_id: thread, turn_id: 'turn-1',
    item: { type: 'McpToolCall', id: `exec-${ordinal}`, server: 'cartographer', tool, status: 'completed', arguments: args, result: { content: [{ type: 'text', text }] } } },
});
const recall = (thread, query, callId) => toolRow(thread, 'recall', { query, limit: 5 },
  `recall "${query}" — 2 results · call_id ${callId} · turbo 200 ms · semantic available\nsources: keyword 2 · semantic 0 · both 0\n 1. …`);
const get = (thread, callId, ids) => toolRow(thread, 'get', { event_ids: ids, call_id: callId }, `get — ${ids.length} fetched, 0 missing · call_id ${callId}\n\n…`);
const markUsed = (thread, callId, ids) => toolRow(thread, 'mark_used', { event_ids: ids, call_id: callId }, `mark_used — ${ids.length} of ${ids.length} recorded · call_id ${callId} · purpose mcp`);
// An agent message that quotes a call id. Text is not evidence.
const chatter = (text) => JSON.stringify({ timestamp: iso(now - HOUR), ordinal: ordinal++, type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] } });
const meta = (id) => JSON.stringify({ timestamp: iso(now - 2 * HOUR), ordinal: ordinal++, type: 'session_meta', payload: { id, session_id: id, originator: 'Codex Desktop' } });

const sessionsDir = path.join(fixtureRoot, 'codex-sessions');
const archivedDir = path.join(fixtureRoot, 'codex-archived');
const rolloutPath = (dir, id, extension = '.jsonl') => path.join(dir, `rollout-2026-09-26T03-00-00-${id}${extension}`);
const rolloutA = rolloutPath(path.join(sessionsDir, '2026', '09', '26'), A);
// Codex compresses a rollout in place after about a week. Where this Node
// cannot write zstd the fixture stays plain and the compressed case is skipped.
const rolloutB = rolloutPath(archivedDir, B, canReadZstd ? '.jsonl.zst' : '.jsonl');
const rolloutC = rolloutPath(archivedDir, C);
const writeRollout = (file, lines) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = lines.join('\n') + '\n';
  fs.writeFileSync(file, file.endsWith('.zst') ? zlib.zstdCompressSync(Buffer.from(body)) : body);
};
writeRollout(rolloutA, [
  meta(A),
  recall(A, 'reel renderer', 'call-mcp-1'),
  get(A, 'call-mcp-1', ['evt-1']),
  markUsed(A, 'call-mcp-1', ['evt-2', 'evt-never']),
  // A query that quotes another call's id in the header's own format: the id
  // in the arguments was supplied, and only call-mcp-2 was minted.
  recall(A, 'who made · call_id call-mcp-3', 'call-mcp-2'),
  chatter('call-mcp-none, call-mcp-dup and call-recorded all appear here as text'),
  recall(A, 'already attributed', 'call-recorded'),
  'not json: the unfinished last line of a live rollout {"type":"event_msg","payload":{"item":{"type":"McpToolCall"',
]);
writeRollout(rolloutB, [
  meta(B),
  recall(B, 'subagent question', 'call-mcp-3'),
  markUsed(B, 'call-mcp-1', ['evt-3']), // it knows its parent's call id
  recall(B, 'copied question', 'call-mcp-dup'),
]);
writeRollout(rolloutC, [
  meta(C),
  recall(C, 'copied question', 'call-mcp-dup'), // the same mint in a second rollout
  recall(A, 'history of another thread', 'call-mcp-foreign'), // thread_id is not this rollout's
]);
const codexEnv = { CARTOGRAPHER_CODEX_TRANSCRIPTS_DIR: sessionsDir, CARTOGRAPHER_CODEX_ARCHIVED_DIR: archivedDir };
const listFixture = () => listCodexRollouts({ env: codexEnv, home: fixtureRoot });

// ── Telemetry, as cartographer-search.sh writes it for a sessionless caller ──
const served = [];
const serve = (callId, eventIds, fields = {}) => eventIds.forEach((eventId, i) => served.push({
  timestamp: iso(now - HOUR), call_id: callId, purpose: 'mcp', session_id: '', provider: 'codex', attribution_status: 'no_session', session_source: '',
  query: `query of ${callId}`, event_id: eventId, rank: i + 1, source: 'changelog', project: 'alpha', backend: 'explorer', ...fields,
}));
serve('call-mcp-1', ['evt-1', 'evt-2', 'evt-3']);
serve('call-mcp-2', ['evt-4']);
serve('call-mcp-3', ['evt-5']);
serve('call-mcp-dup', ['evt-6']);
serve('call-mcp-foreign', ['evt-7']);
serve('call-mcp-none', ['evt-8']);
// Codex shell calls do carry a session; so does a recorded call the rollout happens to mint.
serve('call-shell', ['evt-1'], { purpose: 'remember', session_id: A, attribution_status: 'session', session_source: 'CODEX_SESSION_ID' });
serve('call-recorded', ['evt-9'], { session_id: 'sess-recorded', attribution_status: 'session', session_source: 'CARTOGRAPHER_SESSION_ID' });

const noSessionMark = (source, callId, eventId) => ({
  event_id: eventId, timestamp: iso(now - 30 * 60000), timestamp_ms: now - 30 * 60000, session_id: '', provider: 'codex', session_source: '',
  purpose: 'mcp', source, access_batch_id: 'touch-1', access_ordinal: 1, attribution_status: 'no_session', requested_call_id: callId,
});
const access = [
  noSessionMark('result_fetched', 'call-mcp-1', 'evt-1'), // A's rollout: get
  noSessionMark('result_used', 'call-mcp-1', 'evt-2'), // A's rollout: mark_used
  noSessionMark('result_used', 'call-mcp-1', 'evt-3'), // only B's rollout names this pair
  noSessionMark('result_used', 'call-mcp-1', 'evt-never'), // named by A, never served by the call
  noSessionMark('result_used', 'call-mcp-none', 'evt-8'), // its call has no evidence at all
  { event_id: 'evt-1', timestamp: iso(now - 20 * 60000), timestamp_ms: now - 20 * 60000, session_id: A, provider: 'codex', purpose: 'remember', source: 'result_used', call_id: 'call-shell', requested_call_id: 'call-shell', attribution_status: 'explicit' },
];

const writeJsonl = (file, rows) => fs.writeFileSync(file, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
const paths = {
  served: path.join(fixtureRoot, 'served-log.jsonl'),
  access: path.join(fixtureRoot, 'access-ledger.jsonl'),
  searchCalls: path.join(fixtureRoot, 'search-calls.jsonl'),
};
writeJsonl(paths.served, served);
writeJsonl(paths.access, access);
writeJsonl(paths.searchCalls, []);
const logs = { servedRows: served, accessRows: access, searchCallRows: [] };

const scanInProcess = (rollouts) => Promise.all(rollouts.map((rollout) => scanRollout(rollout.file)));
const fixtureEvidence = async () => foldCallEvidence(await scanInProcess(listFixture()));

function invoke(handler, url) {
  return new Promise((resolve, reject) => {
    let status;
    handler({ url, method: 'GET' }, {
      writeHead(code) { status = code; },
      end(raw) { resolve({ status, body: JSON.parse(raw) }); },
    }).then((handled) => { if (!handled) resolve({ handled: false }); }, reject);
  });
}
const handlerWith = (options = {}) => createMemoryHandler({ getEvents: () => [], now: () => now, recallSource: createRecallSource({ paths }), ...options });
const day = `from=${encodeURIComponent(iso(now - 24 * HOUR))}&through=${encodeURIComponent(iso(now))}`;

// ── Control: the record alone ────────────────────────────────────────────

test('control: without transcript evidence the MCP calls belong to no session and their marks are stray', async () => {
  const index = buildRecallIndex(logs);
  for (const id of ['call-mcp-1', 'call-mcp-2', 'call-mcp-3']) {
    assert.equal(index.calls.get(id).session_id, null);
    assert.equal(index.calls.get(id).derived_session_id, null);
  }
  assert.equal(index.calls.get('call-mcp-1').stray_marks, 3, 'every use mark on the call is stray');
  assert.equal(index.calls.get('call-mcp-1').derived_used, 0);

  // The handler as it was wired before: no evidence source.
  const { body } = await invoke(handlerWith(), `/api/memory/recall?session=${A}`);
  assert.deepEqual(body.calls.map((call) => call.call_id), ['call-shell'], 'the session shows only its shell call');
  assert.equal(body.transcript_attribution.status, 'off');
  const window = (await invoke(handlerWith(), `/api/memory/recall?${day}`)).body;
  assert.equal(window.totals.unattributed, 6);
  assert.equal(window.totals.derived, 0);
});

// ── What a rollout row proves ────────────────────────────────────────────

test('a mint is an id the server printed and the arguments did not supply; an echo or a quote is not', () => {
  assert.deepEqual(rolloutLineEvidence(recall(A, 'q', 'call-x')), { threadId: A, minted: 'call-x', named: [] });
  const fetched = rolloutLineEvidence(get(A, 'call-x', ['evt-1', 'evt-2']));
  assert.equal(fetched.minted, null, 'get echoes the call_id it was handed');
  assert.deepEqual(fetched.named, [['call-x', 'evt-1', 'result_fetched'], ['call-x', 'evt-2', 'result_fetched']]);
  assert.deepEqual(rolloutLineEvidence(markUsed(A, 'call-x', ['evt-1'])).named, [['call-x', 'evt-1', 'result_used']]);
  assert.equal(rolloutLineEvidence(recall(A, 'who made · call_id call-other', 'call-x')).minted, 'call-x');
  assert.equal(rolloutLineEvidence(chatter('I ran McpToolCall and got · call_id call-x')), null);
  assert.equal(rolloutLineEvidence('{"type":"event_msg","payload":{"item":{"type":"McpToolCall"'), null);
});

test('a rollout is scanned whole, compressed or not, and rows of another thread are counted, not believed', async () => {
  const a = await scanRollout(rolloutA);
  assert.equal(a.session_id, A);
  assert.deepEqual(a.minted, ['call-mcp-1', 'call-mcp-2', 'call-recorded']);
  assert.deepEqual(a.named, [['call-mcp-1', 'evt-1', 'result_fetched'], ['call-mcp-1', 'evt-2', 'result_used'], ['call-mcp-1', 'evt-never', 'result_used']]);

  const b = await scanRollout(rolloutB);
  assert.equal(b.readable, true);
  assert.deepEqual(b.minted, ['call-mcp-3', 'call-mcp-dup'], canReadZstd ? 'read through zstd' : 'read plain');

  const c = await scanRollout(rolloutC);
  assert.deepEqual(c.minted, ['call-mcp-dup']);
  assert.equal(c.foreign_rows, 1, 'the row naming thread A is not C\'s own');
});

test('a compressed rollout that cannot be read is reported, never skipped', { skip: !canReadZstd && 'this Node has no zlib zstd' }, async () => {
  const broken = rolloutPath(path.join(fixtureRoot, 'elsewhere'), 'broken', '.jsonl.zst');
  fs.mkdirSync(path.dirname(broken), { recursive: true });
  fs.writeFileSync(broken, 'this is not a zstd frame');
  const scan = await scanRollout(broken);
  assert.equal(scan.readable, false);
  assert.deepEqual(scan.minted, []);
  assert.equal(foldCallEvidence([scan]).unreadable.length, 1);
});

test('only rollouts written at or after the call are listed', () => {
  assert.deepEqual(listFixture().map((rollout) => rollout.session_id).sort(), [A, B, C]);
  const old = new Date(now - 30 * 24 * HOUR);
  const before = fs.statSync(rolloutC);
  fs.utimesSync(rolloutC, old, old);
  try {
    assert.deepEqual(listCodexRollouts({ env: codexEnv, home: fixtureRoot, since: now - HOUR }).map((rollout) => rollout.session_id).sort(), [A, B]);
  } finally {
    fs.utimesSync(rolloutC, before.atime, before.mtime);
  }
});

// ── The join ─────────────────────────────────────────────────────────────

test('a call minted in exactly one rollout gets that session, beside the record', async () => {
  const index = buildRecallIndex({ ...logs, callEvidence: await fixtureEvidence() });
  const session = (id) => [index.calls.get(id).session_id, index.calls.get(id).derived_session_id];
  assert.deepEqual(session('call-mcp-1'), [null, A]);
  assert.deepEqual(session('call-mcp-2'), [null, A]);
  assert.deepEqual(session('call-mcp-3'), [null, B], 'minted by the subagent, though A\'s query quotes it');
  assert.equal(index.calls.get('call-mcp-1').session_derivation, 'codex_rollout');
});

test('a call minted in several rollouts, or in none, stays unattributed and is counted', async () => {
  const source = createRecallSource({ paths });
  const listing = listRecallCalls({ ...source({ evidence: await fixtureEvidence() }), transcript_attribution: { status: 'complete' } }, { from: now - 24 * HOUR, through: now });
  const byId = new Map(listing.calls.map((call) => [call.call_id, call]));
  for (const id of ['call-mcp-dup', 'call-mcp-none', 'call-mcp-foreign']) {
    assert.equal(byId.get(id).session_id, null);
    assert.equal(byId.get(id).derived_session_id, null, id);
  }
  assert.equal(listing.totals.calls, 8);
  assert.equal(listing.totals.attributed, 2);
  assert.equal(listing.totals.derived, 3);
  assert.equal(listing.totals.unattributed, 3);
  assert.equal(listing.totals.derivation_conflicts, 1, 'call-mcp-dup');
  assert.equal(listing.totals.sessions, 3, 'A, B and the recorded session');
});

test('a recorded session is never replaced by a transcript', async () => {
  const call = buildRecallIndex({ ...logs, callEvidence: await fixtureEvidence() }).calls.get('call-recorded');
  assert.equal(call.session_id, 'sess-recorded');
  assert.equal(call.derived_session_id, null, 'A\'s rollout mints it, and the record still wins');
});

test('a no_session mark joins its call when the call\'s own session named that result', async () => {
  const index = buildRecallIndex({ ...logs, callEvidence: await fixtureEvidence() });
  const call = index.calls.get('call-mcp-1');
  const row = (eventId) => call.rows.find((result) => result.event_id === eventId);
  assert.equal(row('evt-2').derived_used.length, 1);
  assert.equal(row('evt-2').derived_used[0].derived_session_id, A);
  assert.equal(row('evt-2').derived_used[0].attribution_status, 'no_session', 'the mark keeps what the writer recorded');
  assert.equal(row('evt-1').derived_fetched.length, 1);
  assert.deepEqual([call.derived_used, call.derived_fetched], [1, 1]);

  // Stray, as before: marked only by the subagent, and marked for a result the call never served.
  assert.deepEqual(call.stray.map((mark) => mark.event_id).sort(), ['evt-3', 'evt-never']);
  assert.equal(row('evt-3').derived_used.length, 0);
  // A call with no session keeps its marks stray.
  assert.equal(index.calls.get('call-mcp-none').stray_marks, 1);
});

test('exact counts do not move: the digest and Internals read the same record', async () => {
  const recorded = buildRecallIndex(logs);
  const derived = buildRecallIndex({ ...logs, callEvidence: await fixtureEvidence() });
  for (const [id, call] of recorded.calls) {
    const other = derived.calls.get(id);
    assert.deepEqual([other.session_id, other.served, other.used, other.fetched], [call.session_id, call.served, call.used, call.fetched], id);
  }
  assert.deepEqual(sessionRecallSummary(derived, A), sessionRecallSummary(recorded, A));
  assert.deepEqual(sessionRecallSummary(derived, A), { calls: 1, served: 1, used: 1, used_event_ids: ['evt-1'] });
});

// ── The desk ─────────────────────────────────────────────────────────────

test('/api/memory/recall shows a session its MCP calls, read on worker threads', async () => {
  // The default scan: real workers, the real worker module.
  const handler = handlerWith({ callEvidence: createCallEvidenceSource({ list: listFixture }) });
  const { status, body } = await invoke(handler, `/api/memory/recall?session=${A}`);
  assert.equal(status, 200);
  assert.deepEqual(body.calls.map((call) => call.call_id).sort(), ['call-mcp-1', 'call-mcp-2', 'call-shell']);
  assert.equal(body.transcript_attribution.status, 'complete');
  assert.equal(body.transcript_attribution.rollouts, 3);
  assert.deepEqual([body.totals.attributed, body.totals.derived, body.totals.unattributed], [1, 2, 0]);
  assert.deepEqual([body.totals.used, body.totals.derived_used, body.totals.derived_fetched, body.totals.stray_marks], [1, 1, 1, 2]);
  const call = body.calls.find((entry) => entry.call_id === 'call-mcp-1');
  assert.deepEqual([call.session_id, call.derived_session_id, call.session_derivation], [null, A, 'codex_rollout']);

  const detail = (await invoke(handler, '/api/memory/recall/call?call=call-mcp-1')).body;
  assert.equal(detail.call.derived_session_id, A);
  assert.equal(detail.rows.find((row) => row.event_id === 'evt-2').derived_used.length, 1);
  assert.deepEqual(detail.stray_marks.map((mark) => mark.event_id).sort(), ['evt-3', 'evt-never']);

  const window = (await invoke(handler, `/api/memory/recall?${day}`)).body;
  assert.deepEqual([window.totals.attributed, window.totals.derived, window.totals.unattributed], [2, 3, 3]);
});

test('a window of attributed calls, and a session that is not a Codex rollout, read no rollout', async () => {
  let scans = 0;
  const evidence = createCallEvidenceSource({ list: listFixture, scan: (rollouts) => { scans++; return scanInProcess(rollouts); } });
  const source = createRecallSource({ paths: { ...paths, served: path.join(fixtureRoot, 'attributed-only.jsonl') } });
  writeJsonl(path.join(fixtureRoot, 'attributed-only.jsonl'), served.filter((row) => row.session_id));
  assert.equal((await loadRecall(source, evidence, { from: now - 24 * HOUR, through: now })).transcript_attribution.status, 'not-needed');
  assert.equal((await loadRecall(createRecallSource({ paths }), evidence, { session: 'sess-recorded' })).transcript_attribution.status, 'not-needed');
  assert.equal(scans, 0);
});

test('a scan that outlasts the budget attributes nothing until it lands', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const evidence = createCallEvidenceSource({ list: listFixture, budgetMs: 25, scan: async (rollouts) => { await gate; return scanInProcess(rollouts); } });
  const source = createRecallSource({ paths });
  const scope = { from: now - 24 * HOUR, through: now };

  const early = await loadRecall(source, evidence, scope);
  assert.equal(early.transcript_attribution.status, 'scanning');
  assert.equal(early.transcript_attribution.pending, 3);
  assert.equal(listRecallCalls(early, scope).totals.derived, 0, 'a partial scan cannot prove "exactly one"');

  release();
  await new Promise((resolve) => setTimeout(resolve, 50));
  const late = await loadRecall(source, evidence, scope);
  assert.equal(late.transcript_attribution.status, 'complete');
  assert.equal(listRecallCalls(late, scope).totals.derived, 3);
});

test('reading transcripts writes nothing', async () => {
  const files = [paths.served, paths.access, paths.searchCalls, rolloutA, rolloutB, rolloutC];
  const snapshot = () => files.map((file) => fs.readFileSync(file).toString('base64'));
  const before = snapshot();
  const entries = fs.readdirSync(fixtureRoot).sort();
  const handler = handlerWith({ callEvidence: createCallEvidenceSource({ list: listFixture, scan: scanInProcess }) });
  await invoke(handler, `/api/memory/recall?session=${A}`);
  await invoke(handler, `/api/memory/recall?${day}`);
  assert.deepEqual(snapshot(), before);
  assert.deepEqual(fs.readdirSync(fixtureRoot).sort(), entries);
});
