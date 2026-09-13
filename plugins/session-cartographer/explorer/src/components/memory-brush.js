/** Session IDs carried by a brush in a shareable Memory route. */
export function normalizeBrush(value) {
  const ids = typeof value === 'string' ? value.split(',') : Array.isArray(value) ? value : [];
  const selected = [...new Set(ids
    .filter(id => typeof id === 'string')
    .map(id => id.trim())
    .filter(id => /^[\w-]{1,256}$/.test(id)))].sort().slice(0, 100);
  return selected.length ? selected : null;
}

/** The Field's existing shared-activity evidence: overlap of project mixes. */
export function projectAffinity(a, b) {
  let intersection = 0, union = 0;
  for (const project of new Set([...Object.keys(a.projects || {}), ...Object.keys(b.projects || {})])) {
    if (project === 'dev') continue;
    const av = (a.projects[project] || 0) / (a.count || 1);
    const bv = (b.projects[project] || 0) / (b.count || 1);
    intersection += Math.min(av, bv);
    union += Math.max(av, bv);
  }
  return union ? intersection / union : 0;
}

/** A secondary brush is subordinate to the existing primary IDs, never a filter. */
export function resolveBrushFocus(sessions, primaryIds, previewId, at = Infinity) {
  const visible = sessions.filter(s => s.events.some(event => event[0] <= at));
  const byId = new Map(visible.map(s => [s.id, s]));
  const primary = [...new Set(primaryIds || [])].filter(id => byId.has(id));
  const candidate = byId.get(previewId);
  const anchors = candidate ? primary.filter(id => id !== candidate.id && projectAffinity(byId.get(id), candidate) >= .12) : [];
  const preview = candidate && (!primary.length || primary.includes(candidate.id) || anchors.length) ? candidate.id : null;
  const secondary = anchors.length ? preview : null;
  const projects = secondary ? [...new Set(anchors.flatMap(id => Object.keys(byId.get(id).projects)
    .filter(project => project !== 'dev' && byId.get(id).projects[project] > 0 && candidate.projects[project] > 0)))].sort() : [];
  return { primary, preview, secondary, anchors, projects };
}

/** Hit the same quadratic curve the Field draws, with a forgiving pointer radius. */
export function connectionDistance(point, edge) {
  const { x, y } = point;
  const { ax, ay, cx, cy, bx, by } = edge;
  if (![x, y, ax, ay, cx, cy, bx, by].every(Number.isFinite)) return Infinity;
  let distance = Infinity, px = ax, py = ay;
  for (let step = 1; step <= 24; step++) {
    const t = step / 24, u = 1 - t;
    const qx = u*u*ax + 2*u*t*cx + t*t*bx, qy = u*u*ay + 2*u*t*cy + t*t*by;
    const dx = qx - px, dy = qy - py;
    const along = Math.max(0, Math.min(1, ((x-px)*dx + (y-py)*dy) / (dx*dx + dy*dy || 1)));
    distance = Math.min(distance, Math.hypot(x-px-along*dx, y-py-along*dy));
    px = qx; py = qy;
  }
  return distance;
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
