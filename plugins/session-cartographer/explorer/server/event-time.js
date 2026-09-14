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
 * Epoch milliseconds for a raw timestamp value, or null when it cannot be
 * interpreted.
 *
 * Null is a real answer, not a failure to be papered over with `Date.now()` or
 * `0`. A row with no usable timestamp cannot honestly be placed inside or
 * outside a time window, so callers applying a window drop it rather than
 * guessing — mirroring `rank_fuse` in scripts/cartographer-search.sh.
 *
 * This is the primitive. The ranking path reached it as `epochMsFromTimestamp`
 * exported from bm25.js and the facts path as `eventEpochMs` here, each
 * documented as "the one definition" — two correct copies of the same rule,
 * which is the arrangement that stays correct only until someone fixes one of
 * them. bm25.js now re-exports this one under its established name.
 */
export function epochMsFromTimestamp(rawTs) {
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

/** Epoch milliseconds for an event, reading its `timestamp` field. */
export function eventEpochMs(item) {
  return epochMsFromTimestamp(item?.timestamp);
}

/** UTC calendar day (`YYYY-MM-DD`) for an epoch-ms value. */
export function utcDay(epochMs) {
  // Formatted once per calendar day, not once per event. `tempo` calls this
  // for every resident event, and `new Date(ms).toISOString()` cost 62 ms of a
  // 170 ms fold over 127k events (perf check-in, 2026-09-14); keyed on the day
  // index it costs 2 ms and returns byte-identical strings. A corpus has a few
  // thousand distinct days at most, so the cache is small; it is still bounded
  // in case a caller hands it garbage timestamps spread across millennia.
  const dayIndex = Math.floor(epochMs / DAY_MS);
  let day = DAY_STRINGS.get(dayIndex);
  if (day === undefined) {
    if (DAY_STRINGS.size >= DAY_CACHE_LIMIT) DAY_STRINGS.clear();
    day = new Date(dayIndex * DAY_MS).toISOString().slice(0, 10);
    DAY_STRINGS.set(dayIndex, day);
  }
  return day;
}

const DAY_MS = 86_400_000;
const DAY_CACHE_LIMIT = 100_000;
const DAY_STRINGS = new Map();
