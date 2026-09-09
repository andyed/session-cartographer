/**
 * One definition of "does this event belong to the requested project scope."
 *
 * Callers do not pass a project name. They pass a pipe-delimited alternation of
 * every alias a project family expands to (`project-registry.json` turns 20
 * names into 37 aliases for FrakBot's feed), and the match is a case-insensitive
 * substring so that a family name selects its repositories: `psychodeli` is
 * meant to select `psychodeli-webgl-port` and `psychodeli-private`.
 *
 * Substring matching is the established behaviour of the keyword ranker
 * (`bm25.js`), and the facts path has to agree with it exactly. A census and a
 * recall over the same `--project` that disagreed about scope would produce two
 * defensible answers with no way to tell which described the requested corpus.
 */

/**
 * Resolve a project spec against the project values actually present, returning
 * the distinct values in scope.
 *
 * This exists because substring matching cannot see a registry alias whose
 * members do not contain their own key, and six of the ten aliases in
 * `project-registry.json` are exactly that: `devtools` expands to
 * `session-cartographer`, `interests` to `histospire`, `scrutinizer` to `fovi`
 * and `clicksense`. The portable CLI expands through the registry before it
 * builds a filter; the API does not, anywhere. So an API caller asking for
 * `devtools` matches nothing and is handed `0 events` — which reads as "nothing
 * happened" when it means "I could not resolve your scope". For a census that
 * is the worst available failure, because the number looks like an answer.
 *
 * Resolving against the corpus makes the two cases distinguishable. It does not
 * make them equal: expanding the registry inside the API is a separate decision
 * with its own policy boundary, since the `frakbot` alias maps to OpenClaw
 * archive material that is never a valid source.
 */
export function resolveProjectValues(values, spec) {
  const matches = projectMatcher(spec);
  const resolved = new Set();
  for (const value of values) {
    if (value && matches(value)) resolved.add(value);
  }
  return [...resolved].sort((a, b) => a.localeCompare(b));
}

/**
 * Build a predicate for a pipe-delimited project spec.
 * An empty spec matches everything — no scope requested, no scope applied.
 */
export function projectMatcher(spec) {
  const names = String(spec || '')
    .split('|')
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean);
  if (names.length === 0) return () => true;
  return (eventProject) => {
    const value = String(eventProject || '').toLowerCase();
    if (!value) return false;
    return names.some((name) => value.includes(name));
  };
}
