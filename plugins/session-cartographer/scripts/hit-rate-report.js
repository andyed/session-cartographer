#!/usr/bin/env node
/**
 * Report whether /remember results were explicitly used.
 *
 * New telemetry joins served rows to result-use records by call_id. Legacy
 * rows can be included explicitly; each legacy touch is assigned only to the
 * latest eligible serve, preventing one touch from crediting several calls.
 *
 * Usage:
 *   node scripts/hit-rate-report.js
 *   node scripts/hit-rate-report.js --json
 *   node scripts/hit-rate-report.js --purpose all --include-legacy
 *   node scripts/hit-rate-report.js --window 120
 */
import fs from 'fs';
import path from 'path';

const DEV = process.env.CARTOGRAPHER_DEV_DIR || path.join(process.env.HOME, 'Documents/dev');
const SERVED_LOG = process.env.CARTOGRAPHER_SERVED_LOG || path.join(DEV, 'served-log.jsonl');
const ACCESS_LEDGER = process.env.CARTOGRAPHER_ACCESS_LEDGER || path.join(DEV, 'access-ledger.jsonl');

const args = process.argv.slice(2);
const AS_JSON = args.includes('--json');
const INCLUDE_LEGACY = args.includes('--include-legacy');
const valueAfter = (flag, fallback) => {
  const idx = args.indexOf(flag);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : fallback;
};
const PURPOSE_FILTER = valueAfter('--purpose', 'remember');
const WINDOW_MIN = Number.parseFloat(valueAfter('--window', '120'));
if (!Number.isFinite(WINDOW_MIN) || WINDOW_MIN <= 0) {
  console.error('--window must be a positive number of minutes');
  process.exit(2);
}

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter(Boolean);
}

function toMs(iso) {
  const value = Date.parse(iso);
  return Number.isNaN(value) ? null : value;
}

function rankBucket(rank) {
  const value = Number(rank);
  if (!Number.isFinite(value) || value <= 0) return 'unknown';
  if (value <= 3) return '1-3';
  if (value <= 7) return '4-7';
  if (value <= 15) return '8-15';
  return '16+';
}

