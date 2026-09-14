// A Turbo server must not outlive its record.
//
// On 2026-09-08 three `turbo-server.js` processes were found five days later,
// reparented to launchd, each bound to an ephemeral port, with no pid record
// anywhere. Their state dirs were born within a 40-second window of runs of
// turbo-external-reuse.test.js, at the moment loading the live corpus took
// longer than the controller's readiness budget. The chain was:
//
//   1. `start` spawned the server detached, wrote server.json, waited 5 s for
//      ready.json, then threw — without signalling the child it had created.
//   2. The test's cleanup ran `stop`, which refused: the ownership handshake
//      needs the ready file the child had not written yet.
//   3. The test removed the state dir. The child finished loading, recreated
//      the dir, bound the now-free port, and ran with no record: invisible to
//      `status`, unstoppable through the controller.
//
// Two layers close it. The controller reaps the child it spawned when
// readiness times out (ownership is certain there; no handshake needed). The
// server treats its ready file as a lease: if the state dir disappears, or the
// ready file is gone or names another pid, it exits instead of resurrecting
// the record.
//
// Hermetic: isolated state and corpus dirs, a free port per case, and the
// session-id chain cleared per CLAUDE.md.
//
// Run with: node --test tests/unit/turbo-orphan-reaping.test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

for (const name of [
  'CARTOGRAPHER_SESSION_ID',
  'CLAUDE_SESSION_ID',
  'CLAUDE_CODE_SESSION_ID',
  'CODEX_SESSION_ID',
]) delete process.env[name];

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CONTROL = path.join(ROOT, 'scripts', 'cartographer-turbo.js');
const SERVER = path.join(ROOT, 'scripts', 'turbo-server.js');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function waitFor(predicate, ms, label) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(50);
  }
  assert.fail(`timed out after ${ms}ms waiting for ${label}`);
}

function freePort() {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function isolated() {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-turbo-reap-'));
  const corpusDir = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-turbo-reap-corpus-'));
  const port = await freePort();
  const env = {
    ...process.env,
    CARTOGRAPHER_DEV_DIR: corpusDir,
    CARTOGRAPHER_TURBO_STATE_DIR: stateDir,
    CARTOGRAPHER_TURBO_URL: `http://127.0.0.1:${port}`,
    CARTOGRAPHER_TURBO: '1',
  };
  const readyFile = path.join(stateDir, 'ready.json');
  const pidFile = path.join(stateDir, 'server.json');
  const cleanup = () => {
    fs.rmSync(stateDir, { recursive: true, force: true });
    fs.rmSync(corpusDir, { recursive: true, force: true });
  };
  return { stateDir, corpusDir, port, env, readyFile, pidFile, cleanup };
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function commandOf(pid) {
  try { return execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }); } catch { return ''; }
}

test('start reaps the child it spawned when readiness times out', async () => {
  const ws = await isolated();
  let pid = null;
  try {
    // Run `start` and, the moment it has recorded its child, freeze that child
    // so it cannot publish ready.json inside the budget. SIGSTOP stands in for
    // the slow corpus load that produced the real orphans; SIGTERM is queued
    // behind it, so only a controller that escalates can reap this child.
    const started = new Promise((resolve) => {
      execFile(process.execPath, [CONTROL, 'start'], { env: ws.env }, (error, stdout, stderr) => {
        resolve({ error, stdout, stderr });
      });
    });
    await waitFor(() => readJson(ws.pidFile)?.pid, 5000, 'server.json');
    pid = Number(readJson(ws.pidFile).pid);
    assert.match(commandOf(pid), /turbo-server\.js/, 'the recorded pid must be the spawned server');
    process.kill(pid, 'SIGSTOP');

    const result = await started;
    assert.ok(result.error, 'start must fail when the child never becomes ready');
    assert.match(result.stderr, /did not become ready/);

    // The bug: `start` threw and walked away, leaving the child to finish
    // loading and run with no record. The controller owns this child; it must
    // be dead — SIGKILL if SIGTERM cannot land — before the failure is reported.
    await waitFor(() => !alive(pid), 2000, 'the abandoned child to be reaped');
    assert.equal(fs.existsSync(ws.pidFile), false, 'a dead child must not leave a pid record');
  } finally {
    if (pid && alive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    ws.cleanup();
  }
});

/** Spawn the server directly and wait until it has published ready.json. */
async function spawnReadyServer(t, ws) {
  const child = spawn(process.execPath, [SERVER], { env: ws.env, stdio: 'ignore' });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await once(child, 'exit');
    }
  });
  await waitFor(() => Number(readJson(ws.readyFile)?.pid) === child.pid, 15000, 'ready.json');
  return child;
}

async function exitedWithin(child, ms) {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(false), ms); });
  const exit = once(child, 'exit').then(() => true);
  const result = await Promise.race([exit, timeout]);
  clearTimeout(timer);
  return result;
}

test('a server whose ready file is removed exits instead of running unrecorded', async (t) => {
  const ws = await isolated();
  try {
    const child = await spawnReadyServer(t, ws);
    fs.unlinkSync(ws.readyFile);
    assert.ok(await exitedWithin(child, 8000), 'the server kept running after its lease was removed');
  } finally { ws.cleanup(); }
});

test('a server whose ready file names another pid exits', async (t) => {
  const ws = await isolated();
  try {
    const child = await spawnReadyServer(t, ws);
    // What a replacement looks like from the old server's side: the controller
    // spawned a successor that now holds the record.
    fs.writeFileSync(ws.readyFile, JSON.stringify({ pid: 1, contract_version: 1 }));
    assert.ok(await exitedWithin(child, 8000), 'the superseded server kept running');
    // It must not have clobbered the successor's record on the way out.
    assert.equal(readJson(ws.readyFile)?.pid, 1);
  } finally { ws.cleanup(); }
});

test('a server whose state dir is deleted exits and does not recreate it', async (t) => {
  const ws = await isolated();
  try {
    const child = await spawnReadyServer(t, ws);
    fs.rmSync(ws.stateDir, { recursive: true, force: true });
    assert.ok(await exitedWithin(child, 8000), 'the server kept running after its state dir was deleted');
    assert.equal(fs.existsSync(ws.stateDir), false, 'the server resurrected a deleted state dir');
  } finally { ws.cleanup(); }
});
