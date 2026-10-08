// The semantic leg filters every query on `project` and `timestamp`. Without
// payload indexes Qdrant scans payloads for those filters: 200-420 ms per
// filtered search on 157k points against 4-16 ms indexed (2026-10-07,
// Qdrant 1.12.1). The indexes were created by hand that day; nothing in the
// repo created them, so a fresh install or a rebuilt collection lost them and
// every stage still reported success. These tests pin the bootstrap: a fresh
// collection issues both index requests, an unindexed existing collection
// gets them without a reindex, and an indexed one issues no writes at all.
process.env.CARTOGRAPHER_SEMANTIC = '0';

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ensureCollection,
  ensurePayloadIndexes,
  missingPayloadIndexes,
  PAYLOAD_INDEXES,
} from '../../scripts/qdrant-collection.js';

const URL_BASE = 'http://qdrant.test';
const NAME = 'fixture-collection';

// A Qdrant stand-in with just enough state to answer the bootstrap: whether
// the collection exists and which payload fields it indexes. Every request is
// recorded so a test can assert on composition (which writes went out, in
// what order), not on "it returned".
function fakeQdrant({ exists = true, schema = {}, refuseIndex = null } = {}) {
  const state = { exists, schema: { ...schema } };
  const calls = [];
  const fetch = async (url, opts = {}) => {
    const method = opts.method || 'GET';
    const body = opts.body ? JSON.parse(opts.body) : null;
    calls.push({ method, url: String(url), body });
    const collectionUrl = `${URL_BASE}/collections/${NAME}`;
    if (url === collectionUrl && method === 'GET') {
      if (!state.exists) return { ok: false, status: 404, text: async () => 'not found' };
      return { ok: true, status: 200, json: async () => ({ result: { status: 'green', payload_schema: state.schema } }) };
    }
    if (url === collectionUrl && method === 'PUT') {
      state.exists = true;
      state.schema = {};
      return { ok: true, status: 200, json: async () => ({ result: true }) };
    }
    if (url === collectionUrl && method === 'DELETE') {
      state.exists = false;
      state.schema = {};
      return { ok: true, status: 200, json: async () => ({ result: true }) };
    }
    if (url === `${collectionUrl}/index` && method === 'PUT') {
      if (refuseIndex && body.field_name === refuseIndex) {
        return { ok: false, status: 400, text: async () => `Index type ${body.field_schema} unsupported` };
      }
      state.schema[body.field_name] = { data_type: body.field_schema, points: 0 };
      return { ok: true, status: 200, json: async () => ({ result: { status: 'acknowledged' } }) };
    }
    throw new Error(`unexpected request ${method} ${url}`);
  };
  return { state, calls, fetch };
}

const opts = (q, extra = {}) => ({ qdrantUrl: URL_BASE, collection: NAME, fetch: q.fetch, ...extra });
const indexWrites = (calls) => calls.filter((c) => c.method === 'PUT' && c.url.endsWith('/index')).map((c) => c.body);
const writes = (calls) => calls.filter((c) => c.method !== 'GET');

test('a fresh collection is created and then indexed on project and timestamp', async () => {
  const q = fakeQdrant({ exists: false });
  const result = await ensureCollection(opts(q));

  assert.equal(result.created_collection, true);
  assert.deepEqual(writes(q.calls).map((c) => [c.method, c.url.slice(URL_BASE.length)]), [
    ['PUT', `/collections/${NAME}`],
    ['PUT', `/collections/${NAME}/index`],
    ['PUT', `/collections/${NAME}/index`],
  ], 'collection first, then exactly one index request per field');
  assert.deepEqual(indexWrites(q.calls), [
    { field_name: 'project', field_schema: 'keyword' },
    { field_name: 'timestamp', field_schema: 'datetime' },
  ]);
  assert.deepEqual(result.indexes.created, ['project', 'timestamp']);
  // The thing the task is about: the collection ends up with both indexes.
  assert.equal(q.state.schema.project.data_type, 'keyword');
  assert.equal(q.state.schema.timestamp.data_type, 'datetime');
  assert.deepEqual(missingPayloadIndexes({ result: { payload_schema: q.state.schema } }), []);
});

