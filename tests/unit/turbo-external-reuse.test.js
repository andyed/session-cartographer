// Turbo reuses an already-running service rather than fighting it for the port.
// The question this file answers is how it decides a listener IS that service.
//
// The probe read only `res.ok`, so any process answering 200 on the configured
// port was accepted and reported as `reused: 'external'` — no server started,
// and every subsequent recall aimed at a stranger. That is not hypothetical: an
// unrelated node process held a probed port during development and answered,
// and the result read as a successful Turbo call. `validateRecallResponse`
// would eventually reject the query on `backend`, but only after the spawn
// decision had been made on a false premise, and its error describes a bad
// response rather than the wrong process.
//
// These drive `start`, because that is where the reuse decision is taken.
// `status` answers from the managed-server record and never reaches the probe —
// the trap that made the first draft of this file pass against unfixed code.
//
// Hermetic: an isolated CARTOGRAPHER_TURBO_STATE_DIR per case, so no managed
// record exists and nothing touches the real service. The session-id chain is
// cleared per CLAUDE.md. Any server a negative case spawns is stopped in the
// same helper that started it.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

for (const name of [
  'CARTOGRAPHER_SESSION_ID',
  'CLAUDE_SESSION_ID',
  'CLAUDE_CODE_SESSION_ID',
  'CODEX_SESSION_ID',
]) delete process.env[name];

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CONTROL = path.join(ROOT, 'scripts', 'cartographer-turbo.js');

function serve(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, url: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

/**
 * Run `start` against `url` in an isolated state dir, then always stop and
 * clean up.
 *
 * CARTOGRAPHER_DEV_DIR points at an empty temp corpus for two reasons. It keeps
 * the case hermetic — nothing reads the real logs — and it keeps it honest: a
 * negative case has to actually spawn a server to prove it did not reuse the
 * stranger, and spawning against the live 127k-event corpus took long enough
 * under concurrent load to blow the readiness budget and fail the test for a
 * reason that had nothing to do with what it asserts. An empty corpus makes the
 * spawn near-instant, so the only thing the case can fail on is the decision.
 */
async function startAgainst(url) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-turbo-reuse-'));
  const corpusDir = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-turbo-corpus-'));
  const env = {
    ...process.env,
    CARTOGRAPHER_DEV_DIR: corpusDir,
    CARTOGRAPHER_TURBO_STATE_DIR: stateDir,
    CARTOGRAPHER_TURBO_URL: url,
    CARTOGRAPHER_TURBO: '1',
  };
  try {
    const { stdout } = await run('node', [CONTROL, 'start'], { env });
    return JSON.parse(stdout);
  } finally {
    try { await run('node', [CONTROL, 'stop'], { env }); } catch {}
    fs.rmSync(stateDir, { recursive: true, force: true });
    fs.rmSync(corpusDir, { recursive: true, force: true });
  }
}

test('a stranger answering 200 on the port is not mistaken for Turbo', async () => {
  const { server, url } = await serve((req, res) => json(res, 200, { status: 'ok', hello: 'not cartographer' }));
  try {
    const result = await startAgainst(url);
    assert.notEqual(
      result.reused, 'external',
      'a 200 from an unrelated process must not be reused as a Turbo service',
    );
    assert.equal(result.started, true, 'it must start its own service instead');
  } finally {
    server.close();
  }
});

test('a service speaking an unsupported contract version is not reused', async () => {
  // "Not ours" for reuse includes a Cartographer speaking a contract this
  // client cannot parse. Reusing it is the same failure with an extra step.
  const { server, url } = await serve((req, res) => json(res, 200, {
    status: 'ok', backend: 'explorer', contract_version: 99,
  }));
  try {
    const result = await startAgainst(url);
    assert.notEqual(result.reused, 'external');
    assert.equal(result.started, true);
  } finally {
    server.close();
  }
});

test('a real recall contract on the port is reused rather than duplicated', async () => {
  // The other half of the invariant. Refusing to reuse a genuine service would
  // mean two processes holding one corpus and one port.
  const { server, url } = await serve((req, res) => {
    if (req.url === '/api/recall/health') {
      return json(res, 200, {
        status: 'ok',
        backend: 'explorer',
        contract_version: 1,
        corpus_root: '/tmp/whatever',
        events: 1,
        indexed_docs: 1,
        index_generation: 'abc',
        process: { pid: 1, rss: 1, heap_used: 1 },
      });
    }
    return json(res, 404, { error: 'not found' });
  });
  try {
    const result = await startAgainst(url);
    assert.equal(result.reused, 'external', 'a service that identifies itself must be reused');
    assert.equal(result.started, false, 'and nothing new should be spawned');
  } finally {
    server.close();
  }
});
