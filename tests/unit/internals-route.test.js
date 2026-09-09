import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createInternalsHandler, internalsUiPlugin } from '../../explorer/server/internals-route.js';

async function fixture(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'internals-route-'));
  const paths = Object.fromEntries(['served', 'access', 'searchCalls', 'indexErrors'].map(key => [key, path.join(dir, key + '.jsonl')]));
  for (const file of Object.values(paths)) fs.writeFileSync(file, '');
  const stamp = new Date().toISOString();
  fs.writeFileSync(paths.served, JSON.stringify({ timestamp: stamp, purpose: 'remember', call_id: 'route-call', event_id: 'route-event', rank: 2, project: 'fixture', source: 'changelog' })+'\n');
  fs.writeFileSync(paths.access, JSON.stringify({ timestamp: stamp, call_id: 'route-call', event_id: 'route-event', source: 'result_used' })+'\n');
  const handler = createInternalsHandler({ paths, ...options });
  const server = http.createServer((req, res) => handler(req, res, () => { res.writeHead(404); res.end(); }));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); fs.rmSync(dir, { recursive: true, force: true }); });
  return { get: (query = '', options) => fetch(`http://127.0.0.1:${server.address().port}/api/internals${query}`, options), paths };
}

test('UI-host route serves exact telemetry without a running warm backend', async t => {
  const { get } = await fixture(t, { getExplorerCounts: async () => { throw new Error('Turbo offline'); } });
  const response = await get('?window=7d');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('server-timing'), /internals;dur=/);
  const data = await response.json();
  assert.equal(data.utility.calls, 1);
  assert.equal(data.utility.explicitUse.callsWithUse, 1);
  assert.equal(data.utility.explicitUse.firstAccessMrr, 0.5);
  assert.equal(data.operations.explorer.capturedEvents, null);
});

test('route preserves filters, validation, force-refresh, and live index counts', async t => {
  const calls = [];
  const { get } = await fixture(t, {
    getSnapshot: async options => { calls.push(options); return { operations: { preserved: true } }; },
    getExplorerCounts: () => ({ capturedEvents: 23, keywordIndexedDocs: 21 }),
  });
  const response = await get('?window=all&purpose=feed&refresh=true');
  const data = await response.json();
  assert.equal(response.status, 200);
  assert.equal(calls[0].window, 'all');
  assert.equal(calls[0].purpose, 'feed');
  assert.equal(calls[0].refresh, true);
  assert.equal(data.operations.explorer.keywordIndexedDocs, 21);
  assert.equal(data.operations.preserved, true);
  assert.equal((await get('?window=invalid')).status, 400);
  assert.equal((await get('?purpose=invalid%20purpose')).status, 400);
  assert.equal((await get('', { method: 'POST' })).status, 405);
  assert.equal(calls.length, 1);
});

test('Internals is registered before proxying in both UI-host modes', () => {
  const plugin = internalsUiPlugin();
  for (const hook of ['configureServer', 'configurePreviewServer']) {
    let handler;
    assert.equal(plugin[hook]({ middlewares: { use(value) { handler = value; } } }), undefined);
    assert.equal(typeof handler, 'function');
  }
});
