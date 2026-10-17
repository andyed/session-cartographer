// The Explorer API (:2526) serves the same corpus as the UI host, which always
// refused a forged Host. The API did not: on 2026-10-16 a request carrying
// `Host: rebind.attacker.example:2526` got 200 and 1.7 MB of
// /api/memory/state, which is what a DNS-rebinding page sees. This drives the
// real Express app over raw HTTP, because Node's fetch rewrites Host.
//
// Each refused shape is paired with the same request under a loopback Host
// answering 200 with fixture data, so the test proves the route would have
// served the corpus and the guard is what stopped it.

process.env.CARTOGRAPHER_SEMANTIC = '0';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { OFFLINE_INDEX_ENV } from './helpers/offline-index.js';

for (const name of [
  'CARTOGRAPHER_SESSION_ID',
  'CLAUDE_SESSION_ID',
  'CLAUDE_CODE_SESSION_ID',
  'CODEX_SESSION_ID',
]) delete process.env[name];

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-api-guard-'));
const now = new Date().toISOString();
fs.writeFileSync(path.join(dir, 'changelog.jsonl'), `${JSON.stringify({
  event_id: 'evt-guarded', timestamp: now, type: 'tool_bash', provider: 'claude',
  session_id: 'session-guarded', project: 'guarded', summary: 'Ran: echo marmoset',
})}\n`);
// DEV_DIR is captured when jsonl.js is first evaluated; /api/health probes
// Qdrant and the embedder, which must not be the live ones.
Object.assign(process.env, { ...OFFLINE_INDEX_ENV, CARTOGRAPHER_DEV_DIR: dir });
const { createExplorerApp } = await import('../../explorer/server/app.js');

function rawRequest(port, pathname, headers, method = 'GET', body = '') {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port, path: pathname, method, headers }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    request.on('error', reject);
    request.end(body);
  });
}

const RECALL = JSON.stringify({
  contract_version: 1, call_id: 'call-guard', query: 'marmoset', project: '', since: '', before: '',
  limit: 10, purpose: 'remember', session_id: '', provider: 'claude', excluded_event_ids: [],
});

test('the API refuses forged Host, foreign Origin and cross-site requests, and serves loopback ones', async (t) => {
  const { app, close } = createExplorerApp();
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(async () => {
    close();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const { port } = server.address();
  const own = `127.0.0.1:${port}`;
  const state = '/api/memory/state?hours=1';

  // The fixture is real: under a loopback Host the route serves the corpus.
  const served = await rawRequest(port, state, { Host: own });
  assert.equal(served.status, 200);
  assert.match(served.body, /session-guarded/, 'the memory state must carry the fixture session');

  const rebound = await rawRequest(port, state, { Host: `rebind.attacker.example:${port}` });
  assert.equal(rebound.status, 403, 'a DNS-rebinding Host must be refused');
  assert.doesNotMatch(rebound.body, /session-guarded/);

  for (const pathname of ['/api/memory/file?download=1', '/api/health', '/api/events', '/api/recall/health', '/api/sessions']) {
    assert.equal((await rawRequest(port, pathname, { Host: `rebind.attacker.example:${port}` })).status, 403, pathname);
  }
  for (const Host of ['attacker.example', `user@127.0.0.1:${port}`, `127.0.0.1.attacker.example:${port}`, `localhost.:${port}`]) {
    assert.equal((await rawRequest(port, state, { Host })).status, 403, Host);
  }

  // A rebound POST is refused before the body is parsed or recall runs.
  const json = { 'Content-Type': 'application/json' };
  assert.equal((await rawRequest(port, '/api/recall', { ...json, Host: own }, 'POST', RECALL)).status, 200);
  assert.equal((await rawRequest(port, '/api/recall', { ...json, Host: `rebind.attacker.example:${port}` }, 'POST', RECALL)).status, 403);
  for (const Origin of ['https://attacker.example', 'null', `http://127.0.0.1:${port + 1}`]) {
    assert.equal((await rawRequest(port, '/api/recall', { ...json, Host: own, Origin }, 'POST', RECALL)).status, 403, Origin);
  }
  assert.equal((await rawRequest(port, state, { Host: own, 'Sec-Fetch-Site': 'cross-site' })).status, 403);

  // Every loopback spelling a client uses, the Vite proxy's same-origin shape,
  // and a browser's own-origin POST all pass.
  for (const Host of [own, `localhost:${port}`, `[::1]:${port}`, `LOCALHOST:${port}`]) {
    assert.equal((await rawRequest(port, state, { Host })).status, 200, Host);
  }
  assert.equal((await rawRequest(port, state, { Host: own, 'Sec-Fetch-Site': 'same-origin' })).status, 200);
  assert.equal((await rawRequest(port, state, { Host: own, 'Sec-Fetch-Site': 'none' })).status, 200);
  assert.equal((await rawRequest(port, '/api/recall', { ...json, Host: own, Origin: `http://${own}` }, 'POST', RECALL)).status, 200);
});
