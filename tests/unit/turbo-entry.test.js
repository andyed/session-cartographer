import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createTurboEntryMiddleware, turboEntryPlugin } from '../../explorer/server/turbo-entry.js';

const HEALTH = { status: 'ok', contract_version: 1, refresh_ms: 5000 };

function rawRequest(url, headers, method = 'GET', body = '') {
  return new Promise((resolve, reject) => {
    const request = http.request(url, { method, headers }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: response.statusCode })));
    });
    request.on('error', reject);
    request.end(body);
  });
}

async function fixture(t, { enabled = true, running = false, ready = false, ...overrides } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cartographer-entry-'));
  const config = path.join(root, 'config.json');
  fs.writeFileSync(config, JSON.stringify({ turbo: { enabled, url: 'http://127.0.0.1:45977' } }));
  const state = { enabled, running, ready, calls: [], proxied: [] };
  const middleware = createTurboEntryMiddleware({
    env: { ...process.env, CARTOGRAPHER_CONFIG: config, CARTOGRAPHER_TURBO_URL: 'http://127.0.0.1:45977' },
    startupProbeMs: 0,
    runController: async (command) => {
      state.calls.push(command);
      if (command === 'stop') state.running = false;
      if (command === 'enable') state.enabled = true;
      if (command === 'start' || command === 'enable') { state.running = true; state.ready = true; }
      return {
        enabled: state.enabled,
        service: { running: state.running, compatible: state.running, ready: { runtime_version: '0.7.5', instance_token: 'secret' } },
      };
    },
    probeMemory: async () => state.ready ? HEALTH : null,
    fetchImpl: async (url) => {
      state.proxied.push(url.toString());
      return new Response(JSON.stringify({ result: 'current memory' }), { status: 200 });
    },
    ...overrides,
  });
  const server = http.createServer((req, res) => middleware(req, res, () => { res.writeHead(404); res.end(); }));
  t.after(async () => {
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    state, url,
    get: (pathname = '/api/turbo/status', headers = {}) => fetch(`${url}${pathname}`, { headers }),
    post: (action, headers = {}, body) => fetch(`${url}/api/turbo/start`, {
      method: 'POST',
      headers: { Origin: url, 'Content-Type': 'application/json', 'X-Cartographer-Action': 'start', ...headers },
      body: body ?? JSON.stringify({ action }),
    }),
  };
}

test('cold status remains available on the UI host and never starts Turbo', async (t) => {
  const { get, state } = await fixture(t, { enabled: false });
  const response = await get();
  const status = await response.json();
  assert.equal(response.status, 200);
  assert.equal(status.ready, false);
  assert.equal(status.action, 'enable');
  assert.equal(status.url, 'http://127.0.0.1:45977');
  assert.deepEqual(state.calls, ['status']);
  assert.doesNotMatch(JSON.stringify(status), /secret|instance_token/);
});

test('start and enable use the shared controller and report verified readiness', async (t) => {
  for (const enabled of [true, false]) {
    const { post, state } = await fixture(t, { enabled });
    const action = enabled ? 'start' : 'enable';
    const response = await post(action);
    const status = await response.json();
    assert.equal(response.status, 200);
    assert.equal(status.ready, true);
    assert.equal(status.action, null);
    assert.equal(status.enabled, true);
    assert.deepEqual(state.calls, ['status', action, 'status']);
  }
});

test('a refresh is explicit and goes through the ownership-checking controller', async (t) => {
  const { get, post, state } = await fixture(t, { running: true });
  assert.equal((await (await get()).json()).action, 'refresh');
  const stale = await post('start');
  assert.equal(stale.status, 409);
  assert.deepEqual(state.calls, ['status', 'status']);
  const response = await post('refresh');
  assert.equal(response.status, 200);
  assert.deepEqual(state.calls, ['status', 'status', 'status', 'stop', 'start', 'status']);
});

test('a compatible external Explorer counts as ready without launching a second service', async (t) => {
  const { get, post, state } = await fixture(t, { enabled: false, running: false, ready: true });
  const status = await (await get()).json();
  assert.equal(status.ready, true);
  assert.equal(status.running, true);
  assert.equal(status.service.managed, false);
  assert.equal(status.action, null);
  assert.equal((await post('enable')).status, 200);
  assert.deepEqual(state.calls, ['status', 'status']);
});

test('refresh preserves a disabled global preference', async (t) => {
  const { post, state } = await fixture(t, { enabled: false, running: true });
  const response = await post('refresh');
  const status = await response.json();
  assert.equal(response.status, 200);
  assert.equal(status.ready, true);
  assert.equal(status.enabled, false);
  assert.equal(state.enabled, false);
  assert.deepEqual(state.calls, ['status', 'stop', 'start', 'status']);
});

test('duplicate start requests share one startup operation', async (t) => {
  const calls = [];
  let ready = false;
  const { post } = await fixture(t, {
    runController: async (command) => {
      calls.push(command);
      if (command === 'start') {
        await new Promise((resolve) => setTimeout(resolve, 100));
        ready = true;
      }
      return { enabled: true, service: { running: ready } };
    },
    probeMemory: async () => ready ? HEALTH : null,
  });
  const responses = await Promise.all([post('start'), post('start')]);
  assert.deepEqual(responses.map((r) => r.status), [200, 200]);
  assert.equal(calls.filter((call) => call === 'start').length, 1);
});

test('cross-origin, forged host, missing action header and non-JSON requests cannot mutate', async (t) => {
  const { post, state, url } = await fixture(t);
  for (const headers of [
    { Origin: 'https://attacker.example' },
    { Origin: '' },
    { 'X-Cartographer-Action': '' },
    { 'Content-Type': 'text/plain' },
    { 'Sec-Fetch-Site': 'cross-site' },
  ]) assert.equal((await post('start', headers)).status, 403, JSON.stringify(headers));
  // Node fetch rewrites Host, so exercise DNS-rebinding protection through HTTP directly.
  assert.equal((await rawRequest(`${url}/api/turbo/status`, { Host: 'attacker.example' })).status, 403);
  assert.equal((await rawRequest(`${url}/api/turbo/start`, {
    Host: 'attacker.example', Origin: url, 'Content-Type': 'application/json', 'X-Cartographer-Action': 'start',
  }, 'POST', '{"action":"start"}')).status, 403);
  assert.deepEqual(state.calls, []);
});

test('action payloads are fixed and bounded', async (t) => {
  const { post, state } = await fixture(t);
  for (const body of ['{', '{"action":"kill"}', '{"action":"start","url":"http://evil"}']) {
    assert.equal((await post('start', {}, body)).status, 400);
  }
  assert.equal((await post('start', {}, ' '.repeat(2049))).status, 413);
  assert.deepEqual(state.calls, []);
});

test('only fixed memory read routes proxy to the configured Turbo origin', async (t) => {
  const { get, state } = await fixture(t);
  for (const pathname of ['/api/memory/state?hours=24', '/api/memory/health', '/api/memory/file?session=one&path=%2Ftmp%2Fa.js']) {
    const response = await get(pathname);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { result: 'current memory' });
    assert.equal(state.proxied.at(-1), `http://127.0.0.1:45977${pathname}`);
  }
  assert.equal((await get('/api/memory/anything')).status, 404);
  assert.deepEqual(state.calls, []);
});

