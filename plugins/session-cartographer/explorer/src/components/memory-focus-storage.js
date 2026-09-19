import { MAX_FOCUS_DURATION_MS, normalizeFocusRange } from '../../shared/focus.js';
import { normalizeBrush } from './memory-brush.js';

export const SAVED_FOCUS_KEY = 'cartographer.saved-focus.v1';
export const LEGACY_RETURN_POINT_KEY = 'cartographer.return-point.v1';
const VERSION = 1;

function failure(key, code, message) {
  return { ok: false, key, value: null, error: { code, message } };
}

function cleanText(value, max = 500) {
  return typeof value === 'string' ? value.replace(/[\x00-\x1f]/g, '').slice(0, max) : '';
}

function cleanList(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(item => cleanText(String(item), 256).trim()).filter(Boolean))].sort().slice(0, 50);
}

function identityParts(identity) {
  if (typeof identity === 'string') return { corpusId: identity, source: 'live' };
  return {
    corpusId: cleanText(identity?.corpusId ?? identity?.corpus ?? '', 512) || 'unknown',
    source: cleanText(identity?.source ?? identity?.sourceMode ?? '', 64) || 'live',
  };
}

export function savedFocusStorageKey(identity) {
  const { corpusId, source } = identityParts(identity);
  return `${SAVED_FOCUS_KEY}:${encodeURIComponent(source)}:${encodeURIComponent(corpusId)}`;
}

export function validateSavedFocus(value) {
  if (!value || value.version !== VERSION || !Number.isSafeInteger(value.savedAt) || value.savedAt < 0) return null;
  const range = normalizeFocusRange(value);
  if (!range || range.through - range.from > MAX_FOCUS_DURATION_MS) return null;
  const scope = value.scope;
  if (!scope || typeof scope !== 'object' || Array.isArray(scope)) return null;
  return {
    version: VERSION,
    savedAt: value.savedAt,
    ...range,
    scope: {
      q: cleanText(scope.q),
      project: cleanText(scope.project, 256) || null,
      providers: cleanList(scope.providers),
      evidence: cleanList(scope.evidence),
      result: scope.result === 'files' ? 'files' : 'tasks',
      kind: scope.kind === 'md' ? 'md' : 'all',
      brush: normalizeBrush(scope.brush),
      filter: scope.filter === 'flight' ? 'flight' : 'all',
    },
  };
}

function envelope(value) {
  if (!value || value.version !== VERSION || typeof value !== 'object') return null;
  const current = value.current === null ? null : validateSavedFocus(value.current);
  const undo = value.undo === null ? null : validateSavedFocus(value.undo);
  if ((value.current !== null && !current) || (value.undo !== null && !undo)) return null;
  return { version: VERSION, current, undo };
}

export function readSavedFocus(storage, identity) {
  const key = savedFocusStorageKey(identity);
  if (!storage || typeof storage.getItem !== 'function') return failure(key, 'unavailable', 'Saved focus storage is unavailable.');
  try {
    const raw = storage.getItem(key);
    if (raw === null || raw === undefined) return { ok: true, key, value: null, undo: null };
    let decoded;
    try { decoded = JSON.parse(raw); } catch { return failure(key, 'corrupt', 'The saved focus record is invalid or corrupted.'); }
    const parsed = envelope(decoded);
    return parsed ? { ok: true, key, value: parsed.current, undo: parsed.undo }
      : failure(key, 'corrupt', 'The saved focus record is invalid or corrupted.');
  } catch {
    return failure(key, 'unavailable', 'This browser could not read the saved focus.');
  }
}

function recordFromFocus(focus, now) {
  const range = normalizeFocusRange(focus);
  if (!range || range.through - range.from > MAX_FOCUS_DURATION_MS || !Number.isSafeInteger(now) || now < 0) return null;
  return validateSavedFocus({
    version: VERSION,
    savedAt: now,
    ...range,
    scope: {
      q: focus.q ?? focus.scope?.q,
      project: focus.project ?? focus.scope?.project,
      providers: focus.providers ?? focus.scope?.providers,
      evidence: focus.evidence ?? focus.scope?.evidence,
      result: focus.result ?? focus.scope?.result,
      kind: focus.kind ?? focus.scope?.kind,
      brush: focus.brush ?? focus.scope?.brush,
      filter: focus.filter ?? focus.scope?.filter,
    },
  });
}

export function saveFocus(storage, identity, focus, now = Date.now()) {
  const key = savedFocusStorageKey(identity);
  if (!storage || typeof storage.getItem !== 'function' || typeof storage.setItem !== 'function') return failure(key, 'unavailable', 'Saved focus storage is unavailable.');
  const record = recordFromFocus(focus, now);
  if (!record) return failure(key, 'invalid-focus', 'Only a valid absolute focus of at most 90 days can be saved.');
  const prior = readSavedFocus(storage, identity);
  if (!prior.ok && prior.error.code !== 'corrupt') return prior;
  // A corrupt value is replaceable by an explicit Save, but remains unavailable
  // as an undo target.
  const next = { version: VERSION, current: record, undo: prior.ok ? prior.value : null };
  try {
    storage.setItem(key, JSON.stringify(next));
    return { ok: true, key, value: record, undo: next.undo };
  } catch {
    return failure(key, 'unavailable', 'This browser could not save the focus.');
  }
}

export function undoSavedFocus(storage, identity) {
  const key = savedFocusStorageKey(identity);
  if (!storage || typeof storage.getItem !== 'function' || typeof storage.setItem !== 'function') return failure(key, 'unavailable', 'Saved focus storage is unavailable.');
  const current = readSavedFocus(storage, identity);
  if (!current.ok) return current;
  if (current.value === null && current.undo === null) return failure(key, 'nothing-to-undo', 'There is no saved focus change to undo.');
  const next = { version: VERSION, current: current.undo, undo: current.value };
  try {
    storage.setItem(key, JSON.stringify(next));
    return { ok: true, key, value: next.current, undo: next.undo };
  } catch {
    return failure(key, 'unavailable', 'This browser could not undo the saved focus change.');
  }
}

export function readLegacyFocusSeed(storage, bounds) {
  const key = LEGACY_RETURN_POINT_KEY;
  if (!storage || typeof storage.getItem !== 'function') return failure(key, 'unavailable', 'Return-point storage is unavailable.');
  try {
    const raw = storage.getItem(key);
    if (raw === null || raw === undefined || raw === '') return { ok: true, key, value: null, origin: 'legacy-return-point', unsupported: false };
    const from = Number(raw);
    const through = Number(bounds?.through ?? bounds?.snapshotAt ?? bounds?.availableEnd ?? bounds?.end);
    if (!Number.isSafeInteger(from) || from < 0) return failure(key, 'corrupt', 'The old return point is invalid.');
    if (!Number.isSafeInteger(through) || through < 0) return failure(key, 'unresolved', 'The old return point needs a successful source snapshot.');
    if (from > through) return failure(key, 'future-return-point', 'The old return point is after the current source snapshot.');
    const value = { from, through, lower: 'open' };
    return {
      ok: true,
      key,
      value,
      origin: 'legacy-return-point',
      unsupported: through - from > MAX_FOCUS_DURATION_MS,
      outsideCoverage: Number.isSafeInteger(Number(bounds?.from)) && from < Number(bounds.from),
      ...(through - from > MAX_FOCUS_DURATION_MS ? {
        warning: { code: 'range-too-wide', message: 'The old return point spans more than 90 days and cannot be activated as a focus.' },
      } : {}),
    };
  } catch {
    return failure(key, 'unavailable', 'This browser could not read the old return point.');
  }
}
