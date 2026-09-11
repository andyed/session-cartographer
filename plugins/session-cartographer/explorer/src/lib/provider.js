/**
 * Provider attribution for views that group raw events in the browser.
 *
 * This is the client-side twin of `attributeProvider` in
 * explorer/server/sessions.js. Two copies exist because the server module sits
 * on scripts/sentinels.js — a Node script with a shebang — and the Timeline
 * groups raw /api/events rows itself rather than consuming the server fold.
 *
 * Divergence between two copies of a rule is how this codebase has been bitten
 * before, so tests/unit/carto-provider-coverage.test.js asserts the two agree
 * on the same inputs. Change one, change the other, and the test will say so.
 */

/** Values the event pipeline uses to mean "absent". Mirrors scripts/sentinels.js. */
const UNRESOLVED = new Set(['', 'unknown']);

export function isResolvedProvider(value) {
  if (value === null || value === undefined) return false;
  return !UNRESOLVED.has(String(value).trim().toLowerCase());
}

/**
 * The agent that produced a run of events: the most-attested resolved provider.
 * Returns { provider, providers } so a genuinely mixed session stays visible
 * rather than being flattened to its majority.
 */
export function attributeProvider(events) {
  const counts = new Map();
  for (const event of events) {
    if (!isResolvedProvider(event?.provider)) continue;
    const key = String(event.provider).trim().toLowerCase();
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  if (counts.size === 0) return { provider: '', providers: [] };
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  return { provider: ranked[0][0], providers: ranked.map(([name]) => name) };
}
