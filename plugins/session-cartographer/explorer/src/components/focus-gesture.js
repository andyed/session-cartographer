export const KEY_STEP_MS = 5 * 60 * 1000;
export const KEY_LARGE_STEP_MS = 60 * 60 * 1000;

export function eventTimestamp(event) {
  const raw = Array.isArray(event) ? event[0] : event?.t ?? event?.timestamp ?? event;
  const value = typeof raw === 'number' ? raw : Date.parse(raw);
  return Number.isFinite(value) ? value : null;
}

const DENSITY_STEPS_MS = [30 * 60000, 60 * 60000, 3 * 3600000, 6 * 3600000, 12 * 3600000, 24 * 3600000, 7 * 24 * 3600000];

export function densityStep(bounds, maxBins = 96) {
  if (!bounds || !(bounds.through > bounds.from) || !Number.isInteger(maxBins) || maxBins < 1) return null;
  const span = bounds.through - bounds.from;
  return DENSITY_STEPS_MS.find(step => Math.ceil(span / step) <= maxBins) || DENSITY_STEPS_MS.at(-1);
}

export function densityBins(events = [], bounds, maxBins = 96) {
  const width = densityStep(bounds, maxBins);
  if (!width) return [];
  const alignedFrom = Math.floor(bounds.from / width) * width;
  const count = Math.max(1, Math.ceil(bounds.through / width) - Math.floor(bounds.from / width));
  const bins = Array.from({ length: count }, (_, index) => ({
    from: alignedFrom + index * width,
    through: alignedFrom + (index + 1) * width,
    count: 0,
  }));
  for (const event of events) {
    const time = eventTimestamp(event);
    if (time === null || time < bounds.from || time > bounds.through) continue;
    const index = Math.min(count - 1, Math.floor((time - alignedFrom) / width));
    bins[index].count += 1;
  }
  return bins;
}

export function normalizeDensityBins(bins = [], bounds) {
  if (!bounds) return [];
  return bins.map((bin, index) => ({
    from: Number(bin.from), through: Number(bin.through), count: Math.max(0, Number(bin.count) || 0), index,
  })).filter(bin => Number.isFinite(bin.from) && Number.isFinite(bin.through)
    && bin.through > bin.from && bin.through >= bounds.from && bin.from <= bounds.through);
}

export function horizontalTime(clientX, rect, bounds) {
  if (!rect || !(rect.width > 0) || !bounds || !(bounds.through > bounds.from)) return bounds?.from ?? 0;
  const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  return bounds.from + ratio * (bounds.through - bounds.from);
}

export function verticalTime(clientY, rect, bounds, timeToY) {
  if (!rect || !bounds || !(bounds.through > bounds.from) || typeof timeToY !== 'function') return bounds?.from ?? 0;
  const y = clientY - rect.top;
  const fromY = timeToY(bounds.from), throughY = timeToY(bounds.through);
  if (![y, fromY, throughY].every(Number.isFinite) || fromY === throughY) return bounds.from;
  const ratio = Math.max(0, Math.min(1, (y - fromY) / (throughY - fromY)));
  return bounds.from + ratio * (bounds.through - bounds.from);
}

export function keyDelta(event, orientation = 'horizontal') {
  const step = event.shiftKey ? KEY_LARGE_STEP_MS : KEY_STEP_MS;
  if (orientation === 'vertical') {
    if (event.key === 'ArrowUp' || event.key === 'ArrowRight') return step;
    if (event.key === 'ArrowDown' || event.key === 'ArrowLeft') return -step;
  } else {
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') return step;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') return -step;
  }
  return null;
}

export function toLocalDateTime(ms) {
  if (!Number.isFinite(ms)) return '';
  const date = new Date(ms - new Date(ms).getTimezoneOffset() * 60000);
  return date.toISOString().slice(0, 19);
}

export function fromLocalDateTime(value) {
  const ms = typeof value === 'string' && value ? new Date(value).getTime() : NaN;
  return Number.isFinite(ms) ? ms : null;
}
