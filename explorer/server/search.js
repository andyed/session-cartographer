/**
 * Hybrid search: BM25 keyword + Qdrant semantic, fused via RRF.
 * Graceful degradation — returns keyword-only if Qdrant/embeddings are down.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { epochMsFromTimestamp, scoreBM25 } from './bm25.js';
import { projectMatcher } from './project-filter.js';

const QDRANT_URL = process.env.CARTOGRAPHER_QDRANT_URL || 'http://localhost:6333';
const EMBED_URL = process.env.CARTOGRAPHER_EMBED_URL || 'http://localhost:8890/v1/embeddings';
const EMBED_MODEL = process.env.CARTOGRAPHER_EMBED_MODEL || 'mxbai-embed-large';
const COLLECTION = process.env.CARTOGRAPHER_COLLECTION || 'session-cartographer';
const RRF_K = 60;
const DECAY_LAMBDA = parseFloat(process.env.CARTOGRAPHER_DECAY_LAMBDA || '0.001');

// Promote-on-reuse access ledger — written by the CLI's --touch when /remember
// actually reads the transcript behind a result. Mirrors the activation layer
// in scripts/cartographer-search.sh:rank_fuse_and_display (the canonical
// implementation); keep the two in sync.
const ACCESS_LEDGER = process.env.CARTOGRAPHER_ACCESS_LEDGER ||
  join(process.env.CARTOGRAPHER_DEV_DIR || join(homedir(), 'Documents/dev'), 'access-ledger.jsonl');
const REUSE_WEIGHT = parseFloat(process.env.CARTOGRAPHER_REUSE_WEIGHT || '0.3');

// Opt out of the semantic leg entirely. Hybrid search reaches a live Qdrant
// instance, which is right in production and wrong anywhere the caller wants a
// deterministic keyword-only answer: unit tests handed a fixture index, offline
// work, CI, or debugging BM25 ranking without fusion noise. Without this the
// only way to isolate the leg was to point the URL at a dead port and rely on
// the connection being refused — which made a passing test depend on a service
// being *absent*, so the same suite passed on CI and failed on a dev box.
// Read at call time, not module load: ES imports are hoisted, so a module-level
// const is fixed before an importing test can set the variable.
const semanticEnabled = () => process.env.CARTOGRAPHER_SEMANTIC !== '0';

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

async function qdrantSearch(body) {
  const res = await fetch(`${QDRANT_URL}/collections/${COLLECTION}/points/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const error = new Error(`Qdrant search failed: ${res.status}`);
    error.status = res.status;
    throw error;
  }
  return res.json();
}

/**
 * Concrete `project` values in the corpus that the requested scope selects.
 *
 * Qdrant's `match: { value }` is exact keyword equality, but every other stage
 * scopes by case-insensitive substring, so a family name reached the keyword
 * ladder as its whole family and the semantic ladder as nothing at all:
 * `--project psycho` returned 20 keyword rows and 0 semantic ones, and
 * `/api/recall` (which does no registry expansion) does the same for a bare
 * `psychodeli`. Nothing errored — the ladder was simply absent.
 *
 * Resolving the spec against the values actually present keeps one filter in
 * one query while preserving substring semantics exactly. Measured at 8-13 ms
 * over 128k resident docs (203 distinct projects) — under 1% of Turbo's 1500 ms
 * budget, so it is computed per call rather than cached, which would trade that
 * for a staleness bug the moment a new project appears.
 */
export function resolveProjectValues(index, spec) {
  const matches = projectMatcher(spec);
  const values = new Set();
  for (const [, doc] of index.docs) {
    const value = doc.event.project;
    if (value && matches(value)) values.add(value);
  }
  return [...values];
}

