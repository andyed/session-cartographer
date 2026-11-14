// The parts of the session map that need no DOM: its address, where a control
// sits over a station, and which rows a station's list shows. Kept apart from
// the component so each can be tested without a browser.

import { memoryHref } from './memory-route.js';

export const MAP_PATH = /^\/map\/?$/;

/** Rows a list renders at most. A session can hold thousands of calls; the rest are counted, not drawn. */
export const ROW_CAP = 300;

/**
 * The map's address: `/map?session=<id or transcript path>&station=<id>&at=<epoch ms>`.
 * `station` and `at` are optional. A link carries the moment, so it reopens on the same frame.
 */
export function readMapRoute(search = '') {
  const params = new URLSearchParams(search);
  const at = Number(params.get('at'));
  return {
    session: params.get('session') || '',
    station: params.get('station') || '',
    at: params.get('at') !== null && Number.isFinite(at) && at > 0 ? at : null,
  };
}

export function mapHref(base, { session, station, at }) {
  const params = new URLSearchParams();
  if (session) params.set('session', session);
  if (station) params.set('station', station);
  if (at !== null && at !== undefined) params.set('at', String(Math.round(at)));
  const qs = params.toString();
  return `${base.replace(/\/$/, '')}/map${qs ? `?${qs}` : ''}`;
}

const pct = (v, of) => `${((v / of) * 100).toFixed(3)}%`;

/**
 * Where a control lies over each drawn station, as CSS percentages of the map, so it scales with the picture.
 * The box takes in the node and the name and count under it: all three read as one target.
 */
export function stationBoxes(geometry, present) {
  const { width, height } = geometry;
  return geometry.stations
    .filter(s => present.has(s.id))
    .map(s => ({
      id: s.id,
      left: pct(s.x - 42, width),
      top: pct(s.y - s.r - 6, height),
      width: pct(84, width),
      height: pct(s.r * 2 + 44, height),
    }));
}

export function coreBox(geometry) {
  const { width, height, core } = geometry;
  const r = core.r + 6;
  return { left: pct(core.x - r, width), top: pct(core.y - r, height), width: pct(r * 2, width), height: pct(r * 2, height) };
}

/**
 * The rows under the map: what one station (or every station, for '') had done by the moment `at`, newest first.
 * The list stops at `at` so that it and the map's count for that station are the same number.
 */
export function rowsFor(actions, station, at) {
  const rows = [];
  let total = 0;
  let failed = 0;
  let byAgents = 0;
  for (let i = actions.length - 1; i >= 0; i--) {
    const a = actions[i];
    if (a.startedAt > at || (station !== '' && a.station !== station)) continue;
    total++;
    // A call that had not answered by `at` was still running then, whatever it came to later.
    const ended = a.endedAt !== undefined && a.endedAt <= at;
    const status = ended ? a.status : 'run';
    if (status === 'err' || status === 'block') failed++;
    if (a.agentId !== undefined) byAgents++;
    if (rows.length < ROW_CAP) rows.push({ key: i, action: a, status, tookMs: ended ? Math.max(0, a.endedAt - a.startedAt) : null });
  }
  return { rows, total, failed, byAgents };
}

const two = n => String(n).padStart(2, '0');

