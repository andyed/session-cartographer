import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../..');
const SEARCH = path.join(ROOT, 'scripts/cartographer-search.sh');
const CLIENT = path.join(ROOT, 'scripts/turbo-search-client.js');
const SID = 'attribution-fixture-session';
const PURPOSE = 'remember';
const writeRows = (file, rows) => fs.writeFileSync(file, rows.map(JSON.stringify).join('\n') + '\n');
const readRows = (file) => fs.existsSync(file)
  ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(JSON.parse) : [];
const served = (call_id, event_id = 'evt-ack', extra = {}) => ({
  call_id, event_id, session_id: SID, purpose: PURPOSE,
  timestamp: '2026-09-07T00:00:00Z', rank: 1, ...extra,
});

function fixture(t, serves = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-origin-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const servedLog = path.join(dir, 'served.jsonl');
  const ledger = path.join(dir, 'access.jsonl');
  const callLog = path.join(dir, 'calls.jsonl');
  writeRows(servedLog, serves);
  writeRows(path.join(dir, 'changelog.jsonl'), [
    { event_id: 'evt-ack', timestamp: '2026-09-06T00:00:00Z', project: 'fixture', summary: 'gestureack original handshake' },
    { event_id: 'evt-other', timestamp: '2026-09-05T00:00:00Z', project: 'fixture', summary: 'gestureack later fix' },
    ...Array.from({ length: 8 }, (_, i) => ({
      event_id: `evt-filler-${i}`, timestamp: '2026-09-05T00:00:00Z',
      project: 'fixture', summary: `unrelated routine filler ${i}`,
    })),
  ]);
  const env = {
    ...process.env,
    CARTOGRAPHER_DEV_DIR: dir,
    CARTOGRAPHER_SERVED_LOG: servedLog,
    CARTOGRAPHER_ACCESS_LEDGER: ledger,
    CARTOGRAPHER_SEARCH_CALL_LOG: callLog,
    CARTOGRAPHER_SESSION_ID: SID,
    CARTOGRAPHER_PURPOSE: PURPOSE,
    CARTOGRAPHER_TURBO: '0',
    CARTOGRAPHER_QDRANT_URL: 'http://127.0.0.1:1',
    CARTOGRAPHER_EMBED_URL: 'http://127.0.0.1:1',
    CARTOGRAPHER_CLAUDE_TRANSCRIPTS_DIR: path.join(dir, 'no-transcripts'),
    CARTOGRAPHER_CODEX_TRANSCRIPTS_DIR: path.join(dir, 'no-transcripts'),
    CARTOGRAPHER_CODEX_ARCHIVED_DIR: path.join(dir, 'no-transcripts'),
    TMPDIR_BASE: dir,
    CLAUDE_SESSION_ID: '', CLAUDE_CODE_SESSION_ID: '', CODEX_SESSION_ID: '',
  };
  function run(args, overrides = {}) {
    const result = spawnSync('bash', [SEARCH, ...args, '--all'], {
      cwd: ROOT, env: { ...env, ...overrides }, encoding: 'utf8', timeout: 15000,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return result;
  }
  return { dir, env, servedLog, ledger, callLog, run, rows: () => readRows(ledger) };
}

test('a fetch origin survives a later repeat serve when touching without a call ID', (t) => {
  const f = fixture(t, [served('call-original')]);
  f.run(['_', '--get', 'evt-ack']);
  assert.equal(f.rows()[0].attribution_status, 'unique_serve');
  fs.appendFileSync(f.servedLog, JSON.stringify(served('call-later')) + '\n');
  f.run(['_', '--touch', 'evt-ack']);
  assert.equal(f.rows()[1].call_id, 'call-original');
  assert.equal(f.rows()[1].attribution_status, 'prior_access');
  assert.ok(Number.isFinite(f.rows()[1].timestamp_ms));
});

test('explicit originating calls govern both fetch and touch after a repeat serve', (t) => {
  const f = fixture(t, [served('call-original'), served('call-later')]);
  f.run(['_', '--get', 'evt-ack', '--call-id', 'call-original']);
  f.run(['_', '--touch', 'evt-ack', '--call-id', 'call-later']);
  assert.deepEqual(f.rows().map((row) => row.call_id), ['call-original', 'call-later']);
  assert.ok(f.rows().every((row) => row.attribution_status === 'explicit'));
  const ambiguous = f.run(['_', '--touch', 'evt-ack']);
  assert.equal(f.rows()[2].call_id, undefined);
  assert.equal(f.rows()[2].attribution_status, 'ambiguous_prior_access');
  assert.match(ambiguous.stderr, /ambiguous_prior_access/);
});

test('multiple serves without a prior access stay visibly unattributed', (t) => {
  const f = fixture(t, [served('call-first'), served('call-second')]);
  const result = f.run(['_', '--get', 'evt-ack']);
  assert.match(result.stdout, /original handshake/);
  assert.equal(f.rows()[0].call_id, undefined);
  assert.equal(f.rows()[0].attribution_status, 'ambiguous_serve');
  assert.match(result.stderr, /ambiguous_serve/);
});

test('an explicit unknown call or wrong event cannot fabricate attribution', (t) => {
  const f = fixture(t, [served('call-real')]);
  f.run(['_', '--get', 'evt-ack', '--call-id', 'call-fabricated']);
  f.run(['_', '--touch', 'evt-other', '--call-id', 'call-real']);
  assert.ok(f.rows().every((row) => row.call_id === undefined && row.attribution_status === 'invalid_call'));
  assert.deepEqual(f.rows().map((row) => row.requested_call_id), ['call-fabricated', 'call-real']);
});

test('different session, purpose, and legacy blank-session serves are never eligible', (t) => {
  const f = fixture(t, [
    served('call-session', 'evt-ack', { session_id: 'other-session' }),
    served('call-purpose', 'evt-ack', { purpose: 'eval' }),
    served('call-blank', 'evt-ack', { session_id: '' }),
  ]);
  for (const call of ['call-session', 'call-purpose', 'call-blank']) {
    f.run(['_', '--get', 'evt-ack', '--call-id', call]);
  }
  f.run(['_', '--touch', 'evt-ack']);
  assert.ok(f.rows().every((row) => row.call_id === undefined));
  assert.equal(f.rows()[3].attribution_status, 'no_compatible_serve');
});

test('no-session use stays uncredited even with an explicit call or blank-session serve', (t) => {
  const f = fixture(t, [served('call-session'), served('call-blank', 'evt-ack', { session_id: '' })]);
  f.run(['_', '--get', 'evt-ack', '--call-id', 'call-blank'], { CARTOGRAPHER_SESSION_ID: '' });
  f.run(['_', '--touch', 'evt-ack'], { CARTOGRAPHER_SESSION_ID: '' });
  assert.ok(f.rows().every((row) => row.call_id === undefined && row.attribution_status === 'no_session'));
});

test('shared unknown session sentinels never establish explicit or implicit attribution', (t) => {
  const f = fixture(t);
  for (const session_id of ['unknown', 'Unknown', '  UNKNOWN  ', '\tunknown\n', ' \t ']) {
    writeRows(f.servedLog, [served('call-unknown', 'evt-ack', { session_id }),
      served('call-blank', 'evt-ack', { session_id: '' })]);
    writeRows(f.ledger, [{ ...served('call-unknown', 'evt-ack', { session_id }), source: 'result_fetched' }]);
    const exact = f.run(['_', '--get', 'evt-ack', '--call-id', 'call-unknown'], { CARTOGRAPHER_SESSION_ID: session_id });
    const implicit = f.run(['_', '--touch', 'evt-ack'], { CARTOGRAPHER_SESSION_ID: session_id });
    assert.match(exact.stdout, /original handshake/);
    assert.match(implicit.stderr, /no_session/);
    assert.ok(f.rows().slice(1).every((row) => row.call_id === undefined && row.attribution_status === 'no_session'));
  }
});

test('accesses from other sessions or purposes cannot choose among current-session serves', (t) => {
  const f = fixture(t, [served('call-first'), served('call-second')]);
  writeRows(f.ledger, [
    { ...served('call-first'), source: 'result_fetched', session_id: 'other' },
    { ...served('call-second'), source: 'result_used', purpose: 'eval' },
  ]);
  f.run(['_', '--touch', 'evt-ack']);
  assert.equal(f.rows()[2].attribution_status, 'ambiguous_serve');
  assert.equal(f.rows()[2].call_id, undefined);
});

test('multi-result batches preserve requested order and validate each explicit pair', (t) => {
  const f = fixture(t, [served('call-batch'), served('call-other', 'evt-other')]);
  f.run(['_', '--get', 'evt-other,evt-ack', '--call-id', 'call-batch']);
  f.run(['_', '--touch', 'evt-other,evt-ack', '--call-id', 'call-batch']);
  const rows = f.rows();
  assert.deepEqual(rows.map((row) => row.event_id), ['evt-other', 'evt-ack', 'evt-other', 'evt-ack']);
  assert.deepEqual(rows.map((row) => row.access_ordinal), [1, 2, 1, 2]);
  assert.deepEqual(rows.map((row) => row.call_id), [undefined, 'call-batch', undefined, 'call-batch']);
  assert.equal(rows[0].access_batch_id, rows[1].access_batch_id);
  assert.equal(rows[2].access_batch_id, rows[3].access_batch_id);
});

test('old valid origins are not discarded by a fixed tail limit or malformed ledger row', (t) => {
  const f = fixture(t, [served('call-original')]);
  writeRows(f.ledger, [{ ...served('call-original'), source: 'result_fetched' }]);
  fs.appendFileSync(f.servedLog, 'not json\n' + Array.from({ length: 2001 }, (_, i) =>
    JSON.stringify(served(`call-unrelated-${i}`, `evt-unrelated-${i}`))).join('\n') + '\n');
  fs.appendFileSync(f.servedLog, JSON.stringify(served('call-repeat')) + '\n');
  f.run(['_', '--touch', 'evt-ack']);
  assert.equal(f.rows()[1].call_id, 'call-original');
});

test('portable search exposes call IDs and precise request/serve telemetry', (t) => {
  const f = fixture(t);
  const text = f.run(['gestureack', '--call-id', 'call-cli-text', '--limit', '2']);
  assert.match(text.stdout, /call_id: call-cli-text/);
  const jsonl = f.run(['gestureack', '--call-id', 'call-cli-json', '--format', 'jsonl', '--limit', '2']);
  assert.ok(jsonl.stdout.trim().split('\n').map(JSON.parse).every((row) => row.call_id === 'call-cli-json'));
  for (const row of readRows(f.callLog)) {
    assert.ok(row.request_started_ms <= row.results_served_ms);
    assert.equal(row.results_served_ms - row.request_started_ms, row.elapsed_ms);
    assert.ok(Number.isFinite(Date.parse(row.request_started_at)));
    assert.equal(row.results_served_at, row.timestamp);
  }
});

test('Turbo exposes call IDs and carries the wrapper request-start timestamp', (t) => {
  const f = fixture(t);
  // Exercise the real client with an in-process HTTP transport fixture. No
  // shared server, spool, credentials, or live corpus is read or restarted.
  const mock = path.join(f.dir, 'mock-fetch.mjs');
  fs.writeFileSync(mock, `globalThis.fetch = async () => ({ ok: true, json: async () => ({
    contract_version: 1, backend: 'explorer', stages_ms: { total: 2 }, semantic_status: 'available',
    results: [{ event_id: 'evt-ack', summary: 'original handshake' }]
  }) });\n`);
  const started = Date.now() - 250;
  for (const format of ['text', 'jsonl']) {
    const result = spawnSync(process.execPath, ['--import', mock, CLIENT,
      '--call-id', 'call-turbo-fixture', '--query', 'gestureack', '--format', format,
      '--request-started-ms', String(started), '--served-log', f.servedLog, '--call-log', f.callLog,
    ], { env: f.env, encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, 0, result.stderr);
    if (format === 'text') assert.match(result.stdout, /call_id: call-turbo-fixture/);
    else assert.equal(JSON.parse(result.stdout).call_id, 'call-turbo-fixture');
  }
  for (const row of readRows(f.callLog)) {
    assert.equal(row.request_started_ms, started);
    assert.equal(Date.parse(row.request_started_at), started);
    assert.equal(Date.parse(row.results_served_at), row.results_served_ms);
    assert.ok(row.results_served_ms >= started);
    assert.equal(row.timestamp, row.results_served_at);
  }
});

test('Turbo surfaces unavailable and unknown semantic search without claiming relevance', (t) => {
  const f = fixture(t);
  const mock = path.join(f.dir, 'mock-semantic.mjs');
  for (const status of ['unavailable', 'disabled', 'unknown', undefined]) {
    fs.writeFileSync(mock, `globalThis.fetch = async () => ({ ok: true, json: async () => (${JSON.stringify({
      contract_version: 1, backend: 'explorer', stages_ms: { total: 1 }, semantic_status: status,
      results: [{ event_id: 'evt-ack', summary: 'handshake keyword match' }],
    })}) });\n`);
    for (const format of ['text', 'jsonl']) {
      const result = spawnSync(process.execPath, ['--import', mock, CLIENT,
        '--call-id', 'call-semantic-fixture', '--query', 'gestureack', '--format', format,
      ], { env: f.env, encoding: 'utf8', timeout: 5000 });
      assert.equal(result.status, 0, result.stderr);
      if (format === 'jsonl') assert.equal(JSON.parse(result.stdout).semantic_status, status || 'unknown');
      else if (status === 'unavailable') assert.match(result.stdout, /semantic search unavailable; keyword results only/);
      else if (status === 'disabled') assert.match(result.stdout, /semantic search disabled; keyword results only/);
      else assert.match(result.stdout, /semantic search status unknown/);
    }
  }
});

test('portable ranking ignores fetched-only records but preserves explicit and legacy use boosts', (t) => {
  const f = fixture(t);
  const ranking = () => f.run(['gestureack', '--limit', '2'], { CARTOGRAPHER_DECAY_LAMBDA: '0' }).stdout;
  const ids = (output) => [...output.matchAll(/\] (evt-[a-z]+)(?:\s|$)/g)].map((match) => match[1]);
  const baseline = ranking();
  const baselineIds = ids(baseline);
  assert.equal(baselineIds.length, 2);
  const target = baselineIds[1];
  const access = { event_id: target, timestamp: new Date().toISOString() };
  writeRows(f.ledger, [{ ...access, source: 'result_fetched' }]);
  const fetched = ranking();
  assert.deepEqual(ids(fetched), baselineIds);
  assert.doesNotMatch(fetched, /used x/);
  for (const source of ['result_used', 'transcript_read', undefined]) {
    writeRows(f.ledger, [{ ...access, source }]);
    const used = ranking();
    assert.equal(ids(used)[0], target);
    assert.match(used, new RegExp(`${target} \\(used x1\\)`));
  }
});

test('API ranking gives fetched-only records the same score/count as no access', (t) => {
  const f = fixture(t);
  const runner = path.join(f.dir, 'rank-fixture.mjs');
  fs.writeFileSync(runner, `
    import fs from 'node:fs';
    import { buildIndex } from ${JSON.stringify(pathToFileURL(path.join(ROOT, 'explorer/server/bm25.js')).href)};
    import { hybridSearch } from ${JSON.stringify(pathToFileURL(path.join(ROOT, 'explorer/server/search.js')).href)};
    const events = fs.readFileSync(process.env.CARTOGRAPHER_DEV_DIR + '/changelog.jsonl', 'utf8')
      .trim().split('\\n').map(JSON.parse);
    const response = await hybridSearch(buildIndex(events), 'gestureack', {});
    process.stdout.write(JSON.stringify(response.items.map(({event_id, _score, _reuseCount}) =>
      ({event_id, _score, _reuseCount}))));
  `);
  const ranking = () => {
    const result = spawnSync(process.execPath, [runner], { encoding: 'utf8', timeout: 5000,
      env: { ...f.env, CARTOGRAPHER_SEMANTIC: '0', CARTOGRAPHER_DECAY_LAMBDA: '0' } });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  const baseline = ranking();
  assert.equal(baseline.length, 2);
  const target = baseline[1].event_id;
  const access = { event_id: target, timestamp: new Date().toISOString() };
  writeRows(f.ledger, [{ ...access, source: 'result_fetched' }]);
  assert.deepEqual(ranking(), baseline);
  for (const source of ['result_used', 'transcript_read', undefined]) {
    writeRows(f.ledger, [{ ...access, source }]);
    const used = ranking();
    assert.equal(used[0].event_id, target);
    assert.equal(used[0]._reuseCount, 1);
    assert.ok(used[0]._score > baseline[1]._score);
  }
});