function accessRecord(row, index) {
  const ordinal = Number(row.access_ordinal);
  return {
    index,
    timestampMs: toMs(row.timestamp),
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

function summarizeAccessMrr(instances) {
  let firstReciprocalRankSum = 0;
  let lastReciprocalRankSum = 0;
  let measuredInstances = 0;
  let unknownInstances = 0;
  let firstUnknownInstances = 0;
  let lastUnknownInstances = 0;
  const firstDistribution = new Map();
  const lastDistribution = new Map();
  for (const instance of instances.values()) {
    const first = resolveAccessBoundary(instance.accesses, 'first');
    const last = resolveAccessBoundary(instance.accesses, 'last');
    const firstBucket = first.status === 'resolved' ? rankBucket(first.rank) : first.status;
    const lastBucket = last.status === 'resolved' ? rankBucket(last.rank) : last.status;
    firstDistribution.set(firstBucket, (firstDistribution.get(firstBucket) || 0) + 1);
    lastDistribution.set(lastBucket, (lastDistribution.get(lastBucket) || 0) + 1);
    if (first.status === 'unknown') firstUnknownInstances++;
    if (last.status === 'unknown') lastUnknownInstances++;
    if (first.status === 'unknown' || last.status === 'unknown') {
      unknownInstances++;
      continue;
    }
    measuredInstances++;
    if (first.status === 'resolved') firstReciprocalRankSum += 1 / first.rank;
    if (last.status === 'resolved') lastReciprocalRankSum += 1 / last.rank;
  }
  return {
    firstValue: measuredInstances > 0 ? firstReciprocalRankSum / measuredInstances : null,
    lastValue: measuredInstances > 0 ? lastReciprocalRankSum / measuredInstances : null,
    measuredInstances,
    unknownInstances,
    firstUnknownInstances,
    lastUnknownInstances,
    firstDistribution,
    lastDistribution,
  };
}

function pct(numerator, denominator) {
  return denominator === 0 ? '—' : `${((numerator / denominator) * 100).toFixed(1)}%`;
}

function sortedRows(map) {
  return [...map.entries()].sort((a, b) => b[1].served - a[1].served);
}

const allServed = readJsonl(SERVED_LOG);
const allUses = readJsonl(ACCESS_LEDGER);
const served = allServed.filter((row) => {
  const isLegacy = !row.call_id || !row.purpose;
  if (isLegacy && !INCLUDE_LEGACY) return false;
  if (PURPOSE_FILTER === 'all') return true;
  return row.purpose === PURPOSE_FILTER;
});

if (served.length === 0) {
  console.log(`No ${PURPOSE_FILTER} served-result data matched at ${SERVED_LOG}.`);
  if (!INCLUDE_LEGACY) console.log('Use --include-legacy to inspect pre-attribution rows.');
  process.exit(0);
}

// Exact attribution for new records: call_id + event_id is the join key.
const exactAccessByPair = new Map();
for (let index = 0; index < allUses.length; index++) {
  const use = allUses[index];
  if (!use.call_id || !use.event_id) continue;
  const key = `${use.call_id}\0${use.event_id}`;
  if (!exactAccessByPair.has(key)) exactAccessByPair.set(key, []);
  exactAccessByPair.get(key).push(accessRecord(use, index));
}

// Legacy attribution is opt-in. Assign every touch without a call_id to the
// single latest preceding serve for that event inside the time window.
const legacyAccessByRow = new Map();
if (INCLUDE_LEGACY) {
  const windowMs = WINDOW_MIN * 60 * 1000;
  for (let useIndex = 0; useIndex < allUses.length; useIndex++) {
    const use = allUses[useIndex];
    if (use.call_id || !use.event_id) continue;
    const useMs = toMs(use.timestamp);
    if (useMs === null) continue;
    let bestIndex = -1;
    let bestMs = -Infinity;
    for (let index = 0; index < served.length; index++) {
      const row = served[index];
      if (row.call_id || row.event_id !== use.event_id) continue;
      if (use.session_id && row.session_id && use.session_id !== row.session_id) continue;
      const serveMs = toMs(row.timestamp);
      if (serveMs === null || serveMs > useMs || useMs - serveMs > windowMs) continue;
      if (serveMs > bestMs) {
        bestMs = serveMs;
        bestIndex = index;
      }
    }
    if (bestIndex >= 0) {
      if (!legacyAccessByRow.has(bestIndex)) legacyAccessByRow.set(bestIndex, []);
      legacyAccessByRow.get(bestIndex).push(accessRecord(use, useIndex));
    }
  }
}

const overall = { served: 0, hit: 0 };
const byRank = new Map();
const bySource = new Map();
const byProject = new Map();
const byPurpose = new Map();
const byEvent = new Map();
const byQuery = new Map();
const instances = new Map();

for (let index = 0; index < served.length; index++) {
  const row = served[index];
  const accesses = row.call_id
    ? exactAccessByPair.get(`${row.call_id}\0${row.event_id}`) || []
    : legacyAccessByRow.get(index) || [];
  const hit = accesses.length > 0;
  const rank = Number(row.rank);
  const purpose = row.purpose || 'legacy';
  const instanceKey = row.call_id || `legacy:${row.timestamp}\0${row.query || ''}`;

  overall.served++;
  if (hit) overall.hit++;

  for (const [map, key] of [
    [byRank, rankBucket(rank)],
    [bySource, row.source || 'unknown'],
    [byProject, row.project || '(none)'],
    [byPurpose, purpose],
  ]) {
    if (!map.has(key)) map.set(key, { served: 0, hit: 0 });
    map.get(key).served++;
    if (hit) map.get(key).hit++;
  }

  if (!byEvent.has(row.event_id)) byEvent.set(row.event_id, { served: 0, hit: 0, lastQuery: row.query });
  const event = byEvent.get(row.event_id);
  event.served++;
  if (hit) event.hit++;
  event.lastQuery = row.query;

  const query = row.query || '(empty)';
  if (!byQuery.has(query)) byQuery.set(query, { served: 0, hit: 0 });
  byQuery.get(query).served++;
  if (hit) byQuery.get(query).hit++;

  if (!instances.has(instanceKey)) instances.set(instanceKey, { accesses: [], accessKeys: new Set(), purpose });
  if (hit) {
    const instance = instances.get(instanceKey);
    const accessedRank = Number.isFinite(rank) && rank > 0 ? rank : null;
    for (const access of accesses) {
      const accessKey = `${access.index}\0${row.event_id}`;
      if (instance.accessKeys.has(accessKey)) continue;
      instance.accessKeys.add(accessKey);
      instance.accesses.push({ ...access, eventId: row.event_id, rank: accessedRank });
    }
  }
}

const accessMrr = summarizeAccessMrr(instances);
const deadWeight = sortedRows(byEvent).filter(([, value]) => value.served >= 3 && value.hit === 0).slice(0, 15);
const zeroHitQueries = sortedRows(byQuery).filter(([, value]) => value.served >= 2 && value.hit === 0).slice(0, 15);

const report = {
  purposeFilter: PURPOSE_FILTER,
  includeLegacy: INCLUDE_LEGACY,
  legacyWindowMinutes: WINDOW_MIN,
  overall: { ...overall, hitRate: overall.served ? overall.hit / overall.served : null },
  mrr: {
    value: accessMrr.firstValue,
    firstAccessValue: accessMrr.firstValue,
    lastAccessValue: accessMrr.lastValue,
    instances: instances.size,
    orderedInstances: accessMrr.measuredInstances,
    orderUnknownInstances: accessMrr.unknownInstances,
    firstAccessMeasuredInstances: accessMrr.measuredInstances,
    lastAccessMeasuredInstances: accessMrr.measuredInstances,
    firstAccessUnknownInstances: accessMrr.firstUnknownInstances,
    lastAccessUnknownInstances: accessMrr.lastUnknownInstances,
    firstAccessRankDistribution: Object.fromEntries(accessMrr.firstDistribution),
    lastAccessRankDistribution: Object.fromEntries(accessMrr.lastDistribution),
    firstHitRankDistribution: Object.fromEntries(accessMrr.firstDistribution),
  },
  byRank: Object.fromEntries(byRank),
  bySource: Object.fromEntries(bySource),
  byProject: Object.fromEntries(byProject),
  byPurpose: Object.fromEntries(byPurpose),
  deadWeightEvents: deadWeight.map(([event_id, value]) => ({ event_id, ...value })),
  zeroHitQueries: zeroHitQueries.map(([query, value]) => ({ query, ...value })),
};

if (AS_JSON) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

console.log(`Session Cartographer — explicit result-use report (purpose: ${PURPOSE_FILTER})`);
console.log('='.repeat(66));
console.log(`Overall: ${overall.hit}/${overall.served} served results used — ${pct(overall.hit, overall.served)}`);
console.log(`First-access MRR: ${accessMrr.firstValue === null ? '—' : accessMrr.firstValue.toFixed(3)} across ${accessMrr.measuredInstances}/${instances.size} jointly ordered call${instances.size === 1 ? '' : 's'}`);
console.log(`Last-access MRR:  ${accessMrr.lastValue === null ? '—' : accessMrr.lastValue.toFixed(3)} across ${accessMrr.measuredInstances}/${instances.size} jointly ordered call${instances.size === 1 ? '' : 's'}`);
if (INCLUDE_LEGACY) console.log(`Legacy rows included; unmatched touches use latest-serve attribution within ${WINDOW_MIN} minutes.`);

console.log('\nFirst accessed result:');
for (const bucket of ['1-3', '4-7', '8-15', '16+', 'unknown', 'none']) {
  if (!accessMrr.firstDistribution.has(bucket)) continue;
  const count = accessMrr.firstDistribution.get(bucket);
  console.log(`  ${bucket.padEnd(8)} ${count} call${count === 1 ? '' : 's'} (${pct(count, instances.size)})`);
}

for (const [title, map] of [
  ['By rank', byRank],
  ['By source', bySource],
  ['By project', byProject],
  ['By purpose', byPurpose],
]) {
  console.log(`\n${title}:`);
  for (const [key, value] of sortedRows(map).slice(0, 15)) {
    console.log(`  ${key.padEnd(22)} ${String(value.hit).padStart(4)}/${String(value.served).padEnd(5)} ${pct(value.hit, value.served)}`);
  }
}

if (deadWeight.length) {
  console.log('\nRepeatedly served and never used:');
  for (const [id, value] of deadWeight) console.log(`  ${id} — ${value.served} serves; last query: "${value.lastQuery}"`);
}
if (zeroHitQueries.length) {
  console.log('\nRepeated queries with no explicit use:');
  for (const [query, value] of zeroHitQueries) console.log(`  "${query}" — ${value.served} served rows`);
}
