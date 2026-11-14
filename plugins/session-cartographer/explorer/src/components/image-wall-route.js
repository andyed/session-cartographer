// URL state for /images: the window and which images count. Defaults stay out
// of the URL so the plain tab link and a shared default link are the same.
export const IMAGE_WALL_DAYS = [1, 7, 30, 90];
export const IMAGE_WALL_SCOPES = ['changed', 'named'];
const DEFAULTS = { days: 7, scope: 'changed' };

export function readImageWallRoute(search = window.location.search) {
  const params = new URLSearchParams(search);
  const days = Number(params.get('days'));
  const scope = params.get('scope');
  return {
    days: IMAGE_WALL_DAYS.includes(days) ? days : DEFAULTS.days,
    scope: IMAGE_WALL_SCOPES.includes(scope) ? scope : DEFAULTS.scope,
  };
}

export function imageWallSearch(route) {
  const params = new URLSearchParams();
  if (route.days !== DEFAULTS.days) params.set('days', String(route.days));
  if (route.scope !== DEFAULTS.scope) params.set('scope', route.scope);
  const query = params.toString();
  return query ? `?${query}` : '';
}

export function imageCollectionUrl(route, { document = false } = {}) {
  const params = new URLSearchParams({ days: String(route.days), scope: route.scope });
  if (document) params.set('document', '1');
  return `/api/images/collection?${params}`;
}

export const formatImageWindow = days => (days === 1 ? '24h' : `${days}d`);
