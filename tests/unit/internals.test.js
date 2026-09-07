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
    searchCalls: path.join(dir, 'search-calls.jsonl'),
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
  assert.equal(aggregate.utility.hitsConsumed, 1);
  assert.equal(aggregate.utility.hitsConsumedPerCall, 0.5);
  assert.equal(aggregate.utility.hitsConsumedPerSuccessfulCall, 1);
  assert.equal(aggregate.utility.consumptionDepth.samples, 1);
  assert.equal(aggregate.utility.consumptionDepth.p50Rank, 1);
  assert.equal(aggregate.utility.consumptionDepth.p95Rank, 1);
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
  assert.equal(aggregate.utility.hitsConsumed, 3);
  assert.equal(aggregate.utility.hitsConsumedPerCall, 3);
  assert.equal(aggregate.utility.consumptionDepth.p50Rank, 8);
  assert.equal(aggregate.utility.consumptionDepth.p95Rank, 8);
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

test('Turbo-on and portable cohorts split latency and ordered MRR without hiding fallbacks', () => {
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
      { ...base, call_id: 'turbo-used', event_id: 'turbo-first', rank: 4, backend: 'explorer' },
      { ...base, call_id: 'turbo-used', event_id: 'turbo-last', rank: 2, backend: 'explorer' },
      { ...base, call_id: 'turbo-unused', event_id: 'turbo-none', rank: 1, backend: 'cli' },
      { ...base, call_id: 'cli-used', event_id: 'cli-first', rank: 1, backend: 'cli' },
      { ...base, call_id: 'cli-used', event_id: 'cli-last', rank: 5, backend: 'cli' },
      { ...base, call_id: 'cli-unused', event_id: 'cli-none', rank: 1, backend: 'cli' },
    ],
    accessRows: [
      { timestamp: '2026-08-28T10:02:00Z', call_id: 'turbo-used', event_id: 'turbo-first', access_batch_id: 'turbo-batch', access_ordinal: 1 },
      { timestamp: '2026-08-28T10:02:00Z', call_id: 'turbo-used', event_id: 'turbo-last', access_batch_id: 'turbo-batch', access_ordinal: 2 },
      { timestamp: '2026-08-28T10:03:00Z', call_id: 'cli-used', event_id: 'cli-first', access_batch_id: 'cli-batch', access_ordinal: 1 },
      { timestamp: '2026-08-28T10:03:00Z', call_id: 'cli-used', event_id: 'cli-last', access_batch_id: 'cli-batch', access_ordinal: 2 },
    ],
    searchCallRows: [
      { ...base, call_id: 'turbo-used', requested_backend: 'explorer', selected_backend: 'explorer', elapsed_ms: 10, stages_ms: { total: 4 } },
      { ...base, call_id: 'turbo-unused', requested_backend: 'explorer', selected_backend: 'cli', elapsed_ms: 30, stages_ms: { total: 20 }, fallback_reason: 'turbo_unavailable' },
      { ...base, call_id: 'cli-used', requested_backend: 'cli', selected_backend: 'cli', elapsed_ms: 1000, stages_ms: { total: 900 } },
      { ...base, call_id: 'cli-unused', requested_backend: 'cli', selected_backend: 'cli', elapsed_ms: 2000, stages_ms: { total: 1800 } },
    ],
  });

  const turbo = aggregate.modeCohorts.find((cohort) => cohort.key === 'explorer');
  const portable = aggregate.modeCohorts.find((cohort) => cohort.key === 'cli');
  assert.equal(turbo.calls, 2);
  assert.equal(turbo.latency.p50Ms, 10);
  assert.equal(turbo.latency.p95Ms, 30);
  assert.equal(turbo.firstAccessMrr, 1 / 8);
  assert.equal(turbo.lastAccessMrr, 1 / 4);
  assert.equal(turbo.hitsConsumed, 2);
  assert.equal(turbo.hitsConsumedPerCall, 1);
  assert.equal(turbo.hitsConsumedPerSuccessfulCall, 2);
  assert.equal(turbo.consumptionDepth.p50Rank, 4);
  assert.equal(turbo.consumptionDepth.p95Rank, 4);
  assert.equal(turbo.fallbackCalls, 1);
  assert.deepEqual(turbo.selectedBackends, { explorer: 1, cli: 1 });
  assert.equal(portable.calls, 2);
  assert.equal(portable.latency.p50Ms, 1000);
  assert.equal(portable.latency.p95Ms, 2000);
  assert.equal(portable.firstAccessMrr, 1 / 2);
  assert.equal(portable.lastAccessMrr, 1 / 10);
  assert.equal(portable.hitsConsumed, 2);
  assert.equal(portable.hitsConsumedPerCall, 1);
  assert.equal(portable.consumptionDepth.p50Rank, 5);
  assert.equal(portable.consumptionDepth.p95Rank, 5);
  assert.equal(aggregate.coverage.latencySamples, 4);
});

