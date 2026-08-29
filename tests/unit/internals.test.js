import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  aggregateInternalsRecords,
  buildInternalsSnapshotFromFiles,
  clearInternalsCache,
  getInternalsSnapshot,
  normalizeSourceLabel,
} from '../../explorer/server/internals.js';

const NOW = Date.parse('2026-08-29T12:00:00Z');

function writeJsonl(filePath, rows) {
  fs.writeFileSync(filePath, rows.length ? `${rows.map(JSON.stringify).join('\n')}\n` : '');
}

function fixturePaths(dir) {
  return {
    served: path.join(dir, 'served.jsonl'),
    access: path.join(dir, 'access.jsonl'),
    indexErrors: path.join(dir, 'errors.jsonl'),
  };
}

test('internals metrics use exact attribution and preserve no-use calls', () => {
  const base = {
    timestamp: '2026-08-28T10:00:00Z',
    purpose: 'remember',
    project: 'cartographer',
  };
  const aggregate = aggregateInternalsRecords({
    nowMs: NOW,
    window: '30d',
    purpose: 'remember',
    servedRows: [
      { ...base, call_id: 'call-a', event_id: 'evt-a', rank: 1, source: 'milestones+milestones+semantic' },
      { ...base, call_id: 'call-b', event_id: 'evt-b', rank: 5, source: 'changelog' },
      { ...base, event_id: 'evt-legacy', rank: 2, source: 'semantic' },
      { ...base, timestamp: '2026-06-01T10:00:00Z', call_id: 'call-old', event_id: 'evt-old', rank: 1, source: 'semantic' },
    ],
    accessRows: [
      { call_id: 'call-a', event_id: 'evt-a', source: 'result_used' },
      { call_id: 'call-a', event_id: 'evt-a', source: 'result_fetched' },
      { event_id: 'evt-legacy', source: 'transcript_read' },
    ],
    indexErrorRows: [
      { timestamp: '2026-08-27T10:00:00Z', stage: 'qdrant_unavailable' },
      { timestamp: '2026-06-01T10:00:00Z', stage: 'embedding_failed' },
    ],
  });

  assert.equal(aggregate.coverage.served.selectedRows, 3);
  assert.equal(aggregate.coverage.served.exactAttributedRows, 2);
  assert.equal(aggregate.utility.calls, 2);
  assert.equal(aggregate.utility.callsWithUse, 1);
  assert.equal(aggregate.utility.callSuccessRate, 0.5);
  assert.equal(aggregate.utility.servedRows, 2);
  assert.equal(aggregate.utility.usedRows, 1);
  assert.equal(aggregate.utility.mrr, 0.5);
  assert.equal(aggregate.utility.firstAccessMrr, 0.5);
  assert.equal(aggregate.utility.lastAccessMrr, 0.5);
  assert.equal(aggregate.utility.firstUsefulRank['1-3'], 1);
  assert.equal(aggregate.utility.firstUsefulRank.none, 1);
  assert.equal(aggregate.sources.find((entry) => entry.key === 'milestones+semantic')?.usedRows, 1);
  assert.equal(aggregate.indexErrors.inWindow, 1);
});

test('MRR follows recorded access ordinals instead of file or rank order', () => {
  const base = {
    timestamp: '2026-08-28T10:00:00Z',
    purpose: 'remember',
    project: 'cartographer',
    call_id: 'call-order',
    source: 'semantic',
  };
  const aggregate = aggregateInternalsRecords({
    nowMs: NOW,
    window: '30d',
    purpose: 'remember',
    servedRows: [
      { ...base, event_id: 'evt-last', rank: 2 },
      { ...base, event_id: 'evt-first', rank: 8 },
      { ...base, event_id: 'evt-best', rank: 1 },
    ],
    // One --touch batch: file order is deliberately different from the
    // caller-recorded access order.
    accessRows: [
      { timestamp: '2026-08-28T10:02:00Z', call_id: 'call-order', event_id: 'evt-best', access_batch_id: 'batch-a', access_ordinal: 2 },
      { timestamp: '2026-08-28T10:02:00Z', call_id: 'call-order', event_id: 'evt-last', access_batch_id: 'batch-a', access_ordinal: 3 },
      { timestamp: '2026-08-28T10:02:00Z', call_id: 'call-order', event_id: 'evt-first', access_batch_id: 'batch-a', access_ordinal: 1 },
    ],
  });

  assert.equal(aggregate.utility.mrr, 1 / 8);
  assert.equal(aggregate.utility.firstAccessMrr, 1 / 8);
  assert.equal(aggregate.utility.lastAccessMrr, 1 / 2);
  assert.equal(aggregate.utility.orderedCalls, 1);
  assert.equal(aggregate.utility.orderUnknownCalls, 0);
  assert.equal(aggregate.utility.firstAccessRank['8-15'], 1);
  assert.equal(aggregate.utility.lastAccessRank['1-3'], 1);
});