/** Local clock time, to the second. */
export function clockTime(ms) {
  const d = new Date(ms);
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * How a moment of this session is written. A session that stays inside one local day needs only the clock; one
 * that crosses midnight names the day as well, or 22:18 and 05:27 read as the same day in the wrong order.
 */
export function stampFor(span) {
  const a = new Date(span.first);
  const b = new Date(span.last);
  const oneDay = a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (oneDay) return clockTime;
  return ms => {
    const d = new Date(ms);
    return `${MONTHS[d.getMonth()]} ${d.getDate()} ${clockTime(ms)}`;
  };
}

/** A length of session time: `48 s`, `12 m`, `3 h 46 m`. */
export function spanText(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} m`;
  return `${Math.floor(m / 60)} h ${two(m % 60)} m`;
}

/**
 * Where the transcript reader shows one action: the transcript it was read from (a subagent's own, for a
 * subagent's call) and the reader's ids for the message and the part. Null when the map names no transcript.
 * The block id is spelled the way the reader mints it (transcript-evidence.js: `<message>--block-<index>`).
 */
export function actionLocation(map, action) {
  const path = action.agentId !== undefined ? map.agents?.[action.agentId] : map.path;
  if (typeof path !== 'string' || path === '') return null;
  const uuid = typeof action.uuid === 'string' ? action.uuid : '';
  return { path, uuid, blockId: uuid && Number.isInteger(action.block) ? `${uuid}--block-${action.block}` : '' };
}

/** The reader's address for a location, in the shape App.openTranscript pushes, so a plain click and a new tab agree. */
export function readerHref(base, location, returnTo) {
  const params = new URLSearchParams({ reader: 'conversation', return: returnTo });
  if (location.uuid) params.set('uuid', location.uuid);
  if (location.blockId) params.set('block', location.blockId);
  return `${base.replace(/\/$/, '')}/session/${encodeURIComponent(location.path)}?${params}`;
}

// ─── Where a row leads ──────────────────────────────────────────────────────
//
// Every row opens the call in the transcript reader unless the Explorer holds a
// closer view of the same thing: a recall's ranked results and what was marked
// used (the Memory Desk's Recall section), or an edit's diff bounded by the
// session's commits (file review). Those two need the desk to know the call or
// the edit, so the page asks it first (`calls`, `files`) and links there only then.

/**
 * Recall calls as the desk recorded them, by call id. Bodies of /api/memory/recall: the session's own calls and
 * every call in its window. The second is needed because the desk does not know whose some calls are: a recall
 * made through the MCP server under Codex is recorded with no session (7 of 7 on the session this was built
 * against), while the transcript says exactly which session made it. The call id joins the two.
 */
export function recallIndex(...bodies) {
  const calls = new Map();
  for (const body of bodies) {
    for (const call of Array.isArray(body?.calls) ? body.calls : []) {
      if (typeof call?.call_id === 'string' && !calls.has(call.call_id)) calls.set(call.call_id, call);
    }
  }
  return calls;
}

/** The files the desk holds edit evidence for in this session. Body of /api/memory/session. */
export function reviewableFiles(body, sessionId) {
  const files = body?.files?.[sessionId];
  return new Set((Array.isArray(files) ? files : []).map(f => f?.path).filter(p => typeof p === 'string'));
}

/** The desk's window for this session: its own span, never past now (the desk refuses a window that ends in the future). */
function deskWindow(span, now) {
  return { from: Math.floor(span.first), through: Math.min(Math.ceil(span.last) + 1000, now) };
}

/**
 * Where one row's link goes. `kind` is `recall`, `review` or `reader`; `location` is set for the reader,
 * which the app opens in place. Null when the map names no transcript and the desk holds nothing either.
 */
export function rowTarget(base, map, action, { calls = new Map(), files = new Set() } = {}, returnTo = '/', now = Date.now()) {
  const desk = `${base.replace(/\/$/, '')}/memory`;
  const session = typeof map.session_id === 'string' ? map.session_id : '';
  if (session && map.span) {
    const window = deskWindow(map.span, now);
    const call = action.call ? calls.get(action.call) : undefined;
    // The desk shows a call inside its session's thread when it knows the session, and in the Recall list when it does not.
    if (call) return { kind: 'recall', href: memoryHref(call.session_id === session ? { ...window, session, call: action.call } : { ...window, surface: 'recall', call: action.call }, desk) };
    // Only an edit or a write carries `file` (workmap-detail.js), so a read never lands on a diff.
    if (action.file && files.has(action.file)) {
      return { kind: 'review', href: memoryHref({ ...window, session, file: action.file, review: 'changes' }, desk) };
    }
  }
  const location = actionLocation(map, action);
  return location ? { kind: 'reader', href: readerHref(base, location, returnTo), location } : null;
}

/** A recall's result page in a line: how many hits it served, how many were marked used, and at which ranks. */
export function serpSummary(call) {
  if (!call) return '';
  const served = Number(call.served) || 0;
  const used = Number(call.used) || 0;
  const ranks = (Array.isArray(call.used_ranks) ? call.used_ranks : []).filter(Number.isFinite);
  // A stray mark is a "used" the desk could not join to a served hit; it is listed, not counted as used.
  const stray = Number(call.stray_marks) || 0;
  return `${served} served · ${used} used${ranks.length ? ` at rank ${ranks.join(', ')}` : ''}${stray ? ` · ${stray} stray ${stray === 1 ? 'mark' : 'marks'}` : ''}`;
}

/**
 * A row's second line. A search adds what its result page came to; a fetch or a mark names the search it
 * belongs to, since "get 3 records" alone does not say of what.
 */
export function rowDetail(action, calls = new Map()) {
  const call = action.call ? calls.get(action.call) : undefined;
  const parts = [action.detail];
  // The transcript's "4 results" and the desk's "4 served" are one number; the desk's line says more.
  if (call && action.recall === 'search') parts.splice(0, 1, String(action.detail ?? '').replace(/(?:^| · )\d+ results?$/, ''), serpSummary(call));
  else if (call && action.recall && call.query) parts.push(`from “${call.query}”`);
  return parts.filter(Boolean).join(' · ');
}

/** The picture as an image source. An image cannot run script or reach the page, so the drawing needs no sanitizer. */
export function svgDataUri(svg) {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
