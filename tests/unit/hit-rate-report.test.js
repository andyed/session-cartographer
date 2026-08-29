import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const ROOT = path.resolve(import.meta.dirname, '../..');
const REPORT = path.join(ROOT, 'scripts/hit-rate-report.js');

function writeJsonl(filePath, rows) {
  fs.writeFileSync(filePath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
}

function runReport(served, uses, extraArgs = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-hit-rate-'));
  const servedPath = path.join(dir, 'served.jsonl');
  const ledgerPath = path.join(dir, 'ledger.jsonl');
  writeJsonl(servedPath, served);
  writeJsonl(ledgerPath, uses);
  const result = spawnSync(process.execPath, [REPORT, '--json', ...extraArgs], {
    encoding: 'utf8',
    env: {
      ...process.env,
      CARTOGRAPHER_SERVED_LOG: servedPath,
      CARTOGRAPHER_ACCESS_LEDGER: ledgerPath,
    },
  });
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('exact call attribution does not credit a later call serving the same event', () => {
  const base = { purpose: 'remember', session_id: 's1', provider: 'codex', project: 'demo', source: 'semantic' };
  const report = runReport([
    { ...base, timestamp: '2026-07-19T10:00:00Z', call_id: 'call-a', query: 'alpha', event_id: 'evt-x', rank: 5 },
    { ...base, timestamp: '2026-07-19T10:01:00Z', call_id: 'call-b', query: 'beta', event_id: 'evt-x', rank: 1 },
  ], [
    { timestamp: '2026-07-19T10:02:00Z', call_id: 'call-a', event_id: 'evt-x', source: 'result_used' },
  ]);

  assert.equal(report.overall.hit, 1);
  assert.equal(report.mrr.instances, 2);
  assert.equal(report.mrr.value, 0.1);
  assert.equal(report.mrr.firstAccessValue, 0.1);
  assert.equal(report.mrr.lastAccessValue, 0.1);
  assert.equal(report.mrr.firstAccessUnknownInstances, 0);
});

test('legacy attribution credits only the latest eligible serve', () => {
  const report = runReport([
    { timestamp: '2026-07-19T10:00:00Z', query: 'alpha', event_id: 'evt-x', rank: 5, source: 'semantic', project: 'demo' },
    { timestamp: '2026-07-19T10:01:00Z', query: 'beta', event_id: 'evt-x', rank: 1, source: 'semantic', project: 'demo' },
  ], [
    { timestamp: '2026-07-19T10:02:00Z', event_id: 'evt-x', source: 'transcript_read' },
  ], ['--purpose', 'all', '--include-legacy']);

  assert.equal(report.overall.hit, 1);
  assert.equal(report.mrr.instances, 2);
  assert.equal(report.mrr.value, 0.5);
  assert.equal(report.mrr.firstAccessValue, 0.5);
  assert.equal(report.mrr.lastAccessValue, 0.5);
});

test('ordered batches define first and last access independently of file order and best rank', () => {
  const base = { purpose: 'remember', session_id: 's1', provider: 'codex', project: 'demo', source: 'semantic' };
  const batch = { timestamp: '2026-07-19T10:02:00Z', call_id: 'call-order', access_batch_id: 'batch-1', source: 'result_used' };
  const report = runReport([
    { ...base, timestamp: '2026-07-19T10:00:00Z', call_id: 'call-order', query: 'alpha', event_id: 'evt-last', rank: 2 },
    { ...base, timestamp: '2026-07-19T10:00:00Z', call_id: 'call-order', query: 'alpha', event_id: 'evt-first', rank: 8 },
    { ...base, timestamp: '2026-07-19T10:00:00Z', call_id: 'call-order', query: 'alpha', event_id: 'evt-best', rank: 1 },
  ], [
    { ...batch, event_id: 'evt-best', access_ordinal: 2 },
    { ...batch, event_id: 'evt-last', access_ordinal: 3 },
    { ...batch, event_id: 'evt-first', access_ordinal: 1 },
  ]);

  assert.equal(report.mrr.value, 1 / 8);
  assert.equal(report.mrr.firstAccessValue, 1 / 8);
  assert.equal(report.mrr.lastAccessValue, 1 / 2);
  assert.equal(report.mrr.firstAccessUnknownInstances, 0);
  assert.equal(report.mrr.lastAccessUnknownInstances, 0);
});

test('historical same-time batches without ordinals remain order-unknown', () => {
  const base = { purpose: 'remember', session_id: 's1', provider: 'codex', project: 'demo', source: 'semantic' };
  const report = runReport([
    { ...base, timestamp: '2026-07-19T10:00:00Z', call_id: 'call-legacy-batch', query: 'alpha', event_id: 'evt-a', rank: 1 },
    { ...base, timestamp: '2026-07-19T10:00:00Z', call_id: 'call-legacy-batch', query: 'alpha', event_id: 'evt-b', rank: 8 },
    { ...base, timestamp: '2026-07-19T10:00:00Z', call_id: 'call-legacy-batch', query: 'alpha', event_id: 'evt-last', rank: 2 },
  ], [
    { timestamp: '2026-07-19T10:02:00Z', call_id: 'call-legacy-batch', event_id: 'evt-a', source: 'result_used' },
    { timestamp: '2026-07-19T10:02:00Z', call_id: 'call-legacy-batch', event_id: 'evt-b', source: 'result_used' },
    { timestamp: '2026-07-19T10:03:00Z', call_id: 'call-legacy-batch', event_id: 'evt-last', source: 'result_used' },
  ]);

  assert.equal(report.mrr.value, null);
  assert.equal(report.mrr.lastAccessValue, null);
  assert.equal(report.mrr.firstAccessMeasuredInstances, 0);
  assert.equal(report.mrr.lastAccessMeasuredInstances, 0);
  assert.equal(report.mrr.orderUnknownInstances, 1);
  assert.equal(report.mrr.firstAccessUnknownInstances, 1);
  assert.equal(report.mrr.lastAccessUnknownInstances, 0);
  assert.equal(report.mrr.firstAccessRankDistribution.unknown, 1);
  assert.equal(report.mrr.lastAccessRankDistribution['1-3'], 1);
});