test('an HTTP 200 with the wrong memory contract does not claim readiness', async (t) => {
  const { get } = await fixture(t, {
    probeMemory: undefined,
    fetchImpl: async () => new Response(JSON.stringify({ status: 'ok', contract_version: 99 })),
  });
  assert.equal((await (await get()).json()).ready, false);
});

test('startup failure or missing memory API never becomes a false ready state', async (t) => {
  const { post } = await fixture(t, { probeMemory: async () => null });
  const response = await post('start');
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /working-memory API is unavailable/);
});

test('ownership rejection stops refresh before the launch command', async (t) => {
  const calls = [];
  const { post } = await fixture(t, {
    runController: async (command) => {
      calls.push(command);
      if (command === 'stop') throw new Error('refusing to stop: instance-token handshake does not match');
      return { enabled: true, service: { running: true } };
    },
  });
  const response = await post('refresh');
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /refusing to stop/);
  assert.deepEqual(calls, ['status', 'stop']);
});

test('the same entry middleware is installed for development and built preview', () => {
  const plugin = turboEntryPlugin();
  for (const hook of ['configureServer', 'configurePreviewServer']) {
    let middleware;
    const result = plugin[hook]({ middlewares: { use(value) { middleware = value; } } });
    assert.equal(typeof middleware, 'function');
    assert.equal(result, undefined, 'pre-hook placement runs before Vite API proxy middleware');
  }
});
