// The semantic leg asks Qdrant for FUSION_DEPTH (500) nearest points. Without a
// time bound in the query those 500 are the nearest in the *whole* corpus, and
// the client-side window then keeps only whichever happen to land inside it —
// for a 24h slice of a 109k-point collection that measured 0 of 500, so the
// semantic ladder contributed nothing to short-window recall while every stage
// reported success. These tests pin the bound into the request and pin the
// degradation path that keeps an older Qdrant working.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildIndex } from '../../explorer/server/bm25.js';

const QDRANT_CALL = /\/points\/search$/;

// Stub the two services hybridSearch reaches. `mode` decides how the server
// answers a request carrying a range clause: 'ok' accepts it, '400' rejects it
// the way a server without datetime range support would, '503' is Qdrant being
// unwell.
function stubFetch(mode) {
  const filters = [];
  globalThis.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    if (String(url).includes('/embeddings')) {
      return { ok: true, json: async () => ({ data: [{ embedding: [0.1, 0.2, 0.3] }] }) };
    }
    assert.match(String(url), QDRANT_CALL);
    filters.push(body.filter ?? null);
    if (JSON.stringify(body.filter ?? {}).includes('"range"') && mode !== 'ok') {
      return { ok: false, status: mode === '400' ? 400 : 503, json: async () => ({}) };
    }
    return {
      ok: true,
      json: async () => ({
        result: [{
          score: 0.9,
          payload: {
            event_id: 'sem-1', timestamp: '2026-09-08T12:00:00Z',
            project: 'p', summary: 'semantic hit', salience: 0.9,
          },
        }],
      }),
    };
  };
  return filters;
}

// A real index holding the project under test. It must not be empty: the
// semantic filter now resolves `project` against the values actually present,
// so an empty index with a project scope correctly resolves to "nothing in
// scope" and short-circuits before Qdrant is ever called.
const INDEX = buildIndex([
  { event_id: 'seed', timestamp: '2026-09-08T12:00:00Z', project: 'p', summary: 'seed document' },
]);
const SINCE = Date.parse('2026-09-08T00:00:00Z');
const BEFORE = Date.parse('2026-09-09T00:00:00Z');

async function search(opts) {
  // Import fresh each time: search.js reads the env opt-out at call time, but
  // the stub has to be installed before the module issues any request.
  const { hybridSearch } = await import('../../explorer/server/search.js');
  return hybridSearch(INDEX, 'q', opts);
}

test('the time window is pushed into the Qdrant query, not applied to its answer', async () => {
  const filters = stubFetch('ok');
  await search({ project: 'p', sinceMs: SINCE, beforeMs: BEFORE });

  assert.equal(filters.length, 1, 'one Qdrant call when the server accepts the range');
  const clauses = filters[0].must;
  const range = clauses.find((c) => c.key === 'timestamp')?.range;
  assert.ok(range, 'the timestamp range clause must reach Qdrant');
  // RFC3339 UTC — Qdrant parses these chronologically, which is what makes the
  // ~2% of payloads carrying non-UTC offsets compare correctly.
  assert.equal(range.gte, '2026-09-08T00:00:00.000Z');
  assert.equal(range.lte, '2026-09-09T00:00:00.000Z');
  assert.ok(clauses.some((c) => c.key === 'project'), 'the project clause must survive alongside it');
});

test('an unwindowed query carries no range clause', async () => {
  const filters = stubFetch('ok');
  await search({ project: 'p' });
  assert.equal(JSON.stringify(filters[0]).includes('range'), false);
});

test('a server that rejects the range clause is retried without it', async () => {
  const filters = stubFetch('400');
  const res = await search({ project: 'p', sinceMs: SINCE });

  assert.equal(filters.length, 2, 'the 4xx must be retried');
  assert.ok(JSON.stringify(filters[0]).includes('range'));
  assert.equal(JSON.stringify(filters[1]).includes('range'), false, 'the retry drops only the range');
  assert.ok(JSON.stringify(filters[1]).includes('project'), 'the retry keeps the project filter');
  // Degraded, not dropped: the client-side window still trims these, which is
  // the pre-pushdown behaviour rather than a missing semantic leg.
  assert.equal(res.semanticStatus, 'available');
  assert.equal(res.items.length, 1);
});

test('an unhealthy Qdrant is not retried', async () => {
  const filters = stubFetch('503');
  const res = await search({ project: 'p', sinceMs: SINCE });

  assert.equal(filters.length, 1, 'a 5xx retry would only cost latency');
  assert.equal(res.semanticStatus, 'unavailable');
});

test('the client-side window still trims what the pushdown lets through', async () => {
  // The stub returns a 2026-09-08 point regardless of the filter, so a window
  // that excludes it proves the backstop is still load-bearing.
  stubFetch('ok');
  const res = await search({ project: 'p', sinceMs: Date.parse('2026-09-10T00:00:00Z') });
  assert.equal(res.items.length, 0);
});
