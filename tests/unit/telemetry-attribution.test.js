/**
 * tests/unit/telemetry-attribution.test.js
 *
 * Every served row, search-call row and access row must name the calling
 * session and provider, or say why it cannot.
 *
 * Measured 2026-09-26 over 24h: 26 of 30 served calls had `session_id: ""` and
 * `provider: "unknown"`, and 11 of 17 access rows had neither a session nor a
 * call_id. None of it errored. Tracing each call back to its caller found two
 * sources, and the rows could not tell them apart:
 *
 *   - 11 calls (and all 11 access rows) were Hermes FrakBot, whose terminal
 *     tool binds HERMES_SESSION_ID but exports none of the chain variables.
 *   - 15 calls were a Claude session that unset the chain on purpose while
 *     replaying FrakBot's queries.
 *
 * So these tests drive the real writers — the portable CLI and the Turbo
 * client — with session variables set through the mechanism each caller
 * actually has, and assert on the rows written to disk.
 *
 * Run with: node --test tests/unit/telemetry-attribution.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { OFFLINE_INDEX_ENV } from './helpers/offline-index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SEARCH = path.join(ROOT, 'scripts', 'cartographer-search.sh');
const runAsync = promisify(execFile);

// Every variable that can name a session or a provider to the CLI. The harness
// starts from none of them so the only ones in play are the ones under test.
const LIVE_IDENTITY_VARS = [
  'CARTOGRAPHER_SESSION_ID',
  'CLAUDE_SESSION_ID',
  'CLAUDE_CODE_SESSION_ID',
  'CODEX_SESSION_ID',
  'CARTOGRAPHER_PROVIDER',
  'CODEX_THREAD_ID',
  'CODEX_HOME',
  'HERMES_SESSION_ID',
];

const HIT = 'evt-attrfixturehit';
const QUERY = 'zzattrqq';

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

/**
 * A throwaway corpus with the query token in exactly one event. The filler
 * matters: BM25 clamps a term found in over half the corpus to zero, and a
 * search that serves nothing writes no row, so every assertion would pass
 * vacuously.
 */
function makeCorpus() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-attribution-'));
  const event = (id, day, summary) => JSON.stringify({
    event_id: id,
    timestamp: `2026-01-${String(day).padStart(2, '0')}T00:00:00Z`,
    type: 'tool_bash',
    project: 'fixtureproject',
    summary,
  });
  const corpus = [
    event(HIT, 1, `Ran: ${QUERY} distinctive fixture token for telemetry attribution`),
    ...Array.from({ length: 7 }, (_, i) =>
      event(`evt-attrfiller${i}`, i + 2, `Ran: routine filler command ${i} touching unrelated files`)),
  ];
  fs.writeFileSync(path.join(dir, 'changelog.jsonl'), `${corpus.join('\n')}\n`);
  for (const name of ['session-milestones.jsonl', 'research-log.jsonl', 'tool-use-log.jsonl']) {
    fs.writeFileSync(path.join(dir, name), '');
  }
  return {
    dir,
    served: path.join(dir, 'served-log.jsonl'),
    calls: path.join(dir, 'search-calls.jsonl'),
    ledger: path.join(dir, 'access-ledger.jsonl'),
    servedLists: path.join(dir, 'cartographer-served'),
  };
}

function cleanEnv(corpus, overrides = {}) {
  const env = { ...process.env };
  for (const key of LIVE_IDENTITY_VARS) delete env[key];
  return {
    ...env,
    ...OFFLINE_INDEX_ENV,
    CARTOGRAPHER_DEV_DIR: corpus.dir,
    CARTOGRAPHER_SERVED_LOG: corpus.served,
    CARTOGRAPHER_SEARCH_CALL_LOG: corpus.calls,
    CARTOGRAPHER_ACCESS_LEDGER: corpus.ledger,
    CARTOGRAPHER_TRANSCRIPTS_DIR: path.join(corpus.dir, 'no-transcripts'),
    CARTOGRAPHER_CODEX_TRANSCRIPTS_DIR: path.join(corpus.dir, 'no-transcripts'),
    CARTOGRAPHER_CODEX_ARCHIVED_DIR: path.join(corpus.dir, 'no-transcripts'),
    CARTOGRAPHER_CONFIG: path.join(corpus.dir, 'no-config.json'),
    CARTOGRAPHER_SEMANTIC: '0',
    CARTOGRAPHER_TURBO: '0',
    CARTOGRAPHER_PURPOSE: 'remember',
    // Delta-serving lists land in the corpus dir, not the shared /tmp.
    TMPDIR_BASE: corpus.dir,
    ...overrides,
  };
}