async function semanticSearch(query, { project, limit, sinceMs = null, beforeMs = null, projectValues = null }) {
  // An empty resolution is a real answer, not a missing one: the scope selects
  // no project in this corpus, so the semantic leg has nothing to contribute.
  // Say so without spending an embedding call or a round trip.
  if (project && projectValues && projectValues.length === 0) return [];

  const vector = await getEmbedding(query);

  const body = { vector, limit, with_payload: true, score_threshold: SEMANTIC_SCORE_THRESHOLD };
  const must = [];
  if (project) {
    // Resolved concrete names when the caller supplied an index; otherwise fall
    // back to treating the spec itself as literal names, which is what this did
    // before and is still correct for a caller that passes exact projects.
    const projects = projectValues
      ?? project.split('|').map((value) => value.trim()).filter(Boolean);
    must.push(projects.length === 1
      ? { key: 'project', match: { value: projects[0] } }
      : { should: projects.map((value) => ({ key: 'project', match: { value } })) });
  }

  // Push the time window into Qdrant instead of trimming its answer afterwards.
  // `limit` is the fusion depth, so an unfiltered query returns the 500 globally
  // nearest points across the whole corpus and the client-side window then keeps
  // whichever of those happen to fall inside it. For a short window that is
  // almost none — a 24h slice of a 109k-point collection matched 0 of 500 on the
  // feed query — so the semantic ladder contributed nothing exactly when recall
  // mattered most. With the bound in the query, the 500 are the 500 nearest
  // *within the window*.
  //
  // Qdrant compares RFC3339 payload strings chronologically (verified against
  // 1.12.1: an offset timestamp `2026-03-17T21:21:04-07:00` is correctly
  // included by `gte: 2026-03-18T00:00:00Z` and excluded by `lt` on the same
  // boundary, where a lexicographic compare would do the opposite). ~2% of this
  // corpus carries non-UTC offsets, so that distinction is load-bearing — do not
  // "simplify" this to a string compare. No payload index is required.
  const range = {};
  if (sinceMs !== null) range.gte = new Date(sinceMs).toISOString();
  if (beforeMs !== null) range.lte = new Date(beforeMs).toISOString();
  const hasRange = Object.keys(range).length > 0;
  if (hasRange) must.push({ key: 'timestamp', range });

  if (must.length > 0) body.filter = { must };

  let data;
  try {
    data = await qdrantSearch(body);
  } catch (error) {
    // A 4xx means this Qdrant rejected the request itself — an older server
    // without datetime range support, or a payload schema that forbids the
    // clause. Retry once without the range rather than dropping the semantic
    // leg entirely: the client-side windowed() backstop still trims the answer,
    // which is the pre-pushdown behaviour and strictly better than no leg at
    // all. A 5xx or a connection failure is Qdrant being unwell, so a retry
    // would only cost latency — let those propagate.
    if (!hasRange || !(error.status >= 400 && error.status < 500)) throw error;
    body.filter = must.length > 1 ? { must: must.slice(0, -1) } : undefined;
    if (!body.filter) delete body.filter;
    data = await qdrantSearch(body);
  }

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
  return epochMsFromTimestamp(item.timestamp);
}

/**
 * Reciprocal Rank Fusion across two result lists.
 */
// The portable CLI does not rank one global list: it searches changelog,
// research, milestones, and tool-use separately and fuses four ranked ladders,
// so an event that is 2nd-best among milestones contributes 1/(60+2) even when
// routine tool events would bury it in a global ranking. The warm path fused a
// single deduplicated keyword list against semantic, which is why milestone and
// research events vanished from accelerated results: at corpus scale a /wrapup
// milestone lands past rank 400 globally and contributes almost nothing, or
// falls outside FUSION_DEPTH entirely. Bucket by the ingest-time `_source` tag
// (jsonl.js resolves each event to exactly one domain source, preferring the
// domain log over changelog) and fuse the ladders the way the CLI does.
function bucketBySource(items) {
  const buckets = new Map();
  for (const item of items) {
    const source = item.event?._source || 'changelog';
    if (!buckets.has(source)) buckets.set(source, []);
    buckets.get(source).push(item);
  }
  return [...buckets.entries()].map(([source, list]) => ({ source, list }));
}

