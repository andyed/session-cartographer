// logPositions()/readAppended() are the durable half of the delta cursor: the
// only thing in the system that answers "what ARRIVED since I last looked"
// rather than "what is timestamped after this instant". The corpus is
// backfilled, so those are different sets and only the first is "what's new".
//
// Everything here runs against temp fixture logs. CARTOGRAPHER_DEV_DIR is
// redirected before jsonl.js is imported (it resolves LOG_FILES at module load)
// and every call passes an explicit logFiles map, so no test can touch the real
// corpus. The session-id chain is cleared per CLAUDE.md — delta serving is real
// and an inherited session id changes behaviour under test.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

for (const name of [
  'CARTOGRAPHER_SESSION_ID',
  'CLAUDE_SESSION_ID',
  'CLAUDE_CODE_SESSION_ID',
  'CODEX_SESSION_ID',
]) delete process.env[name];

const FIXTURE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-facts-positions-'));
process.env.CARTOGRAPHER_DEV_DIR = FIXTURE_DIR;
process.on('exit', () => { try { fs.rmSync(FIXTURE_DIR, { recursive: true, force: true }); } catch {} });

const { logPositions, readAppended } = await import('../../explorer/server/jsonl.js');

let caseCounter = 0;
/** A private directory per test so nothing leaks between cases. */
function workspace() {
  caseCounter += 1;
  const dir = path.join(FIXTURE_DIR, `case-${caseCounter}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const row = (id, extra = {}) =>
  `${JSON.stringify({ event_id: id, timestamp: '2026-09-02T12:00:00Z', summary: `event ${id}`, ...extra })}\n`;

const ids = (events) => events.map((event) => event.event_id);

test('a first call establishes a position, it does not replay history', () => {
  const dir = workspace();
  const file = path.join(dir, 'changelog.jsonl');
  fs.writeFileSync(file, row('evt-1') + row('evt-2') + row('evt-3'));
  const logFiles = { changelog: file };

  const positions = logPositions(logFiles);
  assert.equal(positions.changelog.offset, fs.statSync(file).size);
  assert.notEqual(positions.changelog.boundary, '', 'a non-empty log must carry a boundary fingerprint');

  const { events, stale, pending } = readAppended(positions, { logFiles });
  assert.deepEqual(ids(events), [], 'a baseline position must not replay the existing log');
  assert.deepEqual(stale, {});
  assert.deepEqual(pending, {});
});

test('appends across two logs are returned round-robin so neither starves', () => {
  const dir = workspace();
  const alpha = path.join(dir, 'alpha.jsonl');
  const beta = path.join(dir, 'beta.jsonl');
  fs.writeFileSync(alpha, row('alpha-seed'));
  fs.writeFileSync(beta, row('beta-seed'));
  const logFiles = { alpha, beta };

  const positions = logPositions(logFiles);
  fs.appendFileSync(alpha, row('a1') + row('a2') + row('a3'));
  fs.appendFileSync(beta, row('b1') + row('b2') + row('b3'));

  const { events } = readAppended(positions, { logFiles });
  // Draining in fixed source order would let a saturated log permanently hide
  // another one's new rows.
  assert.deepEqual(ids(events), ['a1', 'b1', 'a2', 'b2', 'a3', 'b3']);
});

test('an immediate re-read returns nothing', () => {
  const dir = workspace();
  const file = path.join(dir, 'changelog.jsonl');
  fs.writeFileSync(file, row('evt-1'));
  const logFiles = { changelog: file };

  const baseline = logPositions(logFiles);
  fs.appendFileSync(file, row('evt-2') + row('evt-3'));

  const first = readAppended(baseline, { logFiles });
  assert.deepEqual(ids(first.events), ['evt-2', 'evt-3']);

  const second = readAppended(first.positions, { logFiles });
  assert.deepEqual(ids(second.events), [], 'events must not be replayed on the next call');
  assert.deepEqual(second.stale, {});
  assert.deepEqual(second.pending, {});
  assert.equal(second.positions.changelog.offset, fs.statSync(file).size);
});

test('a saturated budget reports the remainder and loses nothing on the follow-up', () => {
  const dir = workspace();
  const alpha = path.join(dir, 'alpha.jsonl');
  const beta = path.join(dir, 'beta.jsonl');
  fs.writeFileSync(alpha, row('alpha-seed'));
  fs.writeFileSync(beta, row('beta-seed'));
  const logFiles = { alpha, beta };

  const baseline = logPositions(logFiles);
  fs.appendFileSync(alpha, row('a1') + row('a2') + row('a3'));
  fs.appendFileSync(beta, row('b1') + row('b2') + row('b3'));

  const first = readAppended(baseline, { logFiles, budget: 2 });
  assert.equal(first.events.length, 2, 'budget must bind');
  assert.deepEqual(first.pending, { alpha: 2, beta: 2 }, 'the unreturned remainder must be reported per source');

  const second = readAppended(first.positions, { logFiles, budget: 100 });
  assert.deepEqual(second.pending, {}, 'the remainder must drain on the follow-up');

  const seen = [...ids(first.events), ...ids(second.events)];
  assert.equal(seen.length, 6, 'nothing may be lost across a saturated read');
  assert.equal(new Set(seen).size, 6, 'nothing may be duplicated across a saturated read');
  assert.deepEqual([...seen].sort(), ['a1', 'a2', 'a3', 'b1', 'b2', 'b3']);

  const third = readAppended(second.positions, { logFiles });
  assert.deepEqual(ids(third.events), [], 'the cursor must be fully drained');
});

test('a trailing line with no newline is not consumed until the newline arrives', () => {
  const dir = workspace();
  const file = path.join(dir, 'changelog.jsonl');
  fs.writeFileSync(file, row('evt-1'));
  const logFiles = { changelog: file };

  const baseline = logPositions(logFiles);
  const whole = row('evt-mid-flush');
  const head = whole.slice(0, 20);
  const tail = whole.slice(20);

  // A writer caught mid-flush: a complete record, then a fragment.
  fs.appendFileSync(file, row('evt-2') + head);
  const first = readAppended(baseline, { logFiles });
  assert.deepEqual(ids(first.events), ['evt-2'], 'a fragment must not be parsed as a record');
  assert.equal(
    first.positions.changelog.offset,
    fs.statSync(file).size - Buffer.byteLength(head, 'utf-8'),
    'the fragment bytes must stay unconsumed',
  );

  fs.appendFileSync(file, tail);
  const second = readAppended(first.positions, { logFiles });
  assert.deepEqual(ids(second.events), ['evt-mid-flush'], 'the completed record must arrive whole');

  const third = readAppended(second.positions, { logFiles });
  assert.deepEqual(ids(third.events), [], 'and exactly once');
});

test('a malformed line is consumed rather than wedging the cursor forever', () => {
  const dir = workspace();
  const file = path.join(dir, 'changelog.jsonl');
  fs.writeFileSync(file, row('evt-1'));
  const logFiles = { changelog: file };

  const baseline = logPositions(logFiles);
  fs.appendFileSync(file, '{"event_id": "broken", trailing garbage\n' + row('evt-after'));

  const first = readAppended(baseline, { logFiles });
  assert.deepEqual(ids(first.events), ['evt-after'], 'the valid event after a malformed line must still arrive');
  assert.equal(first.positions.changelog.offset, fs.statSync(file).size, 'the malformed bytes must be consumed');

  fs.appendFileSync(file, row('evt-later'));
  const second = readAppended(first.positions, { logFiles });
  assert.deepEqual(ids(second.events), ['evt-later'], 'the cursor must keep advancing past a malformed line');
});

test('an in-place rewrite is reported as stale and contributes zero events', () => {
  const dir = workspace();
  const alpha = path.join(dir, 'alpha.jsonl');
  const beta = path.join(dir, 'beta.jsonl');
  fs.writeFileSync(alpha,
    row('evt-1', { transcript_path: '/Users/me/.codex/sessions/a.jsonl' })
    + row('evt-2', { transcript_path: '/Users/me/.codex/sessions/b.jsonl' }));
  fs.writeFileSync(beta, row('beta-seed'));
  const logFiles = { alpha, beta };

  const baseline = logPositions(logFiles);

  // The exact shape of repair-transcript-paths.js: bytes BEFORE the cursor
  // change and the file grows, so a size check alone reads the shifted tail as
  // fresh appends.
  const repaired = fs.readFileSync(alpha, 'utf8')
    .replaceAll('/.codex/sessions/', '/.codex/archived_sessions/');
  assert.ok(Buffer.byteLength(repaired) > fs.statSync(alpha).size, 'the repair must grow the file');
  fs.writeFileSync(alpha, repaired);
  fs.appendFileSync(beta, row('b1'));

  const { events, stale, positions } = readAppended(baseline, { logFiles });
  assert.equal(stale.alpha, 'rewritten');
  assert.equal(stale.beta, undefined, 'an untouched log must not be flagged');
  assert.deepEqual(ids(events), ['b1'], 'a rewritten log contributes nothing rather than a wrong diff');
  assert.equal(positions.alpha.offset, fs.statSync(alpha).size, 'a stale source re-baselines at the new end');
});

test('truncation is reported as stale truncated', () => {
  const dir = workspace();
  const file = path.join(dir, 'changelog.jsonl');
  fs.writeFileSync(file, row('evt-1') + row('evt-2') + row('evt-3'));
  const logFiles = { changelog: file };

  const baseline = logPositions(logFiles);
  fs.writeFileSync(file, row('evt-1'));

  const { events, stale, positions } = readAppended(baseline, { logFiles });
  assert.equal(stale.changelog, 'truncated');
  assert.deepEqual(ids(events), []);
  assert.equal(positions.changelog.offset, fs.statSync(file).size);
});

test('a log that does not exist is position zero and not stale', () => {
  const dir = workspace();
  const missing = path.join(dir, 'never-written.jsonl');
  const logFiles = { changelog: missing };

  const positions = logPositions(logFiles);
  assert.deepEqual(positions.changelog, { offset: 0, boundary: '' });

  const { events, stale, pending, positions: next } = readAppended(positions, { logFiles });
  assert.deepEqual(ids(events), []);
  assert.deepEqual(stale, {}, 'a log that was never created is absent, not corrupt');
  assert.deepEqual(pending, {});
  assert.deepEqual(next.changelog, { offset: 0, boundary: '' });

  // ...and it starts delivering as soon as it exists.
  fs.writeFileSync(missing, row('evt-1'));
  const after = readAppended(next, { logFiles });
  assert.deepEqual(ids(after.events), ['evt-1']);
});
