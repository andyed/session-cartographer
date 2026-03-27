/**
 * Hybrid search: BM25 keyword + Qdrant semantic, fused via RRF.
 * Graceful degradation — returns keyword-only if Qdrant/embeddings are down.
 */

import { scoreBM25 } from './bm25.js';

const QDRANT_URL = process.env.CARTOGRAPHER_QDRANT_URL || 'http://localhost:6333';
const EMBED_URL = process.env.CARTOGRAPHER_EMBED_URL || 'http://localhost:8890/v1/embeddings';
const EMBED_MODEL = process.env.CARTOGRAPHER_EMBED_MODEL || 'mxbai-embed-large';
const COLLECTION = process.env.CARTOGRAPHER_COLLECTION || 'session-cartographer';
const RRF_K = 60;

/**
 * Get embedding vector for a query string.
 */
async function getEmbedding(text) {
  const res = await fetch(EMBED_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: EMBED_MODEL,
      input: `Represent this sentence for retrieval: ${text}`,
    }),
  });
  if (!res.ok) throw new Error(`Embedding failed: ${res.status}`);
  const data = await res.json();
  return data.data[0].embedding;
}

/**
 * Search Qdrant by vector similarity.
 */
async function semanticSearch(query, { project, limit }) {
  const vector = await getEmbedding(query);

  const body = { vector, limit, with_payload: true };
  if (project) {
    body.filter = { must: [{ key: 'project', match: { value: project } }] };
  }

  const res = await fetch(`${QDRANT_URL}/collections/${COLLECTION}/points/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Qdrant search failed: ${res.status}`);
  const data = await res.json();

  return (data.result || []).map((hit, i) => ({
    id: hit.payload?.event_id || `sem-${i}`,
    score: hit.score,
    event: hit.payload || {},
  }));
}

/**
 * Reciprocal Rank Fusion across two result lists.
 */
function rrfFuse(list1, list1Source, list2, list2Source, limit) {
  const scores = new Map();  // id → { score, sources: Set, event }

  function addList(list, source) {
    for (let rank = 0; rank < list.length; rank++) {
      const { id, event } = list[rank];
      const rrfScore = 1 / (RRF_K + rank + 1);

      if (scores.has(id)) {
        const entry = scores.get(id);
        entry.score += rrfScore;
        entry.sources.add(source);
      } else {
        scores.set(id, {
          score: rrfScore,
          sources: new Set([source]),
          event,
        });
      }
    }
  }

  addList(list1, list1Source);
  addList(list2, list2Source);

  return [...scores.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(entry => ({
      ...entry.event,
      _score: entry.score,
      _sources: [...entry.sources].join('+'),
    }));
}

/**
 * Run hybrid search: BM25 + optional Qdrant, fused via RRF.
 */
export async function hybridSearch(index, query, { project = '', limit = 15 } = {}) {
  // Always run BM25
  const bm25Results = scoreBM25(index, query, { project, limit });

  // Try semantic search (silent fail)
  let semanticResults = [];
  try {
    semanticResults = await semanticSearch(query, { project, limit });
  } catch {
    // Qdrant or embedding server down — keyword only
  }

  // If both have results, fuse via RRF
  if (semanticResults.length > 0 && bm25Results.length > 0) {
    const fused = rrfFuse(bm25Results, 'keyword', semanticResults, 'semantic', limit);
    return {
      items: fused,
      keywordCount: bm25Results.length,
      semanticCount: semanticResults.length,
    };
  }

  // Keyword only
  if (bm25Results.length > 0) {
    return {
      items: bm25Results.map(r => ({ ...r.event, _score: r.score, _sources: 'keyword' })),
      keywordCount: bm25Results.length,
      semanticCount: 0,
    };
  }

  // Semantic only
  if (semanticResults.length > 0) {
    return {
      items: semanticResults.map(r => ({ ...r.event, _score: r.score, _sources: 'semantic' })),
      keywordCount: 0,
      semanticCount: semanticResults.length,
    };
  }

  return { items: [], keywordCount: 0, semanticCount: 0 };
}
