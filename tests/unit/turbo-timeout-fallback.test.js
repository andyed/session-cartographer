/**
 * tests/unit/turbo-timeout-fallback.test.js
 *
 * A recall that outruns the client's budget must not be run a second time.
 *
 * Every Turbo recall fallback in the 30 days to 2026-09-26 (6 of 260
 * remember/focus calls) had one signature: "HTTP This operation was aborted;
 * file transport spool response timed out". The service was healthy. Its
 * semantic stage had run 1.7-2.7 s against a 1.5 s client budget; the client
 * read its own abort as an unreachable service and re-sent the request through
 * the file spool, where the same process ran the query again beside the
 * abandoned first run, missed the spool's 3 s deadline, and handed the caller a
 * 13-89 s portable search.
 *
 * The spool exists for a connect the sandbox refuses, and that fails fast: of
 * 104 spool calls since 2026-08-27, 102 had failed HTTP within ~90 ms.
 *
 * These drive the real clients against a fake service and count what reaches
 * it: HTTP requests at the port, and request files in the spool directory.
 *
 * Run with: node --test tests/unit/turbo-timeout-fallback.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { OFFLINE_INDEX_ENV } from './helpers/offline-index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SEARCH = path.join(ROOT, 'scripts', 'cartographer-search.sh');
const FACTS = path.join(ROOT, 'scripts', 'cartographer-facts.js');

const IDENTITY_VARS = [
  'CARTOGRAPHER_SESSION_ID', 'CLAUDE_SESSION_ID', 'CLAUDE_CODE_SESSION_ID', 'CODEX_SESSION_ID',
  'CARTOGRAPHER_PROVIDER', 'CARTOGRAPHER_TURBO_TIMEOUT_MS',
];
const HIT = 'evt-timeoutfixturehit';
const QUERY = 'zztimeoutqq';
// The budget the client shipped with before this fix.
const OLD_DEFAULT_MS = 1500;

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function makeWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-turbo-timeout-'));
  const event = (id, day, summary) => JSON.stringify({
    event_id: id,
    timestamp: `2026-01-${String(day).padStart(2, '0')}T00:00:00Z`,
    type: 'tool_bash',
    project: 'fixtureproject',
    summary,
  });
  // Filler keeps the query term under half the corpus, or BM25 scores it zero.
  const corpus = [
    event(HIT, 1, `Ran: ${QUERY} distinctive fixture token for the timeout path`),
    ...Array.from({ length: 7 }, (_, i) =>
      event(`evt-timeoutfiller${i}`, i + 2, `Ran: routine filler command ${i} touching unrelated files`)),
  ];
  fs.writeFileSync(path.join(dir, 'changelog.jsonl'), `${corpus.join('\n')}\n`);
  for (const name of ['session-milestones.jsonl', 'research-log.jsonl', 'tool-use-log.jsonl']) {
    fs.writeFileSync(path.join(dir, name), '');
  }
  const stateDir = path.join(dir, 'turbo-state');
  return {
    dir,
    stateDir,
    requestsDir: path.join(stateDir, 'requests'),
    served: path.join(dir, 'served-log.jsonl'),
    calls: path.join(dir, 'search-calls.jsonl'),
  };
}

function recallBody() {
  return {
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
  };
}

/** A fake service that answers every POST after `delayMs`, counting arrivals. */
function slowService(delayMs, body = recallBody()) {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push(req.url);
    req.resume();
    req.on('end', () => {
      setTimeout(() => {
        // The client may have given up; writing to a closed socket is harmless.
        try {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(body));
        } catch {}
      }, delayMs);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      seen,
      url: `http://127.0.0.1:${server.address().port}`,
      close: () => { server.closeAllConnections?.(); server.close(); },
    }));
  });
}

/** A loopback port with nothing listening on it: connect is refused at once. */
async function refusedUrl() {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return `http://127.0.0.1:${port}`;
}

/**
 * Watch the spool directory for request files. With `answer`, reply to each one
 * as the service's spool worker would; without it, only count them.
 */