test('fetch and explicit-use summaries retain no-use and zero-result calls without cross-credit', () => {
  const base = { timestamp: '2026-08-28T10:00:00Z', purpose: 'remember', backend: 'explorer' };
  const fetched = { ...base, call_id: 'inspect', event_id: 'candidate', rank: 1 };
  const aggregate = aggregateInternalsRecords({
    nowMs: NOW,
    servedRows: [fetched, fetched, { ...base, call_id: 'inspect', event_id: 'answer', rank: 4 },
      { ...base, call_id: 'unused', event_id: 'unused', rank: 1 }],
    accessRows: [
      { ...base, call_id: 'inspect', event_id: 'candidate', source: 'result_fetched' },
      { ...base, call_id: 'inspect', event_id: 'candidate', source: 'result_fetched' },
      { ...base, timestamp: '2026-08-28T10:01:00Z', call_id: 'inspect', event_id: 'answer', source: 'result_used' },
      // A historical untyped access stays in the union but is never explicit use.
      { ...base, call_id: 'unused', event_id: 'unused' },
    ],
    searchCallRows: [{ ...base, call_id: 'zero-results', result_count: 0 }],
  });
  const { utility } = aggregate;
  assert.equal(utility.calls, 3);
  assert.equal(utility.callsWithUse, 2);
  assert.equal(utility.servedRows, 3);
  assert.equal(utility.usedRows, 3);
  assert.equal(aggregate.coverage.served.duplicateExactPairs, 1);
  assert.equal(utility.fetched.calls, 3);
  assert.equal(utility.fetched.callsWithUse, 1);
  assert.equal(utility.fetched.usedRows, 1);
  assert.equal(utility.fetched.firstAccessMrr, 1 / 3);
  assert.equal(utility.explicitUse.calls, 3);
  assert.equal(utility.explicitUse.callsWithUse, 1);
  assert.equal(utility.explicitUse.firstAccessMrr, 1 / 12);
  assert.equal(utility.explicitUse.firstAccessRank.none, 2);
});

test('semantic cohorts keep unavailable, unknown, zero-result and fallback calls visible', () => {
  const base = { timestamp: '2026-08-28T10:00:00Z', purpose: 'remember', requested_backend: 'explorer' };
  const aggregate = aggregateInternalsRecords({
    nowMs: NOW,
    servedRows: [{ ...base, call_id: 'used', event_id: 'answer', rank: 2, session_id: 'session-a' }],
    accessRows: [{ ...base, call_id: 'used', event_id: 'answer', source: 'result_used' }],
    searchCallRows: [
      { ...base, call_id: 'used', semantic_status: 'available', selected_backend: 'explorer', elapsed_ms: 200 },
      { ...base, call_id: 'unused', semantic_status: 'available', selected_backend: 'explorer', elapsed_ms: 300 },
      { ...base, call_id: 'fallback', semantic_status: 'unavailable', selected_backend: 'cli', elapsed_ms: 23000, fallback_reason: 'timeout', session_id: 'session-b' },
      { ...base, call_id: 'unknown', selected_backend: 'explorer', elapsed_ms: 100 },
      { ...base, call_id: 'future-status', semantic_status: 'new-value', selected_backend: 'explorer', elapsed_ms: 50 },
    ],
  });
  const mode = aggregate.modeCohorts[0];
  assert.equal(mode.calls, 5);
  assert.equal(mode.explicitUse.firstAccessMrr, 0.1);
  assert.deepEqual(mode.semanticAvailability, {
    availableCalls: 2, unavailableCalls: 1, unknownCalls: 2, measuredCalls: 3, availableRate: 2 / 3,
  });
  assert.deepEqual(mode.sessionAttribution, { attributedCalls: 2, missingCalls: 3, attributionRate: 0.4 });
  const [available, unavailable, unknown] = mode.semanticCohorts;
  assert.equal(available.explicitUse.firstAccessMrr, 0.25);
  assert.equal(unavailable.calls, 1);
  assert.equal(unavailable.explicitUse.firstAccessMrr, 0);
  assert.equal(unavailable.fallbackCalls, 1);
  assert.deepEqual(unavailable.selectedBackends, { cli: 1 });
  assert.equal(unavailable.latency.maxMs, 23000);
  assert.equal(mode.latency.maxMs, 23000);
  assert.equal(unknown.key, 'unknown');
  assert.equal(unknown.calls, 2);
  assert.equal(unknown.latency.samples, 2);
  assert.equal(unknown.explicitUse.firstAccessRank.none, 2);
});

