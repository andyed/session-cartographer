import { normalizeBrush } from './memory-brush.js';
import { MAX_FOCUS_DURATION_MS, parseFocusTimestamp } from '../../shared/focus.js';

export const MEMORY_WINDOWS = [1, 6, 24, 72, 168, 720, 2160];
export const formatMemoryWindow = hours => hours < 24 || hours % 24 ? `${hours}h` : hours === 24 ? '24h' : `${hours / 24}d`;
const integer = (value, fallback, min, max) => value !== '' && value !== null && value !== undefined && Number.isInteger(Number(value)) && Number(value) >= min && Number(value) <= max ? Number(value) : fallback;
const VIEWS = ['field', 'wake', 'compare'];
const X = ['spanMs', 'activeMs'];
const Y = ['output', 'total', 'edit', 'files', 'research', 'commit', 'events'];
const MAX_LIST_ITEMS = 50;
export const CAM_MIN_SCALE = 0.4;
export const CAM_MAX_SCALE = 8;
const CAM_MAX_PAN = 100000;
const round2 = n => Math.round(n * 100) / 100;

function panels(value) {
  const items = typeof value === 'string' ? value.split(',')
    : Array.isArray(value) ? value.map(String) : null;
  if (!items) return null;
  const kept = VIEWS.filter(view => items.includes(view));
  return kept.length && kept.length < VIEWS.length ? kept : null;
}

function camera(value) {
  let x, y, scale;
  if (typeof value === 'string') {
    const parts = value.split(',');
    if (parts.length !== 3) return null;
    [x, y, scale] = parts.map(Number);
  } else if (value && typeof value === 'object') {
    ({ x, y, scale } = value);
  } else return null;
  if (![x, y, scale].every(n => Number.isFinite(n))) return null;
  if (scale < CAM_MIN_SCALE || scale > CAM_MAX_SCALE) return null;
  if (Math.abs(x) > CAM_MAX_PAN || Math.abs(y) > CAM_MAX_PAN) return null;
  const cam = { x: round2(x), y: round2(y), scale: round2(scale) };
  return cam.x === 0 && cam.y === 0 && cam.scale === 1 ? null : cam;
}

function text(value, max = 256) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\x00-\x1f]/g, '').trim().slice(0, max);
}

function list(value) {
  const source = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  return [...new Set(source.map(item => text(String(item))).filter(Boolean))].sort().slice(0, MAX_LIST_ITEMS);
}

function routeFailure(code, message, requested = null) {
  return { code, message, ...(requested ? { requested } : {}) };
}

