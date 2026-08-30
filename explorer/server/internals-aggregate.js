import { createHash } from 'crypto';
import { readFileSync, statSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { performance } from 'perf_hooks';

export const INTERNALS_SCHEMA_VERSION = 4;
export const INTERNALS_WINDOWS = Object.freeze({
  '7d': 7,
  '30d': 30,
  all: null,
});

const DAY_MS = 24 * 60 * 60 * 1000;
const FIRST_RANK_BUCKETS = ['1-3', '4-7', '8-15', '16+', 'unknown', 'none'];

export function normalizeInternalsWindow(value = '30d') {
  const normalized = String(value || '30d').trim().toLowerCase();
  if (normalized === '7' || normalized === '7d') return '7d';
  if (normalized === '30' || normalized === '30d') return '30d';
  if (normalized === 'all') return 'all';
  return null;
}

export function normalizeInternalsPurpose(value = 'remember') {
  const normalized = String(value || 'remember').trim().toLowerCase();
  if (!normalized || normalized.length > 64 || !/^[a-z0-9_-]+$/.test(normalized)) return null;
  return normalized;
}

/**
 * RRF can see the same event more than once in a source and historically
 * concatenated every occurrence. Preserve the useful source combination while
 * removing repeats and making equivalent combinations share one label.
 */
export function normalizeSourceLabel(value) {
  const parts = String(value || 'unknown')
    .split('+')
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0) return 'unknown';
  return [...new Set(parts)].sort((a, b) => a.localeCompare(b)).join('+');
}

export function internalsSourcePaths(env = process.env) {
  const devDir = env.CARTOGRAPHER_DEV_DIR || join(homedir(), 'Documents', 'dev');
  return {
    served: env.CARTOGRAPHER_SERVED_LOG || join(devDir, 'served-log.jsonl'),
    access: env.CARTOGRAPHER_ACCESS_LEDGER || join(devDir, 'access-ledger.jsonl'),
    searchCalls: env.CARTOGRAPHER_SEARCH_CALL_LOG || join(devDir, '.carto', 'search-calls.jsonl'),
    indexErrors: env.CARTOGRAPHER_INDEX_ERROR_LOG
      || env.CARTOGRAPHER_INDEX_ERRORS
      || join(devDir, '.carto', 'index-errors.jsonl'),
  };
}

function fileIdentity(filePath) {
  try {
    const stat = statSync(filePath);
    return {
      path: filePath,
      exists: true,
      size: stat.size,
      mtimeMs: Math.round(stat.mtimeMs * 1000) / 1000,
    };
  } catch {
    return { path: filePath, exists: false, size: 0, mtimeMs: null };
  }
}

export function internalsSourceFingerprint(paths = internalsSourcePaths()) {
  const files = Object.fromEntries(
    Object.entries(paths).map(([name, filePath]) => [name, fileIdentity(filePath)])
  );
  const descriptor = Object.entries(files).map(([name, file]) => ({ name, ...file }));
  const value = createHash('sha256').update(JSON.stringify(descriptor)).digest('hex');
  const totalBytes = descriptor.reduce((sum, file) => sum + file.size, 0);
  return { value, totalBytes, files };
}

function parseJsonl(filePath) {
  let content;
  try {
    content = readFileSync(filePath, 'utf8');
  } catch {
    return { rows: [], totalLines: 0, validRows: 0, malformedRows: 0 };
  }

  const rows = [];
  let totalLines = 0;
  let malformedRows = 0;
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    totalLines++;
    try {
      const row = JSON.parse(line);
      if (row && typeof row === 'object' && !Array.isArray(row)) rows.push(row);
      else malformedRows++;
    } catch {
      malformedRows++;
    }
  }
  return { rows, totalLines, validRows: rows.length, malformedRows };
}

function timestampMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 2_000_000_000 ? value * 1000 : value;
  }
  if (typeof value === 'string' && /^\d+(\.\d+)?$/.test(value)) {
    const number = Number(value);
    return number < 2_000_000_000 ? number * 1000 : number;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function utcDay(value) {
  const ms = timestampMs(value);
  return ms === null ? null : new Date(ms).toISOString().slice(0, 10);
}

function inWindow(row, cutoffMs) {
  if (cutoffMs === null) return true;
  const ms = timestampMs(row.timestamp);
  return ms !== null && ms >= cutoffMs;
}

function positiveRank(value) {
  const rank = Number(value);
  return Number.isFinite(rank) && rank > 0 ? rank : null;
}

function nonNegativeNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function normalizeBackend(value) {
  const backend = String(value || '').trim().toLowerCase();
  if (backend === 'explorer' || backend === 'turbo') return 'explorer';
  if (backend === 'cli' || backend === 'portable') return 'cli';
  return 'unknown';
}

function percentile(values, probability) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const index = Math.max(0, Math.ceil(probability * sorted.length) - 1);
  return sorted[index];
}