function search(corpus, callId, overrides) {
  const result = spawnSync('bash', [SEARCH, QUERY, '--limit', '3', '--call-id', callId], {
    encoding: 'utf8',
    env: cleanEnv(corpus, overrides),
  });
  assert.equal(result.status, 0, result.stderr);
  const served = readJsonl(corpus.served).filter((row) => row.call_id === callId);
  // The guard on the guard: no served row means nothing below is tested.
  assert.ok(served.some((row) => row.event_id === HIT),
    `the fixture must serve ${HIT}; stdout: ${result.stdout} stderr: ${result.stderr}`);
  const calls = readJsonl(corpus.calls).filter((row) => row.call_id === callId);
  assert.equal(calls.length, 1, 'one search-call row per call');
  return { served, call: calls[0] };
}

function touch(corpus, callId, overrides) {
  const before = readJsonl(corpus.ledger).length;
  const result = spawnSync('bash', [SEARCH, '_', '--touch', HIT, '--call-id', callId], {
    encoding: 'utf8',
    env: cleanEnv(corpus, overrides),
  });
  assert.equal(result.status, 0, result.stderr);
  const rows = readJsonl(corpus.ledger).slice(before);
  assert.equal(rows.length, 1, `one access row per touched id; stderr: ${result.stderr}`);
  return rows[0];
}

/**
 * A row states its attribution when it either names a real session or says
 * why it has none. The pre-fix writers left `session_id: ""` with no reason.
 */
function statesAttribution(row) {
  const named = typeof row.session_id === 'string' && row.session_id.trim() !== ''
    && row.session_id.trim().toLowerCase() !== 'unknown';
  if (named) return row.attribution_status !== 'no_session' && typeof row.provider === 'string';
  return typeof row.attribution_status === 'string' && row.attribution_status !== ''
    && typeof row.provider === 'string';
}

function assertAttributed(rows, { session, provider, source }) {
  for (const row of rows) {
    assert.equal(row.session_id, session, `${row.event_id ?? row.call_id}: session`);
    assert.equal(row.provider, provider, `${row.event_id ?? row.call_id}: provider`);
    assert.equal(row.attribution_status, session ? 'session' : 'no_session');
    assert.equal(row.session_source, source);
    assert.ok(statesAttribution(row));
  }
}

let counter = 0;
const freshSid = (label) => `sid-${label}-${process.pid}-${++counter}`;

test('the attribution predicate rejects the row the old writers produced', () => {
  // Without this, a predicate that accepted anything would pass every case.
  assert.equal(statesAttribution({ session_id: '', provider: 'unknown' }), false);
  assert.equal(statesAttribution({ session_id: 'unknown', provider: 'claude' }), false);
  assert.equal(statesAttribution({ session_id: '', provider: 'hermes', attribution_status: 'no_session' }), true);
  assert.equal(statesAttribution({ session_id: 'sid-1', provider: 'hermes', attribution_status: 'session' }), true);
});

test('a Hermes wrapper that exports CARTOGRAPHER_SESSION_ID is attributed on served, call and access rows', () => {
  const corpus = makeCorpus();
  try {
    const sid = freshSid('hermes');
    // What the docs tell a Hermes wrapper to do with the id its terminal tool binds.
    const env = { HERMES_SESSION_ID: sid, CARTOGRAPHER_SESSION_ID: sid, CARTOGRAPHER_PROVIDER: 'hermes' };
    const { served, call } = search(corpus, 'call-attr-hermes', env);
    assertAttributed([...served, call], { session: sid, provider: 'hermes', source: 'CARTOGRAPHER_SESSION_ID' });
    assert.equal(call.selected_backend, 'cli');

    const access = touch(corpus, 'call-attr-hermes', env);
    assert.equal(access.session_id, sid);
    assert.equal(access.provider, 'hermes');
    assert.equal(access.session_source, 'CARTOGRAPHER_SESSION_ID');
    assert.equal(access.call_id, 'call-attr-hermes');
    assert.equal(access.attribution_status, 'explicit');
  } finally {
    fs.rmSync(corpus.dir, { recursive: true, force: true });
  }
});