function routeTimes(value, hours) {
  const rawFrom = value.from ?? value.requestedFrom;
  const rawThrough = value.through ?? value.requestedThrough;
  const hasFrom = rawFrom !== undefined && rawFrom !== null && rawFrom !== '';
  const hasThrough = rawThrough !== undefined && rawThrough !== null && rawThrough !== '';
  let from = parseFocusTimestamp(rawFrom);
  let through = parseFocusTimestamp(rawThrough);
  let lower = value.lower ?? 'closed';
  let mode = value.mode ?? null;
  let durationMs = value.durationMs === undefined || value.durationMs === null || value.durationMs === ''
    ? null : Number(value.durationMs);
  let routeError = null;

  if (hasFrom !== hasThrough) {
    routeError = routeFailure('partial-range', 'Focus links require both from and through.', { from: rawFrom, through: rawThrough });
  } else if (hasFrom && (from === null || through === null)) {
    routeError = routeFailure('invalid-range', 'Focus endpoints must be valid UTC timestamps.', { from: rawFrom, through: rawThrough });
  }

  const legacyAt = parseFocusTimestamp(value.at);
  const legacyEnd = parseFocusTimestamp(value.end);
  if (!hasFrom && !hasThrough && (legacyAt !== null || legacyEnd !== null)) {
    const end = legacyEnd ?? legacyAt;
    through = legacyAt ?? end;
    from = end - hours * 60 * 60 * 1000;
    if (value.catchup === 'return' && parseFocusTimestamp(value.checkpoint) !== null) {
      from = parseFocusTimestamp(value.checkpoint);
      lower = 'open';
      mode = 'since-saved';
    }
  }

  const resolved = from !== null && through !== null;
  if (!routeError && mode !== null && !['fixed', 'rolling', 'since-saved'].includes(mode)) {
    routeError = routeFailure('invalid-mode', 'Focus mode must be fixed, rolling, or since-saved.');
  }
  if (resolved && !routeError) {
    mode ??= 'fixed';
    if (from > through) routeError = routeFailure('reversed-range', 'Focus from must not be after through.', { from, through });
    else if (through - from > MAX_FOCUS_DURATION_MS) routeError = routeFailure('range-too-wide', 'Focus ranges may not exceed 90 days.', { from, through });
    else if (!['closed', 'open'].includes(lower)) routeError = routeFailure('invalid-lower-bound', 'Focus lower must be closed or open.');
    else if (mode === 'rolling' && (!Number.isSafeInteger(durationMs) || durationMs <= 0 || durationMs > MAX_FOCUS_DURATION_MS)) routeError = routeFailure('invalid-duration', 'Rolling focus requires a positive duration no greater than 90 days.');
    else if (mode === 'rolling' && durationMs !== through - from) routeError = routeFailure('duration-mismatch', 'Rolling duration must equal the focus interval.');
    else if (mode === 'rolling' && lower !== 'closed') routeError = routeFailure('invalid-rolling-bound', 'Rolling focus requires a closed lower bound.');
    else if (mode === 'since-saved' && lower !== 'open') routeError = routeFailure('invalid-catchup-bound', 'Since-saved focus requires an open lower bound.');
    else if (mode !== 'rolling' && durationMs !== null) routeError = routeFailure('unexpected-duration', 'Only rolling focus accepts durationMs.');
  } else if (!resolved && !routeError && mode !== null) {
    routeError = routeFailure('unresolved-mode', 'A focus mode requires resolved from and through endpoints.');
  }

  return {
    from, through, lower, mode, durationMs, routeError,
    requestedFrom: routeError && hasFrom ? String(rawFrom).slice(0, 128) : null,
    requestedThrough: routeError && hasThrough ? String(rawThrough).slice(0, 128) : null,
  };
}

export function normalizeMemoryRoute(value = {}) {
  const hours = integer(value.hours, 24, 1, 2160);
  const times = routeTimes(value, hours);
  const catchupExplicit = value.catchupExplicit === true
    || (value.catchupExplicit !== false && Object.prototype.hasOwnProperty.call(value, 'catchup'));
  const at = parseFocusTimestamp(value.at);
  const end = at === null ? null : parseFocusTimestamp(value.end) ?? at;
  const hasResult = Object.prototype.hasOwnProperty.call(value, 'result');
  const hasEvidence = Object.prototype.hasOwnProperty.call(value, 'evidence');
  const legacyFilter = ['flight', 'changed', 'landed'].includes(value.filter) ? value.filter : null;
  const evidence = legacyFilter === 'landed' && !hasEvidence ? ['commit', 'wrapup'] : list(value.evidence);
  const result = legacyFilter === 'changed' && !hasResult ? 'files' : value.result === 'files' ? 'files' : 'tasks';
  const legacyActivity = value.focus === 'charts' || VIEWS.includes(value.view);
  const session = typeof value.session === 'string' && /^[\w-]{1,256}$/.test(value.session) ? value.session : null;
  const file = session && typeof value.file === 'string' && value.file.startsWith('/') && value.file.length <= 4096 && !/[\x00-\x1f]/.test(value.file) ? value.file : null;
  const contributor = typeof value.contributor === 'string' && /^[\w-]{1,256}$/.test(value.contributor) ? value.contributor : null;
  return {
    hours,
    q: typeof value.q === 'string' ? value.q.replace(/[\x00-\x1f]/g, '').slice(0, 500) : '',
    project: text(value.project) || null,
    providers: list(value.providers ?? value.provider),
    evidence,
    result,
    surface: value.surface === 'activity' || (value.surface == null && legacyActivity) ? 'activity' : 'results',
    doc: value.doc === 'source' ? 'source' : 'preview',
    contributor,
    ...times,
    // Changed/landed are migrated into canonical fields immediately. Only the
    // flight predicate still has no newer equivalent.
    filter: legacyFilter === 'flight' ? 'flight' : 'all',
    catchup: ['hour', 'day', 'return'].includes(value.catchup) ? value.catchup : 'hour',
    catchupExplicit,
    checkpoint: parseFocusTimestamp(value.checkpoint),
    offset: integer(value.offset, 0, 0, 100000),
    sort: integer(value.sort, 0, 0, Number.MAX_SAFE_INTEGER),
    focus: value.focus === 'charts' ? 'charts' : 'overview',
    view: VIEWS.includes(value.view) ? value.view : 'field',
    x: X.includes(value.x) ? value.x : 'spanMs',
    y: Y.includes(value.y) ? value.y : 'output',
    at: at === null ? null : Math.max(end - hours * 3600000, Math.min(end, at)), end,
    session, file,
    cam: camera(value.cam),
    brush: normalizeBrush(value.brush),
    panels: panels(value.panels),
    review: file && ['changes', 'file'].includes(value.review) ? value.review : null,
    diff: value.diff === 'unified' ? 'unified' : 'split',
    kind: value.kind === 'md' ? 'md' : 'all',
  };
}

