// The headless Turbo server binds the same port as the Explorer API and serves
// the Memory Desk routes, recall and facts over the same corpus. It had no Host
// check at all, so a DNS-rebinding page could read sessions through it the way
// it could through the API (api-loopback-guard.test.js). This drives the real
// service, started by the controller, over raw HTTP, because Node's fetch
// rewrites Host.
//
// Hermetic: temp corpus, state dir, and config; the session-id chain is
// cleared per CLAUDE.md; the service is stopped by the case that started it.

process.env.CARTOGRAPHER_SEMANTIC = '0';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { OFFLINE_INDEX_ENV } from './helpers/offline-index.js';

for (const name of [
  'CARTOGRAPHER_SESSION_ID',
  'CLAUDE_SESSION_ID',
  'CLAUDE_CODE_SESSION_ID',
  'CODEX_SESSION_ID',
]) delete process.env[name];

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CONTROL = path.join(ROOT, 'scripts', 'cartographer-turbo.js');
const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

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
  contract_version: 1, call_id: 'call-turbo-guard', query: 'pangolin', project: '', since: '', before: '',
  limit: 10, purpose: 'remember', session_id: '', provider: 'claude', excluded_event_ids: [],
});

test('turbo: the HTTP listener refuses forged Host, foreign Origin and cross-site requests', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-turbo-guard-'));
  const dev = path.join(root, 'dev');
  fs.mkdirSync(dev);
  // Padding keeps the query word's document frequency low enough to score.
  const rows = [
    { event_id: 'evt-turbo-guarded', timestamp: new Date().toISOString(), type: 'tool_bash', provider: 'claude',
      session_id: 'session-turbo-guarded', project: 'guarded', summary: 'Ran: echo pangolin' },
    ...['glacier notebook', 'copper lantern', 'meadow compass'].map((summary, i) => ({
      event_id: `evt-pad-${i}`, timestamp: '2026-09-25T12:00:00Z', project: 'padding', summary,
    })),
  ];
  fs.writeFileSync(path.join(dev, 'changelog.jsonl'), rows.map((row) => `${JSON.stringify(row)}\n`).join(''));
  const port = await freePort();
  const env = {
    ...process.env,
    ...OFFLINE_INDEX_ENV,
    CARTOGRAPHER_DEV_DIR: dev,
    CARTOGRAPHER_CONFIG: path.join(root, 'config.json'),
    CARTOGRAPHER_TURBO_STATE_DIR: path.join(root, 'state'),
    CARTOGRAPHER_TURBO_URL: `http://127.0.0.1:${port}`,
  };
  t.after(async () => {
    try { await run(process.execPath, [CONTROL, 'stop'], { env }); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  });

  await run(process.execPath, [CONTROL, 'start'], { env });
  // `start` returns on the first ready publish; the listen lands just after.
  const readyFile = path.join(env.CARTOGRAPHER_TURBO_STATE_DIR, 'ready.json');
  for (let i = 0; i < 100; i += 1) {
    try { if (JSON.parse(fs.readFileSync(readyFile, 'utf8')).http === 'listening') break; } catch {}
    await settle(50);
  }

  const own = `127.0.0.1:${port}`;
  const rebound = `rebind.attacker.example:${port}`;
  const state = '/api/memory/state?hours=1';
  const json = { 'Content-Type': 'application/json' };

  // The fixture is real: under a loopback Host each route serves the corpus.
  const served = await rawRequest(port, state, { Host: own });
  assert.equal(served.status, 200);
  assert.match(served.body, /session-turbo-guarded/, 'the memory state must carry the fixture session');
  const recalled = await rawRequest(port, '/api/recall', { ...json, Host: own }, 'POST', RECALL);
  assert.equal(recalled.status, 200);
  assert.match(recalled.body, /evt-turbo-guarded/, 'recall must find the fixture event');

  const refused = await rawRequest(port, state, { Host: rebound });
  assert.equal(refused.status, 403, 'a DNS-rebinding Host must be refused');
  assert.doesNotMatch(refused.body, /session-turbo-guarded/);
  for (const pathname of ['/api/memory/file?download=1', '/api/memory/health', '/api/recall/health', '/api/facts/health']) {
    assert.equal((await rawRequest(port, pathname, { Host: rebound })).status, 403, pathname);
  }
  const reboundRecall = await rawRequest(port, '/api/recall', { ...json, Host: rebound }, 'POST', RECALL);
  assert.equal(reboundRecall.status, 403);
  assert.doesNotMatch(reboundRecall.body, /evt-turbo-guarded/);
  assert.equal((await rawRequest(port, '/api/recall', { ...json, Host: own, Origin: 'https://attacker.example' }, 'POST', RECALL)).status, 403);
  assert.equal((await rawRequest(port, state, { Host: own, 'Sec-Fetch-Site': 'cross-site' })).status, 403);

  // The spellings Cartographer's own clients send still pass, and the service
  // is still answering after the refusals.
  for (const Host of [own, `localhost:${port}`, `[::1]:${port}`]) {
    assert.equal((await rawRequest(port, '/api/recall/health', { Host })).status, 200, Host);
  }
  const health = await fetch(`http://${own}/api/recall/health`);
  assert.equal(health.status, 200, 'Node fetch, as the recall client sends it, must pass');
});
