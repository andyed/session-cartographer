import { normalizeBrush } from './memory-brush.js';
const DAY = 86400000;
const VIEWS = ['field', 'wake', 'compare'];
const X = ['spanMs', 'activeMs'];
const Y = ['output', 'total', 'edit', 'files', 'research', 'commit', 'events'];
// The field's camera bounds live here so route validation and the renderer's
// clamping cannot drift apart.
export const CAM_MIN_SCALE = 0.4;
export const CAM_MAX_SCALE = 8;
const CAM_MAX_PAN = 100000;
const round2 = n => Math.round(n * 100) / 100;

/** Which panels the viewer has toggled on. All of them is the default, so it
 *  costs no parameter; an empty selection is not a view and is refused. */
function panels(value) {
  const list = typeof value === 'string' ? value.split(',')
    : Array.isArray(value) ? value.map(String) : null;
  if (!list) return null;
  const kept = VIEWS.filter(view => list.includes(view));
  return kept.length && kept.length < VIEWS.length ? kept : null;
}

/** "x,y,scale" from a URL, or {x,y,scale} from the renderer. Identity is null. */
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

function time(value) {
  if (value === null || value === undefined || value === '') return null;
  const ms = typeof value === 'number' || /^\d{13}$/.test(value) ? Number(value)
    : /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value) ? Date.parse(value) : NaN;
  return Number.isSafeInteger(ms) && ms > 0 && ms <= 8640000000000000 ? ms : null;
}

export function normalizeMemoryRoute(value = {}) {
  const at = time(value.at);
  const end = at === null ? null : time(value.end) ?? at;
  const session = typeof value.session === 'string' && /^[\w-]{1,256}$/.test(value.session) ? value.session : null;
  const file = session && typeof value.file === 'string' && value.file.startsWith('/') && value.file.length <= 4096 && !/[\x00-\x1f]/.test(value.file) ? value.file : null;
  return {
    view: VIEWS.includes(value.view) ? value.view : 'field',
    x: X.includes(value.x) ? value.x : 'spanMs',
    y: Y.includes(value.y) ? value.y : 'output',
    at: at === null ? null : Math.max(end - DAY, Math.min(end, at)), end,
    session, file,
    cam: camera(value.cam),
    brush: normalizeBrush(value.brush),
    panels: panels(value.panels),
    review: file && ['changes', 'file'].includes(value.review) ? value.review : null,
  };
}

export function parseMemoryRoute(search) {
  return normalizeMemoryRoute(Object.fromEntries(new URLSearchParams(search)));
}

export function memoryHref(value, pathname = '/memory') {
  const route = normalizeMemoryRoute(value);
  const params = new URLSearchParams();
  if (route.view !== 'field') params.set('view', route.view);
  if (route.x !== 'spanMs') params.set('x', route.x);
  if (route.y !== 'output') params.set('y', route.y);
  if (route.panels) params.set('panels', route.panels.join(','));
  if (route.brush) params.set('brush', route.brush.join(','));
  if (route.cam) params.set('cam', `${route.cam.x},${route.cam.y},${route.cam.scale}`);
  if (route.session) params.set('session', route.session);
  if (route.file) params.set('file', route.file);
  if (route.review) params.set('review', route.review);
  if (route.at !== null) {
    params.set('at', new Date(route.at).toISOString());
    params.set('end', new Date(route.end).toISOString());
  }
  return pathname + (params.size ? `?${params}` : '');
}

export function plainLinkClick(event) {
  return !event.defaultPrevented && event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}
