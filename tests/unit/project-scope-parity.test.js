// Every stage scopes `--project` by case-insensitive substring so a family name
// selects its repositories — except Qdrant, whose match:{value} is exact
// equality. The two ladders therefore disagreed about what the scope meant:
// `--project psycho` reached the keyword ladder as the whole psychodeli family
// and the semantic ladder as a literal string matching nothing, and /api/recall
// does the same for a bare `psychodeli` because it performs no registry
// expansion. Measured on the live corpus: exact `psychodeli` = 0 points,
// `psychodeli-webgl-port` = 9,943. Nothing errored; the ladder was just absent.
process.env.CARTOGRAPHER_SEMANTIC = '0';

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildIndex, projectMatcher, scoreBM25 } from '../../explorer/server/bm25.js';
import { resolveProjectValues } from '../../explorer/server/search.js';

const FAMILY = ['psychodeli-webgl-port', 'psychodeli-plus-tvos', 'psychodeli-metal'];

function corpus() {
  const events = [];
  FAMILY.forEach((project, i) => {
    events.push({ event_id: `p-${i}`, timestamp: '2026-09-08T12:00:00Z', project, summary: 'shader palette widget' });
  });
  events.push({ event_id: 'other', timestamp: '2026-09-08T12:00:00Z', project: 'session-cartographer', summary: 'shader palette widget' });
  for (let i = 0; i < 40; i++) {
    events.push({ event_id: `n-${i}`, timestamp: '2026-09-08T12:00:00Z', project: 'noise', summary: 'unrelated glacier lantern' });
  }
  return events;
}

test('a family prefix resolves to the concrete project values present', () => {
  const index = buildIndex(corpus());
  assert.deepEqual(resolveProjectValues(index, 'psychodeli').sort(), [...FAMILY].sort());
  assert.deepEqual(resolveProjectValues(index, 'psycho').sort(), [...FAMILY].sort());
  // A substring that spans no project name selects nothing — an answer, not a failure.
  assert.deepEqual(resolveProjectValues(index, 'zzz-no-such-project'), []);
});

test('an exact project name still resolves to exactly itself', () => {
  const index = buildIndex(corpus());
  assert.deepEqual(resolveProjectValues(index, 'psychodeli-webgl-port'), ['psychodeli-webgl-port']);
});

test('a pipe-delimited alias list resolves to the union', () => {
  const index = buildIndex(corpus());
  const got = resolveProjectValues(index, 'psychodeli-metal|session-cartographer').sort();
  assert.deepEqual(got, ['psychodeli-metal', 'session-cartographer']);
});

test('the resolved scope is exactly the scope the keyword ladder used', () => {
  // The parity that was broken: whatever the BM25 pass accepted, the semantic
  // filter must name. If these ever diverge, one ladder is searching a corpus
  // the other cannot see.
  const index = buildIndex(corpus());
  for (const spec of ['psychodeli', 'psycho', 'psychodeli-webgl-port', 'noise']) {
    const keyword = new Set(
      scoreBM25(index, 'shader palette widget glacier lantern', { project: spec })
        .items.map((it) => it.event.project),
    );
    const resolved = new Set(resolveProjectValues(index, spec));
    for (const project of keyword) {
      assert.ok(resolved.has(project), `${spec}: keyword matched ${project}, semantic filter would not name it`);
    }
  }
});

test('projectMatcher is the one predicate, and an empty spec scopes to everything', () => {
  const matches = projectMatcher('psychodeli');
  assert.equal(matches('psychodeli-webgl-port'), true);
  assert.equal(matches('PSYCHODELI-Metal'), true, 'matching is case-insensitive');
  assert.equal(matches('session-cartographer'), false);
  assert.equal(matches(''), false, 'an event with no project is not in any scope');
  assert.equal(projectMatcher('')('anything'), true);
});
