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
  return text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

/**
 * Extract searchable text from an event using the field fallback chain.
 * Matches bm25-search.awk get_search_text().
 */
export function extractSearchText(event) {
  // Concatenate all text fields — URL should always be searchable
  // even when summary exists
  const parts = [
    event.summary,
    event.description,
    event.prompt,
    event.url,
    event.query,
    event.title,
  ].filter(Boolean);
  return parts.join(' ') || event.event_id || event.milestone || '';
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
export function scoreBM25(index, query, { project, limit = 15 } = {}) {
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return [];

  const N = index.docs.size;
  if (N === 0) return [];

  const results = [];

  for (const [id, doc] of index.docs) {
    // Project filter
    if (project && !(doc.event.project || '').toLowerCase().includes(project.toLowerCase())) {
      continue;
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
  return results.slice(0, limit);
}
