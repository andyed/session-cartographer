// hybridSearch fuses BM25 over the index it is handed with a semantic leg that
// queries a live Qdrant. These tests hand it a six-event fixture, so a running
// Qdrant leaks real corpus ids into the assertions — the suite passed wherever
// the service was down and failed wherever it was up. Pin the leg off.
process.env.CARTOGRAPHER_SEMANTIC = '0';

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildIndex } from '../../explorer/server/bm25.js';
import { CORPUS_ROOT } from '../../explorer/server/jsonl.js';
import { executeRecall } from '../../explorer/server/recall.js';
import { readFileSync } from 'node:fs';
import { RECALL_LIMIT_MAX, RECALL_PROJECT_MAX, RecallContractError, validateRecallResponse } from '../../explorer/server/recall-contract.js';

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

// cartographer-feed.sh fans out over every active project and clamps its own
// search limit to 200. The contract's original ceiling of 100 rejected that
// request outright, so every daily feed run since Turbo shipped fell back to
// the ~11 s portable search — the fallback made it invisible, not harmless.
// The ceiling has to admit the callers that actually exist.
test('the feed\'s maximum fan-out limit is inside the contract ceiling', async () => {
  const feedScript = readFileSync(new URL('../../scripts/cartographer-feed.sh', import.meta.url), 'utf8');
  const clamp = feedScript.match(/search_limit" -le (\d+) \] \|\| search_limit=(\d+)/);
  assert.ok(clamp, 'cartographer-feed.sh no longer clamps its search limit in a recognizable form');
  assert.equal(clamp[1], clamp[2], 'feed clamp bound and assignment disagree');
  assert.ok(
    Number(clamp[1]) <= RECALL_LIMIT_MAX,
    `feed requests up to ${clamp[1]} results but the recall ceiling is ${RECALL_LIMIT_MAX}`,
  );

  const events = fixture();
  const response = await executeRecall(
    { events, index: buildIndex(events) },
    request({ limit: Number(clamp[1]), purpose: 'feed' }),
  );
  validateRecallResponse(response);
});

test('a limit above the ceiling is rejected rather than silently clamped', async () => {
  const events = fixture();
  await assert.rejects(
    executeRecall({ events, index: buildIndex(events) }, request({ limit: RECALL_LIMIT_MAX + 1 })),
    (error) => error instanceof RecallContractError && error.status === 400,
  );
});

// The result ceiling was only the first of two blockers. `project` carries a
// pipe-delimited alternation of every alias in the caller's allowlist, and the
// real daily feed packs to 576 characters against an original 512 cap — so it
// still failed the contract, on a different field, and still fell back to the
// ~11 s portable search. Pin the whole registry's packed width against the cap
// so registry growth fails here rather than silently degrading the feed.
test('the full project registry packs inside the contract project cap', async () => {
  const registry = JSON.parse(
    readFileSync(new URL('../../project-registry.json', import.meta.url), 'utf8'),
  );
  const names = new Set();
  for (const [alias, expansions] of Object.entries(registry.aliases || {})) {
    names.add(alias);
    for (const name of expansions) names.add(name);
  }
  const packed = [...names].sort().join('|');
  assert.ok(names.size > 0, 'project-registry.json exposed no aliases');
  assert.ok(
    packed.length <= RECALL_PROJECT_MAX,
    `registry packs to ${packed.length} chars but the contract cap is ${RECALL_PROJECT_MAX}`,
  );

  const events = fixture();
  const response = await executeRecall(
    { events, index: buildIndex(events) },
    request({ project: `${packed}|beta`, purpose: 'feed' }),
  );
  validateRecallResponse(response);
  assert.deepEqual(response.results.map((row) => row.event_id), ['evt-beta']);
});

// The warm service is reached by a fixed loopback port but indexes exactly one
// corpus, chosen when it spawned. A caller that pointed CARTOGRAPHER_DEV_DIR at
// a different corpus was answered from the shared one and had no way to tell —
// which read as authoritative results for a corpus that was never searched.
test('a request naming a different corpus is refused, not silently answered', async () => {
  const events = fixture();
  await assert.rejects(
    executeRecall(
      { events, index: buildIndex(events) },
      request({ corpus_root: '/tmp/some-other-corpus' }),
    ),
    (error) => error instanceof RecallContractError && error.status === 409,
  );
});

test('a request naming this corpus, or naming none, is served', async () => {
  const events = fixture();
  const index = buildIndex(events);
  const matching = await executeRecall({ events, index }, request({ corpus_root: CORPUS_ROOT }));
  validateRecallResponse(matching);
  const unstated = await executeRecall({ events, index }, request());
  validateRecallResponse(unstated);
  assert.deepEqual(
    matching.results.map((row) => row.event_id),
    unstated.results.map((row) => row.event_id),
  );
});

// ~/.claude/history.jsonl and two legacy backfills put 20,544 id-less rows in
// the warm index — 16% of it. One of them in a result set failed response
// validation at the client, which threw away the whole answer and fell back to
// the ~11 s portable search. A result with no id also cannot be fetched,
// touched, or threaded, so it could never finish the workflow it interrupted.
test('results without an event_id never reach the response', async () => {
  // bm25.js synthesizes a document id for an id-less event, so it is indexed and
  // returned with no event_id on the event itself. Enough non-matching filler to
  // keep the probe term's IDF positive, or nothing scores at all.
  const events = [];
  for (let i = 0; i < 60; i++) {
    events.push({
      event_id: `evt-filler-${i}`,
      timestamp: '2026-08-20T12:00:00Z',
      project: 'noise',
      summary: `unrelated maintenance chore ${i}`,
    });
  }
  events.push({ event_id: 'evt-identified', timestamp: '2026-08-31T12:00:00Z', project: 'alpha', summary: 'zebraprobe identified row' });
  events.push({ _source: 'claude-history', timestamp: '2026-08-31T11:00:00Z', project: 'alpha', summary: 'zebraprobe history row with no id' });
  events.push({ event_id: '', _source: 'research', timestamp: '2026-08-31T10:00:00Z', project: 'alpha', summary: 'zebraprobe legacy row empty id' });

  const response = await executeRecall({ events, index: buildIndex(events) }, request({ query: 'zebraprobe' }));
  validateRecallResponse(response);
  assert.ok(
    response.results.some((row) => row.event_id === 'evt-identified'),
    'the identified match should still be served',
  );
  assert.ok(
    response.results.every((row) => typeof row.event_id === 'string' && row.event_id !== ''),
    'an id-less result reached the client and would invalidate the whole response',
  );
  assert.equal(response.meta.unidentified_count, 2, 'both id-less rows must be counted, not silently lost');
});
