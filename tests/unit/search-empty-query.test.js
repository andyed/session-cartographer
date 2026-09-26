// A query that tokenizes to nothing, or a search over an empty index, is an
// answer of zero results, not a server error. scoreBM25's early exits returned
// a bare [] after its result became { items, total }, and hybridSearch threw
// "Cannot read properties of undefined (reading 'filter')" from /api/search.
process.env.CARTOGRAPHER_SEMANTIC = '0';
process.env.CARTOGRAPHER_ACCESS_LEDGER = '/dev/null';
for (const name of ['CARTOGRAPHER_SESSION_ID', 'CLAUDE_SESSION_ID', 'CLAUDE_CODE_SESSION_ID', 'CODEX_SESSION_ID']) delete process.env[name];

import test from 'node:test';
import assert from 'node:assert/strict';

const { buildIndex, scoreBM25, tokenize } = await import('../../explorer/server/bm25.js');
const { hybridSearch } = await import('../../explorer/server/search.js');

// Pad with non-matching documents: BM25 clamps a term held by over half the
// corpus to zero, which would make the control below pass for the wrong reason.
const events = ['melody shuffle', 'shader palette', 'turbo facts', 'cursor dynamics'].map((summary, i) => ({
  event_id: `e${i}`, timestamp: '2026-09-26T12:00:00Z', project: 'p', type: 'tool_bash', summary,
}));

test('queries with no letters or digits return no results instead of throwing', async () => {
  const index = buildIndex(events);
  for (const query of ['!!!', '   ', '日本語', '—']) {
    assert.deepEqual(tokenize(query), [], `fixture: "${query}" must tokenize to nothing to reach the early exit`);
    assert.deepEqual(scoreBM25(index, query), { items: [], total: 0 });
    const result = await hybridSearch(index, query);
    assert.deepEqual(result.items, [], `"${query}"`);
  }
});

test('an empty index returns no results instead of throwing', async () => {
  const empty = buildIndex([]);
  assert.equal(empty.docs.size, 0);
  assert.deepEqual(scoreBM25(empty, 'melody'), { items: [], total: 0 });
  assert.deepEqual((await hybridSearch(empty, 'melody')).items, []);
});

test('control: the same query shape still finds a matching document', async () => {
  const result = await hybridSearch(buildIndex(events), 'melody');
  assert.deepEqual(result.items.map((item) => item.event_id), ['e0']);
});
