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
export async function hybridSearch(index, query, { project = '', limit = 15, offset = 0 } = {}) {
  const FUSION_DEPTH = 500;
  // Always run BM25 and get full pool
  const bm25All = scoreBM25(index, query, { project });

  // Try semantic search
  let semanticAll = [];
  try {
    semanticAll = await semanticSearch(query, { project, limit: FUSION_DEPTH });
  } catch {}

  let fusedItems = [];
  let keywordCount = bm25All.total;
  let semanticCount = semanticAll.length;

  if (semanticAll.length > 0 && bm25All.items.length > 0) {
    fusedItems = rrfFuse(bm25All.items.slice(0, FUSION_DEPTH), 'keyword', semanticAll, 'semantic', FUSION_DEPTH);
  } else if (bm25All.items.length > 0) {
    fusedItems = bm25All.items.map(r => ({ ...r.event, _score: r.score, _sources: 'keyword' }));
  } else {
    fusedItems = semanticAll.map(r => ({ ...r.event, _score: r.score, _sources: 'semantic' }));
  }

  return {
    items: fusedItems.slice(offset, offset + limit),
    fusedCount: fusedItems.length,
    keywordCount,
    semanticCount,
  };
}
