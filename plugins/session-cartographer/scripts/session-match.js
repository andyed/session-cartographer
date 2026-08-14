#!/usr/bin/env node
/**
 * Strict session matching for orphan records.
 *
 * Deliberately stricter than enrich-sessions.js, which accepts a time-only
 * match when no project matches. That is fine for backfilled git commits made
 * outside any session; it is not fine for records written from inside one. A
 * wrong session id is worse than a missing one — it points /remember at an
 * unrelated conversation and presents it as this record's territory.
 *
 * Policy: project match required, proximity used to separate concurrent
 * sessions, ambiguity refused rather than guessed at.
 *
 * Shared by repair-orphan-sessions.js and backfill-investigations.js so the
 * two cannot drift. Six divergent copies of a one-line sentinel check is what
 * produced the phantom-window bug this module's callers exist to clean up.
 */

/**
 * Distance in ms from `ms` to the nearest event this session logged in
 * `project`. Infinity when the session has no events there.
 */
export function nearestGap(session, project, ms) {
  const stamps = session.stampsByProject?.get(project);
  if (!stamps || stamps.length === 0) return Infinity;
  // Binary search for the insertion point, then check the two neighbours.
  let lo = 0;
  let hi = stamps.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (stamps[mid] < ms) lo = mid + 1; else hi = mid;
  }
  let best = Math.abs(stamps[lo] - ms);
  if (lo > 0) best = Math.min(best, Math.abs(stamps[lo - 1] - ms));
  return best;
}

/**
 * @param {Array} sessionList  start-sorted windows from toSortedList()
 * @param {{nearMs?:number, separation?:number, isResolved:Function}} opts
 * @returns {(timestamp:string, project:string, cwd?:string) =>
 *            {match?, via?, gapSeconds?, ambiguous?}}
 */
export function createMatcher(sessionList, { nearMs = 600_000, separation = 4, isResolved }) {
  return function matchSession(timestamp, project, cwd) {
    if (!timestamp || !isResolved(project)) return {};

    const covering = [];
    for (const s of sessionList) {
      if (s.start > timestamp) break; // start-sorted; nothing later can cover
      if (timestamp <= s.end && s.projects.has(project)) covering.push(s);
    }

    if (covering.length === 0) return {};
    if (covering.length === 1) return { match: covering[0], via: 'project+time' };

    // A record written from inside a session sits within minutes of that
    // session's other events. Window coverage alone cannot separate concurrent
    // sessions — one resumed over five days covers everything in between.
    const ms = Date.parse(timestamp);
    const ranked = covering
      .map((s) => ({ s, gap: nearestGap(s, project, ms) }))
      .sort((a, b) => a.gap - b.gap);

    const [best, runnerUp] = ranked;
    const clear = best.gap <= nearMs
      && (runnerUp.gap === Infinity
        || runnerUp.gap >= best.gap * separation
        || runnerUp.gap - best.gap >= nearMs);
    if (clear) {
      return { match: best.s, via: 'proximity', gapSeconds: Math.round(best.gap / 1000) };
    }

    // Last resort: exactly one candidate worked in this exact directory.
    const byCwd = cwd ? covering.filter((s) => s.cwds.has(cwd)) : [];
    if (byCwd.length === 1) return { match: byCwd[0], via: 'cwd' };

    return { ambiguous: covering };
  };
}