test('an existing unindexed collection gets both indexes without a reindex', async () => {
  const q = fakeQdrant({ exists: true });
  const result = await ensurePayloadIndexes(opts(q));

  assert.equal(writes(q.calls).some((c) => c.url === `${URL_BASE}/collections/${NAME}`), false,
    'the collection is neither deleted nor recreated');
  assert.deepEqual(indexWrites(q.calls), [
    { field_name: 'project', field_schema: 'keyword' },
    { field_name: 'timestamp', field_schema: 'datetime' },
  ]);
  assert.deepEqual(result, { collection: NAME, present: [], created: ['project', 'timestamp'], failed: [] });
});

test('only the missing index is created when one already exists', async () => {
  const q = fakeQdrant({ schema: { project: { data_type: 'keyword', points: 10 } } });
  const result = await ensurePayloadIndexes(opts(q));

  assert.deepEqual(indexWrites(q.calls), [{ field_name: 'timestamp', field_schema: 'datetime' }]);
  assert.deepEqual(result.present, ['project']);
  assert.deepEqual(result.created, ['timestamp']);
});

test('an indexed collection issues no writes: re-running bootstrap is a no-op', async () => {
  const q = fakeQdrant({
    schema: {
      project: { data_type: 'keyword', points: 10 },
      timestamp: { data_type: 'datetime', points: 10 },
    },
  });
  const result = await ensurePayloadIndexes(opts(q));

  assert.deepEqual(writes(q.calls), [], 'every request was a read');
  assert.deepEqual(result.present, PAYLOAD_INDEXES.map((ix) => ix.field));
  assert.deepEqual(result.created, []);

  // ensureCollection on the same state is equally silent.
  const again = await ensureCollection(opts(q));
  assert.equal(again.created_collection, false);
  assert.deepEqual(writes(q.calls), []);
});

test('a field indexed under the wrong schema counts as missing', () => {
  const info = { result: { payload_schema: {
    project: { data_type: 'text' },
    timestamp: { data_type: 'datetime' },
  } } };
  assert.deepEqual(missingPayloadIndexes(info).map((ix) => ix.field), ['project']);
  assert.deepEqual(missingPayloadIndexes({ result: {} }).map((ix) => ix.field), ['project', 'timestamp']);
  assert.deepEqual(missingPayloadIndexes(null).map((ix) => ix.field), ['project', 'timestamp']);
});

test('a refused index build is reported on the lenient path and thrown on the strict one', async () => {
  // A Qdrant older than 1.8 has no datetime index. The hook path must still
  // index its event; the batch indexer must not proceed as if it succeeded.
  const lenient = fakeQdrant({ refuseIndex: 'timestamp' });
  const result = await ensurePayloadIndexes(opts(lenient));
  assert.deepEqual(result.created, ['project']);
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].field, 'timestamp');
  assert.match(result.failed[0].error, /^400 /);

  const strict = fakeQdrant({ refuseIndex: 'timestamp' });
  await assert.rejects(ensureCollection(opts(strict)), /payload index timestamp \(datetime\): 400/);
});

test('--recreate deletes, recreates, and re-indexes', async () => {
  const q = fakeQdrant({
    schema: {
      project: { data_type: 'keyword', points: 10 },
      timestamp: { data_type: 'datetime', points: 10 },
    },
  });
  const result = await ensureCollection(opts(q, { recreate: true }));

  assert.equal(result.created_collection, true);
  assert.deepEqual(writes(q.calls).map((c) => c.method), ['DELETE', 'PUT', 'PUT', 'PUT']);
  assert.deepEqual(result.indexes.created, ['project', 'timestamp']);
  assert.equal(q.state.schema.timestamp.data_type, 'datetime');
});

test('a missing collection is an error for the index-only path, not a silent success', async () => {
  const q = fakeQdrant({ exists: false });
  await assert.rejects(ensurePayloadIndexes(opts(q)), /does not exist/);
  assert.deepEqual(writes(q.calls), []);
});