function rankBucket(value) {
  const rank = positiveRank(value);
  if (rank === null) return 'unknown';
  if (rank <= 3) return '1-3';
  if (rank <= 7) return '4-7';
  if (rank <= 15) return '8-15';
  return '16+';
}

function accessRecord(row, index) {
  const ordinal = Number(row.access_ordinal);
  return {
    index,
    timestampMs: timestampMs(row.timestamp),
    batchId: typeof row.access_batch_id === 'string' && row.access_batch_id ? row.access_batch_id : null,
    ordinal: Number.isInteger(ordinal) && ordinal > 0 ? ordinal : null,
  };
}

function resolveAccessBoundary(accesses, edge) {
  if (accesses.length === 0) return { status: 'none', rank: null };
  const uniqueEvents = new Set(accesses.map((access) => access.eventId));
  if (uniqueEvents.size === 1) {
    const rank = accesses.find((access) => access.rank !== null)?.rank ?? null;
    return rank === null ? { status: 'unknown', rank: null } : { status: 'resolved', rank };
  }

  const validTimes = accesses.filter((access) => access.timestampMs !== null);
  if (validTimes.length !== accesses.length) return { status: 'unknown', rank: null };
  const boundaryMs = edge === 'first'
    ? Math.min(...validTimes.map((access) => access.timestampMs))
    : Math.max(...validTimes.map((access) => access.timestampMs));
  const boundary = validTimes.filter((access) => access.timestampMs === boundaryMs);
  const boundaryEvents = new Set(boundary.map((access) => access.eventId));
  if (boundaryEvents.size === 1) {
    const rank = boundary.find((access) => access.rank !== null)?.rank ?? null;
    return rank === null ? { status: 'unknown', rank: null } : { status: 'resolved', rank };
  }

  const batchIds = new Set(boundary.map((access) => access.batchId));
  const hasOrderedBatch = batchIds.size === 1
    && !batchIds.has(null)
    && boundary.every((access) => access.ordinal !== null);
  if (!hasOrderedBatch) return { status: 'unknown', rank: null };
  const targetOrdinal = edge === 'first'
    ? Math.min(...boundary.map((access) => access.ordinal))
    : Math.max(...boundary.map((access) => access.ordinal));
  const candidates = boundary.filter((access) => access.ordinal === targetOrdinal);
  if (new Set(candidates.map((access) => access.eventId)).size !== 1) {
    return { status: 'unknown', rank: null };
  }
  const rank = candidates.find((access) => access.rank !== null)?.rank ?? null;
  return rank === null ? { status: 'unknown', rank: null } : { status: 'resolved', rank };
}

