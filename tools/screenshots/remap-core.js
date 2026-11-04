// The one name matcher for screenshots: used on snapshots in Node and, as
// source text, inside every page and frame a capture renders. It must stay
// self-contained (no imports, no references outside the function) because
// gallery.js serializes it into a Playwright init script.

/**
 * `entries` are [original, replacement] pairs. Matching is case-insensitive,
 * longest first, on token boundaries, in one pass, so a replacement that
 * contains another original is never rewritten. Home-directory owners are
 * replaced in plain and URL-encoded paths.
 *
 * `deny` and `watch` are never replaced; they only count as leaks. Token
 * boundaries treat `-` and `_` as word characters, so a name inside a longer
 * token (`proj9_analysis`) is neither replaced nor caught by the boundary
 * match. `watch` terms are therefore matched as plain substrings, and deny
 * terms of five or more characters join them; shorter deny terms stay
 * bounded so a three-letter name does not flag every word containing it.
 */
export function createReplacer(entries, { deny = [], watch = [] } = {}) {
  const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const sorted = [...entries].filter(([key]) => key).sort(([a], [b]) => b.length - a.length || a.localeCompare(b));
  const lookup = new Map(sorted.map(([a, b]) => [a.toLowerCase(), b]));
  const bounded = keys => new RegExp(`(?<![\\p{L}\\p{N}_-])(?:${keys.map(escape).join('|')})(?![\\p{L}\\p{N}_-])`, 'giu');
  const pattern = sorted.length ? bounded(sorted.map(([key]) => key)) : null;
  const shortDeny = deny.filter(term => term && term.length < 5);
  const substrings = [...new Set([...watch, ...deny.filter(term => term && term.length >= 5)].filter(Boolean).map(term => term.toLowerCase()))];
  const denied = shortDeny.length ? bounded(shortDeny) : null;
  const watched = substrings.length ? new RegExp(substrings.map(escape).join('|'), 'gi') : null;
  // A watched name the dictionary maps is also replaced inside longer tokens
  // (`<claude-mem-context>`, `repo-www-ultrawide/`). Aliases are generated
  // words that contain no watched name, so this second pass cannot cascade.
  const embeddedKeys = watch.filter(term => term && lookup.has(term.toLowerCase())).sort((a, b) => b.length - a.length);
  const embedded = embeddedKeys.length ? new RegExp(embeddedKeys.map(escape).join('|'), 'gi') : null;
  const homes = /\/(?:Users|home)\/(?!demo(?:[/"'\s<>]|$))[^/\s"'<>]+/g;
  const encodedHomes = /%2F(?:Users|home)%2F(?!demo(?:%2F|[\s"'<>]|$))[^%\s"'<>]+/gi;
  const replace = text => {
    if (typeof text !== 'string' || !text) return text;
    let result = pattern ? text.replace(pattern, key => lookup.get(key.toLowerCase()) ?? key) : text;
    if (embedded) result = result.replace(embedded, key => lookup.get(key.toLowerCase()) ?? key);
    result = result.replace(homes, '/home/demo');
    return result.replace(encodedHomes, '%2Fhome%2Fdemo');
  };
  // What a finished frame still shows that it should not: an original the
  // dictionary maps, a denied term, or a real home directory.
  const leaks = text => {
    if (typeof text !== 'string' || !text) return [];
    const found = [];
    if (pattern) for (const match of text.matchAll(pattern)) if (lookup.get(match[0].toLowerCase()) !== match[0]) found.push(match[0]);
    if (denied) for (const match of text.matchAll(denied)) found.push(match[0]);
    if (watched) for (const match of text.matchAll(watched)) found.push(match[0]);
    for (const match of text.matchAll(homes)) found.push(match[0]);
    return found;
  };
  return { replace, leaks, size: sorted.length };
}
