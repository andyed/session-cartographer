/**
 * The one definition of how a recall call's served results join to the marks
 * an agent left on them.
 *
 * Three readers ask this question: the Internals aggregate (rates over a
 * window), the session digest (/wrapup's "recall" line), and the Memory Desk's
 * Recall view (the ranked list itself). They must agree on what "used" means,
 * or the desk shows a marker the digest does not count.
 *
 * The rule is exact and never inferred:
 *   - A served result is the first (call_id, event_id) row the CLI wrote.
 *   - A result is "marked used" when an access-ledger row with
 *     source "result_used" carries the same call_id AND event_id.
 *   - A --get fetch ("result_fetched") joins the same way but is inspection,
 *     not a use mark, and is reported separately.
 *
 * Marks that do not join are kept, not dropped. The writer
 * (cartographer-search.sh:record_accesses) omits call_id when it cannot verify
 * attribution, recording why in attribution_status:
 *   - invalid_call: the agent named a call (requested_call_id) that never
 *     served that event in its session and purpose. Listed on the named call
 *     as a stray mark when that call exists.
 *   - no_session and the ambiguous_* statuses: no call is named at all.
 *     Listed as unplaced marks.
 * Crediting either to a row would be inference, which this pipeline keeps
 * report-only.
 */
import { readFileSync } from 'node:fs';
import { isResolved } from './sentinels.js';

export const USED_SOURCE = 'result_used';
export const FETCHED_SOURCE = 'result_fetched';

