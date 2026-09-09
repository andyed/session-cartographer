const DAY = 86400000;
const VIEWS = ['field', 'wake', 'compare'];
const X = ['spanMs', 'activeMs'];
const Y = ['output', 'total', 'edit', 'files', 'research', 'commit', 'events'];

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