function rrfFuseMany(ladders, limit) {
  const scores = new Map();
  for (const { source, list } of ladders) {
    for (let rank = 0; rank < list.length; rank++) {
      const { id, event } = list[rank];
      const rrfScore = 1 / (RRF_K + rank + 1);
      if (scores.has(id)) {
        const entry = scores.get(id);
        entry.score += rrfScore;
        entry.sources.add(source);
      } else {
        scores.set(id, { score: rrfScore, sources: new Set([source]), event });
      }
    }
  }
  return [...scores.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((entry) => ({
      ...entry.event,
      _score: entry.score,
      _sources: [...entry.sources].join('+'),
    }));
}

/**
 * Aggregate the access ledger: event_id → { n, lastMs, sum } where sum is the
 * ACT-R-style frequency term Σ 1/sqrt(days_since_access). Re-read per query —
 * the ledger is tiny, the server is long-running, and the sums are
 * time-varying (an access counts less as it ages), so caching would freeze
 * them. Missing or unreadable ledger → empty map → no behavior change.
 */
function loadAccessLedger() {
  const map = new Map();
  let raw;
  try {
    raw = readFileSync(ACCESS_LEDGER, 'utf8');
  } catch {
    return map;
  }
  const now = Date.now();
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    // Fetching is inspection, not endorsement. Preserve historical
    // transcript_read/source-less use records, matching the portable CLI.
    if (rec.source === 'result_fetched') continue;
    const id = rec.event_id;
    const ts = Date.parse(rec.timestamp || '');
    if (!id || isNaN(ts)) continue;
    // Floor ~30min — guards div-by-zero and clock skew
    const days = Math.max(0.02, (now - ts) / 86400e3);
    const entry = map.get(id) || { n: 0, lastMs: 0, sum: 0 };
    entry.n += 1;
    entry.lastMs = Math.max(entry.lastMs, ts);
    entry.sum += 1 / Math.sqrt(days);
    map.set(id, entry);
  }
  return map;
}

/**
 * Apply activation: Ebbinghaus time-decay + promote-on-reuse.
 * score *= exp(-lambda * hours_since_last_use) * reuse_boost
 *
 * "Last use" is the event timestamp or the most recent recorded access,
 * whichever is newer — reuse refreshes recency. reuse_boost =
 * 1 + REUSE_WEIGHT * Σ 1/sqrt(days_since_access), capped at 2.0 so reuse
 * breaks ties without overpowering relevance. Events with no recorded
 * access score exactly as before. Mirrors the awk activation block in
 * scripts/cartographer-search.sh — keep the two in sync.
 */
function applySalience(items) {
  for (const item of items) {
    const salience = Number(item.salience);
    item._score *= Number.isFinite(salience) ? salience : 0.5;
  }
  return items;
}