export function parseMemoryRoute(search) {
  return normalizeMemoryRoute(Object.fromEntries(new URLSearchParams(search)));
}

export function memoryHref(value, pathname = '/memory') {
  const route = normalizeMemoryRoute(value);
  const params = new URLSearchParams();
  if (route.from !== null) params.set('from', new Date(route.from).toISOString());
  else if (route.requestedFrom !== null) params.set('from', route.requestedFrom);
  if (route.through !== null) params.set('through', new Date(route.through).toISOString());
  else if (route.requestedThrough !== null) params.set('through', route.requestedThrough);
  if (route.lower !== 'closed') params.set('lower', route.lower);
  if (route.mode && route.mode !== 'fixed') params.set('mode', route.mode);
  if (route.durationMs !== null) params.set('durationMs', route.durationMs);
  if (route.project) params.set('project', route.project);
  if (route.providers.length) params.set('provider', route.providers.join(','));
  if (route.evidence.length) params.set('evidence', route.evidence.join(','));
  if (route.result !== 'tasks') params.set('result', route.result);
  if (route.surface !== 'results') params.set('surface', route.surface);
  if (route.doc !== 'preview') params.set('doc', route.doc);
  if (route.contributor) params.set('contributor', route.contributor);
  if (route.hours !== 24) params.set('hours', route.hours);
  if (route.q) params.set('q', route.q);
  if (route.filter !== 'all') params.set('filter', route.filter);
  if (route.catchup !== 'hour' || route.catchupExplicit) params.set('catchup', route.catchup);
  if (route.checkpoint !== null) params.set('checkpoint', route.checkpoint);
  if (route.offset) params.set('offset', route.offset);
  if (route.sort) params.set('sort', route.sort);
  if (route.focus !== 'overview') params.set('focus', route.focus);
  if (route.view !== 'field') params.set('view', route.view);
  if (route.x !== 'spanMs') params.set('x', route.x);
  if (route.y !== 'output') params.set('y', route.y);
  if (route.panels) params.set('panels', route.panels.join(','));
  if (route.brush) params.set('brush', route.brush.join(','));
  if (route.cam) params.set('cam', `${route.cam.x},${route.cam.y},${route.cam.scale}`);
  if (route.session) params.set('session', route.session);
  if (route.file) params.set('file', route.file);
  if (route.review) params.set('review', route.review);
  if (route.diff !== 'split') params.set('diff', route.diff);
  if (route.kind !== 'all') params.set('kind', route.kind);
  if (route.at !== null) {
    params.set('at', new Date(route.at).toISOString());
    params.set('end', new Date(route.end).toISOString());
  }
  return pathname + (params.size ? `?${params}` : '');
}

export function plainLinkClick(event) {
  return !event.defaultPrevented && event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}