function summarizeCalls(callValues) {
  const calls = [...callValues];
  const firstAccessRank = Object.fromEntries(FIRST_RANK_BUCKETS.map((bucket) => [bucket, 0]));
  const lastAccessRank = Object.fromEntries(FIRST_RANK_BUCKETS.map((bucket) => [bucket, 0]));
  let callsWithUse = 0;
  let servedRows = 0;
  let usedRows = 0;
  let firstAccessReciprocalRankSum = 0;
  let lastAccessReciprocalRankSum = 0;
  let orderedCalls = 0;
  let orderUnknownCalls = 0;
  let firstAccessUnknownCalls = 0;
  let lastAccessUnknownCalls = 0;
  let hitsConsumed = 0;
  let consumptionDepthUnknownCalls = 0;
  const consumptionDepthRanks = [];

  for (const call of calls) {
    servedRows += call.servedRows;
    usedRows += call.usedRows;
    if (call.used) callsWithUse++;
    const consumedEvents = new Map();
    for (const access of call.accesses) {
      if (!consumedEvents.has(access.eventId)) consumedEvents.set(access.eventId, []);
      if (access.rank !== null) consumedEvents.get(access.eventId).push(access.rank);
    }
    hitsConsumed += consumedEvents.size;
    if (consumedEvents.size > 0) {
      const consumedRanks = [...consumedEvents.values()]
        .flat()
        .filter((rank) => positiveRank(rank) !== null);
      if (consumedRanks.length > 0) consumptionDepthRanks.push(Math.max(...consumedRanks));
      else consumptionDepthUnknownCalls++;
    }
    const first = resolveAccessBoundary(call.accesses, 'first');
    const last = resolveAccessBoundary(call.accesses, 'last');
    firstAccessRank[first.status === 'resolved' ? rankBucket(first.rank) : first.status]++;
    lastAccessRank[last.status === 'resolved' ? rankBucket(last.rank) : last.status]++;
    if (first.status === 'unknown') firstAccessUnknownCalls++;
    if (last.status === 'unknown') lastAccessUnknownCalls++;
    if (first.status === 'unknown' || last.status === 'unknown') {
      orderUnknownCalls++;
      continue;
    }
    orderedCalls++;
    if (first.status === 'resolved') firstAccessReciprocalRankSum += 1 / first.rank;
    if (last.status === 'resolved') lastAccessReciprocalRankSum += 1 / last.rank;
  }

  return {
    calls: calls.length,
    callsWithUse,
    callSuccessRate: ratio(callsWithUse, calls.length),
    servedRows,
    usedRows,
    resultUseRate: ratio(usedRows, servedRows),
    hitsConsumed,
    hitsConsumedPerCall: ratio(hitsConsumed, calls.length),
    hitsConsumedPerSuccessfulCall: ratio(hitsConsumed, callsWithUse),
    consumptionDepth: {
      samples: consumptionDepthRanks.length,
      p50Rank: percentile(consumptionDepthRanks, 0.5),
      p95Rank: percentile(consumptionDepthRanks, 0.95),
      averageRank: consumptionDepthRanks.length > 0
        ? consumptionDepthRanks.reduce((sum, rank) => sum + rank, 0) / consumptionDepthRanks.length
        : null,
      maxRank: consumptionDepthRanks.length > 0 ? Math.max(...consumptionDepthRanks) : null,
      unknownCalls: consumptionDepthUnknownCalls,
    },
    mrr: orderedCalls > 0 ? firstAccessReciprocalRankSum / orderedCalls : null,
    firstAccessMrr: orderedCalls > 0 ? firstAccessReciprocalRankSum / orderedCalls : null,
    lastAccessMrr: orderedCalls > 0 ? lastAccessReciprocalRankSum / orderedCalls : null,
    orderedCalls,
    orderUnknownCalls,
    firstAccessUnknownCalls,
    lastAccessUnknownCalls,
    firstAccessRank,
    lastAccessRank,
    firstUsefulRank: firstAccessRank,
  };
}

function ratio(numerator, denominator) {
  return denominator > 0 ? numerator / denominator : null;
}

function makeGroup() {
  return { servedRows: 0, usedRows: 0, callIds: new Set(), usedCallIds: new Set() };
}

function addGroup(map, key, callId, used) {
  const label = key || '(none)';
  if (!map.has(label)) map.set(label, makeGroup());
  const group = map.get(label);
  group.servedRows++;
  group.callIds.add(callId);
  if (used) {
    group.usedRows++;
    group.usedCallIds.add(callId);
  }
}

function finalizeGroup(key, group) {
  return {
    key,
    servedRows: group.servedRows,
    usedRows: group.usedRows,
    resultUseRate: ratio(group.usedRows, group.servedRows),
    calls: group.callIds.size,
    callsWithUse: group.usedCallIds.size,
    callSuccessRate: ratio(group.usedCallIds.size, group.callIds.size),
  };
}

function finalizeGroups(map) {
  return [...map.entries()]
    .map(([key, group]) => finalizeGroup(key, group))
    .sort((a, b) => b.servedRows - a.servedRows || a.key.localeCompare(b.key));
}

function fileCoverage(identity, parsed) {
  return {
    ...identity,
    totalLines: parsed.totalLines,
    validRows: parsed.validRows,
    malformedRows: parsed.malformedRows,
  };
}

/**
 * Pure aggregation entry point for fixtures and tests. Result-use credit is
 * exact only: both sides must share call_id + event_id.
 */
