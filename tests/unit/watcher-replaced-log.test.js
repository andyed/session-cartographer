import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { watchFiles } from '../../explorer/server/jsonl.js';

// fs.watch needs a moment to arm, and handleChange debounces 100ms.
const settle = (ms = 900) => new Promise((r) => setTimeout(r, ms));
const row = (id, summary, session_id = 's-1') =>
  `${JSON.stringify({ event_id: id, timestamp: '2026-09-25T12:00:00Z', summary, session_id })}\n`;

// fs.watch on a file is bound to its inode, not its path. The repair scripts
// (repair-foreign-commit-sessions.js, backfill-event-ids.js,
// migrate-project-attribution.js) replace a log by writing a temp file beside
// it and renaming it over the original. The watcher fires once, for the
// unlink, and is then attached to a file nothing will ever write again. On
// 2026-09-25 that left the managed Turbo service reporting 2 hermes milestones
// while session-milestones.jsonl held 69 and was still growing.
test('a log replaced by write-temp-then-rename keeps delivering appends', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-replaced-'));
  const file = path.join(dir, 'session-milestones.jsonl');
  fs.writeFileSync(file, row('evt-1', 'first') + row('evt-2', 'second'));

  const appended = [];
  const rewrites = [];
  const stop = watchFiles(
    (events) => appended.push(...events.map((e) => e.event_id)),
    (source) => rewrites.push(source),
    { milestones: file },
  );

  try {
    await settle(300); // let the watchers arm before touching the file

    // The exact shape of repair-foreign-commit-sessions.js: rewrite a field on
    // an existing row, write the result to a temp file in the same directory,
    // rename it over the log.
    const inodeBefore = fs.statSync(file).ino;
    const tmp = `${file}.tmp-foreign-sessions`;
    fs.writeFileSync(tmp, row('evt-1', 'first', 'unknown') + row('evt-2', 'second'));
    fs.renameSync(tmp, file);
    // Without this, the test could pass on an in-place rewrite, which the
    // boundary hash already handled (jsonl-rewrite-detection.test.js).
    assert.notEqual(fs.statSync(file).ino, inodeBefore, 'the fixture must replace the inode');
    await settle();

    assert.deepEqual(rewrites, ['milestones'], 'a replaced log is a rewrite: the consumer must reload');
    assert.deepEqual(appended, [], 'the replaced contents must not be replayed as appends');

    // The defect: every append after the replace went to a file the watcher
    // could no longer see.
    fs.appendFileSync(file, row('evt-3', 'appended after the replace'));
    await settle();
    assert.deepEqual(appended, ['evt-3'], 'an append to the replacement must be delivered');

    // And the watcher stays live, rather than catching one event and dying.
    fs.appendFileSync(file, row('evt-4', 'second append after the replace'));
    await settle();
    assert.deepEqual(appended, ['evt-3', 'evt-4']);
    assert.deepEqual(rewrites, ['milestones'], 'plain appends must not raise further rewrites');
  } finally {
    stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a log deleted and recreated is re-watched and reported as a rewrite', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-recreated-'));
  const file = path.join(dir, 'changelog.jsonl');
  fs.writeFileSync(file, row('evt-1', 'first'));

  const appended = [];
  const rewrites = [];
  const stop = watchFiles(
    (events) => appended.push(...events.map((e) => e.event_id)),
    (source) => rewrites.push(source),
    { changelog: file },
  );

  try {
    await settle(300);
    fs.unlinkSync(file);
    await settle(300);
    // Hooks append with `>>`, which creates the file when it is missing.
    fs.appendFileSync(file, row('evt-2', 'first row of the new file'));
    await settle();

    // Everything resident from the old file is gone from disk, so the
    // consumer must reload; the reload reads evt-2 along with the rest.
    assert.deepEqual(rewrites, ['changelog']);

    fs.appendFileSync(file, row('evt-3', 'appended to the new file'));
    await settle();
    assert.deepEqual(appended, ['evt-3'], 'appends to the recreated log must be delivered');
  } finally {
    stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a log absent at startup is watched once it appears', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-appears-'));
  const present = path.join(dir, 'changelog.jsonl');
  const absent = path.join(dir, 'prompt-history.jsonl');
  fs.writeFileSync(present, row('evt-seed', 'seed'));

  const appended = [];
  const rewrites = [];
  const stop = watchFiles(
    (events) => appended.push(...events.map((e) => `${e._source}:${e.event_id}`)),
    (source) => rewrites.push(source),
    { changelog: present, prompts: absent },
  );

  try {
    await settle(300);
    // build-prompt-history.js creates the file on its first run.
    fs.appendFileSync(absent, row('evt-p1', 'first projected prompt'));
    await settle();
    assert.deepEqual(rewrites, ['prompts'], 'a new log must be loaded, not ignored until restart');

    fs.appendFileSync(absent, row('evt-p2', 'next projected prompt'));
    fs.appendFileSync(present, row('evt-c1', 'unrelated append'));
    await settle();
    assert.deepEqual(appended.sort(), ['changelog:evt-c1', 'prompts:evt-p2']);
  } finally {
    stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
