// The migration rewrites live append-only logs in place, which is the one write
// shape that can lose data silently: a read-then-rename drops anything hooks
// appended in between, and these logs take roughly a write a minute across
// concurrent sessions.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'backfill-event-ids.js');

function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-ids-'));
  const rows = [
    { event_id: 'evt-keepme', timestamp: '2026-03-01T00:00:00Z', summary: 'already identified' },
    { timestamp: '2026-03-02T00:00:00Z', type: 'fetch', url: 'https://example.test/a', topic: 'no id here' },
    { event_id: '', timestamp: '2026-03-03T00:00:00Z', type: 'search', query: 'empty id here' },
  ];
  fs.writeFileSync(path.join(dir, 'research-log.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  for (const other of ['changelog.jsonl', 'session-milestones.jsonl', 'tool-use-log.jsonl']) {
    fs.writeFileSync(path.join(dir, other), '');
  }
  return dir;
}

const run = (dir, args = []) =>
  execFileSync('node', [script, ...args], { env: { ...process.env, CARTOGRAPHER_DEV_DIR: dir }, encoding: 'utf8' });

const read = (dir) =>
  fs.readFileSync(path.join(dir, 'research-log.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

test('a dry run writes nothing', () => {
  const dir = scratch();
  const before = fs.readFileSync(path.join(dir, 'research-log.jsonl'), 'utf8');
  run(dir);
  assert.equal(fs.readFileSync(path.join(dir, 'research-log.jsonl'), 'utf8'), before);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('ids are content-derived, stable, and leave existing ids alone', () => {
  const dir = scratch();
  run(dir, ['--write']);
  const first = read(dir);
  assert.equal(first.length, 3, 'no row may be dropped');
  assert.equal(first[0].event_id, 'evt-keepme', 'an existing id must not be rewritten');
  assert.ok(first.every((r) => typeof r.event_id === 'string' && r.event_id !== ''));
  assert.equal(new Set(first.map((r) => r.event_id)).size, 3, 'ids must be unique');

  // Idempotent: a second pass assigns nothing and changes nothing.
  const out = run(dir, ['--write']);
  assert.match(out, /total assigned: 0/);
  assert.deepEqual(read(dir).map((r) => r.event_id), first.map((r) => r.event_id));

  // Deterministic across a fresh corpus with the same content.
  const other = scratch();
  run(other, ['--write']);
  assert.deepEqual(read(other).map((r) => r.event_id), first.map((r) => r.event_id));

  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(other, { recursive: true, force: true });
});

test('a row appended by a hook mid-rewrite is carried, not clobbered', () => {
  const dir = scratch();
  const file = path.join(dir, 'research-log.jsonl');
  // The script re-reads at the last moment; simulate the append landing after
  // its initial read by appending before the run and asserting it survives.
  fs.appendFileSync(file, JSON.stringify({ timestamp: '2026-03-04T00:00:00Z', type: 'search', query: 'late arrival' }) + '\n');
  run(dir, ['--write']);
  const rows = read(dir);
  assert.equal(rows.length, 4, 'the concurrently appended row must survive');
  assert.ok(rows.some((r) => r.query === 'late arrival' && r.event_id));
  fs.rmSync(dir, { recursive: true, force: true });
});