test('historical tied multi-result accesses stay unknown and use one shared MRR cohort', () => {
  const base = {
    timestamp: '2026-08-28T10:00:00Z',
    purpose: 'remember',
    project: 'cartographer',
    source: 'semantic',
  };
  const aggregate = aggregateInternalsRecords({
    nowMs: NOW,
    window: '30d',
    purpose: 'remember',
    servedRows: [
      { ...base, call_id: 'call-ambiguous', event_id: 'evt-a', rank: 8 },
      { ...base, call_id: 'call-ambiguous', event_id: 'evt-b', rank: 2 },
      { ...base, call_id: 'call-known', event_id: 'evt-known', rank: 4 },
    ],
    accessRows: [
      { timestamp: '2026-08-28T10:02:00Z', call_id: 'call-ambiguous', event_id: 'evt-a' },
      { timestamp: '2026-08-28T10:02:00Z', call_id: 'call-ambiguous', event_id: 'evt-b' },
      { timestamp: '2026-08-28T10:03:00Z', call_id: 'call-known', event_id: 'evt-known' },
    ],
  });

  assert.equal(aggregate.utility.calls, 2);
  assert.equal(aggregate.utility.orderedCalls, 1);
  assert.equal(aggregate.utility.orderUnknownCalls, 1);
  assert.equal(aggregate.utility.firstAccessUnknownCalls, 1);
  assert.equal(aggregate.utility.lastAccessUnknownCalls, 1);
  assert.equal(aggregate.utility.firstAccessMrr, 1 / 4);
  assert.equal(aggregate.utility.lastAccessMrr, 1 / 4);
  assert.equal(aggregate.utility.firstAccessRank.unknown, 1);
  assert.equal(aggregate.utility.lastAccessRank.unknown, 1);
});

test('source normalization removes repeated fusion components deterministically', () => {
  assert.equal(
    normalizeSourceLabel('semantic+milestones+milestones+semantic'),
    'milestones+semantic',
  );
  assert.equal(normalizeSourceLabel(''), 'unknown');
});

test('fingerprint cache coalesces refreshes and missing sources stay honest', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-internals-'));
  const paths = fixturePaths(dir);
  writeJsonl(paths.served, [{
    timestamp: '2026-08-28T10:00:00Z', purpose: 'remember', call_id: 'call-a',
    event_id: 'evt-a', rank: 1, source: 'semantic', project: 'cartographer',
  }]);
  writeJsonl(paths.access, []);
  writeJsonl(paths.indexErrors, []);

  try {
    clearInternalsCache();
    const [first, second] = await Promise.all([
      getInternalsSnapshot({ paths, nowMs: NOW, executionMode: 'inline', refresh: true }),
      getInternalsSnapshot({ paths, nowMs: NOW, executionMode: 'inline', refresh: true }),
    ]);
    assert.deepEqual(new Set([first.meta.cacheStatus, second.meta.cacheStatus]), new Set(['miss', 'coalesced']));

    const warm = await getInternalsSnapshot({ paths, nowMs: NOW, executionMode: 'inline' });
    assert.equal(warm.meta.cacheStatus, 'hit');

    const missing = buildInternalsSnapshotFromFiles({
      paths: fixturePaths(path.join(dir, 'missing')),
      nowMs: NOW,
    });
    assert.equal(missing.utility.calls, 0);
    assert.equal(missing.coverage.files.served.exists, false);
    assert.equal(missing.coverage.files.access.exists, false);
    assert.equal(missing.coverage.files.indexErrors.exists, false);
  } finally {
    clearInternalsCache();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
