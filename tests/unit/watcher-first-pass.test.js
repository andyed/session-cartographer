import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { watchFiles } from '../../explorer/server/jsonl.js';

const settle = (ms = 900) => new Promise((r) => setTimeout(r, ms));
const row = (id, summary) =>
  `${JSON.stringify({ event_id: id, timestamp: '2026-09-26T12:00:00Z', summary })}\n`;

// Both servers arm the watcher and then load the corpus in the same tick. On
// macOS a file watch reaches the kernel only when the event loop next polls, so
// an append during the load raises no event on it; measured, 0 of 5 did. The
// directory watch caught them in isolation and missed under suite load, which
// is why the service-level test in watcher-startup-window.test.js only failed
// when the machine was busy. Here no watch can report anything, so the only
// way the row arrives is the pass watchFiles makes after the caller's tick.
test('an append in the tick the watcher arms is read without any watch event', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-first-pass-'));
  const changelog = path.join(dir, 'changelog.jsonl');
  const milestones = path.join(dir, 'session-milestones.jsonl');
  fs.writeFileSync(changelog, row('evt-c1', 'seed'));
  fs.writeFileSync(milestones, row('evt-m1', 'seed'));

  const appended = [];
  const rewrites = [];
  const original = fs.watch;
  let watches = 0;
  // A watcher that is armed and never fires: the macOS case at its worst.
  fs.watch = () => {
    watches += 1;
    const silent = new EventEmitter();
    silent.close = () => {};
    return silent;
  };
  syncBuiltinESMExports();
  let stop;
  try {
    stop = watchFiles(
      (events) => appended.push(...events.map((e) => `${e._source}:${e.event_id}`)),
      (source) => rewrites.push(source),
      { changelog, milestones },
    );
    // The caller's load, still in the arming tick.
    fs.appendFileSync(changelog, row('evt-c2', 'appended while the corpus loads'));
  } finally {
    fs.watch = original;
    syncBuiltinESMExports();
  }

  try {
    // Without this, a real watch could be delivering the row and the test
    // would pass against a watcher with no first pass.
    assert.equal(watches, 3, 'the stub must stand in for both file watches and the directory watch');
    await settle();
    assert.deepEqual(appended, ['changelog:evt-c2'],
      'the row appended in the arming tick must be read by the first pass');
    assert.deepEqual(rewrites, [], 'an untouched log must not read as rewritten');
    assert.equal(stop.positions().changelog.offset, fs.statSync(changelog).size);
  } finally {
    stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
