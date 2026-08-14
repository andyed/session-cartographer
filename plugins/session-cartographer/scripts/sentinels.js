#!/usr/bin/env node
/**
 * One definition of "this field carries no real value."
 *
 * Writers have spelled absence three ways for the same idea — `/wrapup` alone
 * produced `session_id: ""` (252 records), `"unknown"` (31), and
 * `provider: null`, across different eras of the skill. Readers then each
 * re-derived the set, and diverged: some checked `""`, some checked
 * `"unknown"`, none checked both consistently.
 *
 * The failure mode is never a crash. `"unknown"` is truthy and equal to
 * itself, so `if (sid)` passes and `groupBy(sid)` silently merges every
 * unattributed record into one phantom entity. That is exactly what happened
 * during the 0.5.0 orphan repair: a phantom `"unknown"` session window spanned
 * the whole corpus, "matched" 148 orphans, and inflated the reported recovery
 * rate by 54% before it was caught. Nothing errored; the number was just wrong.
 *
 * Keep this set tight and evidence-based. It holds the values actually found in
 * the corpus, not every string that sounds like a placeholder — a generic
 * "looks like a placeholder" list would eventually reject a legitimate value
 * (`git_branch: "none"` is a real answer, not a missing one).
 */

/** Values that mean "absent", as actually written by the event pipeline. */
export const UNRESOLVED = new Set(['', 'unknown']);

/**
 * True when the value is a real, usable identifier — safe to group by, match
 * on, or treat as an identity.
 */
export function isResolved(value) {
  if (value === null || value === undefined) return false;
  return !UNRESOLVED.has(String(value).trim().toLowerCase());
}

/** The value if it is real, otherwise `fallback`. */
export function resolved(value, fallback = null) {
  return isResolved(value) ? value : fallback;
}

/** Pick the first resolved value from a chain. Returns `fallback` if none are. */
export function firstResolved(values, fallback = null) {
  for (const value of values) if (isResolved(value)) return value;
  return fallback;
}
