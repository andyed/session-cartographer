// demo.js — Static data layer for GH Pages demo.
// Loaded lazily only when VITE_DEMO=true.

import { activityFromMemory, projectMemoryScope } from '../shared/activity-scope.js';

const BASE = import.meta.env.BASE_URL || '/';

let cache = null;

async function load() {
  if (cache) return cache;

  const [queries, ac, sessions, events, projects] = await Promise.all([
    fetch(`${BASE}demo/demo/queries.json`).then(r => r.json()),
    fetch(`${BASE}demo/demo/autocomplete.json`).then(r => r.json()),
    fetch(`${BASE}demo/demo/sessions.json`).then(r => r.json()),
    fetch(`${BASE}demo/demo/events.json`).then(r => r.json()),
    fetch(`${BASE}demo/demo/projects.json`).then(r => r.json()),
  ]);

  const results = {};
  for (const q of queries) {
    results[q.query.toLowerCase()] = await fetch(`${BASE}demo/demo/results/${q.id}.json`).then(r => r.json());
  }

  cache = { queries, ac, sessions, events, projects, results };
  return cache;
}

// The complete bounded evidence fixture is loaded separately and only the
// memory/activity views pay for it.
let memoryCache = null;
async function loadMemory() {
  if (!memoryCache) memoryCache = fetch(`${BASE}demo/demo/memory/state.json`).then(r => r.json());
  return memoryCache;
}

class DemoError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

function demoTime(value, fallback, label) {
  if (!value) return fallback;
  const parsed = /^\d{13}$/.test(value) ? Number(value) : Date.parse(value);
  if (!Number.isFinite(parsed)) throw new DemoError(`Invalid demo ${label}.`, 400);
  return parsed;
}

function demoList(params, name) {
  return params.getAll(name).flatMap(value => value.split(',')).map(value => value.trim()).filter(Boolean);
}

function demoScope(params, field, from = null, through = null) {
  const legacyEnd = demoTime(params.get('end'), field.end, 'window end');
  const legacyHours = Number(params.get('hours') || field.windowHours || 24);
  if (!Number.isFinite(legacyHours) || legacyHours <= 0) throw new DemoError('Invalid demo window hours.', 400);
  const scope = {
    from: from ?? demoTime(params.get('from'), legacyEnd - legacyHours * 60 * 60 * 1000, 'scope start'),
    through: through ?? demoTime(params.get('through'), legacyEnd, 'scope end'),
    lower: params.get('lower') === 'open' ? 'open' : 'closed',
    project: params.get('project') || '',
    providers: demoList(params, 'provider'),
    evidence: demoList(params, 'evidence'),
    brush: demoList(params, 'brush'),
    q: params.get('q') || '',
    result: params.get('result') || 'tasks',
    kind: params.get('kind') || 'all',
  };
  if (scope.from > scope.through) throw new DemoError('Demo scope start must not be later than its end.', 400);
  return scope;
}

function demoActivity(field, params) {
  const focus = demoScope(params, field);
  const contextFrom = demoTime(params.get('contextFrom'), focus.from, 'context start');
  const contextThrough = demoTime(params.get('contextThrough'), focus.through, 'context end');
  if (contextFrom > focus.from || contextThrough < focus.through) throw new DemoError('Demo context must contain the focus interval.', 400);
  const context = projectMemoryScope(field, { ...focus, from: contextFrom, through: contextThrough });
  if (params.get('shape') === 'context') return {
    source: context.source,
    coverage: context.coverage,
    context,
  };
  const focused = projectMemoryScope(field, focus);
  const complete = activityFromMemory(focused);
  const limit = Number(params.get('limit') || 200);
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new DemoError('Demo activity limit must be between 1 and 500.', 400);
  const rawCursor = params.get('cursor') || '';
  const cursorPrefix = `demo:${focused.sourceRevision}:${encodeURIComponent(JSON.stringify(focused.scope))}:`;
  const offsetText = rawCursor.startsWith(cursorPrefix) ? rawCursor.slice(cursorPrefix.length) : '';
  if (rawCursor && !/^\d+$/.test(offsetText)) throw new DemoError('Demo activity cursor belongs to a different fixture revision or scope.', 409);
  const offset = offsetText ? Number(offsetText) : 0;
  const events = complete.events.slice(offset, offset + limit);
  const nextOffset = offset + events.length;
  return {
    scope: focused.scope, source: focused.source, coverage: focused.coverage, context, focused,
    activity: {
      ...complete, events, cursor: rawCursor || null,
      nextCursor: nextOffset < complete.events.length ? `${cursorPrefix}${nextOffset}` : null,
    },
  };
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

  // ─── Working memory ───
  // The field is a frozen fixture derived from demo/sessions.json. Exact
  // ranges project that fixture locally; an empty interval remains visibly
  // outside/partial coverage rather than snapping back to the busy day.

  if (u.pathname === '/api/turbo/status') {
    // Turbo is the live warm-corpus service. The static demo has no service to
    // report on, so it reports the one thing the view acts on — the field is
    // readable — and says plainly that this is the demo, not a running host.
    return { ready: true, demo: true, enabled: true, running: true, error: '' };
  }

  if (u.pathname === '/api/turbo/start') {
    // Unreachable while status reports ready with no pending action, so the
    // launch button never renders. Handled anyway: the alternative to a stated
    // refusal is a 404 against the GH Pages host, which surfaces as a
    // connection error and invites the viewer to retry something that can
    // never succeed.
    throw new DemoError('The static demo has no Turbo service to start.', 400);
  }

  if (u.pathname === '/api/memory/state') {
    const { field } = await loadMemory();
    return projectMemoryScope(field, demoScope(u.searchParams, field));
  }

  if (u.pathname === '/api/memory/activity' || u.pathname === '/api/activity-scope') {
    const { field } = await loadMemory();
    return demoActivity(field, u.searchParams);
  }

  if (u.pathname === '/api/memory/session') {
    const id = u.searchParams.get('session');
    if (!id) throw new DemoError('A session id is required.', 400);
    const { field } = await loadMemory();
    if (!field.sessions.some(session => session.id === id)) {
      throw new DemoError('This session has no recorded activity in the demo window.', 404);
    }
    return field;
  }

  if (u.pathname === '/api/memory/file') {
    // reviewFile() reads real file contents off the corpus. Nothing stands in
    // for that statically, and no demo session resolves any files anyway, so
    // this says so rather than inventing a diff.
    throw new DemoError('File review is not included in the static demo.', 404);
  }

  if (u.pathname === '/api/memory/recall' || u.pathname === '/api/memory/recall/call') {
    // The fixture carries no served log or access ledger. The views skip these
    // requests in demo mode; an empty {} here would read as "no recall happened".
    throw new DemoError('Recall telemetry is not included in the static demo.', 404);
  }

  return {};
}

export function getQueries() {
  return cache?.queries || [];
}

// Which comparison axes the shipped fixture can support. Derived at build time
// from the fixture itself, so regenerating a denser demo corpus lights the
// remaining axes up without a second edit here.
export async function getMemoryAxes() {
  return (await loadMemory()).axes || [];
}