test('a Hermes call that has not opted in names its provider and says why it has no session', () => {
  const corpus = makeCorpus();
  try {
    // FrakBot's wrapper before the fix: HERMES_SESSION_ID is bound, nothing else.
    const env = { HERMES_SESSION_ID: freshSid('hermes-bare') };
    const { served, call } = search(corpus, 'call-attr-bare', env);
    assertAttributed([...served, call], { session: '', provider: 'hermes', source: '' });

    const access = touch(corpus, 'call-attr-bare', env);
    assert.equal(access.session_id, '');
    assert.equal(access.provider, 'hermes');
    assert.equal(access.attribution_status, 'no_session');
    assert.equal(access.call_id, undefined, 'a sessionless mark earns no call credit');
    assert.equal(access.requested_call_id, 'call-attr-bare');
    // Opting out of the session must also keep delta serving off.
    assert.equal(fs.existsSync(corpus.servedLists) && fs.readdirSync(corpus.servedLists).length, false);
  } finally {
    fs.rmSync(corpus.dir, { recursive: true, force: true });
  }
});

test('a sentinel ahead of a real id is skipped, and never names a served list', () => {
  const corpus = makeCorpus();
  try {
    const sid = freshSid('code');
    const env = { CARTOGRAPHER_SESSION_ID: 'unknown', CLAUDE_CODE_SESSION_ID: sid };

    // Prove the fixture exercises the defect: the chain as spelled before the
    // fix takes the first non-empty value, which here is the sentinel.
    const naive = spawnSync('bash', ['-c',
      'printf %s "${CARTOGRAPHER_SESSION_ID:-${CLAUDE_SESSION_ID:-${CLAUDE_CODE_SESSION_ID:-${CODEX_SESSION_ID:-}}}}"'],
    { encoding: 'utf8', env: cleanEnv(corpus, env) });
    assert.equal(naive.stdout, 'unknown', 'the fixture must put a sentinel first in the chain');

    const { served, call } = search(corpus, 'call-attr-sentinel', env);
    assertAttributed([...served, call], { session: sid, provider: 'claude', source: 'CLAUDE_CODE_SESSION_ID' });
    const lists = fs.readdirSync(corpus.servedLists);
    assert.deepEqual(lists, [`${sid}.txt`], 'delta serving keys on the resolved id only');
  } finally {
    fs.rmSync(corpus.dir, { recursive: true, force: true });
  }
});

test('a sentinel alone resolves to no session, not to a shared identity', () => {
  const corpus = makeCorpus();
  try {
    const env = { CARTOGRAPHER_SESSION_ID: '  Unknown ' };
    const { served, call } = search(corpus, 'call-attr-sentinel-only', env);
    assertAttributed([...served, call], { session: '', provider: 'unknown', source: '' });
    assert.equal(fs.existsSync(corpus.servedLists) && fs.readdirSync(corpus.servedLists).length, false,
      'no served list may be created for a sentinel');
  } finally {
    fs.rmSync(corpus.dir, { recursive: true, force: true });
  }
});

test('Claude and Codex sessions name the variable they came from', () => {
  const corpus = makeCorpus();
  try {
    const claude = freshSid('claude');
    const codex = freshSid('codex');
    const a = search(corpus, 'call-attr-claude', { CLAUDE_CODE_SESSION_ID: claude });
    assertAttributed([...a.served, a.call], { session: claude, provider: 'claude', source: 'CLAUDE_CODE_SESSION_ID' });
    const b = search(corpus, 'call-attr-codex', { CODEX_SESSION_ID: codex, CODEX_THREAD_ID: codex });
    assertAttributed([...b.served, b.call], { session: codex, provider: 'codex', source: 'CODEX_SESSION_ID' });
  } finally {
    fs.rmSync(corpus.dir, { recursive: true, force: true });
  }
});

