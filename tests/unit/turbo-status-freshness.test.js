// `cartographer-turbo.js status` reports `index_freshness`. It used to say
// "live" whenever the running process answered /api/recall/health, which
// proves the process is up and nothing about its watchers. On 2026-09-25 a log
// replaced by write-temp-then-rename left the watcher bound to the unlinked
// inode (fixed in 9e3d014), and status said "live" throughout while Turbo
// served 2 of 69 hermes milestones.
//
// So status now compares the byte offset and inode each watcher reports with
// the logs on disk. These cases drive the real CLI. The stale cases serve it the
// positions of a real `watchFiles` that has stopped, since the fixed watcher
// can no longer be made to stall on its own; the last case runs the real
// service end to end.
//
// Hermetic: temp corpus, state dir, and config per case; the session-id chain
// is cleared per CLAUDE.md; the one real service is stopped by the case that
// started it.

process.env.CARTOGRAPHER_SEMANTIC = '0';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { watchFiles } from '../../explorer/server/jsonl.js';
import { recallHealth } from '../../explorer/server/recall.js';

for (const name of [
  'CARTOGRAPHER_SESSION_ID',
  'CLAUDE_SESSION_ID',
  'CLAUDE_CODE_SESSION_ID',
  'CODEX_SESSION_ID',
]) delete process.env[name];

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CONTROL = path.join(ROOT, 'scripts', 'cartographer-turbo.js');
const RUNTIME_VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

// fs.watch needs a moment to arm, and the watcher debounces 100 ms.
const settle = (ms = 900) => new Promise((resolve) => setTimeout(resolve, ms));
const row = (id, summary) =>
  `${JSON.stringify({ event_id: id, timestamp: '2026-09-25T12:00:00Z', summary })}\n`;

