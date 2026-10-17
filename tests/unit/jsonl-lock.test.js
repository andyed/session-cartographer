/**
 * tests/unit/jsonl-lock.test.js
 *
 * The repair scripts replace a log whole while hooks keep appending to it. A
 * truncate-and-write loses every row appended between its read and its write,
 * and nothing reports it. scripts/jsonl-lock.js is the shared protocol: a
 * rewriter marks "<log>.rewrite" held, replaces by temp + rename carrying
 * everything appended past what it read, marks it released, and appends late
 * arrivals and the spool; appenders (cartographer_append in hooks/common.sh,
 * appendJsonl) divert to "<log>.spool" while a live pid holds it, and write a
 * row again when the state changed while it was being written.
 *
 * The race test runs real bash writers through cartographer_append during
 * repeated replaces and requires every writer row back. The first version of
 * the protocol had only a grace period after release; this test lost a row at
 * load average 160 (a cat that opened the old file before the rename and wrote
 * after the last look), which is why appenders re-read the state. Its
 * control runs the same writers against a naive read-then-write and must see
 * rows lost, or the writers are not landing inside the rewrite window and the
 * clean result proves nothing.
 *
 * Run with: node --test tests/unit/jsonl-lock.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  acquireRewriteLock, APPEND_TRIES, appendJsonl, drainSpool, lockPath, lockStatus, releaseRewriteLock,
  replaceJsonl, RewriteConflictError, snapshotJsonl, spoolPath, statePath,
} from '../../scripts/jsonl-lock.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const COMMON = path.join(ROOT, 'plugins', 'session-cartographer', 'hooks', 'common.sh');
const LOCK_CLI = path.join(ROOT, 'scripts', 'jsonl-lock.js');

function tempLog(rows = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-lock-'));
  const file = path.join(dir, 'log.jsonl');
  fs.writeFileSync(file, rows.map((row) => `${JSON.stringify(row)}\n`).join(''));
  return { dir, file };
}

const rowsOf = (file) => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));

function bashAppend(file, row) {
  const run = spawnSync('bash', ['-c', '. "$1"; cartographer_append "$2" "$3"', '_', COMMON, file, JSON.stringify(row)], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
}

// A pid that existed and has exited: a crashed rewriter.
function deadPid() {
  const child = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  return Number(child.stdout);
}

test('a live holder diverts both appenders to the spool; a dead one diverts neither', () => {
  const { dir, file } = tempLog([{ event_id: 'seed' }]);
  const handle = acquireRewriteLock(file);
  bashAppend(file, { event_id: 'hook-row' });
  appendJsonl(file, JSON.stringify({ event_id: 'script-row' }));
  assert.deepEqual(rowsOf(file).map((r) => r.event_id), ['seed']);
  assert.deepEqual(rowsOf(spoolPath(file)).map((r) => r.event_id), ['hook-row', 'script-row']);
  assert.equal(lockStatus(file).spooled_rows, 2);

  // The holder is gone: rows go to the log, and the spool waits for a drain.
  fs.writeFileSync(statePath(file), `held ${deadPid()} 7 host 2026-10-16T00:00:00Z\n`);
  bashAppend(file, { event_id: 'after-crash' });
  assert.deepEqual(rowsOf(file).map((r) => r.event_id), ['seed', 'after-crash']);
  releaseRewriteLock(handle);
  assert.equal(drainSpool(file), 2);
  assert.deepEqual(rowsOf(file).map((r) => r.event_id), ['seed', 'after-crash', 'hook-row', 'script-row']);
  assert.equal(fs.existsSync(spoolPath(file)), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('replaceJsonl carries rows appended after the read, untransformed, and keeps the mode', () => {
  const { dir, file } = tempLog([{ event_id: 'a', n: 1 }, { event_id: 'b', n: 2 }]);
  fs.chmodSync(file, 0o640);
  const raw = fs.readFileSync(file);
  bashAppend(file, { event_id: 'late-1', n: 3 });
  appendJsonl(file, JSON.stringify({ event_id: 'late-2', n: 4 }));
  const body = raw.toString('utf8').split('\n').map((line) => {
    if (!line) return line;
    const row = JSON.parse(line);
    return JSON.stringify({ ...row, n: row.n * 10 });
  }).join('\n');

  const result = replaceJsonl(file, { original: raw, body, graceMs: 0 });
  assert.equal(result.carried_rows, 2);
  assert.deepEqual(rowsOf(file), [
    { event_id: 'a', n: 10 }, { event_id: 'b', n: 20 },
    { event_id: 'late-1', n: 3 }, { event_id: 'late-2', n: 4 },
  ]);
  assert.equal(fs.statSync(file).mode & 0o777, 0o640);
  assert.equal(fs.existsSync(lockPath(file)), false, 'the lock is released');
  assert.match(fs.readFileSync(statePath(file), 'utf8'), /^released /);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['log.jsonl', 'log.jsonl.rewrite'], 'no temp file is left beside the log');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a change that is not an append is refused and nothing is written', () => {
  const { dir, file } = tempLog([{ event_id: 'a' }, { event_id: 'b' }]);
  const raw = fs.readFileSync(file);
  // Another rewriter got there first.
  fs.writeFileSync(file, `${JSON.stringify({ event_id: 'a', theirs: true })}\n`);
  assert.throws(() => replaceJsonl(file, { original: raw, body: 'ours\n', graceMs: 0 }), RewriteConflictError);
  assert.deepEqual(rowsOf(file), [{ event_id: 'a', theirs: true }]);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['log.jsonl', 'log.jsonl.rewrite'], 'no lock or temp file is left');
  assert.match(fs.readFileSync(statePath(file), 'utf8'), /^released /, 'a refused rewrite still releases');
  // A read that ended inside a row cannot be carried from: the writer's
  // remainder would land beside the rewriter's copy of the fragment.
  assert.throws(() => replaceJsonl(file, { original: '{"event_id":"a"', body: '', graceMs: 0 }), /row boundary/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a dead rewriter\'s lock is reclaimed and its spool lands before the new copy', () => {
  const { dir, file } = tempLog([{ event_id: 'a' }]);
  const dead = deadPid();
  fs.writeFileSync(lockPath(file), `${dead} host 2026-10-16T00:00:00Z\n`);
  fs.writeFileSync(statePath(file), `held ${dead} 7 host 2026-10-16T00:00:00Z\n`);
  fs.writeFileSync(spoolPath(file), `${JSON.stringify({ event_id: 'stranded' })}\n`);
  const raw = fs.readFileSync(file);
  const result = replaceJsonl(file, { original: raw, body: `${JSON.stringify({ event_id: 'a', fixed: true })}\n`, graceMs: 0, waitMs: 0 });
  assert.equal(result.carried_rows, 1);
  assert.deepEqual(rowsOf(file), [{ event_id: 'a', fixed: true }, { event_id: 'stranded' }]);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['log.jsonl', 'log.jsonl.rewrite']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a live holder makes a second rewriter wait, then give up with its name', () => {
  const { dir, file } = tempLog([{ event_id: 'a' }]);
  fs.writeFileSync(lockPath(file), `${process.pid} host 2026-10-16T00:00:00Z\n`);
  assert.throws(
    () => replaceJsonl(file, { original: fs.readFileSync(file), body: '', graceMs: 0, waitMs: 200 }),
    new RegExp(`being rewritten by pid ${process.pid}`),
  );
  assert.deepEqual(rowsOf(file), [{ event_id: 'a' }]);
  fs.rmSync(dir, { recursive: true, force: true });
});

// Wait, without yielding: the rewriter under test is synchronous, and the
// appenders are separate processes that keep running while it blocks.
function waitFor(predicate, ms = 10000) {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
}

// Run <during> inside replaceJsonl at two points, by wrapping fs.renameSync,
// which the module calls through the same fs object: once the state file has
// just been renamed to say held, and once the new copy is about to be renamed
// over the log.
function replaceWithPauses(file, { afterHeld, beforeSwap }) {
  const rename = fs.renameSync;
  fs.renameSync = function patched(from, to) {
    if (to === file && String(from).startsWith(`${file}.rewrite-`)) beforeSwap?.();
    rename.call(fs, from, to);
    if (to === statePath(file) && fs.readFileSync(to, 'utf8').startsWith('held ')) afterHeld?.();
  };
  try {
    const raw = snapshotJsonl(file);
    return replaceJsonl(file, { original: raw, body: raw, graceMs: 50 });
  } finally {
    fs.renameSync = rename;
  }
}

test('a dead rewriter\'s spool is moved before the state says held, never after', () => {
  const { dir, file } = tempLog([{ event_id: 'a' }]);
  const dead = deadPid();
  fs.writeFileSync(lockPath(file), `${dead} host 2026-10-16T00:00:00Z\n`);
  fs.writeFileSync(statePath(file), `held ${dead} 3 host 2026-10-16T00:00:00Z\n`);
  fs.writeFileSync(spoolPath(file), `${JSON.stringify({ event_id: 'orphan' })}\n`);
  const states = [];
  const rename = fs.renameSync;
  fs.renameSync = function spy(from, to) {
    if (from === spoolPath(file)) states.push(fs.readFileSync(statePath(file), 'utf8').trim());
    if (to === file) fs.appendFileSync(spoolPath(file), `${JSON.stringify({ event_id: 'spooled-while-held' })}\n`);
    return rename.call(fs, from, to);
  };
  try {
    const raw = snapshotJsonl(file);
    replaceJsonl(file, { original: raw, body: raw, graceMs: 0 });
  } finally {
    fs.renameSync = rename;
  }
  assert.equal(states.length, 2, 'the orphan spool and the one written while held are each moved once');
  for (const state of states) assert.ok(!state.startsWith(`held ${process.pid} `), `the spool moved while the state read "${state}"`);
  assert.deepEqual(rowsOf(file).map((r) => r.event_id).sort(), ['a', 'orphan', 'spooled-while-held']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('an appender that opens the spool as a rewrite says held keeps its row (the CI race)', { timeout: 60000 }, async () => {
  // Found on 2-4 core runners: the rewriter said held, an appender read it and
  // opened the spool, the rewriter then moved the spool (renamed, read, unlinked),
  // and the appender's row went into the unlinked file. Its second read still
  // said held, so it never wrote again. Here the interleaving is forced: a cat
  // shim slows the appender's write, and the rewriter waits at its rename until
  // the appender has finished.
  const { dir, file } = tempLog([{ event_id: 'seed' }]);
  const shim = path.join(dir, 'bin');
  fs.mkdirSync(shim);
  fs.writeFileSync(path.join(shim, 'cat'), '#!/bin/bash\nsleep 0.3\nexec /bin/cat "$@"\n', { mode: 0o755 });
  const done = path.join(dir, 'appender-done');
  const row = JSON.stringify({ event_id: 'raced', pad: 'r'.repeat(1500) });   // past 1023 bytes: the cat path
  let appender;
  replaceWithPauses(file, {
    afterHeld() {
      appender = spawn('bash', ['-c', '. "$1"; cartographer_append "$2" "$3"; : > "$4"', '_', COMMON, file, row, done],
        { env: { ...process.env, PATH: `${shim}:${process.env.PATH}` }, stdio: 'ignore' });
      waitFor(() => fs.existsSync(spoolPath(file)));                       // it read held and opened the spool
    },
    beforeSwap() { waitFor(() => fs.existsSync(done)); },                    // it wrote, re-read held, returned
  });
  await new Promise((resolve) => (appender.exitCode !== null ? resolve() : appender.on('exit', resolve)));
  drainSpool(file);
  const ids = rowsOf(file).map((r) => r.event_id);
  assert.equal(ids.filter((id) => id === 'raced').length, 1, `the raced row must arrive once: ${JSON.stringify(ids)}`);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a drain takes complete rows only; the fragment of a write still landing is left to its appender', () => {
  const { dir, file } = tempLog([{ event_id: 'a' }]);
  fs.writeFileSync(spoolPath(file), `${JSON.stringify({ event_id: 'whole' })}\n{"event_id":"half`);
  assert.equal(drainSpool(file), 1);
  assert.deepEqual(rowsOf(file).map((r) => r.event_id), ['a', 'whole']);
  fs.rmSync(dir, { recursive: true, force: true });
});

// writer <file> <tag> <count>: appends tagged rows through cartographer_append,
// a few hundred microseconds apart, like a busy hook.
const WRITER = '. "$1"; f=$2; tag=$3; i=0; pad=$(printf "%*s" 1500 "" | tr " " x); '
  + 'while [ $i -lt "$4" ]; do cartographer_append "$f" "{\\"w\\":\\"$tag\\",\\"i\\":$i,\\"pad\\":\\"$pad\\"}"; i=$((i+1)); done';

function startWriters(file, count) {
  return [...'uvwxyz'].map((tag) => new Promise((resolve, reject) => {
    const child = spawn('bash', ['-c', WRITER, '_', COMMON, file, tag, String(count)], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(stderr))));
  }));
}

// Rewrites the seed rows, leaving writer rows alone, until the writers finish.
async function rewriteWhileWriting(file, writers, rewrite) {
  let done = false;
  const all = Promise.all(writers).then(() => { done = true; });
  let rewrites = 0;
  let moved = 0;
  while (!done) {
    const raw = snapshotJsonl(file);
    const body = raw.toString('utf8').split('\n').map((line) => {
      if (!line) return line;
      const row = JSON.parse(line);
      return row.seed ? JSON.stringify({ ...row, rewrites: (row.rewrites || 0) + 1 }) : line;
    }).join('\n');
    moved += rewrite(file, raw, body);
    rewrites += 1;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await all;
  return { rewrites, moved };
}

function writerRows(file, count) {
  const seen = new Map();
  for (const row of rowsOf(file)) if (row.w) seen.set(`${row.w}:${row.i}`, (seen.get(`${row.w}:${row.i}`) || 0) + 1);
  const expected = 6 * count;
  const lost = expected - seen.size;
  const doubled = [...seen.values()].filter((n) => n > 1).length;
  const most = Math.max(0, ...seen.values());
  return { lost, doubled, most, expected };
}

test('replaces racing six appenders lose nothing, and write no row more often than an appender may', { timeout: 120000 }, async (t) => {
  const { dir, file } = tempLog(Array.from({ length: 2000 }, (_, i) => ({ event_id: `seed-${i}`, seed: true })));
  const count = 300;
  const { rewrites, moved } = await rewriteWhileWriting(file, startWriters(file, count), (target, raw, body) => {
    const r = replaceJsonl(target, { original: raw, body, graceMs: 20 });
    return r.carried_rows + r.late_rows + r.spooled_rows;
  });
  drainSpool(file);
  const { lost, doubled, most } = writerRows(file, count);
  t.diagnostic(`${rewrites} rewrites, ${moved} rows moved by them, ${doubled} doubled`);
  assert.ok(rewrites >= 2, `only ${rewrites} rewrite(s) ran while the writers did`);
  assert.ok(moved > 0, 'no row arrived during a rewrite, so the race was not exercised');
  assert.equal(lost, 0, `${lost} writer row(s) lost`);
  // At least once: a row whose write spans a rewrite's release, or a whole
  // rewrite, can be both kept and written again; readers fold it by event_id.
  // The rewriter moves rows and never copies one, so a row exists once per
  // write of it, and an appender writes a row at most APPEND_TRIES times. How many
  // double depends on load: this test rewrites every few dozen ms, and doubled
  // 1-3 of 1,800 rows alone and ~200 under the full suite's parallel load.
  // A repair run is one rewrite per log.
  assert.ok(most <= APPEND_TRIES, `a writer row appears ${most} times; an appender writes a row at most ${APPEND_TRIES}`);
  assert.equal(rowsOf(file).filter((r) => r.seed).length, 2000, 'every seed row survives');
  assert.deepEqual(fs.readdirSync(dir).sort(), ['log.jsonl', 'log.jsonl.rewrite'], 'no lock, spool or temp file is left');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('control: a naive read-then-write under the same writers loses rows', { timeout: 120000 }, async () => {
  let lost = 0;
  for (let round = 0; round < 3 && lost === 0; round += 1) {
    const { dir, file } = tempLog(Array.from({ length: 2000 }, (_, i) => ({ event_id: `seed-${i}`, seed: true })));
    const count = 300;
    await rewriteWhileWriting(file, startWriters(file, count), (target, _raw, body) => {
      fs.writeFileSync(target, body);
      return 0;
    });
    lost = writerRows(file, count).lost;
    fs.rmSync(dir, { recursive: true, force: true });
  }
  assert.ok(lost > 0, 'the naive rewrite lost nothing: the writers are not landing in the rewrite window');
});

test('the CLI snapshot and replace verbs carry a shell rewriter the same way', () => {
  const { dir, file } = tempLog([{ event_id: 'a' }]);
  fs.appendFileSync(file, '{"event_id":"partial"');      // a row still being written
  const snapshot = path.join(dir, 'snapshot');
  const body = path.join(dir, 'body');
  const env = { ...process.env, CARTOGRAPHER_REWRITE_GRACE_MS: '0' };
  assert.equal(spawnSync(process.execPath, [LOCK_CLI, 'snapshot', file, snapshot], { env }).status, 0);
  assert.equal(fs.readFileSync(snapshot, 'utf8'), '{"event_id":"a"}\n', 'only complete rows are snapshotted');
  fs.appendFileSync(file, ',"done":true}\n');
  fs.writeFileSync(body, '{"event_id":"a","fixed":true}\n');
  const run = spawnSync(process.execPath, [LOCK_CLI, 'replace', file, snapshot, body], { env, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(rowsOf(file), [{ event_id: 'a', fixed: true }, { event_id: 'partial', done: true }]);
  fs.rmSync(dir, { recursive: true, force: true });
});
