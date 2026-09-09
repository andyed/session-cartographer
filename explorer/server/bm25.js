/**
 * BM25 scorer — ported from scripts/bm25-search.awk
 * In-memory index with incremental updates.
 */

const K1 = 1.2;
const B = 0.75;

/**
 * Tokenize text into lowercase alphanumeric terms.
 * Matches the awk: split(tolower(body), words, /[^a-z0-9]+/)
 */
export function tokenize(text) {
  // Normalize accented characters to ASCII (résumé → resume, über → uber)
  // then split on non-alphanumeric. Handles European languages without
  // breaking the simple tokenizer. CJK/RTL still needs semantic search.
  const normalized = text.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  return normalized.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

/**
 * Extract searchable text from an event. Human-readable fields drive most
 * matches, while identifiers remain addressable for exact recall.
 */
export function extractSearchText(event) {
  // Concatenate all text fields — URL should always be searchable
  // even when summary exists
  const parts = [
    event.summary,
    event.description,
    event.display,
    event.prompt,
    event.url,
    event.query,
    event.title,
    event.event_id,
    event.milestone,
  ].filter(Boolean);
  return parts.join(' ');
}

/**
 * Build a BM25 index from an array of events.
 */
export function buildIndex(events) {
  const index = {
    docs: new Map(),    // eventId → { tokens, tf: Map<term, count>, length, event }
    df: new Map(),      // term → number of docs containing it
    totalLength: 0,
    avgdl: 0,
  };

  for (const event of events) {
    addToIndex(index, event);
  }

  return index;
}

/**
 * Add a single event to the index. Used for initial build and incremental updates.
 */
export function addToIndex(index, event) {
  const id = event.event_id || event.milestone || `${event._source}-${index.docs.size}`;

  // Skip duplicates
  if (index.docs.has(id)) return;

  const text = extractSearchText(event);
  if (!text) return;

  const tokens = tokenize(text);
  const tf = new Map();
  for (const token of tokens) {
    tf.set(token, (tf.get(token) || 0) + 1);
  }

  // Update document frequencies
  const seen = new Set();
  for (const token of tokens) {
    if (!seen.has(token)) {
      seen.add(token);
      index.df.set(token, (index.df.get(token) || 0) + 1);
    }
  }

  index.docs.set(id, { tokens, tf, length: tokens.length, event });
  index.totalLength += tokens.length;
  index.avgdl = index.totalLength / index.docs.size;
}

/**
 * Score all documents against a query. Returns sorted results (highest first).
 */
/**
 * Expand wildcard tokens (e.g., "hallucinat*") into matching terms from the index.
 * Returns expanded token list with wildcards replaced by all matching terms.
 */
function expandWildcards(rawQuery, dfMap) {
  // Split on whitespace, preserving wildcards (don't run through tokenize which strips *)
  const parts = rawQuery.toLowerCase().split(/\s+/).filter(Boolean);
  const expanded = [];

  for (const part of parts) {
    if (part.endsWith('*') && part.length > 2) {
      // Prefix match against all terms in the DF map
      const prefix = part.slice(0, -1).replace(/[^a-z0-9]/g, '');
      if (prefix.length < 2) continue;

      for (const term of dfMap.keys()) {
        if (term.startsWith(prefix)) {
          expanded.push(term);
        }
      }
      // If no matches, keep the prefix as a literal (best effort)
      if (!expanded.some(t => t.startsWith(prefix))) {
        expanded.push(prefix);
      }
    } else {
      // Normal token — run through tokenize
      expanded.push(...tokenize(part));
    }
  }

  return [...new Set(expanded)]; // deduplicate
}

/**
 * Parse an event timestamp to epoch ms. Returns null when absent or unparseable.
 * The one definition — search.js:eventEpochMs() delegates here so the window
 * applied before BM25 truncation and the window applied after fusion cannot
 * disagree about what a given row's time is.
 */
export function epochMsFromTimestamp(rawTs) {
  if (typeof rawTs === 'string' && rawTs.startsWith('20')) {
    const t = new Date(rawTs).getTime();
    return isNaN(t) ? null : t;
  }
  if (rawTs) {
    const num = Number(rawTs);
    if (!isNaN(num)) return num > 1e12 ? num : num * 1000;
  }
  return null;
}

/**
 * One definition of "does this event belong to the requested project scope."
 *
 * Callers pass a pipe-delimited alternation of aliases, and the match is a
 * case-insensitive SUBSTRING so a family name selects its repositories:
 * `psychodeli` selects `psychodeli-webgl-port`. This has always been the
 * keyword ranker's behaviour; it is exported so the semantic leg can reproduce
 * it exactly instead of approximating it with equality (see
 * resolveProjectValues() in search.js).
 *
 * NOTE: spike/learning-lab is extracting this same predicate into
 * explorer/server/project-filter.js for the facts path. When that lands, both
 * should point at the one file rather than keeping two copies.
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

export function scoreBM25(index, query, { project, limit = 15, sinceMs = null, beforeMs = null } = {}) {
  // Expand wildcards before tokenizing
  const hasWildcard = query.includes('*');
  const queryTokens = hasWildcard
    ? expandWildcards(query, index.df)
    : tokenize(query);
  if (queryTokens.length === 0) return [];

  const N = index.docs.size;
  if (N === 0) return [];

  const results = [];
  const matchesProject = projectMatcher(project);

  const windowed = sinceMs !== null || beforeMs !== null;

  for (const [id, doc] of index.docs) {
    // Project filter
    if (!matchesProject(doc.event.project)) continue;

    // Time filter, applied here rather than to the returned ranking. The caller
    // truncates this list to FUSION_DEPTH, so windowing afterwards keeps the 500
    // globally best matches and then asks which fall inside the window — for a
    // short window that is almost none, and the keyword ladder reached fusion
    // empty while every stage reported success. Scoring is unaffected: N, df and
    // avgdl come from the whole index, so an in-window document scores exactly
    // what it scores unwindowed. A row with no parseable timestamp is dropped
    // when a window is active, matching hybridSearch and the CLI's rank_fuse.
    if (windowed) {
      const ts = epochMsFromTimestamp(doc.event.timestamp);
      if (ts === null) continue;
      if (sinceMs !== null && ts < sinceMs) continue;
      if (beforeMs !== null && ts > beforeMs) continue;
    }

    let score = 0;
    for (const q of queryTokens) {
      const termTf = doc.tf.get(q) || 0;
      if (termTf === 0) continue;

      const termDf = index.df.get(q) || 0;
      const idf = Math.log((N - termDf + 0.5) / (termDf + 0.5));
      if (idf < 0) continue; // clamp common terms

      const num = termTf * (K1 + 1);
      const denom = termTf + K1 * (1 - B + B * (doc.length / index.avgdl));
      score += idf * (num / denom);
    }

    if (score > 0) {
      results.push({ id, score, event: doc.event });
    }
  }

  results.sort((a, b) => b.score - a.score);
  return {
    items: results,
    total: results.length
  };
}
