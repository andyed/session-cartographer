// The CLI's scorer is bm25-search.awk, and it truncates to max_results in its
// END block. Windowing after that truncation keeps the globally best rows and
// then asks which fall in the window, so a short window over a busy log loses
// rows the window actually contains. These tests drive the awk directly.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const AWK = join(ROOT, 'scripts', 'bm25-search.awk');

const NOW = Date.parse('2026-09-08T12:00:00Z');
const DAY = 86_400_000;
const SINCE_EPOCH = Math.floor((NOW - DAY) / 1000);

// Same shape as the JS fixture: matching rows that outrank the window, plus
// enough non-matching rows to keep BM25's idf positive.
function corpusLines() {
  const lines = [];
  for (let i = 0; i < 600; i++) {
    lines.push({ event_id: `old-${i}`, timestamp: new Date(NOW - 30 * DAY - i * 1000).toISOString(),
      project: 'p', summary: 'widget widget widget widget widget' });
  }
  for (let i = 0; i < 5; i++) {
    lines.push({ event_id: `new-${i}`, timestamp: new Date(NOW - i * 60_000).toISOString(),
      project: 'p', summary: 'widget widget mentioned here' });
  }
  for (let i = 0; i < 1500; i++) {
    lines.push({ event_id: `noise-${i}`, timestamp: new Date(NOW - 60 * DAY - i * 1000).toISOString(),
      project: 'p', summary: 'unrelated glacier lantern meadow compass' });
  }
  return lines.map((e) => JSON.stringify(e)).join('\n') + '\n';
}

function runAwk(file, { sinceEpoch = 0, maxResults = 500 } = {}) {
  const out = execFileSync('awk', [
    '-f', AWK,
    '-v', 'query=widget',
    '-v', 'src=changelog',
    '-v', 'proj_filter=p',
    '-v', `max_results=${maxResults}`,
    '-v', `since_epoch=${sinceEpoch}`,
    '-v', 'before_epoch=0',
    file,
    file,
  ], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  return out.split('\n').filter(Boolean).map((line) => line.split('\t'));
}

let dir; let file;
test.before(() => {
  dir = mkdtempSync(join(tmpdir(), 'carto-awk-'));
  file = join(dir, 'changelog.jsonl');
  writeFileSync(file, corpusLines());
});
test.after(() => rmSync(dir, { recursive: true, force: true }));

test('truncation alone loses in-window rows', () => {
  // Establishes the defect the filter exists to prevent: rank first, window
  // after, and some of the five in-window rows never reach the caller.
  const rows = runAwk(file, { sinceEpoch: 0 });
  const survivors = rows.filter((r) => r[2].startsWith('new-'));
  assert.equal(rows.length, 500, 'the fixture must actually hit max_results');
  assert.ok(survivors.length < 5,
    'the fixture must put in-window rows past max_results for this test to mean anything');
});

test('windowing before truncation returns every in-window match', () => {
  const rows = runAwk(file, { sinceEpoch: SINCE_EPOCH });
  assert.equal(rows.length, 5);
  assert.ok(rows.every((r) => r[2].startsWith('new-')));
});

test('an unwindowed run is unchanged', () => {
  assert.equal(runAwk(file, { sinceEpoch: 0 }).length, 500);
});

test('a row with no timestamp is dropped only when a window is active', () => {
  const undated = join(dir, 'undated.jsonl');
  const lines = [JSON.stringify({ event_id: 'undated', project: 'p', summary: 'widget' })];
  for (let i = 0; i < 20; i++) {
    lines.push(JSON.stringify({ event_id: `noise-${i}`, timestamp: new Date(NOW).toISOString(),
      project: 'p', summary: 'unrelated glacier lantern meadow compass' }));
  }
  writeFileSync(undated, lines.join('\n') + '\n');

  assert.equal(runAwk(undated, { sinceEpoch: 0 }).length, 1);
  assert.equal(runAwk(undated, { sinceEpoch: SINCE_EPOCH }).length, 0);
});
