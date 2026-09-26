import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { watchFiles } from '../../explorer/server/jsonl.js';

// fs.watch needs a moment to arm, and the watcher debounces 100 ms.
const settle = (ms = 900) => new Promise((r) => setTimeout(r, ms));
const row = (id, summary) =>
  `${JSON.stringify({ event_id: id, timestamp: '2026-09-26T12:00:00Z', summary })}\n`;

// A writer can be caught mid-line: a large row, or one written in more than one
// write(), leaves a fragment with no newline yet. The watcher used to parse the
// fragment, skip it as malformed, and still count its bytes as consumed. The
// rest of the line then arrived as a second fragment, failed the same way, and
// the event was never indexed, while the offset matched the file and status
// read "live". readAppended already stops at the last newline; the watcher must
// do the same.
test('a line written in two halves is delivered once it is complete', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-partial-'));
  const file = path.join(dir, 'changelog.jsonl');
  fs.writeFileSync(file, row('evt-1', 'seed'));

  const appended = [];
  const stop = watchFiles(
    (events) => appended.push(...events.map((e) => ({ id: e.event_id, summary: e.summary }))),
    () => {},
    { changelog: file },
  );

  try {
    await settle(300);

    // Split inside a multi-byte character, so an offset counted in characters
    // rather than bytes, or a fragment decoded on its own, corrupts the row.
    const summary = 'split across two writes — naïve café 🗺️';
    const whole = row('evt-3', summary);
    const bytes = Buffer.from(whole, 'utf-8');
    const cut = bytes.indexOf(Buffer.from('🗺️', 'utf-8')) + 2;
    const completeRow = row('evt-2', 'complete row ahead of the fragment');
    fs.appendFileSync(file, Buffer.concat([Buffer.from(completeRow, 'utf-8'), bytes.subarray(0, cut)]));
    await settle();

    // Without this, the test cannot tell whether the watcher ran between the
    // two halves; if it did not, the halves arrive together and any code passes.
    assert.deepEqual(appended.map((e) => e.id), ['evt-2'],
      'the debounce must fire while the second row is still a fragment');
    const endOfComplete = fs.statSync(file).size - cut;
    assert.equal(stop.positions().changelog.offset, endOfComplete,
      'a fragment must not count as consumed');

    fs.appendFileSync(file, bytes.subarray(cut));
    await settle();

    assert.deepEqual(appended.map((e) => e.id), ['evt-2', 'evt-3'],
      'the completed line must be delivered');
    assert.equal(appended[1].summary, summary, 'the row must decode byte-exact');
    assert.equal(stop.positions().changelog.offset, fs.statSync(file).size);
  } finally {
    stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a log that ends mid-line when the watcher arms delivers that line once finished', async () => {
  // The same gap at arm time: baselining at the file size puts the offset
  // inside the unfinished line, so its completion is read as a fragment.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-partial-arm-'));
  const file = path.join(dir, 'tool-use-log.jsonl');
  const inFlight = row('evt-2', 'row being written when the service started');
  const half = Math.floor(inFlight.length / 2);
  fs.writeFileSync(file, row('evt-1', 'seed') + inFlight.slice(0, half));

  const appended = [];
  const stop = watchFiles(
    (events) => appended.push(...events.map((e) => e.event_id)),
    () => {},
    { 'tool-use': file },
  );

  try {
    await settle(300);
    assert.equal(stop.positions()['tool-use'].offset, Buffer.byteLength(row('evt-1', 'seed')),
      'the start position must sit at the last complete line');

    fs.appendFileSync(file, inFlight.slice(half));
    await settle();
    assert.deepEqual(appended, ['evt-2']);
  } finally {
    stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