export function aggregateInternalsRecords({
  servedRows = [],
  accessRows = [],
  searchCallRows = [],
  indexErrorRows = [],
  window = '30d',
  purpose = 'remember',
  nowMs = Date.now(),
} = {}) {
  const normalizedWindow = normalizeInternalsWindow(window);
  const normalizedPurpose = normalizeInternalsPurpose(purpose);
  if (!normalizedWindow) throw new Error(`Unsupported internals window: ${window}`);
  if (!normalizedPurpose) throw new Error(`Unsupported internals purpose: ${purpose}`);

  const days = INTERNALS_WINDOWS[normalizedWindow];
  const cutoffMs = days === null ? null : nowMs - days * DAY_MS;
  const selectedServed = servedRows.filter((row) => {
    if (!inWindow(row, cutoffMs)) return false;
    return normalizedPurpose === 'all' || String(row.purpose || '').toLowerCase() === normalizedPurpose;
  });
  const exactServed = selectedServed.filter((row) => row.call_id && row.event_id);
  const selectedSearchCalls = searchCallRows.filter((row) => {
    if (!inWindow(row, cutoffMs)) return false;
    return normalizedPurpose === 'all' || String(row.purpose || '').toLowerCase() === normalizedPurpose;
  });
  const searchCallById = new Map();
  for (const row of selectedSearchCalls) {
    if (row.call_id) searchCallById.set(String(row.call_id), row);
  }
  const selectedErrors = indexErrorRows.filter((row) => inWindow(row, cutoffMs));

  const exactUseKeys = new Set();
  const exactAccessByPair = new Map();
  let exactAccessRows = 0;
  for (let index = 0; index < accessRows.length; index++) {
    const row = accessRows[index];
    if (!row.call_id || !row.event_id) continue;
    exactAccessRows++;
    const key = `${row.call_id}\0${row.event_id}`;
    exactUseKeys.add(key);
    if (!exactAccessByPair.has(key)) exactAccessByPair.set(key, []);
    exactAccessByPair.get(key).push(accessRecord(row, index));
  }

  const calls = new Map();
  const purposeGroups = new Map();
  const sourceGroups = new Map();
  const projectGroups = new Map();
  const dailyGroups = new Map();

  let sessionAttributedRows = 0;
  for (const row of exactServed) {
    const callId = String(row.call_id);
    const accesses = exactAccessByPair.get(`${row.call_id}\0${row.event_id}`) || [];
    const used = accesses.length > 0;
    const rank = positiveRank(row.rank);
    const day = utcDay(row.timestamp) || 'unknown';
    const source = normalizeSourceLabel(row.source);
    const project = String(row.project || '(none)');
    const rowPurpose = String(row.purpose || '(missing)');

    if (row.session_id || row.session || row.sessionId) sessionAttributedRows++;

    if (!calls.has(callId)) {
      calls.set(callId, {
        used: false,
        accesses: [],
        accessKeys: new Set(),
        servedRows: 0,
        usedRows: 0,
        servedBackends: new Set(),
      });
    }
    const call = calls.get(callId);
    call.servedRows++;
    if (used) call.usedRows++;
    const servedBackend = normalizeBackend(row.backend);
    if (servedBackend !== 'unknown') call.servedBackends.add(servedBackend);
    if (used) {
      call.used = true;
      for (const access of accesses) {
        const accessKey = `${access.index}\0${row.event_id}`;
        if (call.accessKeys.has(accessKey)) continue;
        call.accessKeys.add(accessKey);
        call.accesses.push({ ...access, eventId: row.event_id, rank });
      }
    }

    addGroup(purposeGroups, rowPurpose, callId, used);
    addGroup(sourceGroups, source, callId, used);
    addGroup(projectGroups, project, callId, used);
    addGroup(dailyGroups, day, callId, used);
  }

  // Search-call timing rows are the authoritative mode/backend record. Add
  // zero-result calls here so they remain visible as no-use outcomes instead
  // of disappearing from latency and MRR denominators.
  for (const callId of searchCallById.keys()) {
    if (!calls.has(callId)) {
      calls.set(callId, {
        used: false,
        accesses: [],
        accessKeys: new Set(),
        servedRows: 0,
        usedRows: 0,
        servedBackends: new Set(),
      });
    }
  }

  for (const [callId, call] of calls) {
    const telemetry = searchCallById.get(callId);
    let selectedBackend = normalizeBackend(telemetry?.selected_backend || telemetry?.backend);
    if (selectedBackend === 'unknown' && call.servedBackends.size === 1) {
      selectedBackend = [...call.servedBackends][0];
    }
    let requestedBackend = normalizeBackend(telemetry?.requested_backend);
    if (requestedBackend === 'unknown') requestedBackend = selectedBackend;
    call.selectedBackend = selectedBackend;
    call.requestedBackend = requestedBackend;
    call.elapsedMs = nonNegativeNumber(telemetry?.elapsed_ms);
    call.stageTotalMs = nonNegativeNumber(telemetry?.stages_ms?.total);
    call.fallbackReason = telemetry?.fallback_reason || null;
  }

  const utility = summarizeCalls(calls.values());
  const modeCalls = new Map();
  for (const call of calls.values()) {
    if (!modeCalls.has(call.requestedBackend)) modeCalls.set(call.requestedBackend, []);
    modeCalls.get(call.requestedBackend).push(call);
  }
  const modeOrder = new Map([['explorer', 0], ['cli', 1], ['unknown', 2]]);
  const modeCohorts = [...modeCalls.entries()].map(([key, cohortCalls]) => {
    const cohortUtility = summarizeCalls(cohortCalls);
    const elapsed = cohortCalls.map((call) => call.elapsedMs).filter(Number.isFinite);
    const stageTotals = cohortCalls.map((call) => call.stageTotalMs).filter(Number.isFinite);
    const selectedBackends = {};
    let fallbackCalls = 0;
    for (const call of cohortCalls) {
      selectedBackends[call.selectedBackend] = (selectedBackends[call.selectedBackend] || 0) + 1;
      if (call.fallbackReason || (
        call.requestedBackend !== 'unknown'
        && call.selectedBackend !== 'unknown'
        && call.requestedBackend !== call.selectedBackend
      )) fallbackCalls++;
    }
    return {
      key,
      requestedBackend: key,
      ...cohortUtility,
      latency: {
        samples: elapsed.length,
        p50Ms: percentile(elapsed, 0.5),
        p95Ms: percentile(elapsed, 0.95),
      },
      stageLatency: {
        samples: stageTotals.length,
        p50Ms: percentile(stageTotals, 0.5),
        p95Ms: percentile(stageTotals, 0.95),
      },
      selectedBackends,
      fallbackCalls,
    };
  }).sort((a, b) => (modeOrder.get(a.key) ?? 99) - (modeOrder.get(b.key) ?? 99));

  const errorByStage = new Map();
  const errorByDay = new Map();
  for (const row of selectedErrors) {
    const stage = String(row.stage || 'unknown');
    const day = utcDay(row.timestamp) || 'unknown';
    errorByStage.set(stage, (errorByStage.get(stage) || 0) + 1);
    errorByDay.set(day, (errorByDay.get(day) || 0) + 1);
  }

  // A line between active days would falsely imply that the omitted days had
  // unknown values. Fill calendar gaps with explicit zeroes so the activity
  // trace shows silence as silence. Fixed rolling windows can span one extra
  // calendar label because their first day is partial.
  const daily = [];
  if (exactServed.length > 0) {
    const observedDays = [...dailyGroups.keys()].filter((day) => day !== 'unknown').sort();
    const firstDayMs = cutoffMs === null
      ? Date.parse(`${observedDays[0]}T00:00:00Z`)
      : Date.parse(`${new Date(cutoffMs).toISOString().slice(0, 10)}T00:00:00Z`);
    const lastDayMs = Date.parse(`${new Date(nowMs).toISOString().slice(0, 10)}T00:00:00Z`);
    for (let dayMs = firstDayMs; dayMs <= lastDayMs; dayMs += DAY_MS) {
      const date = new Date(dayMs).toISOString().slice(0, 10);
      const entry = finalizeGroup(date, dailyGroups.get(date) || makeGroup());
      const { key: _key, ...values } = entry;
      daily.push({ date, ...values });
    }
    if (dailyGroups.has('unknown')) {
      const { key: _key, ...values } = finalizeGroup('unknown', dailyGroups.get('unknown'));
      daily.push({ date: 'unknown', ...values });
    }
  }

  const exactAttributedRows = exactServed.length;
  return {
    window: {
      key: normalizedWindow,
      days,
      from: cutoffMs === null ? null : new Date(cutoffMs).toISOString(),
      to: new Date(nowMs).toISOString(),
    },
    purpose: normalizedPurpose,
    coverage: {
      served: {
        totalRows: servedRows.length,
        selectedRows: selectedServed.length,
        exactAttributedRows,
        exactAttributionRate: ratio(exactAttributedRows, selectedServed.length),
        missingCallIdRows: selectedServed.filter((row) => !row.call_id).length,
        missingEventIdRows: selectedServed.filter((row) => !row.event_id).length,
        sessionAttributedRows,
        sessionAttributionRate: ratio(sessionAttributedRows, exactAttributedRows),
      },
      access: {
        totalRows: accessRows.length,
        exactRows: exactAccessRows,
        exactUniquePairs: exactUseKeys.size,
        exactAttributionRate: ratio(exactAccessRows, accessRows.length),
      },
      indexErrors: {
        totalRows: indexErrorRows.length,
        selectedRows: selectedErrors.length,
      },
      searchCalls: {
        totalRows: searchCallRows.length,
        selectedRows: selectedSearchCalls.length,
        exactCallIdRows: selectedSearchCalls.filter((row) => row.call_id).length,
      },
      latencySamples: modeCohorts.reduce((sum, cohort) => sum + cohort.latency.samples, 0),
    },
    // Keep `mrr` as the compatibility field. It is first-access MRR: the
    // top-heavy precision proxy. Last-access MRR is the recall-depth proxy.
    utility,
    modeCohorts,
    purposes: finalizeGroups(purposeGroups),
    sources: finalizeGroups(sourceGroups),
    projects: finalizeGroups(projectGroups),
    daily,
    indexErrors: {
      total: indexErrorRows.length,
      inWindow: selectedErrors.length,
      byStage: [...errorByStage.entries()]
        .map(([stage, count]) => ({ stage, count }))
        .sort((a, b) => b.count - a.count || a.stage.localeCompare(b.stage)),
      daily: [...errorByDay.entries()]
        .map(([date, count]) => ({ date, count }))
        .sort((a, b) => a.date.localeCompare(b.date)),
    },
  };
}

