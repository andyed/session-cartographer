export const MAX_FOCUS_DURATION_MS = 90 * 24 * 60 * 60 * 1000;
export const FOCUS_MODES = Object.freeze(['fixed', 'rolling', 'since-saved']);
export const LOWER_BOUNDS = Object.freeze(['closed', 'open']);

export function parseFocusTimestamp(value) {
  if (value === null || value === undefined || value === '') return null;
  const milliseconds = typeof value === 'number' || /^\d+$/.test(String(value))
    ? Number(value)
    : /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(String(value))
      ? Date.parse(String(value)) : NaN;
  return Number.isSafeInteger(milliseconds) && milliseconds >= 0
    && milliseconds <= 8640000000000000 ? milliseconds : null;
}

export function normalizeFocusRange(value) {
  const from = parseFocusTimestamp(value?.from);
  const through = parseFocusTimestamp(value?.through);
  const lower = value?.lower ?? 'closed';
  if (from === null || through === null || from > through || !LOWER_BOUNDS.includes(lower)) return null;
  return { from, through, lower };
}

function normalizedBounds(value) {
  if (!value) return null;
  const from = parseFocusTimestamp(value.from ?? value.availableStart ?? value.start ?? value.loadedRange?.from);
  const through = parseFocusTimestamp(value.through ?? value.snapshotAt ?? value.end
    ?? value.availableEnd ?? value.loadedRange?.through);
  return from !== null && through !== null && from <= through ? { from, through } : null;
}

/** Resolve a canonical route, or an old hours/catch-up route against a snapshot. */
export function getFocusRange(route, snapshotOrBounds) {
  if (route?.routeError) return null;
  const explicit = normalizeFocusRange(route);
  if (explicit) return explicit.through - explicit.from <= MAX_FOCUS_DURATION_MS ? explicit : null;
  if (route?.from != null || route?.through != null) return null;

  const bounds = normalizedBounds(snapshotOrBounds);
  const snapshotThrough = parseFocusTimestamp(snapshotOrBounds?.through ?? snapshotOrBounds?.snapshotAt
    ?? snapshotOrBounds?.end ?? snapshotOrBounds?.availableEnd ?? snapshotOrBounds?.loadedRange?.through);
  const end = parseFocusTimestamp(route?.end) ?? bounds?.through ?? snapshotThrough;
  const at = parseFocusTimestamp(route?.at) ?? end;
  if (at === null || end === null) return null;
  const hours = Number.isInteger(Number(route?.hours)) && Number(route.hours) > 0
    ? Number(route.hours) : 24;
  const coveringFrom = end - hours * 60 * 60 * 1000;
  if (!Number.isSafeInteger(coveringFrom) || coveringFrom < 0) return null;

  if (route?.catchup === 'return') {
    const checkpoint = parseFocusTimestamp(route.checkpoint);
    return checkpoint !== null && checkpoint <= at && at - checkpoint <= MAX_FOCUS_DURATION_MS
      ? normalizeFocusRange({ from: checkpoint, through: at, lower: 'open' }) : null;
  }
  const from = route?.catchup === 'hour' && route?.catchupExplicit !== false
    ? Math.max(coveringFrom, at - 60 * 60 * 1000)
    : coveringFrom;
  return normalizeFocusRange({ from, through: at, lower: 'closed' });
}

export function containsTimestamp(timestamp, range) {
  const value = parseFocusTimestamp(timestamp);
  const normalized = normalizeFocusRange(range);
  if (value === null || !normalized) return false;
  return (normalized.lower === 'open' ? value > normalized.from : value >= normalized.from)
    && value <= normalized.through;
}

export function shiftFocusRange(range, delta, bounds) {
  const normalized = normalizeFocusRange(range);
  const limits = normalizedBounds(bounds);
  if (!normalized || !Number.isFinite(delta)) return null;
  const amount = Math.trunc(delta);
  const duration = normalized.through - normalized.from;
  if (!Number.isSafeInteger(amount)) return null;
  if (limits && duration > limits.through - limits.from) return null;
  let from = normalized.from + amount;
  let through = normalized.through + amount;
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(through)) return null;
  if (limits && from < limits.from) {
    from = limits.from;
    through = from + duration;
  }
  if (limits && through > limits.through) {
    through = limits.through;
    from = through - duration;
  }
  return normalizeFocusRange({ from, through, lower: normalized.lower });
}

export function resizeFocusRange(range, edge, value, bounds) {
  const normalized = normalizeFocusRange(range);
  const next = parseFocusTimestamp(value);
  const limits = normalizedBounds(bounds);
  if (!normalized || next === null || !['from', 'through'].includes(edge)) return null;
  if (edge === 'from') {
    const from = Math.min(normalized.through, Math.max(limits?.from ?? 0, next));
    return normalizeFocusRange({ ...normalized, from });
  }
  const through = Math.max(normalized.from, Math.min(limits?.through ?? 8640000000000000, next));
  return normalizeFocusRange({ ...normalized, through });
}

export function advanceFocusRange(range, mode, durationMs, now) {
  const normalized = normalizeFocusRange(range);
  if (!normalized || !FOCUS_MODES.includes(mode)) return null;
  if (mode === 'fixed') return normalized;
  const current = parseFocusTimestamp(now);
  if (current === null) return null;
  if (mode === 'rolling') {
    const duration = Number(durationMs);
    if (!Number.isSafeInteger(duration) || duration <= 0 || duration > MAX_FOCUS_DURATION_MS || current < duration) return null;
    return { from: current - duration, through: current, lower: 'closed' };
  }
  return current >= normalized.from
    ? { from: normalized.from, through: current, lower: 'open' } : null;
}