function watchSpool(requestsDir, { answer = false } = {}) {
  const seen = new Set();
  const timer = setInterval(() => {
    let names = [];
    try { names = fs.readdirSync(requestsDir); } catch { return; }
    for (const name of names) {
      if (!name.endsWith('.request.json') || seen.has(name)) continue;
      seen.add(name);
      if (!answer) continue;
      const file = path.join(requestsDir, name);
      let envelope;
      try { envelope = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { seen.delete(name); continue; }
      const responseFile = file.replace(/\.request\.json$/, '.response.json');
      const tmp = `${responseFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({
        request_token: envelope.request_token, status: 200, body: recallBody(),
      }));
      fs.renameSync(tmp, responseFile);
    }
  }, 10);
  return { seen, stop: () => clearInterval(timer) };
}

function env(ws, url, overrides = {}) {
  const base = { ...process.env };
  for (const key of IDENTITY_VARS) delete base[key];
  const config = path.join(ws.dir, 'config.json');
  // No timeout_ms: the shipped default is what is under test.
  fs.writeFileSync(config, JSON.stringify({ turbo: { enabled: true, auto_start: false, url } }));
  return {
    ...base,
    ...OFFLINE_INDEX_ENV,
    CARTOGRAPHER_DEV_DIR: ws.dir,
    CARTOGRAPHER_SERVED_LOG: ws.served,
    CARTOGRAPHER_SEARCH_CALL_LOG: ws.calls,
    CARTOGRAPHER_ACCESS_LEDGER: path.join(ws.dir, 'access-ledger.jsonl'),
    CARTOGRAPHER_TRANSCRIPTS_DIR: path.join(ws.dir, 'no-transcripts'),
    CARTOGRAPHER_CODEX_TRANSCRIPTS_DIR: path.join(ws.dir, 'no-transcripts'),
    CARTOGRAPHER_CODEX_ARCHIVED_DIR: path.join(ws.dir, 'no-transcripts'),
    CARTOGRAPHER_CONFIG: config,
    CARTOGRAPHER_SEMANTIC: '0',
    CARTOGRAPHER_TURBO: '1',
    CARTOGRAPHER_TURBO_URL: url,
    CARTOGRAPHER_TURBO_STATE_DIR: ws.stateDir,
    CARTOGRAPHER_PURPOSE: 'remember',
    TMPDIR_BASE: ws.dir,
    ...overrides,
  };
}

function run(command, args, childEnv) {
  // Async: the fake service lives in this process and must keep answering.
  return new Promise((resolve) => {
    execFile(command, args, { env: childEnv, encoding: 'utf8', timeout: 60000 }, (error, stdout, stderr) => {
      resolve({ code: error ? (error.code ?? 1) : 0, stdout, stderr });
    });
  });
}

async function recall(ws, url, overrides) {
  const result = await run('bash', [SEARCH, QUERY, '--limit', '3', '--call-id', 'call-timeout-fixture'],
    env(ws, url, overrides));
  assert.equal(result.code, 0, result.stderr);
  const calls = readJsonl(ws.calls);
  assert.equal(calls.length, 1, 'one search-call row per call');
  return { call: calls[0], served: readJsonl(ws.served), stderr: result.stderr };
}

test('a recall that outruns the budget falls back once, without a spool rerun', async () => {
  const ws = makeWorkspace();
  const service = await slowService(1500);
  const spool = watchSpool(ws.requestsDir);
  try {
    const { call, served } = await recall(ws, service.url, { CARTOGRAPHER_TURBO_TIMEOUT_MS: '300' });

    // The fixture must reach a live service that is merely slow. A refused
    // connect would be the sandbox path, where the spool is correct.
    assert.deepEqual(service.seen, ['/api/recall'], 'the service received the request exactly once');
    assert.equal(spool.seen.size, 0, 'a timed-out request must not be re-sent through the spool');

    assert.equal(call.selected_backend, 'cli');
    assert.equal(call.fallback_reason, 'turbo_unavailable');
    assert.match(call.fallback_detail, /no answer within 300 ms/);
    // The pre-fix client reported "... file transport spool response timed out".
    assert.doesNotMatch(call.fallback_detail, /spool response/);
    assert.ok(served.some((row) => row.event_id === HIT && row.backend === 'cli'),
      'the portable CLI must still answer');
  } finally {
    spool.stop();
    service.close();
    fs.rmSync(ws.dir, { recursive: true, force: true });
  }
});

test('the default budget waits out a service slower than the old 1.5 s', async () => {
  const ws = makeWorkspace();
  const delay = 2000;
  const service = await slowService(delay);
  const spool = watchSpool(ws.requestsDir);
  try {
    assert.ok(delay > OLD_DEFAULT_MS, 'the fixture must be slower than the budget it replaces');
    const { call, served } = await recall(ws, service.url);
    assert.equal(call.selected_backend, 'explorer', `fell back: ${call.fallback_detail}`);
    assert.equal(call.transport, 'http');
    assert.ok(call.elapsed_ms >= delay, `the service really was slow (${call.elapsed_ms} ms)`);
    assert.equal(spool.seen.size, 0);
    assert.ok(served.some((row) => row.event_id === HIT && row.backend === 'explorer'));
  } finally {
    spool.stop();
    service.close();
    fs.rmSync(ws.dir, { recursive: true, force: true });
  }
});

test('a refused connect still reaches the service through the spool, at once', async () => {
  const ws = makeWorkspace();
  const url = await refusedUrl();
  const spool = watchSpool(ws.requestsDir, { answer: true });
  try {
    const { call } = await recall(ws, url);
    assert.equal(spool.seen.size, 1, 'the spool must carry the request when HTTP cannot connect');
    assert.equal(call.selected_backend, 'explorer', `fell back: ${call.fallback_detail}`);
    assert.equal(call.transport, 'file');
    // A refused connect fails in milliseconds; this must not wait out the budget.
    assert.ok(call.elapsed_ms < OLD_DEFAULT_MS, `took ${call.elapsed_ms} ms`);
  } finally {
    spool.stop();
    fs.rmSync(ws.dir, { recursive: true, force: true });
  }
});

test('the facts client does not re-send a timed-out request through the spool', async () => {
  const ws = makeWorkspace();
  const service = await slowService(1500, {});
  const spool = watchSpool(ws.requestsDir);
  try {
    const result = await run('node', [FACTS, '--verb', 'census', '--url', service.url, '--timeout', '300',
      '--corpus-root', ws.dir], env(ws, service.url));
    assert.deepEqual(service.seen, ['/api/facts'], 'the service received the request exactly once');
    assert.equal(spool.seen.size, 0, 'a timed-out request must not be re-sent through the spool');
    assert.equal(result.code, 75);
    assert.match(result.stderr, /no answer within 300 ms/);
    assert.doesNotMatch(result.stderr, /spool response/);
  } finally {
    spool.stop();
    service.close();
    fs.rmSync(ws.dir, { recursive: true, force: true });
  }
});
