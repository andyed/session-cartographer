// A failed `start` must leave a trace in the log it points at.
//
// On 2026-09-26 at load average 72 on 16 CPUs, `cartographer-turbo.js start`
// exited 1 with "Turbo service did not become ready; see .../server.log", and
// server.log had not been written since the previous successful start.
// turbo-server.js wrote nothing until its corpus had loaded, and a child the
// controller killed at its 5 s deadline, or one killed from outside, left the
// log untouched either way. The same path runs when /remember auto-starts
// Turbo, where the only visible symptom is a drop to the portable CLI. A retry
// a minute later came up in 2,059 ms, so the cause is still open. These repairs
// make the next occurrence say which it was:
//   - the controller appends what became of the spawn to server.log, and
//     separates a child it killed at the deadline from one that died first;
//   - the server writes a line before it loads, so a spawn that never reaches
//     ready is still visible;
//   - CARTOGRAPHER_TURBO_READY_TIMEOUT_MS overrides the 5 s default.
//
// Hermetic: isolated state and corpus dirs and a free port per case. The
// session-id chain is cleared per CLAUDE.md. No search runs, so no semantic
// leg or telemetry log is reached.
//
// Run with: node --test tests/unit/turbo-start-diagnostics.test.js

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
    await sleep(25);
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
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-turbo-diag-'));
  const corpusDir = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-turbo-diag-corpus-'));
  const port = await freePort();
  const env = {
    ...process.env,
    CARTOGRAPHER_DEV_DIR: corpusDir,
    CARTOGRAPHER_TURBO_STATE_DIR: stateDir,
    CARTOGRAPHER_TURBO_URL: `http://127.0.0.1:${port}`,
    CARTOGRAPHER_TURBO: '1',
    // Hold the child before its load, so it cannot publish ready.json inside
    // any deadline these cases set. It stands in for a slow corpus load.
    CARTOGRAPHER_TURBO_TEST_STARTUP_DELAY_MS: '15000',
  };
  delete env.CARTOGRAPHER_TURBO_READY_TIMEOUT_MS;
  return {
    stateDir,
    corpusDir,
    env,
    pidFile: path.join(stateDir, 'server.json'),
    readyFile: path.join(stateDir, 'ready.json'),
    logFile: path.join(stateDir, 'server.log'),
    cleanup: () => {
      fs.rmSync(stateDir, { recursive: true, force: true });
      fs.rmSync(corpusDir, { recursive: true, force: true });
    },
  };
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function readLog(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
}

function commandOf(pid) {
  try { return execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }); } catch { return ''; }
}

function runStart(env) {
  const began = Date.now();
  return new Promise((resolve) => {
    execFile(process.execPath, [CONTROL, 'start'], { env }, (error, stdout, stderr) => {
      resolve({ error, stdout, stderr, elapsed: Date.now() - began });
    });
  });
}

