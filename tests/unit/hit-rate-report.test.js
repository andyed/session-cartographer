import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { aggregateInternalsRecords } from '../../explorer/server/internals-aggregate.js';

const ROOT = path.resolve(import.meta.dirname, '../..');
const REPORT = path.join(ROOT, 'scripts/hit-rate-report.js');

function writeJsonl(filePath, rows) {
  fs.writeFileSync(filePath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
}

function runReport(served, uses, extraArgs = [], searchCalls = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-hit-rate-'));
  const servedPath = path.join(dir, 'served.jsonl');
  const ledgerPath = path.join(dir, 'ledger.jsonl');
  const searchCallPath = path.join(dir, 'calls.jsonl');
  writeJsonl(servedPath, served);
  writeJsonl(ledgerPath, uses);
  writeJsonl(searchCallPath, searchCalls);
  const result = spawnSync(process.execPath, [REPORT, '--json', ...extraArgs], {
    encoding: 'utf8',
    env: {
      ...process.env,
      CARTOGRAPHER_SERVED_LOG: servedPath,
      CARTOGRAPHER_ACCESS_LEDGER: ledgerPath,
      CARTOGRAPHER_SEARCH_CALL_LOG: searchCallPath,
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

test('CLI and Explorer share source-filtered metrics and zero-result denominators', () => {
  const base = { timestamp: '2026-07-19T10:00:00Z', purpose: 'remember', requested_backend: 'explorer' };
  const served = [
    { ...base, call_id: 'inspect', event_id: 'candidate', rank: 1 },
    { ...base, call_id: 'inspect', event_id: 'answer', rank: 4 },
    { ...base, call_id: 'unused', event_id: 'unused', rank: 1 },
  ];
  const access = [
    { ...base, call_id: 'inspect', event_id: 'candidate', source: 'result_fetched' },
    { ...base, timestamp: '2026-07-19T10:01:00Z', call_id: 'inspect', event_id: 'answer', source: 'result_used' },
  ];
  const searchCalls = [
    { ...base, call_id: 'inspect', selected_backend: 'explorer', semantic_status: 'available', elapsed_ms: 200 },
    { ...base, call_id: 'unused', selected_backend: 'cli', semantic_status: 'unavailable', elapsed_ms: 23000, fallback_reason: 'timeout' },
    { ...base, call_id: 'zero', selected_backend: 'explorer', result_count: 0, elapsed_ms: 100 },
  ];
  const report = runReport([...served, served[0]], access, [], searchCalls);
  const canonical = aggregateInternalsRecords({ servedRows: served, accessRows: access, searchCallRows: searchCalls, window: 'all' });
  assert.deepEqual(report.utility, canonical.utility);
  assert.deepEqual(report.modeCohorts, canonical.modeCohorts);
  assert.equal(report.overall.served, 3);
  assert.equal(report.overall.hit, 2);
  assert.equal(report.mrr.instances, 3);
  assert.equal(report.mrr.value, 1 / 3);
  assert.equal(report.utility.explicitUse.firstAccessMrr, 1 / 12);
  assert.equal(report.utility.fetched.firstAccessMrr, 1 / 3);
});

test('an entirely zero-result cohort remains a valid JSON report', () => {
  const report = runReport([], [], [], [{
    timestamp: '2026-07-19T10:00:00Z', purpose: 'remember', call_id: 'zero', result_count: 0,
    requested_backend: 'explorer', selected_backend: 'explorer', semantic_status: 'unavailable', elapsed_ms: 75,
  }]);
  assert.equal(report.mrr.instances, 1);
  assert.equal(report.mrr.value, 0);
  assert.equal(report.utility.explicitUse.calls, 1);
  assert.equal(report.utility.explicitUse.callsWithUse, 0);
  assert.equal(report.modeCohorts[0].semanticCohorts[0].key, 'unavailable');
  assert.equal(report.modeCohorts[0].latency.p50Ms, 75);
});

test('JSON output flushes completely when the report exceeds the pipe buffer', () => {
  const base = { timestamp: '2026-07-19T10:00:00Z', purpose: 'remember', call_id: 'large', rank: 1 };
  const served = Array.from({ length: 1200 }, (_, index) => ({
    ...base, event_id: `event-${index}`, project: `project-${index}-${'x'.repeat(80)}`,
  }));
  const report = runReport(served, []);
  assert.equal(report.overall.served, 1200);
  assert.equal(Object.keys(report.byProject).length, 1200);
});