test('a call with no session variable at all says so on every row', () => {
  const corpus = makeCorpus();
  try {
    const { served, call } = search(corpus, 'call-attr-none', {});
    assertAttributed([...served, call], { session: '', provider: 'unknown', source: '' });
    const access = touch(corpus, 'call-attr-none', {});
    assert.equal(access.attribution_status, 'no_session');
    assert.equal(access.session_source, '');
    assert.ok(statesAttribution(access));
  } finally {
    fs.rmSync(corpus.dir, { recursive: true, force: true });
  }
});

// ─── Turbo path ───
// A Turbo-served call writes its served and call rows from turbo-search-client.js,
// not the awk writer, so it needs its own proof. A fake /api/recall records the
// request body the client sent; the rows on disk must carry the same identity.

function fakeTurbo() {
  const bodies = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      if (req.method !== 'POST' || req.url !== '/api/recall') {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end('{"error":"not found"}');
        return;
      }
      bodies.push(JSON.parse(raw));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        contract_version: 1,
        backend: 'explorer',
        semantic_status: 'disabled',
        index_generation: 'fixture',
        stages_ms: { total: 1 },
        results: [{
          event_id: HIT,
          timestamp: '2026-01-01T00:00:00Z',
          project: 'fixtureproject',
          summary: 'fixture hit served by the fake Turbo',
          _sources: 'keyword',
        }],
      }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, bodies, url: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

async function turboSearch(corpus, turbo, callId, overrides) {
  const config = path.join(corpus.dir, 'turbo-config.json');
  fs.writeFileSync(config, JSON.stringify({ turbo: { enabled: true, auto_start: false, url: turbo.url } }));
  // Async: the fake server lives in this process and must keep answering.
  await runAsync('bash', [SEARCH, QUERY, '--limit', '3', '--call-id', callId], {
    env: cleanEnv(corpus, {
      CARTOGRAPHER_CONFIG: config,
      CARTOGRAPHER_TURBO: '1',
      CARTOGRAPHER_TURBO_URL: turbo.url,
      CARTOGRAPHER_TURBO_STATE_DIR: path.join(corpus.dir, 'turbo-state'),
      ...overrides,
    }),
  });
  const served = readJsonl(corpus.served).filter((row) => row.call_id === callId);
  const calls = readJsonl(corpus.calls).filter((row) => row.call_id === callId);
  // Composition, not presence: the rows must come from the Turbo writer, or the
  // portable fallback answered and this case proves nothing about Turbo.
  assert.ok(served.length > 0 && served.every((row) => row.backend === 'explorer'),
    `served rows must come from Turbo: ${JSON.stringify(served)}`);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].selected_backend, 'explorer');
  return { served, call: calls[0], body: turbo.bodies.find((b) => b.call_id === callId) };
}

test('Turbo carries the request identity into served, call and access rows', async () => {
  const corpus = makeCorpus();
  const turbo = await fakeTurbo();
  try {
    const sid = freshSid('turbo');
    const env = { HERMES_SESSION_ID: sid, CARTOGRAPHER_SESSION_ID: sid, CARTOGRAPHER_PROVIDER: 'hermes' };
    const { served, call, body } = await turboSearch(corpus, turbo, 'call-attr-turbo', env);
    assert.ok(body, 'the fake Turbo must have received this call');
    assert.equal(body.session_id, sid);
    assert.equal(body.provider, 'hermes');
    assertAttributed([...served, call], { session: sid, provider: 'hermes', source: 'CARTOGRAPHER_SESSION_ID' });

    // The access writer joins against rows the Turbo client wrote.
    const access = touch(corpus, 'call-attr-turbo', env);
    assert.equal(access.call_id, 'call-attr-turbo');
    assert.equal(access.attribution_status, 'explicit');
    assert.equal(access.provider, 'hermes');
  } finally {
    turbo.server.close();
    fs.rmSync(corpus.dir, { recursive: true, force: true });
  }
});

test('a sessionless Turbo call says why on its served and call rows', async () => {
  const corpus = makeCorpus();
  const turbo = await fakeTurbo();
  try {
    const { served, call, body } = await turboSearch(corpus, turbo, 'call-attr-turbo-none',
      { HERMES_SESSION_ID: freshSid('turbo-bare') });
    assert.equal(body.session_id, '');
    assert.equal(body.provider, 'hermes');
    assertAttributed([...served, call], { session: '', provider: 'hermes', source: '' });
  } finally {
    turbo.server.close();
    fs.rmSync(corpus.dir, { recursive: true, force: true });
  }
});
