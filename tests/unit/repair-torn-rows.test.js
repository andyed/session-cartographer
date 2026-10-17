// scripts/repair-torn-rows.js splits rows that concurrent appends spliced
// together back into their records. The fixture tears milestone pairs the way
// the live ones tore: one row's first 1024 bytes, the second row whole, the
// first row's remainder on the next line (and the mirror order). Both rows end
// `…,"session_event_count":N,"salience":0.5}`, so either tail completes either
// head and parsing alone cannot pair them, as with all three live pairs. The
// changelog copies, whose summaries name each row's counts, decide.
//
// Asserted: the fixture really is ambiguous by parse; a dry run writes
// nothing; --write restores each record byte for byte and touches no other
// line; a run nothing can untangle is left alone; a recovered record already
// in the log is not written twice.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chunksOf, findTornRows, untangle } from '../../scripts/repair-torn-rows.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = path.join(ROOT, 'scripts', 'repair-torn-rows.js');

function milestone(id, count, dirty) {
  return JSON.stringify({
    event_id: id, timestamp: '2026-10-09T05:51:48Z', milestone: 'session_end_other',
    description: 'Session ended (other)', session_id: `sess-${id}`, project: 'electron',
    git_branch: 'electron', git_dirty_files: dirty,
    recent_commits: `${'fix(tray): one taskbar identity '.repeat(28)}transport is disabled while nothing is queued`,
    session_event_count: count, salience: 0.5,
  });
}
const copy = (id, count, dirty) => JSON.stringify({
  event_id: id, timestamp: '2026-10-09T05:51:48Z', type: 'milestone_session_end_other',
  summary: `Session ended (other) [electron, ${dirty} dirty, ${count} events]`,
});

// a1 b1 b2 | a2: B finished before A's last chunk.
const tearAfter = (a, b) => `${a.slice(0, 1024)}${b}\n${a.slice(1024)}\n`;
// a1 b1 a2 | b2: A finished first.
const tearBefore = (a, b) => `${a.slice(0, 1024)}${b.slice(0, 1024)}${a.slice(1024)}\n${b.slice(1024)}\n`;

function fixture() {
  const dev = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-torn-'));
  const rows = {
    a: milestone('evt-a', 36, 520), b: milestone('evt-b', 7, 520),
    c: milestone('evt-c', 51, 558), d: milestone('evt-d', 170, 558),
  };
  const whole = JSON.stringify({ event_id: 'evt-whole', summary: 'untouched' });
  const log = `${whole}\n${tearAfter(rows.a, rows.b)}${whole.replace('whole', 'middle')}\n${tearBefore(rows.c, rows.d)}`;
  fs.writeFileSync(path.join(dev, 'session-milestones.jsonl'), log);
  fs.writeFileSync(path.join(dev, 'changelog.jsonl'),
    [copy('evt-a', 36, 520), copy('evt-b', 7, 520), copy('evt-c', 51, 558), copy('evt-d', 170, 558)].join('\n') + '\n');
  return { dev, file: path.join(dev, 'session-milestones.jsonl'), log, rows, whole };
}

const run = (dev, ...args) => spawnSync(process.execPath, [SCRIPT, ...args], {
  encoding: 'utf8', env: { ...process.env, CARTOGRAPHER_DEV_DIR: dev, CARTOGRAPHER_REWRITE_GRACE_MS: '0' },
});

test('the fixture is torn and parses two ways, as the live pairs did', () => {
  const { dev, rows } = fixture();
  for (const torn of [tearAfter(rows.a, rows.b), tearBefore(rows.c, rows.d)]) {
    for (const line of torn.split('\n').filter(Boolean)) assert.throws(() => JSON.parse(line));
    const chunks = chunksOf(Buffer.from(torn), 1024);
    assert.deepEqual(chunks.slice(0, 2).map((piece) => piece.bytes.length), [1024, 1024]);
    assert.equal(untangle(chunks).length, 2, 'parsing alone must not settle it, or the copies are not being tested');
  }
  fs.rmSync(dev, { recursive: true, force: true });
});

test('a dry run reports every run and writes nothing', () => {
  const { dev, file, log } = fixture();
  const out = run(dev);
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /lines 2-3: .* recoverable \(parses 2 ways; settled by the copies/);
  assert.match(out.stdout, /lines 5-6: .* recoverable/);
  assert.match(out.stdout, /Dry run — nothing written\. 2 run\(s\) recoverable/);
  assert.equal(fs.readFileSync(file, 'utf8'), log);
  assert.deepEqual(fs.readdirSync(dev).sort(), ['changelog.jsonl', 'session-milestones.jsonl'], 'no backup, lock or state file');
  fs.rmSync(dev, { recursive: true, force: true });
});

test('--write restores each record byte for byte and leaves every other line alone', () => {
  const { dev, file, rows, whole } = fixture();
  const out = run(dev, '--write');
  assert.equal(out.status, 0, out.stderr);
  assert.equal(fs.readFileSync(file, 'utf8'),
    [whole, rows.a, rows.b, whole.replace('whole', 'middle'), rows.c, rows.d].join('\n') + '\n');
  const backups = fs.readdirSync(dev).filter((name) => name.includes('.bak-torn-'));
  assert.equal(backups.length, 1);
  assert.equal(run(dev).stdout.trim(), 'No torn rows.');
  fs.rmSync(dev, { recursive: true, force: true });
});

test('a run nothing can untangle is reported and kept as it is', () => {
  const { dev, file } = fixture();
  const garbage = `${'x'.repeat(1500)}\n`;
  fs.appendFileSync(file, garbage);
  const { runs } = findTornRows(fs.readFileSync(file));
  assert.equal(runs.at(-1).status, 'unrecoverable');
  assert.equal(run(dev, '--write').status, 0);
  assert.ok(fs.readFileSync(file, 'utf8').endsWith(garbage), 'the unrecoverable line survives the write');
  fs.rmSync(dev, { recursive: true, force: true });
});

test('a recovered record the log already holds is not written again', () => {
  const { dev, file, rows } = fixture();
  fs.appendFileSync(file, `${rows.b}\n`);
  const out = run(dev, '--write');
  assert.match(out.stdout, /evt-b .* \(already in the log; not written again\)/);
  const ids = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line).event_id);
  assert.equal(ids.filter((id) => id === 'evt-b').length, 1);
  assert.equal(ids.filter((id) => id === 'evt-a').length, 1);
  fs.rmSync(dev, { recursive: true, force: true });
});