test('a start killed at its deadline says so in server.log and in the error', async () => {
  const ws = await isolated();
  ws.env.CARTOGRAPHER_TURBO_READY_TIMEOUT_MS = '2000';
  let pid = null;
  try {
    const started = runStart(ws.env);
    await waitFor(() => readJson(ws.pidFile)?.pid, 5000, 'server.json');
    pid = Number(readJson(ws.pidFile).pid);
    assert.match(commandOf(pid), /turbo-server\.js/, 'the recorded pid must be the spawned server');

    const result = await started;
    assert.ok(result.error, 'start must fail when the child never becomes ready');

    // Without this, a child that died on its own would satisfy the test too:
    // the case under test is a live child the controller gave up on.
    assert.ok(result.elapsed >= 2000,
      `the controller must have waited out its deadline (returned after ${result.elapsed} ms)`);

    const firstLine = result.stderr.split('\n')[0];
    // cartographer-search.sh carries only the first stderr line of `ensure`
    // into its fallback detail, so the diagnosis must be on that line.
    assert.match(firstLine, /did not become ready/);
    assert.match(firstLine, new RegExp(`pid ${pid}\\b`), 'the error must name the child');
    assert.match(firstLine, /still starting/, 'the error must say the child was alive when it was killed');
    assert.match(firstLine, /2000 ms deadline/, 'the error must name the deadline it applied');
    assert.match(firstLine, /load average \d+(\.\d+)? on \d+ CPUs/, 'the error must carry the load it saw');

    // The defect: server.log was the file the error named, and it was empty.
    const log = readLog(ws.logFile);
    const control = log.split('\n').filter((line) => line.startsWith('[turbo-control]'));
    assert.equal(control.length, 1, `server.log must record the failed spawn once:\n${log}`);
    assert.match(control[0], new RegExp(`pid ${pid} was still starting at the 2000 ms deadline and was killed`));
    assert.match(control[0], /^\[turbo-control\] \d{4}-\d\d-\d\dT[\d:.]+Z /, 'the line must be timestamped');

    await waitFor(() => !alive(pid), 2000, 'the killed child to be gone');
    assert.equal(fs.existsSync(ws.pidFile), false, 'a dead child must not leave a pid record');
  } finally {
    if (pid && alive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    ws.cleanup();
  }
});

test('a child that dies before ready is reported as exited, not as timed out', async () => {
  const ws = await isolated();
  // Long enough that returning early proves the controller noticed the death
  // rather than waiting out the clock.
  ws.env.CARTOGRAPHER_TURBO_READY_TIMEOUT_MS = '20000';
  let pid = null;
  try {
    const started = runStart(ws.env);
    await waitFor(() => readJson(ws.pidFile)?.pid, 5000, 'server.json');
    pid = Number(readJson(ws.pidFile).pid);
    assert.match(commandOf(pid), /turbo-server\.js/, 'the recorded pid must be the spawned server');
    // What jetsam or an operator's kill looks like from the controller's side.
    process.kill(pid, 'SIGKILL');

    const result = await started;
    assert.ok(result.error, 'start must fail when the child dies');
    assert.ok(result.elapsed < 10000,
      `the controller must notice the death, not wait out the deadline (took ${result.elapsed} ms)`);

    const firstLine = result.stderr.split('\n')[0];
    assert.match(firstLine, new RegExp(`pid ${pid} exited \\(signal SIGKILL\\)`));
    assert.doesNotMatch(firstLine, /still starting/);

    const control = readLog(ws.logFile).split('\n').filter((line) => line.startsWith('[turbo-control]'));
    assert.equal(control.length, 1, 'server.log must record the failed spawn once');
    assert.match(control[0], new RegExp(`pid ${pid} exited \\(signal SIGKILL\\) after \\d+ ms, before writing ready\\.json`));
  } finally {
    if (pid && alive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    ws.cleanup();
  }
});

test('the server writes a line before it loads the corpus', async (t) => {
  const ws = await isolated();
  const out = fs.openSync(ws.logFile, 'a');
  const child = spawn(process.execPath, [SERVER], { env: ws.env, stdio: ['ignore', out, out] });
  fs.closeSync(out);
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await once(child, 'exit');
    }
    ws.cleanup();
  });
  const expected = new RegExp(
    `^\\[turbo\\] \\d{4}-\\d\\d-\\d\\dT[\\d:.]+Z pid ${child.pid} loading corpus from `
    + `${ws.corpusDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\(modules loaded after \\d+ ms\\)$`,
    'm',
  );
  await waitFor(() => expected.test(readLog(ws.logFile)), 10000, `a loading line for pid ${child.pid}`);
  // The line has to be there while the child is still short of ready, or it
  // leaves no more trace than the old post-load line did.
  assert.equal(fs.existsSync(ws.readyFile), false, 'the loading line must precede ready.json');
});

test('the ready deadline keeps its 5 s default and takes an explicit override', async () => {
  const { turboReadyTimeoutMs } = await import('../../scripts/turbo-common.js');
  const settings = { timeoutMs: 1500 };

  assert.equal(turboReadyTimeoutMs(settings, {}), 5000, 'the default is unchanged');
  assert.equal(turboReadyTimeoutMs({ timeoutMs: 8000 }, {}), 8000,
    'a request budget above 5 s still raises it, as before');
  assert.equal(turboReadyTimeoutMs(settings, { CARTOGRAPHER_TURBO_READY_TIMEOUT_MS: '12000' }), 12000,
    'an explicit budget wins');
  assert.equal(turboReadyTimeoutMs({ timeoutMs: 8000 }, { CARTOGRAPHER_TURBO_READY_TIMEOUT_MS: '2500' }), 2500,
    'an explicit budget wins over the request budget too');
  for (const bad of ['abc', '-1', '10', '999999999', '']) {
    assert.equal(turboReadyTimeoutMs(settings, { CARTOGRAPHER_TURBO_READY_TIMEOUT_MS: bad }), 5000,
      `an invalid budget (${JSON.stringify(bad)}) is ignored`);
  }
});
