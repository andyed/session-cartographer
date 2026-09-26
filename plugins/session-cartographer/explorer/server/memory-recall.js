/**
 * Recall telemetry for the Memory Desk: which /remember calls ran in a window,
 * what each returned in rank order, and which results the agent marked used.
 *
 * Loaded on demand through its own endpoints, never folded into
 * /api/memory/state: that payload is polled every few seconds and already
 * runs to megabytes for a day's tasks.
 *
 * Read-only. scripts/cartographer-search.sh stays the single writer of the
 * served log and access ledger; opening the desk must not add rows to either.
 */
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { firstResolved, isResolved } from '../../scripts/sentinels.js';
import { buildRecallIndex, parseJsonl } from '../../scripts/recall-join.js';
import { eventEpochMs } from './event-time.js';
import { internalsSourcePaths } from './internals-aggregate.js';

const DAY_MS = 24 * 60 * 60 * 1000;
export const RECALL_DEFAULT_WINDOW_MS = DAY_MS;
export const RECALL_MAX_WINDOW_MS = 90 * DAY_MS;
export const RECALL_CALL_LIMIT = 500;
const UNPLACED_LIMIT = 200;
const SUMMARY_CHARS = 400;

function text(value) {
  return isResolved(value) ? String(value).trim() : null;
}

function fileIdentity(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
  } catch {
    return 'missing';
  }
}

/**
 * A lazily rebuilt index over the three telemetry logs. The logs are append-
 * only and tens of thousands of rows; parsing them per request would put tens
 * of milliseconds on every expand, so the index is kept until a file changes.
 */
export function createRecallSource({ paths = internalsSourcePaths() } = {}) {
  let cached = null;
  return function load() {
    const key = [paths.served, paths.access, paths.searchCalls].map(fileIdentity).join('|');
    if (cached?.key === key) return cached.value;
    const served = parseJsonl(paths.served);
    const access = parseJsonl(paths.access);
    const searchCalls = parseJsonl(paths.searchCalls);
    const coverage = Object.fromEntries([['served', served], ['access', access], ['searchCalls', searchCalls]]
      .map(([name, parsed]) => [name, { rows: parsed.validRows, malformedRows: parsed.malformedRows, exists: fileIdentity(paths[name]) !== 'missing' }]));
    const value = {
      index: buildRecallIndex({ servedRows: served.rows, accessRows: access.rows, searchCallRows: searchCalls.rows }),
      coverage,
    };
    cached = { key, value };
    return value;
  };
}

function callSummary(call) {
  return {
    call_id: call.call_id,
    timestamp: call.timestamp,
    query: call.query,
    purpose: call.purpose,
    session_id: call.session_id,
    provider: call.provider,
    backend: call.backend,
    served: call.served,
    used: call.used,
    fetched: call.fetched,
    stray_marks: call.stray_marks,
    used_ranks: call.used_ranks,
    deepest_used_rank: call.deepest_used_rank,
  };
}

const purposeKey = (call) => call.purpose || '(none)';

/**
 * Calls in a window, newest first. A call with no session is listed with
 * session_id null and counted as unattributed; dropping it would make a day
 * whose calls were mostly unattributed read as a day without recall.
 */
export function listRecallCalls({ index, coverage }, { from = null, through = null, session = null, purpose = null, limit = RECALL_CALL_LIMIT } = {}) {
  const inWindow = (t) => (from === null || (t !== null && t >= from)) && (through === null || (t !== null && t <= through));
  const selected = [...index.calls.values()].filter((call) => (session === null || call.session_id === session) && inWindow(call.timestamp));
  const purposes = {};
  for (const call of selected) purposes[purposeKey(call)] = (purposes[purposeKey(call)] || 0) + 1;
  const calls = (purpose ? selected.filter((call) => purposeKey(call) === purpose) : selected)
    .sort((a, b) => (b.timestamp ?? -Infinity) - (a.timestamp ?? -Infinity) || a.call_id.localeCompare(b.call_id));
  const attributed = calls.filter((call) => call.session_id !== null);
  const sum = (field) => calls.reduce((total, call) => total + call[field], 0);

  const marks = index.unplaced
    .filter((mark) => (session === null || mark.session_id === session) && inWindow(mark.timestamp))
    .sort((a, b) => (b.timestamp ?? -Infinity) - (a.timestamp ?? -Infinity) || a.event_id.localeCompare(b.event_id));
  const byStatus = {};
  for (const mark of marks) {
    const status = mark.attribution_status || 'not recorded';
    byStatus[status] = (byStatus[status] || 0) + 1;
  }

  return {
    window: { from, through },
    session,
    purpose,
    purposes,
    totals: {
      calls: calls.length,
      attributed: attributed.length,
      unattributed: calls.length - attributed.length,
      sessions: new Set(attributed.map((call) => call.session_id)).size,
      served: sum('served'),
      used: sum('used'),
      fetched: sum('fetched'),
      stray_marks: sum('stray_marks'),
    },
    calls: calls.slice(0, limit).map(callSummary),
    truncated: Math.max(0, calls.length - limit),
    unplaced: { total: marks.length, by_status: byStatus, marks: marks.slice(0, UNPLACED_LIMIT) },
    coverage,
  };
}

