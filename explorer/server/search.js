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
const DECAY_LAMBDA = parseFloat(process.env.CARTOGRAPHER_DECAY_LAMBDA || '0.001');

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
const SEMANTIC_SCORE_THRESHOLD = 0.3;

async function semanticSearch(query, { project, limit }) {
  const vector = await getEmbedding(query);

  const body = { vector, limit, with_payload: true, score_threshold: SEMANTIC_SCORE_THRESHOLD };
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
 * Parse a temporal argument (--since / --before equivalent for the API path).
 * Mirrors scripts/cartographer-search.sh:parse_time_arg() — keep the two in sync.
 *
 * Accepts: natural phrases (today, yesterday, this morning/afternoon/evening,
 * tonight, this hour, this/last week/month), relative durations (7d, 2h, 30m,
 * 1w, 3mo, 1y), or absolute dates (2026-04-20, 2026-04-20T12:00:00).
 * Returns epoch ms, or null on parse failure.
 */
export function parseTimeArg(arg) {
  if (!arg) return null;
  const norm = String(arg).toLowerCase().trim().replace(/\s+/g, ' ');
  const now = new Date();

  // Helpers: build local-time anchors
  const atToday = (h, m = 0) => {
    const d = new Date(now); d.setHours(h, m, 0, 0); return d.getTime();
  };
  const atYesterday = (h, m = 0) => {
    const d = new Date(now); d.setDate(d.getDate() - 1); d.setHours(h, m, 0, 0); return d.getTime();
  };
  const atMonday = (offsetWeeks = 0) => {
    const d = new Date(now);
    const dow = d.getDay() || 7; // Sun=0 → 7 so Monday is dow=1
    d.setDate(d.getDate() - (dow - 1) + offsetWeeks * 7);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  };
  const atFirstOfMonth = (offsetMonths = 0) => {
    const d = new Date(now.getFullYear(), now.getMonth() + offsetMonths, 1, 0, 0, 0, 0);
    return d.getTime();
  };

  // Natural-language phrases
  switch (norm) {
    case 'today':
    case 'this day':           return atToday(0);
    case 'yesterday':
    case 'last night':         return atYesterday(0);
    case 'this morning':       return atToday(6);
    case 'this afternoon':     return atToday(12);
    case 'this evening':       return atToday(18);
    case 'tonight':            return atToday(21);
    case 'this hour': {
      const d = new Date(now); d.setMinutes(0, 0, 0); return d.getTime();
    }
    case 'this week':          return atMonday(0);
    case 'last week':          return atMonday(-1);
    case 'this month':         return atFirstOfMonth(0);
    case 'last month':         return atFirstOfMonth(-1);
  }

  // Relative duration: NUMBER + UNIT
  const rel = arg.match(/^(\d+)(d|h|m|w|mo|y)$/);
  if (rel) {
    const num = parseInt(rel[1], 10);
    const unitMs = { h: 3600e3, m: 60e3, d: 86400e3, w: 604800e3, mo: 2592000e3, y: 31536000e3 }[rel[2]];
    return now.getTime() - num * unitMs;
  }

  // Absolute date (ISO-ish)
  if (/^\d{4}-\d{2}-\d{2}/.test(arg)) {
    const t = Date.parse(arg.length === 10 ? arg + 'T00:00:00' : arg);
    if (!isNaN(t)) return t;
  }
  return null;
}

/**
 * Extract epoch ms from an event's timestamp field. Mirrors applyTimeDecay's
 * normalization. Returns null if the value cant be interpreted.
 */
function eventEpochMs(item) {
  const rawTs = item.timestamp;
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
 * Apply Ebbinghaus-inspired time decay to fused results.
 * score *= exp(-lambda * hours_since_event)
 * Gently favors recent results without eliminating old ones.
 */
function applyTimeDecay(items, lambda) {
  if (lambda <= 0) return items;
  const now = Date.now();
  for (const item of items) {
    const rawTs = item.timestamp;
    let epoch = 0;
    if (typeof rawTs === 'string' && rawTs.startsWith('20')) {
      epoch = new Date(rawTs).getTime();
    } else if (rawTs) {
      const num = Number(rawTs);
      if (!isNaN(num)) epoch = num > 1e12 ? num : num * 1000;
    }
    if (epoch > 0) {
      const hours = (now - epoch) / 3600000;
      item._score *= Math.exp(-lambda * Math.max(0, hours));
    }
  }
  // Re-sort after decay adjustment
  items.sort((a, b) => b._score - a._score);
  return items;
}

/**
 * Compute facets over a result set — project, type, source, and time distributions.
 */
export function computeFacets(items) {
  const projMap = new Map();
  const typeMap = new Map();
  const srcMap = new Map();
  const quadMap = new Map();
  const monthMap = new Map();
  const dayMap = new Map();
  let oldest = null, newest = null;

  for (const item of items) {
    // Project
    const proj = item.project;
    if (proj) projMap.set(proj, (projMap.get(proj) || 0) + 1);

    // Event type
    const type = item.type || item.milestone || '';
    if (type) typeMap.set(type, (typeMap.get(type) || 0) + 1);

    // Diff shape quadrant (Tier 3)
    const quad = item.diff_shape?.quadrant;
    if (quad) quadMap.set(quad, (quadMap.get(quad) || 0) + 1);

    // Sources (split compound like "keyword+semantic")
    const sources = (item._sources || '').split('+');
    for (const s of sources) {
      if (s) srcMap.set(s, (srcMap.get(s) || 0) + 1);
    }

    // Time buckets — normalize timestamps to ISO strings
    const rawTs = item.timestamp;
    let ts = '';
    if (typeof rawTs === 'string' && rawTs.startsWith('20')) {
      ts = rawTs;
    } else if (rawTs) {
      // Numeric epoch (seconds or milliseconds) → ISO
      const num = Number(rawTs);
      if (!isNaN(num)) {
        const d = new Date(num > 1e12 ? num : num * 1000);
        ts = d.toISOString();
      }
    }
    if (ts) {
      const month = ts.slice(0, 7);  // YYYY-MM
      const day = ts.slice(0, 10);    // YYYY-MM-DD
      if (/^\d{4}-\d{2}$/.test(month)) monthMap.set(month, (monthMap.get(month) || 0) + 1);
      if (/^\d{4}-\d{2}-\d{2}$/.test(day)) dayMap.set(day, (dayMap.get(day) || 0) + 1);
      if (!oldest || ts < oldest) oldest = ts;
      if (!newest || ts > newest) newest = ts;
    }
  }

  const sortDesc = (map, max) =>
    [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, max).map(([name, count]) => ({ name, count }));

  const sortChron = (map, max) =>
    [...map.entries()].sort((a, b) => b[0].localeCompare(a[0])).slice(0, max).map(([name, count]) => ({ name, count }));

  return {
    projects: sortDesc(projMap, 5),
    types: sortDesc(typeMap, 5),
    quadrants: sortDesc(quadMap, 4),
    sources: sortDesc(srcMap, 5),
    time: {
      oldest: oldest ? oldest.slice(0, 10) : null,
      newest: newest ? newest.slice(0, 10) : null,
      months: sortChron(monthMap, 6),
      days: sortChron(dayMap, 7),
    },
  };
}

/**
 * Run hybrid search: BM25 + optional Qdrant, fused via RRF.
 * Returns full fusion pool (up to 500) + facets. Client paginates.
 */
export async function hybridSearch(index, query, { project = '', sinceMs = null, beforeMs = null } = {}) {
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

  // Temporal filter: --since / --before equivalent. Drop items outside the window.
  // Items with no parseable timestamp are dropped when a filter is active —
  // mirrors the CLI behaviour at scripts/cartographer-search.sh:rank_fuse.
  if (sinceMs !== null || beforeMs !== null) {
    fusedItems = fusedItems.filter(item => {
      const ts = eventEpochMs(item);
      if (ts === null) return false;
      if (sinceMs !== null && ts < sinceMs) return false;
      if (beforeMs !== null && ts > beforeMs) return false;
      return true;
    });
  }

  // Apply time-decay: Ebbinghaus-inspired recency weighting.
  // Applied after RRF fusion so it affects ranking but doesn't
  // eliminate old results entirely (they still appear if relevant enough).
  applyTimeDecay(fusedItems, DECAY_LAMBDA);

  // Trim noise tail — keep results with meaningful RRF score
  // Threshold: items scoring below 20% of the top score are noise
  if (fusedItems.length > 0) {
    const topScore = fusedItems[0]._score;
    const minScore = topScore * 0.1;
    fusedItems = fusedItems.filter(item => item._score >= minScore);
  }

  return {
    items: fusedItems,
    fusedCount: fusedItems.length,
    keywordCount,
    semanticCount,
    facets: computeFacets(fusedItems),
  };
}