export function buildInternalsSnapshotFromFiles({
  paths = internalsSourcePaths(),
  fingerprint = internalsSourceFingerprint(paths),
  window = '30d',
  purpose = 'remember',
  nowMs = Date.now(),
  executionMode = 'inline',
} = {}) {
  const started = performance.now();
  const served = parseJsonl(paths.served);
  const access = parseJsonl(paths.access);
  const searchCalls = parseJsonl(paths.searchCalls);
  const errors = parseJsonl(paths.indexErrors);
  const aggregate = aggregateInternalsRecords({
    servedRows: served.rows,
    accessRows: access.rows,
    searchCallRows: searchCalls.rows,
    indexErrorRows: errors.rows,
    window,
    purpose,
    nowMs,
  });
  const buildDurationMs = performance.now() - started;
  const files = {
    served: fileCoverage(fingerprint.files.served, served),
    access: fileCoverage(fingerprint.files.access, access),
    searchCalls: fileCoverage(fingerprint.files.searchCalls, searchCalls),
    indexErrors: fileCoverage(fingerprint.files.indexErrors, errors),
  };

  return {
    meta: {
      schemaVersion: INTERNALS_SCHEMA_VERSION,
      generatedAt: new Date(nowMs).toISOString(),
      window: aggregate.window,
      purpose: aggregate.purpose,
      sourceFingerprint: fingerprint.value,
      buildDurationMs,
      executionMode,
    },
    coverage: {
      ...aggregate.coverage,
      files,
    },
    utility: aggregate.utility,
    modeCohorts: aggregate.modeCohorts,
    purposes: aggregate.purposes,
    sources: aggregate.sources,
    projects: aggregate.projects,
    daily: aggregate.daily,
    operations: {
      files,
      indexErrors: aggregate.indexErrors,
      semanticCoverage: { available: false, reason: 'not measured by internals aggregation' },
      queryLatency: {
        available: aggregate.coverage.latencySamples > 0,
        samples: aggregate.coverage.latencySamples,
        byMode: aggregate.modeCohorts.map((cohort) => ({
          key: cohort.key,
          requestedBackend: cohort.requestedBackend,
          ...cohort.latency,
          fallbackCalls: cohort.fallbackCalls,
        })),
        reason: aggregate.coverage.latencySamples > 0 ? null : 'search stage timings are not persisted',
      },
    },
  };
}