// Transcript turns live only in the semantic index, but their ids name their
// session: turn-<sid>-<idx> (Claude), turn-codex-<sid>-<idx>, turn-hermes-<sid>-<idx>.
const TURN_ID = /^turn-(?:(codex|hermes)-)?(.+)-(\d+)$/;
export function parseTurnId(eventId) {
  const match = TURN_ID.exec(String(eventId || ''));
  if (!match) return null;
  return { provider: match[1] || 'claude', session_id: match[2], turn: Number(match[3]) };
}

// Must stay byte-identical to hashToInt() in scripts/embed-events.js and
// cartographer_point_id() in scripts/index-event.sh.
export function qdrantPointId(eventId) {
  return parseInt(createHash('sha256').update(String(eventId)).digest('hex').slice(0, 13), 16);
}

/**
 * Fetch index payloads for ids the warm corpus does not hold (transcript
 * turns, backfilled memories). Bounded and optional: a slow or absent index
 * leaves those rows resolved from their id alone, and the response says why.
 */
export async function fetchIndexedEvents(ids, { env = process.env, timeoutMs = 1500 } = {}) {
  if (!ids.length) return { status: 'not-needed', events: [] };
  if (env.CARTOGRAPHER_SEMANTIC === '0') return { status: 'disabled', events: [] };
  const url = env.CARTOGRAPHER_QDRANT_URL || 'http://localhost:6333';
  const collection = env.CARTOGRAPHER_COLLECTION || 'session-cartographer';
  try {
    const response = await fetch(`${url}/collections/${encodeURIComponent(collection)}/points`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: ids.map(qdrantPointId), with_payload: true, with_vector: false }),
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'error',
    });
    if (!response.ok) return { status: 'unavailable', events: [] };
    const body = await response.json();
    const wanted = new Set(ids);
    // A 52-bit point id can collide; only a payload naming the requested id counts.
    const events = (body.result || []).map((point) => point?.payload).filter((payload) => payload && wanted.has(payload.event_id));
    return { status: 'available', events };
  } catch {
    return { status: 'unavailable', events: [] };
  }
}

function eventSession(event) {
  const value = firstResolved([event.session_id, event.session, event.sessionId]);
  return typeof value === 'string' || typeof value === 'number' ? String(value).trim() || null : null;
}

// The corpus's field fallback chain (CLAUDE.md: summary → description → prompt → url → query → milestone).
function eventSummary(event) {
  const value = text(firstResolved([event.summary, event.display, event.description, event.prompt, event.url, event.query, event.milestone]));
  if (!value) return null;
  const clean = value.replace(/\s+/g, ' ');
  return clean.length > SUMMARY_CHARS ? `${clean.slice(0, SUMMARY_CHARS - 1).trimEnd()}…` : clean;
}

function describe(event, resolution) {
  const t = eventEpochMs(event);
  return {
    resolution,
    summary: eventSummary(event),
    event_project: text(event.project),
    event_timestamp: Number.isFinite(t) ? t : null,
    session_id: eventSession(event),
    provider: text(event.provider)?.toLowerCase() || null,
    type: text(firstResolved([event.type, event.event, event.milestone])),
  };
}

function fillMissing(target, source) {
  for (const [key, value] of Object.entries(source)) if (target[key] === null || target[key] === undefined) target[key] = value;
}

/**
 * event_id → what the result was and which episode it came from.
 * Order: warm corpus, then the semantic index, then the turn id itself.
 * An id none of them knows is reported with resolution null, never dropped.
 */
