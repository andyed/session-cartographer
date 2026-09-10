import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createExplorerUiMiddleware, explorerUiPlugin } from '../../explorer/server/explorer-ui.js';

function request(url, overrides = {}) {
  return { url, method: 'GET', headers: { host: '127.0.0.1:2527' }, ...overrides };
}
function response() {
  return {
    headersSent: false,
    writeHead(status) { this.status = status; this.headersSent = true; },
    end(body) { this.body = body; },
  };
}

test('legacy requests share one lazy app while memory/control/telemetry retain their routing', async () => {
  let loads = 0, closed = 0, passed = 0;
  const seen = [];
  const middleware = createExplorerUiMiddleware({ loadApp: async () => {
    loads++;
    return { app: req => seen.push(req.url), close: () => closed++ };
  } });
  for (const url of ['/memory', '/api/memory/state', '/api/turbo/status', '/api/internals', '/api/recall', '/api/facts']) {
    await middleware(request(url), response(), () => passed++);
  }
  assert.equal(loads, 0);
  assert.equal(passed, 6);
  const urls = ['/api/events?limit=400', '/api/sessions?days=7', '/api/projects', '/api/search?q=fixture', '/api/autocomplete?prefix=fi', '/api/coterms?term=fixture', '/api/transcript?path=fixture', '/api/transcript/analysis?path=fixture', '/api/stream', '/api/health'];
  await Promise.all(urls.map(url => middleware(request(url), response(), () => assert.fail('legacy request escaped to Turbo'))));
  assert.equal(loads, 1);
  assert.deepEqual(seen.sort(), urls.sort());
  await middleware.close();
  await middleware.close();
  assert.equal(closed, 1);
});

test('rejects cross-origin and non-read requests before loading private corpus data', async () => {
  let loads = 0;
  const middleware = createExplorerUiMiddleware({ loadApp: async () => { loads++; } });
  for (const [overrides, status] of [
    [{ headers: { host: 'attacker.example' } }, 403],
    [{ headers: { host: '127.0.0.1:2527', origin: 'https://attacker.example' } }, 403],
    [{ headers: { host: '127.0.0.1:2527', 'sec-fetch-site': 'cross-site' } }, 403],
    [{ method: 'POST' }, 405],
  ]) {
    const res = response();
    await middleware(request('/api/events', overrides), res, () => assert.fail('request escaped'));
    assert.equal(res.status, status);
  }
  assert.equal(loads, 0);
});

test('failed startup can retry and closing during startup disposes the app', async () => {
  let attempts = 0, closed = 0;
  let finish;
  const middleware = createExplorerUiMiddleware({ loadApp: () => {
    if (++attempts === 1) throw new Error('fixture startup failure');
    return new Promise(resolve => { finish = resolve; });
  } });
  const failed = response();
  await middleware(request('/api/events'), failed, () => {});
  assert.equal(failed.status, 503);
  const res = response();
  const serving = middleware(request('/api/events'), res, () => {});
  await Promise.resolve();
  const closing = middleware.close();
  finish({ app: () => assert.fail('closed app served request'), close: () => closed++ });
  await Promise.all([serving, closing]);
  assert.equal(closed, 1);
  assert.equal(res.status, 503);
  const after = response();
  await middleware(request('/api/events'), after, () => {});
  assert.equal(after.status, 503);
  assert.equal(attempts, 2);
});

test('development and preview hosts dispose their own lazy app on shutdown', async () => {
  let closed = 0;
  const plugin = explorerUiPlugin({ loadApp: async () => ({ app() {}, close() { closed++; } }) });
  for (const hook of ['configureServer', 'configurePreviewServer']) {
    let middleware;
    const server = { httpServer: new EventEmitter(), middlewares: { use(fn) { middleware = fn; } } };
    plugin[hook](server);
    await middleware(request('/api/events'), response(), () => {});
    server.httpServer.emit('close');
    await Promise.resolve();
  }
  await plugin.closeBundle();
  assert.equal(closed, 2);
});
