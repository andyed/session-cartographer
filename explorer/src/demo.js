// demo.js — Static data layer for GH Pages demo.
// Loaded lazily only when VITE_DEMO=true.

const BASE = import.meta.env.BASE_URL || '/';

let cache = null;

async function load() {
  if (cache) return cache;

  const [queries, ac, sessions, events, projects] = await Promise.all([
    fetch(`${BASE}demo/queries.json`).then(r => r.json()),
    fetch(`${BASE}demo/autocomplete.json`).then(r => r.json()),
    fetch(`${BASE}demo/sessions.json`).then(r => r.json()),
    fetch(`${BASE}demo/events.json`).then(r => r.json()),
    fetch(`${BASE}demo/projects.json`).then(r => r.json()),
  ]);

  const results = {};
  for (const q of queries) {
    results[q.query.toLowerCase()] = await fetch(`${BASE}demo/results/${q.id}.json`).then(r => r.json());
  }

  cache = { queries, ac, sessions, events, projects, results };
  return cache;
}

function closestQuery(query, queries) {
  const q = query.toLowerCase().trim();
  const exact = queries.find(qd => qd.query.toLowerCase() === q);
  if (exact) return exact.query.toLowerCase();
  const partial = queries.find(qd => q.includes(qd.query.toLowerCase()) || qd.query.toLowerCase().includes(q));
  if (partial) return partial.query.toLowerCase();
  return queries[0]?.query.toLowerCase();
}

const EMPTY_SEARCH = { results: [], facets: null, meta: { query: '', keyword_count: 0, semantic_count: 0, fused_count: 0, duration_ms: 0, total_matches: 0 } };

// Route /api/* URLs to cached data
export async function handleFetch(url) {
  const d = await load();
  const u = new URL(url, 'http://localhost');

  if (u.pathname === '/api/events') {
    const limit = parseInt(u.searchParams.get('limit') || '50', 10);
    const offset = parseInt(u.searchParams.get('offset') || '0', 10);
    const project = u.searchParams.get('project') || '';
    let events = d.events.events || [];
    if (project) events = events.filter(e => (e.project || '').toLowerCase().includes(project.toLowerCase()));
    return { events: events.slice(offset, offset + limit), total: events.length };
  }

  if (u.pathname === '/api/search') {
    const query = u.searchParams.get('q') || '';
    if (!query.trim()) return EMPTY_SEARCH;
    // Exact match only — don't silently return a different query's results
    const key = query.toLowerCase().trim();
    if (d.results[key]) return d.results[key];
    // No match — return empty with a hint
    return { ...EMPTY_SEARCH, meta: { ...EMPTY_SEARCH.meta, query, demo_miss: true } };
  }

  if (u.pathname === '/api/autocomplete') {
    const prefix = (u.searchParams.get('prefix') || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    if (prefix.length === 0) {
      // On focus: show all available queries
      return { suggestions: d.queries.map(q => q.query), isQueryList: true };
    }
    if (prefix.length === 1) {
      // After 1 char: filter available queries + word completions
      const queryMatches = d.queries
        .filter(q => q.query.toLowerCase().startsWith(prefix))
        .map(q => q.query);
      const wordMatches = (d.ac.autocomplete[prefix] || []).slice(0, 4);
      return { suggestions: [...queryMatches, ...wordMatches].slice(0, 8) };
    }
    return { suggestions: d.ac.autocomplete[prefix] || [] };
  }

  if (u.pathname === '/api/coterms') {
    const term = (u.searchParams.get('term') || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    return { terms: d.ac.coterms[term] || [] };
  }

  if (u.pathname === '/api/projects') {
    return d.projects;
  }

  if (u.pathname === '/api/sessions') {
    return d.sessions;
  }

  if (u.pathname === '/api/transcript') {
    return { path: '', messages: [], total: 0 };
  }

  if (u.pathname === '/api/transcript/analysis') {
    return { summary: null, attribution: null, compactionEvents: [], perMessageCategory: {} };
  }

  return {};
}

export function getQueries() {
  return cache?.queries || [];
}