export async function resolveRecallEvents(ids, events, { lookupIndexed = fetchIndexedEvents } = {}) {
  const wanted = new Set(ids);
  const found = new Map();
  for (const event of events) {
    const id = text(event.event_id);
    if (!id || !wanted.has(id)) continue;
    if (!found.has(id)) found.set(id, describe(event, 'corpus'));
    else fillMissing(found.get(id), describe(event, 'corpus'));
  }
  const missing = [...wanted].filter((id) => !found.has(id));
  const indexed = await lookupIndexed(missing);
  for (const payload of indexed.events || []) {
    if (!found.has(payload.event_id)) found.set(payload.event_id, describe(payload, 'index'));
  }
  for (const id of wanted) {
    if (found.has(id)) {
      const turn = parseTurnId(id);
      if (turn) fillMissing(found.get(id), { session_id: turn.session_id, provider: turn.provider, turn: turn.turn });
      continue;
    }
    const turn = parseTurnId(id);
    found.set(id, turn
      ? { resolution: 'turn-id', summary: null, event_project: null, event_timestamp: null, session_id: turn.session_id, provider: turn.provider, type: 'transcript', turn: turn.turn }
      : { resolution: null, summary: null, event_project: null, event_timestamp: null, session_id: null, provider: null, type: null });
  }

  // The episode a result came from, bounded by its whole recorded life so the
  // link opens a fixed window the session is actually inside.
  const sessions = new Map([...found.values()].filter((row) => row.session_id).map((row) => [row.session_id, { from: null, through: null, title: null, provider: null }]));
  if (sessions.size) {
    for (const event of events) {
      const sid = eventSession(event);
      const session = sid && sessions.get(sid);
      if (!session) continue;
      const t = eventEpochMs(event);
      if (Number.isFinite(t)) {
        session.from = session.from === null ? t : Math.min(session.from, t);
        session.through = session.through === null ? t : Math.max(session.through, t);
      }
      session.title ||= text(firstResolved([event.session_title, event.title]))?.replace(/\s+/g, ' ').slice(0, 120) || null;
      session.provider ||= text(event.provider)?.toLowerCase() || null;
    }
  }
  for (const row of found.values()) {
    const session = row.session_id ? sessions.get(row.session_id) : null;
    row.session_range = session && session.from !== null ? { from: session.from, through: session.through } : null;
    row.session_title = session?.title || null;
    row.provider ||= session?.provider || null;
  }
  return { rows: found, index_status: indexed.status };
}

/**
 * A mark carries two sessions: the one that made it, and the one its result
 * came from. Keep them apart — the second is the episode link.
 */
function markWithResult(mark, resolved) {
  return {
    ...resolved.get(mark.event_id),
    event_id: mark.event_id,
    marked_at: mark.timestamp,
    marked_by_session: mark.session_id,
    attribution_status: mark.attribution_status,
    requested_call_id: mark.requested_call_id,
  };
}

/** Unplaced marks name no call, but their results can still be identified. */
export async function resolveUnplacedMarks(listing, { events, lookupIndexed } = {}) {
  const marks = listing.unplaced.marks;
  if (!marks.length) return listing;
  const { rows: resolved } = await resolveRecallEvents([...new Set(marks.map((mark) => mark.event_id))], events, { lookupIndexed });
  return { ...listing, unplaced: { ...listing.unplaced, marks: marks.map((mark) => markWithResult(mark, resolved)) } };
}

export async function recallCallDetail({ index, coverage }, callId, { events, lookupIndexed } = {}) {
  const call = index.calls.get(callId);
  if (!call) return null;
  const ids = [...new Set([...call.rows.map((row) => row.event_id), ...call.stray.map((mark) => mark.event_id)])];
  const { rows: resolved, index_status: indexStatus } = await resolveRecallEvents(ids, events, { lookupIndexed });
  const rows = call.rows.map((row) => ({ ...row, ...resolved.get(row.event_id) }));
  return {
    call: callSummary(call),
    rows,
    stray_marks: call.stray.map((mark) => markWithResult(mark, resolved)),
    resolution: {
      corpus: rows.filter((row) => row.resolution === 'corpus').length,
      index: rows.filter((row) => row.resolution === 'index').length,
      turn_id: rows.filter((row) => row.resolution === 'turn-id').length,
      unresolved: rows.filter((row) => row.resolution === null).length,
      index_status: indexStatus,
    },
    coverage,
  };
}
