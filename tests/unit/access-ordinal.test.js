import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const ROOT = path.resolve(import.meta.dirname, '../..');
const SEARCH = path.join(ROOT, 'scripts/cartographer-search.sh');

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
}

function runSearch(args, env) {
  return spawnSync('bash', [SEARCH, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

test('--touch records one ordered access batch in caller-supplied order', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-touch-ordinal-'));
  const ledger = path.join(dir, 'access.jsonl');
  try {
    const result = runSearch(['_', '--call-id', 'call-touch', '--touch', 'evt-b,evt-a,evt-c'], {
      CARTOGRAPHER_DEV_DIR: dir,
      CARTOGRAPHER_ACCESS_LEDGER: ledger,
    });
    assert.equal(result.status, 0, result.stderr);
    const rows = readJsonl(ledger);
    assert.deepEqual(rows.map((row) => row.event_id), ['evt-b', 'evt-a', 'evt-c']);
    assert.deepEqual(rows.map((row) => row.access_ordinal), [1, 2, 3]);
    assert.equal(new Set(rows.map((row) => row.access_batch_id)).size, 1);
    assert.ok(rows[0].access_batch_id.startsWith('touch-'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('--get preserves requested result order in fetched-access telemetry', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-get-ordinal-'));
  const ledger = path.join(dir, 'access.jsonl');
  const served = path.join(dir, 'served.jsonl');
  try {
    fs.writeFileSync(path.join(dir, 'changelog.jsonl'), [
      { event_id: 'evt-a', timestamp: '2026-08-29T10:00:00Z', project: 'demo', summary: 'alpha' },
      { event_id: 'evt-b', timestamp: '2026-08-29T10:01:00Z', project: 'demo', summary: 'beta' },
    ].map(JSON.stringify).join('\n') + '\n');
    fs.writeFileSync(served, [
      { event_id: 'evt-a', timestamp: '2026-08-29T10:02:00Z', session_id: 'session-1', call_id: 'call-get', purpose: 'remember', rank: 1 },
      { event_id: 'evt-b', timestamp: '2026-08-29T10:02:00Z', session_id: 'session-1', call_id: 'call-get', purpose: 'remember', rank: 2 },
    ].map(JSON.stringify).join('\n') + '\n');

    const result = runSearch(['_', '--get', 'evt-b,evt-a'], {
      CARTOGRAPHER_DEV_DIR: dir,
      CARTOGRAPHER_SERVED_LOG: served,
      CARTOGRAPHER_ACCESS_LEDGER: ledger,
      CARTOGRAPHER_SESSION_ID: 'session-1',
      CARTOGRAPHER_PURPOSE: 'remember',
    });
    assert.equal(result.status, 0, result.stderr);
    const rows = readJsonl(ledger);
    assert.deepEqual(rows.map((row) => row.event_id), ['evt-b', 'evt-a']);
    assert.deepEqual(rows.map((row) => row.access_ordinal), [1, 2]);
    assert.equal(new Set(rows.map((row) => row.access_batch_id)).size, 1);
    assert.ok(rows[0].access_batch_id.startsWith('get-'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