test('filtered access ordering is independent of ledger order and repeated records', () => {
  const base = { timestamp: '2026-08-28T10:00:00Z', purpose: 'remember', call_id: 'ordered' };
  const servedRows = [{ ...base, event_id: 'first', rank: 1 }, { ...base, event_id: 'last', rank: 8 }];
  const accessRows = [
    { ...base, event_id: 'first', source: 'result_fetched', access_batch_id: 'fetch', access_ordinal: 1 },
    { ...base, event_id: 'last', source: 'result_fetched', access_batch_id: 'fetch', access_ordinal: 2 },
    { ...base, event_id: 'first', source: 'result_used', access_batch_id: 'use', access_ordinal: 2 },
    { ...base, event_id: 'last', source: 'result_used', access_batch_id: 'use', access_ordinal: 1 },
  ];
  const first = aggregateInternalsRecords({ nowMs: NOW, servedRows, accessRows }).utility;
  const repeated = aggregateInternalsRecords({ nowMs: NOW, servedRows: [...servedRows].reverse(), accessRows: [...accessRows, ...accessRows].reverse() }).utility;
  assert.deepEqual(first, repeated);
  assert.equal(first.orderUnknownCalls, 1);
  assert.equal(first.fetched.firstAccessMrr, 1);
  assert.equal(first.fetched.lastAccessMrr, 1 / 8);
  assert.equal(first.explicitUse.firstAccessMrr, 1 / 8);
  assert.equal(first.explicitUse.lastAccessMrr, 1);
  assert.equal(first.explicitUse.hitsConsumed, 2);
});

test('time to first access uses explicit starts and millisecond access times only', () => {
  const start = Date.parse('2026-08-28T10:00:00Z') + 500;
  const base = { timestamp: '2026-08-28T10:00:00Z', purpose: 'remember' };
  const ids = ['new', 'historical', 'negative', 'missing-access-time'];
  const aggregate = aggregateInternalsRecords({
    nowMs: NOW,
    servedRows: ids.map((call_id) => ({ ...base, call_id, event_id: call_id, rank: 1 })),
    accessRows: [
      { ...base, call_id: 'new', event_id: 'new', source: 'result_fetched', timestamp_ms: start + 200 },
      { ...base, call_id: 'new', event_id: 'new', source: 'result_used', timestamp_ms: start + 800 },
      { ...base, call_id: 'historical', event_id: 'historical', source: 'result_used' },
      { ...base, call_id: 'negative', event_id: 'negative', source: 'result_used', timestamp_ms: start - 100 },
      { call_id: 'missing-access-time', event_id: 'missing-access-time', source: 'result_used' },
    ],
    searchCallRows: ids.map((call_id) => ({
      ...base, call_id, elapsed_ms: 100,
      ...(call_id === 'historical' ? {} : { request_started_at: new Date(start).toISOString() }),
    })),
  });
  assert.equal(aggregate.utility.timeToFirstAccess.p50Ms, 200);
  assert.deepEqual(aggregate.utility.explicitUse.timeToFirstAccess, {
    samples: 1, p50Ms: 800, p95Ms: 800, maxMs: 800,
    missingStartCalls: 1, missingAccessTimeCalls: 1, negativeSamples: 1,
  });
});

test('session attribution rejects unresolved sentinels and accepts resolved aliases', () => {
  const base = { timestamp: '2026-08-28T10:00:00Z', purpose: 'remember', backend: 'explorer', rank: 1 };
  const aggregate = aggregateInternalsRecords({
    nowMs: NOW,
    servedRows: [
      { ...base, call_id: 'absent', event_id: 'absent', session_id: ' unknown ', session: '', sessionId: null },
      { ...base, call_id: 'alias', event_id: 'alias', session_id: 'unknown', sessionId: 'valid-alias' },
      { ...base, call_id: 'timing', event_id: 'timing', session_id: null },
    ],
    searchCallRows: [
      { ...base, call_id: 'absent', session_id: 'UNKNOWN' },
      { ...base, call_id: 'timing', session_id: 'valid-timing' },
    ],
  });
  assert.equal(aggregate.coverage.served.sessionAttributedRows, 1);
  assert.equal(aggregate.coverage.served.sessionAttributionRate, 1 / 3);
  assert.deepEqual(aggregate.utility.sessionAttribution, {
    attributedCalls: 2, missingCalls: 1, attributionRate: 2 / 3,
  });
  assert.deepEqual(aggregate.modeCohorts[0].sessionAttribution, aggregate.utility.sessionAttribution);
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
  writeJsonl(paths.searchCalls, []);
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
    assert.equal(missing.coverage.files.searchCalls.exists, false);
    assert.equal(missing.coverage.files.indexErrors.exists, false);
  } finally {
    clearInternalsCache();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