/** Tolerant JSONL reader shared by every telemetry consumer. */
export function parseJsonl(filePath) {
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

/** Epoch ms from an ISO string, epoch seconds, or epoch ms; null when unreadable. */
export function timestampMs(value) {
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

export function positiveRank(value) {
  const rank = Number(value);
  return Number.isFinite(rank) && rank > 0 ? rank : null;
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

/** A telemetry row's session, or null. Goes through isResolved: "" and "unknown" are not identities. */
export function recordSession(row) {
  for (const value of [row?.session_id, row?.session, row?.sessionId]) {
    if (isResolved(value)) return String(value).trim();
  }
  return null;
}

function resolvedText(value) {
  return isResolved(value) ? String(value).trim() : null;
}

export function pairKey(callId, eventId) {
  return `${callId}\0${eventId}`;
}

/**
 * Served rows that can join at all (both ids present), first occurrence per
 * (call_id, event_id). A call can repeat an event across ladders; counting the
 * repeat would inflate served and deflate the use rate.
 */
export function exactServedPairs(servedRows) {
  const attributed = servedRows.filter((row) => row.call_id && row.event_id);
  const byPair = new Map();
  for (const row of attributed) {
    const key = pairKey(row.call_id, row.event_id);
    if (!byPair.has(key)) byPair.set(key, row);
  }
  return { rows: [...byPair.values()], attributedRows: attributed.length, keys: new Set(byPair.keys()) };
}

/** Access rows that name a call, indexed by (call_id, event_id), with their ledger position. */
export function indexExactAccesses(accessRows) {
  const byPair = new Map();
  let exactRows = 0;
  for (let index = 0; index < accessRows.length; index++) {
    const row = accessRows[index];
    if (!row.call_id || !row.event_id) continue;
    exactRows++;
    const key = pairKey(row.call_id, row.event_id);
    if (!byPair.has(key)) byPair.set(key, []);
    byPair.get(key).push({ row, index });
  }
  return { byPair, exactRows };
}

function markOf(row) {
  return {
    event_id: String(row.event_id),
    timestamp: timestampMs(row.timestamp_ms) ?? timestampMs(row.timestamp),
    // Rows written before the writer recorded a status carry none; say so
    // rather than inventing one.
    attribution_status: resolvedText(row.attribution_status),
    session_id: recordSession(row),
    requested_call_id: resolvedText(row.requested_call_id),
  };
}

function newCall(callId) {
  return {
    call_id: callId, timestamp: null, query: '', purpose: null, session_id: null,
    provider: null, backend: null, rows: [], stray: [],
  };
}

function fillCallFields(call, row) {
  const t = timestampMs(row.timestamp);
  if (t !== null) call.timestamp = call.timestamp === null ? t : Math.min(call.timestamp, t);
  call.query ||= resolvedText(row.query) || '';
  call.purpose ||= resolvedText(row.purpose);
  call.session_id ||= recordSession(row);
  call.provider ||= resolvedText(row.provider);
  call.backend ||= resolvedText(row.selected_backend) || resolvedText(row.backend);
}

/**
 * Every call the logs know about, each with its ranked results and marks.
 * searchCallRows add zero-result calls and fill fields the served rows lack;
 * they never override what the served rows recorded.
 */
export function buildRecallIndex({ servedRows = [], accessRows = [], searchCallRows = [] } = {}) {
  const { rows: served, keys: servedKeys } = exactServedPairs(servedRows);
  const { byPair } = indexExactAccesses(accessRows);
  const calls = new Map();

  for (const row of served) {
    const callId = String(row.call_id);
    if (!calls.has(callId)) calls.set(callId, newCall(callId));
    const call = calls.get(callId);
    fillCallFields(call, row);
    const accesses = (byPair.get(pairKey(row.call_id, row.event_id)) || []).map(({ row: access }) => access);
    call.rows.push({
      event_id: String(row.event_id),
      rank: positiveRank(row.rank),
      source: normalizeSourceLabel(row.source),
      project: resolvedText(row.project),
      used: accesses.filter((access) => access.source === USED_SOURCE).map(markOf),
      fetched: accesses.filter((access) => access.source === FETCHED_SOURCE).map(markOf),
    });
  }

  for (const row of searchCallRows) {
    if (!row.call_id) continue;
    const callId = String(row.call_id);
    if (!calls.has(callId)) calls.set(callId, newCall(callId));
    fillCallFields(calls.get(callId), row);
  }

  const unplaced = [];
  for (const row of accessRows) {
    if (row.source !== USED_SOURCE || !row.event_id) continue;
    if (row.call_id && servedKeys.has(pairKey(row.call_id, row.event_id))) continue;
    const named = resolvedText(row.call_id) || resolvedText(row.requested_call_id);
    if (named && calls.has(named)) calls.get(named).stray.push(markOf(row));
    else unplaced.push(markOf(row));
  }

  for (const call of calls.values()) {
    call.rows.sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity) || a.event_id.localeCompare(b.event_id));
    Object.assign(call, summarizeCall(call));
  }
  return { calls, unplaced };
}

/** Counts shown beside a call. `used` counts results, not marks: two touches of one row are one use. */
export function summarizeCall(call) {
  const usedRanks = call.rows.filter((row) => row.used.length > 0).map((row) => row.rank);
  const knownRanks = usedRanks.filter((rank) => rank !== null);
  return {
    served: call.rows.length,
    used: usedRanks.length,
    fetched: call.rows.filter((row) => row.fetched.length > 0).length,
    stray_marks: call.stray.length,
    used_ranks: knownRanks.sort((a, b) => a - b),
    deepest_used_rank: knownRanks.length ? Math.max(...knownRanks) : null,
  };
}

/** The digest's recall line for one session, from the same join the desk renders. */
export function sessionRecallSummary(index, sessionId) {
  const calls = [...index.calls.values()].filter((call) => call.session_id === sessionId);
  const usedEventIds = new Set();
  for (const call of calls) {
    for (const row of call.rows) if (row.used.length) usedEventIds.add(row.event_id);
  }
  return {
    calls: calls.length,
    served: calls.reduce((sum, call) => sum + call.served, 0),
    used: usedEventIds.size,
    used_event_ids: [...usedEventIds],
  };
}
