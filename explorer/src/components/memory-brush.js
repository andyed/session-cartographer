/** Session IDs carried by a brush in a shareable Memory route. */
export function normalizeBrush(value) {
  const ids = typeof value === 'string' ? value.split(',') : Array.isArray(value) ? value : [];
  const selected = [...new Set(ids
    .filter(id => typeof id === 'string')
    .map(id => id.trim())
    .filter(id => /^[\w-]{1,256}$/.test(id)))].sort().slice(0, 100);
  return selected.length ? selected : null;
}

/** Inclusive screen-space selection works in every drag direction. */
export function brushHits(points, rect) {
  if (!rect || ![rect.x0, rect.y0, rect.x1, rect.y1].every(Number.isFinite)) return [];
  const left = Math.min(rect.x0, rect.x1), right = Math.max(rect.x0, rect.x1);
  const top = Math.min(rect.y0, rect.y1), bottom = Math.max(rect.y0, rect.y1);
  return [...new Set((Array.isArray(points) ? points : [])
    .filter(point => point && typeof point.id === 'string' && point.id.length
      && Number.isFinite(point.x) && Number.isFinite(point.y)
      && point.x >= left && point.x <= right && point.y >= top && point.y <= bottom)
    .map(point => point.id))].sort();
}

/** Detail increases with scale; invalid scales fall back to the default view. */
export function semanticLevel(scale) {
  if (!Number.isFinite(scale) || scale <= 0) return 'sessions';
  return scale < 0.85 ? 'projects' : scale >= 2.2 ? 'artifacts' : 'sessions';
}

/** Zoom around a screen position while keeping the world point under it fixed. */
export function zoomCameraAt(camera, point, factor, min = 0.4, max = 8) {
  const current = {
    x: Number.isFinite(camera?.x) ? camera.x : 0,
    y: Number.isFinite(camera?.y) ? camera.y : 0,
    scale: Number.isFinite(camera?.scale) && camera.scale > 0 ? camera.scale : 1,
  };
  if (!Number.isFinite(point?.x) || !Number.isFinite(point?.y)
    || !Number.isFinite(factor) || factor <= 0) return current;
  const lower = Number.isFinite(min) && min > 0 ? min : 0.4;
  const upper = Number.isFinite(max) && max >= lower ? max : Math.max(lower, 8);
  const scale = Math.max(lower, Math.min(upper, current.scale * factor));
  if (scale === current.scale) return current;
  const ratio = scale / current.scale;
  const x = point.x - (point.x - current.x) * ratio;
  const y = point.y - (point.y - current.y) * ratio;
  // Extreme malformed input must not poison the renderer with Infinity/NaN.
  if (!Number.isFinite(x) || !Number.isFinite(y)) return current;
  return { x, y, scale };
}