function applyActivation(items, lambda) {
  const accesses = REUSE_WEIGHT > 0 ? loadAccessLedger() : new Map();
  if (lambda <= 0 && accesses.size === 0) return items;
  const now = Date.now();
  for (const item of items) {
    const acc = accesses.get(item.event_id);
    if (acc) {
      item._score *= Math.min(2.0, 1 + REUSE_WEIGHT * acc.sum);
      item._reuseCount = acc.n;
    }
    if (lambda > 0) {
      const rawTs = item.timestamp;
      let epoch = 0;
      if (typeof rawTs === 'string' && rawTs.startsWith('20')) {
        epoch = new Date(rawTs).getTime();
      } else if (rawTs) {
        const num = Number(rawTs);
        if (!isNaN(num)) epoch = num > 1e12 ? num : num * 1000;
      }
      if (epoch > 0) {
        if (acc && acc.lastMs > epoch) epoch = acc.lastMs;
        const hours = (now - epoch) / 3600000;
        item._score *= Math.exp(-lambda * Math.max(0, hours));
      }
    }
  }
  // Re-sort after activation adjustment
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
  const started = performance.now();
  const FUSION_DEPTH = 500;
  // Always run BM25 and get full pool
  const keywordStarted = performance.now();
  const bm25All = scoreBM25(index, query, { project, sinceMs, beforeMs });
  const keywordMs = performance.now() - keywordStarted;

  // Try semantic search
  let semanticAll = [];
  const useSemantic = semanticEnabled();
  let semanticStatus = useSemantic ? 'available' : 'disabled';
  const semanticStarted = performance.now();
  if (useSemantic) {
    try {
      semanticAll = await semanticSearch(query, {
        project, limit: FUSION_DEPTH, sinceMs, beforeMs,
        projectValues: project ? resolveProjectValues(index, project) : null,
      });
    } catch (error) {
      semanticStatus = 'unavailable';
    }
  }
  const semanticMs = performance.now() - semanticStarted;

  const fusionStarted = performance.now();
  let fusedItems = [];
  let keywordCount = bm25All.total;
  let semanticCount = semanticAll.length;

  // Temporal window: --since / --before equivalent. This MUST run before the
  // FUSION_DEPTH truncation. Ranking is global, so slicing first keeps the 500
  // best matches across all time and only then asks which fall inside the
  // window — and on a six-figure corpus a 24-hour window is barely 1% of
  // events, so almost everything recent was discarded before the filter ever
  // saw it. The daily pulse returned 2 results where the portable path returned
  // 15, against 1,641 changelog rows written in that same window.
  // Items with no parseable timestamp are dropped when a window is active,
  // mirroring the CLI at scripts/cartographer-search.sh:rank_fuse.
  // Both pools are now ALSO bounded at their source — scoreBM25 filters before
  // it truncates, and semanticSearch puts a `timestamp` range clause in the
  // Qdrant query — so this is the backstop rather than the only filter. It has
  // to stay: the semantic pushdown can be absent (a server without datetime
  // range support falls back to an unbounded query), and a pool that arrives
  // unbounded must still be trimmed here.
  const windowed = (list, getEvent) => {
    if (sinceMs === null && beforeMs === null) return list;
    return list.filter((entry) => {
      const ts = eventEpochMs(getEvent(entry));
      if (ts === null) return false;
      if (sinceMs !== null && ts < sinceMs) return false;
      if (beforeMs !== null && ts > beforeMs) return false;
      return true;
    });
  };

  const keywordPool = windowed(bm25All.items, (entry) => entry.event);
  const semanticPool = windowed(semanticAll, (entry) => entry.event);

  const keywordLadders = bucketBySource(keywordPool.slice(0, FUSION_DEPTH));
  if (semanticPool.length > 0 || keywordLadders.length > 0) {
    const ladders = [...keywordLadders];
    if (semanticPool.length > 0) ladders.push({ source: 'semantic', list: semanticPool.slice(0, FUSION_DEPTH) });
    fusedItems = rrfFuseMany(ladders, FUSION_DEPTH);
  }

  // Weight by write-time salience before activation, exactly as the portable
  // fusion does at scripts/cartographer-search.sh (`score = 1/(60+rank) * sal`).
  // Without this the warm path ranked a /wrapup milestone (0.9) and a routine
  // bash command (0.2) identically on relevance alone, and since routine tool
  // events outnumber deliberate ones by orders of magnitude in the corpus, every
  // milestone and research event fell below the noise-tail cut. Measured on five
  // targeted queries the warm path returned 0-1 milestones where the portable
  // path returned 2-6 — the material /wrapup exists to create was the material
  // Turbo silently dropped. Missing salience defaults to 0.5 (neutral), matching
  // the portable default for events written before the field existed.
  applySalience(fusedItems);

  // Apply activation: time-decay + promote-on-reuse weighting.
  // Applied after RRF fusion so it affects ranking but doesn't
  // eliminate old results entirely (they still appear if relevant enough).
  applyActivation(fusedItems, DECAY_LAMBDA);

  // Trim noise tail — keep results with meaningful RRF score
  // Threshold: items scoring below 20% of the top score are noise
  if (fusedItems.length > 0) {
    const topScore = fusedItems[0]._score;
    const minScore = topScore * 0.1;
    fusedItems = fusedItems.filter(item => item._score >= minScore);
  }
  const fusionMs = performance.now() - fusionStarted;

  return {
    items: fusedItems,
    fusedCount: fusedItems.length,
    keywordCount,
    semanticCount,
    facets: computeFacets(fusedItems),
    semanticStatus,
    stagesMs: {
      keyword: Number(keywordMs.toFixed(3)),
      semantic: Number(semanticMs.toFixed(3)),
      fusion_activation: Number(fusionMs.toFixed(3)),
      total: Number((performance.now() - started).toFixed(3)),
    },
  };
}
