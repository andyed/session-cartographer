import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { watchFiles } from '../../explorer/server/jsonl.js';

// fs.watch needs a moment to arm, and handleChange debounces 100ms.
const settle = (ms = 900) => new Promise((r) => setTimeout(r, ms));
const row = (id, summary) =>
  `${JSON.stringify({ event_id: id, timestamp: '2026-09-02T12:00:00Z', summary })}\n`;

test('appends are delivered incrementally, rewrites trigger a reload', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-rewrite-'));
  const file = path.join(dir, 'changelog.jsonl');
  fs.writeFileSync(file, row('evt-1', '/Users/me/.codex/sessions/a.jsonl')
                       + row('evt-2', '/Users/me/.codex/sessions/b.jsonl'));

  const appended = [];
  const rewrites = [];
  const stop = watchFiles(
    (events) => appended.push(...events.map((e) => e.event_id)),
    (source) => rewrites.push(source),
    { changelog: file },
  );

  try {
    await settle(300); // let the watchers arm before touching the file

    // 1. An ordinary append arrives as new events, not as a rewrite.
    fs.appendFileSync(file, row('evt-3', 'appended'));
    await settle();
    assert.deepEqual(appended, ['evt-3'], 'append should be delivered incrementally');
    assert.deepEqual(rewrites, [], 'append must not be mistaken for a rewrite');

    // 2. Repairing history in place — the exact shape of
    //    repair-transcript-paths.js — rewrites bytes BEFORE the watch offset and
    //    grows the file. The size check alone reads the shifted tail as fresh
    //    appends while every indexed record keeps its stale value.
    const repaired = fs.readFileSync(file, 'utf8')
      .replaceAll('/.codex/sessions/', '/.codex/archived_sessions/');
    assert.ok(repaired.length > fs.statSync(file).size, 'repair should grow the file');
    fs.writeFileSync(file, repaired);
    await settle();

    assert.deepEqual(rewrites, ['changelog'], 'in-place rewrite must be detected');
    assert.deepEqual(appended, ['evt-3'], 'a rewrite must not be replayed as appends');
  } finally {
    stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