function fixture(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const dev = path.join(root, 'dev');
  fs.mkdirSync(dev);
  fs.writeFileSync(path.join(dev, 'changelog.jsonl'), row('evt-c1', 'seed change') + row('evt-c2', 'second change'));
  fs.writeFileSync(path.join(dev, 'session-milestones.jsonl'), row('evt-m1', 'seed milestone'));
  const logs = {
    changelog: path.join(dev, 'changelog.jsonl'),
    milestones: path.join(dev, 'session-milestones.jsonl'),
  };
  const env = {
    ...process.env,
    CARTOGRAPHER_DEV_DIR: dev,
    CARTOGRAPHER_CONFIG: path.join(root, 'config.json'),
    CARTOGRAPHER_TURBO_STATE_DIR: path.join(root, 'state'),
    CARTOGRAPHER_QDRANT_URL: 'http://127.0.0.1:1',
    CARTOGRAPHER_EMBED_URL: 'http://127.0.0.1:1/v1/embeddings',
  };
  return { root, dev, logs, env, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

async function status(env) {
  const { stdout } = await run(process.execPath, [CONTROL, 'status'], { env });
  return JSON.parse(stdout).service;
}

/**
 * Stand in for the service: answer /api/recall/health with the real
 * `recallHealth` over the given watcher, and record the managed-server files
 * `status` reads before it will ask. The pid is this process, which is alive.
 */
async function serveWatcher(env, stop, { beforeReply = () => {} } = {}) {
  const hits = { count: 0 };
  const server = http.createServer((req, res) => {
    if (req.url !== '/api/recall/health') {
      res.writeHead(404);
      res.end();
      return;
    }
    hits.count += 1;
    beforeReply(hits.count);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(recallHealth({
      events: [],
      index: { docs: new Map() },
      watch: stop.positions(),
    })));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const state = env.CARTOGRAPHER_TURBO_STATE_DIR;
  fs.mkdirSync(state, { recursive: true, mode: 0o700 });
  const token = 'f'.repeat(48);
  fs.writeFileSync(path.join(state, 'server.json'), JSON.stringify({
    pid: process.pid,
    server_script: path.join(ROOT, 'scripts', 'turbo-server.js'),
    runtime_version: RUNTIME_VERSION,
    instance_token: token,
  }));
  fs.writeFileSync(path.join(state, 'ready.json'), JSON.stringify({
    pid: process.pid,
    contract_version: 1,
    runtime_version: RUNTIME_VERSION,
    instance_token: token,
    http: 'listening',
  }));
  return {
    hits,
    env: { ...env, CARTOGRAPHER_TURBO_URL: `http://127.0.0.1:${server.address().port}` },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test('a log appended while its watcher is stopped reads as stale', async () => {
  const f = fixture('carto-fresh-stalled-');
  const stop = watchFiles(() => {}, () => {}, f.logs);
  let stub;
  try {
    await settle(300);
    stop();
    const appended = row('evt-m2', 'milestone the stalled watcher never reads');
    fs.appendFileSync(f.logs.milestones, appended);
    stub = await serveWatcher(f.env, stop);

    const service = await status(stub.env);
    assert.equal(service.index_freshness, 'stale',
      'a watcher that stopped consuming a log must not be reported live');
    assert.equal(stub.hits.count, 2,
      'a first look that lags must be re-sampled before anything is called stale');
    assert.equal(service.watch.milestones.stale, true);
    assert.equal(service.watch.milestones.bytes_behind, Buffer.byteLength(appended),
      'the lag must be the bytes the watcher never consumed');
    assert.equal(service.watch.milestones.inode_mismatch, false);
    assert.equal(service.watch.changelog.stale, false, 'an untouched log is not stale');
  } finally {
    stop();
    await stub?.close();
    f.cleanup();
  }
});

test('a log replaced under a watcher that did not re-arm reads as stale', async () => {
  // The pre-9e3d014 shape: a repair script writes a temp file beside the log
  // and renames it over the original, and the watcher stays on the old inode.
  const f = fixture('carto-fresh-replaced-');
  const stop = watchFiles(() => {}, () => {}, f.logs);
  let stub;
  try {
    await settle(300);
    stop();
    const inodeBefore = fs.statSync(f.logs.milestones).ino;
    const tmp = `${f.logs.milestones}.tmp-repair`;
    fs.writeFileSync(tmp, row('evt-m1', 'seed milestone, repaired'));
    fs.renameSync(tmp, f.logs.milestones);
    assert.notEqual(fs.statSync(f.logs.milestones).ino, inodeBefore, 'the fixture must replace the inode');
    stub = await serveWatcher(f.env, stop);

    const service = await status(stub.env);
    assert.equal(service.index_freshness, 'stale');
    assert.equal(service.watch.milestones.stale, true);
    assert.equal(service.watch.milestones.inode_mismatch, true,
      'a watcher bound to an unlinked inode must be named as such');
    assert.equal(service.watch.milestones.bytes_behind, null,
      'bytes on two different files are not a lag');
    assert.equal(service.watch.changelog.stale, false);
  } finally {
    stop();
    await stub?.close();
    f.cleanup();
  }
});

test('an append still in flight at the first look reads as live', async () => {
  // Appends are continuous, so a first look often catches the watcher inside
  // its debounce. The stub appends while answering the first request, so the
  // first look lags by construction; a working watcher must clear it by the
  // second.
  const f = fixture('carto-fresh-inflight-');
  const stop = watchFiles(() => {}, () => {}, f.logs);
  let stub;
  try {
    await settle(300);
    stub = await serveWatcher(f.env, stop, {
      beforeReply: (n) => {
        if (n === 1) fs.appendFileSync(f.logs.changelog, row('evt-c3', 'append racing the status call'));
      },
    });

    const service = await status(stub.env);
    assert.equal(stub.hits.count, 2, 'the fixture must make the first look lag');
    assert.equal(service.index_freshness, 'live',
      'an append the watcher consumes within the grace period is not a stall');
    assert.equal(service.watch.changelog.bytes_behind, 0);
    assert.equal(service.watch.changelog.stale, false);
  } finally {
    stop();
    await stub?.close();
    f.cleanup();
  }
});

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

test('the real service reports its watcher positions, and a replaced log stays live', async () => {
  const f = fixture('carto-fresh-real-');
  const env = { ...f.env, CARTOGRAPHER_TURBO_URL: `http://127.0.0.1:${await freePort()}` };
  try {
    await run(process.execPath, [CONTROL, 'start'], { env });
    // `start` returns on the first ready publish; the listen lands just after.
    const readyFile = path.join(env.CARTOGRAPHER_TURBO_STATE_DIR, 'ready.json');
    for (let i = 0; i < 100; i += 1) {
      try { if (JSON.parse(fs.readFileSync(readyFile, 'utf8')).http === 'listening') break; } catch {}
      await settle(50);
    }
    await settle(300); // let the service's watchers arm

    let service = await status(env);
    assert.equal(service.index_freshness, 'live');
    assert.deepEqual(Object.keys(service.watch).sort(),
      ['changelog', 'milestones', 'prompts', 'research', 'tool-use'],
      'every searched log must be reported');
    assert.equal(service.watch.milestones.consumed_bytes, fs.statSync(f.logs.milestones).size);
    assert.equal(service.watch.prompts.stale, false, 'a log absent from disk has nothing to lag');

    // The 2026-09-25 incident against the fixed watcher: replace by rename,
    // then keep appending. Status must see the service follow the new file.
    const tmp = `${f.logs.milestones}.tmp-repair`;
    fs.writeFileSync(tmp, row('evt-m1', 'seed milestone, repaired'));
    fs.renameSync(tmp, f.logs.milestones);
    await settle();
    fs.appendFileSync(f.logs.milestones, row('evt-m2', 'appended after the replace'));
    await settle();

    service = await status(env);
    assert.equal(service.index_freshness, 'live');
    assert.equal(service.watch.milestones.inode_mismatch, false);
    assert.equal(service.watch.milestones.consumed_bytes, fs.statSync(f.logs.milestones).size);
  } finally {
    try { await run(process.execPath, [CONTROL, 'stop'], { env }); } catch {}
    f.cleanup();
  }
});
