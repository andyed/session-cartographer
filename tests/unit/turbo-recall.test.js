import test from 'node:test';
import assert from 'node:assert/strict';
import { buildIndex } from '../../explorer/server/bm25.js';
import { executeRecall } from '../../explorer/server/recall.js';
import { RecallContractError, validateRecallResponse } from '../../explorer/server/recall-contract.js';

function fixture() {
  return [
    { event_id: 'evt-alpha', timestamp: '2026-08-30T12:00:00Z', project: 'alpha', summary: 'globalturbo recall contract', salience: 0.8 },
    { event_id: 'evt-beta', timestamp: '2026-08-29T12:00:00Z', project: 'beta', summary: 'globalturbo alternate project', salience: 0.7 },
    { event_id: 'evt-noise-1', timestamp: '2026-08-28T12:00:00Z', project: 'noise', summary: 'unrelated glacier notebook' },
    { event_id: 'evt-noise-2', timestamp: '2026-08-27T12:00:00Z', project: 'noise', summary: 'unrelated copper lantern' },
    { event_id: 'evt-noise-3', timestamp: '2026-08-26T12:00:00Z', project: 'noise', summary: 'unrelated meadow compass' },
    { event_id: 'evt-noise-4', timestamp: '2026-08-25T12:00:00Z', project: 'noise', summary: 'unrelated river telescope' },
  ];
}

function request(overrides = {}) {
  return {
    contract_version: 1,
    call_id: 'call-test',
    query: 'globalturbo',
    project: '',
    since: '',
    before: '',
    limit: 10,
    purpose: 'remember',
    session_id: 'session-test',
    provider: 'codex',
    excluded_event_ids: [],
    ...overrides,
  };
}

test('recall contract returns a versioned Explorer result set', async () => {
  const events = fixture();
  const response = await executeRecall({ events, index: buildIndex(events) }, request());
  validateRecallResponse(response);
  assert.equal(response.backend, 'explorer');
  assert.deepEqual(response.results.map((row) => row.event_id), ['evt-alpha', 'evt-beta']);
  assert.equal(typeof response.stages_ms.total, 'number');
  assert.equal(response.meta.excluded_count, 0);
});

test('exclusions apply before the final result window', async () => {
  const events = fixture();
  const response = await executeRecall(
    { events, index: buildIndex(events) },
    request({ limit: 1, excluded_event_ids: ['evt-alpha'] }),
  );
  assert.deepEqual(response.results.map((row) => row.event_id), ['evt-beta']);
  assert.equal(response.meta.excluded_count, 1);
});

test('pipe-expanded project aliases are accepted by the warm index', async () => {
  const events = fixture();
  const response = await executeRecall(
    { events, index: buildIndex(events) },
    request({ project: 'missing|beta' }),
  );
  assert.deepEqual(response.results.map((row) => row.event_id), ['evt-beta']);
});

test('event ids remain searchable when an event also has a summary', async () => {
  const events = fixture();
  const response = await executeRecall(
    { events, index: buildIndex(events) },
    request({ query: 'alpha' }),
  );
  assert.deepEqual(response.results.map((row) => row.event_id), ['evt-alpha']);
});

test('unsupported contract versions fail instead of being guessed', async () => {
  const events = fixture();
  await assert.rejects(
    executeRecall({ events, index: buildIndex(events) }, request({ contract_version: 2 })),
    (error) => error instanceof RecallContractError && error.status === 409,
  );
});
