#!/usr/bin/env node
/**
 * Report /remember result inspection and explicit use separately.
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
import { aggregateInternalsRecords } from '../explorer/server/internals-aggregate.js';

const DEV = process.env.CARTOGRAPHER_DEV_DIR || path.join(process.env.HOME, 'Documents/dev');
const SERVED_LOG = process.env.CARTOGRAPHER_SERVED_LOG || path.join(DEV, 'served-log.jsonl');
const ACCESS_LEDGER = process.env.CARTOGRAPHER_ACCESS_LEDGER || path.join(DEV, 'access-ledger.jsonl');
const SEARCH_CALL_LOG = process.env.CARTOGRAPHER_SEARCH_CALL_LOG || path.join(DEV, '.carto/search-calls.jsonl');

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

function pct(numerator, denominator) {
  return denominator === 0 ? '—' : `${((numerator / denominator) * 100).toFixed(1)}%`;
}

function sortedRows(map) {
  return [...map.entries()].sort((a, b) => b[1].served - a[1].served);
}

const allServed = readJsonl(SERVED_LOG);
const allUses = readJsonl(ACCESS_LEDGER);
const searchCalls = readJsonl(SEARCH_CALL_LOG).filter((row) => {
  if (!row.call_id || (!row.purpose && !INCLUDE_LEGACY)) return false;
  return PURPOSE_FILTER === 'all' || row.purpose === PURPOSE_FILTER;
});
const seenPairs = new Set();
const served = allServed.filter((row) => {
  const isLegacy = !row.call_id || !row.purpose;
  if (isLegacy && !INCLUDE_LEGACY) return false;
  if (PURPOSE_FILTER !== 'all' && row.purpose !== PURPOSE_FILTER) return false;
  if (!row.event_id) return false;
  if (row.call_id) {
    const key = `${row.call_id}\0${row.event_id}`;
    if (seenPairs.has(key)) return false;
    seenPairs.add(key);
  }
  return true;
});

if (served.length === 0 && searchCalls.length === 0 && !AS_JSON) {
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
  exactAccessByPair.get(key).push(use);
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
      legacyAccessByRow.get(bestIndex).push(use);
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

for (let index = 0; index < served.length; index++) {
  const row = served[index];
  const accesses = row.call_id
    ? exactAccessByPair.get(`${row.call_id}\0${row.event_id}`) || []
    : legacyAccessByRow.get(index) || [];
  const hit = accesses.length > 0;
  const rank = Number(row.rank);
  const purpose = row.purpose || 'legacy';

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
}

// Keep legacy latest-serve inference isolated and opt-in. Both modes then use
// the Explorer's exact aggregator for ordering, source filters and zero-result
// call denominators; report computation never modifies either ledger.
const syntheticCallId = (row) => `legacy:${row.timestamp}\0${row.query || ''}`;
const canonical = aggregateInternalsRecords({
  window: 'all',
  purpose: 'all',
  servedRows: served.map((row) => row.call_id ? row : { ...row, call_id: syntheticCallId(row) }),
  accessRows: [
    ...allUses.filter((row) => row.call_id),
    ...[...legacyAccessByRow.entries()].flatMap(([index, accesses]) =>
      accesses.map((access) => ({ ...access, call_id: syntheticCallId(served[index]) }))),
  ],
  searchCallRows: searchCalls,
});
const utility = canonical.utility;
const accessMrr = {
  firstValue: utility.firstAccessMrr,
  lastValue: utility.lastAccessMrr,
  measuredInstances: utility.orderedCalls,
  unknownInstances: utility.orderUnknownCalls,
  firstUnknownInstances: utility.firstAccessUnknownCalls,
  lastUnknownInstances: utility.lastAccessUnknownCalls,
  firstDistribution: new Map(Object.entries(utility.firstAccessRank)),
  lastDistribution: new Map(Object.entries(utility.lastAccessRank)),
};
const deadWeight = sortedRows(byEvent).filter(([, value]) => value.served >= 3 && value.hit === 0).slice(0, 15);
const zeroHitQueries = sortedRows(byQuery).filter(([, value]) => value.served >= 2 && value.hit === 0).slice(0, 15);

const report = {
  purposeFilter: PURPOSE_FILTER,
  includeLegacy: INCLUDE_LEGACY,
  legacyWindowMinutes: WINDOW_MIN,
  utility,
  modeCohorts: canonical.modeCohorts,
  coverage: canonical.coverage,
  overall: { ...overall, hitRate: overall.served ? overall.hit / overall.served : null },
  mrr: {
    value: accessMrr.firstValue,
    firstAccessValue: accessMrr.firstValue,
    lastAccessValue: accessMrr.lastValue,
    instances: utility.calls,
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
} else {
  console.log(`Session Cartographer — result access and explicit use report (purpose: ${PURPOSE_FILTER})`);
  console.log('='.repeat(66));
  console.log(`Overall: ${overall.hit}/${overall.served} served results accessed — ${pct(overall.hit, overall.served)}`);
  console.log(`First-access MRR: ${accessMrr.firstValue === null ? '—' : accessMrr.firstValue.toFixed(3)} across ${accessMrr.measuredInstances}/${utility.calls} jointly ordered call${utility.calls === 1 ? '' : 's'}`);
  console.log(`Last-access MRR:  ${accessMrr.lastValue === null ? '—' : accessMrr.lastValue.toFixed(3)} across ${accessMrr.measuredInstances}/${utility.calls} jointly ordered call${utility.calls === 1 ? '' : 's'}`);
  if (INCLUDE_LEGACY) console.log(`Legacy rows included; unmatched touches use latest-serve attribution within ${WINDOW_MIN} minutes.`);

  console.log(`Fetched: ${utility.fetched.callsWithUse}/${utility.calls} calls (${pct(utility.fetched.callsWithUse, utility.calls)}); first-access MRR ${utility.fetched.firstAccessMrr === null ? '—' : utility.fetched.firstAccessMrr.toFixed(3)}`);
  console.log(`Explicit use: ${utility.explicitUse.callsWithUse}/${utility.calls} calls (${pct(utility.explicitUse.callsWithUse, utility.calls)}); first-use MRR ${utility.explicitUse.firstAccessMrr === null ? '—' : utility.explicitUse.firstAccessMrr.toFixed(3)}`);
  console.log('Access combines recorded sources; fetching alone does not assert useful recall.');
  for (const mode of canonical.modeCohorts) {
    console.log(`\n${mode.key}: ${mode.calls} calls; ${mode.fallbackCalls} fallbacks; response p50/p95/max ${mode.latency.p50Ms ?? '—'}/${mode.latency.p95Ms ?? '—'}/${mode.latency.maxMs ?? '—'} ms`);
    for (const cohort of mode.semanticCohorts) {
      console.log(`  semantic ${cohort.key}: ${cohort.calls} calls; explicit use ${pct(cohort.explicitUse.callsWithUse, cohort.calls)}; MRR ${cohort.explicitUse.firstAccessMrr === null ? '—' : cohort.explicitUse.firstAccessMrr.toFixed(3)}; response p50/p95/max ${cohort.latency.p50Ms ?? '—'}/${cohort.latency.p95Ms ?? '—'}/${cohort.latency.maxMs ?? '—'} ms`);
    }
  }
  console.log('\nFirst accessed result:');
  for (const bucket of ['1-3', '4-7', '8-15', '16+', 'unknown', 'none']) {
    if (!accessMrr.firstDistribution.has(bucket)) continue;
    const count = accessMrr.firstDistribution.get(bucket);
    console.log(`  ${bucket.padEnd(8)} ${count} call${count === 1 ? '' : 's'} (${pct(count, utility.calls)})`);
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
    console.log('\nRepeatedly served and never accessed:');
    for (const [id, value] of deadWeight) console.log(`  ${id} — ${value.served} serves; last query: "${value.lastQuery}"`);
  }
  if (zeroHitQueries.length) {
    console.log('\nRepeated queries with no recorded access:');
    for (const [query, value] of zeroHitQueries) console.log(`  "${query}" — ${value.served} served rows`);
  }
}
