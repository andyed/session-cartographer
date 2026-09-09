/**
 * One definition of "when did this event happen."
 *
 * The corpus spells timestamps at least three ways: ISO-8601 with a `Z`
 * (`2026-09-08T13:12:12Z`), ISO-8601 with milliseconds
 * (`2026-03-01T18:24:30.368Z`), and bare epoch numbers in both seconds and
 * milliseconds, depending on which writer produced the row. Every consumer that
 * windows, sorts, or buckets by time has to normalize, and a consumer that
 * re-derives the rule diverges from the others in exactly the way
 * `scripts/sentinels.js` documents for identity fields: nothing errors, the
 * numbers are just quietly different.
 *
 * `search.js` owned the original private copy. This module is the shared home
 * so the ranking path and the facts path agree on which events fall inside a
 * window — otherwise a census and a recall over the same `--since` can
 * legitimately disagree about their own corpus, and there is no way to tell
 * which one is right.
 */

/**
 * Epoch milliseconds for an event, or null when the value cannot be
 * interpreted.
 *
 * Null is a real answer, not a failure to be papered over with `Date.now()` or
 * `0`. A row with no usable timestamp cannot honestly be placed inside or
 * outside a time window, so callers applying a window drop it rather than
 * guessing — mirroring `rank_fuse` in scripts/cartographer-search.sh.
 */
export function eventEpochMs(item) {
  const rawTs = item?.timestamp;
  if (typeof rawTs === 'string' && rawTs.startsWith('20')) {
    const parsed = new Date(rawTs).getTime();
    return Number.isNaN(parsed) ? null : parsed;
  }
  if (rawTs) {
    const num = Number(rawTs);
    // Ten-digit values are seconds, thirteen-digit are milliseconds. The
    // boundary sits above any plausible second-precision timestamp and below
    // any plausible millisecond one.
    if (!Number.isNaN(num)) return num > 1e12 ? num : num * 1000;
  }
  return null;
}

/** UTC calendar day (`YYYY-MM-DD`) for an epoch-ms value. */
export function utcDay(epochMs) {
  return new Date(epochMs).toISOString().slice(0, 10);
}
