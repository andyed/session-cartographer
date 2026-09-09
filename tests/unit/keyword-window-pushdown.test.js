// hybridSearch truncates the BM25 ladder to FUSION_DEPTH (500) before fusing.
// Windowing the ladder after that truncation keeps the 500 globally best
// matches and then asks which fall inside the window — so a short window over a
// busy corpus arrives at fusion with far fewer rows than the window actually
// holds, or none. These tests pin the filter ahead of the truncation, and pin
// that doing so does not disturb the scores of the rows that survive.
//
// The semantic leg pulls a live Qdrant; this file is about the keyword leg.
process.env.CARTOGRAPHER_SEMANTIC = '0';

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildIndex, scoreBM25, epochMsFromTimestamp } from '../../explorer/server/bm25.js';
import { hybridSearch } from '../../explorer/server/search.js';

const DAY = 86_400_000;
const NOW = Date.parse('2026-09-08T12:00:00Z');
const SINCE = NOW - DAY;

// BM25 clamps a term whose df exceeds about half the corpus (idf goes negative),
// so a fixture where every document matches scores zero across the board. Pad
// with non-matching documents to keep "widget" discriminating.
function noise(count, events) {
  for (let i = 0; i < count; i++) {
    events.push({
      event_id: `noise-${i}`,
      timestamp: new Date(NOW - 60 * DAY - i * 1000).toISOString(),
      project: 'p',
      summary: 'unrelated glacier lantern meadow compass',
    });
  }
}

// 600 out-of-window documents that match, plus 5 in-window ones. The
// out-of-window rows repeat the term, so they outrank every in-window row:
// truncating to 500 before windowing would discard the entire window.
function corpus() {
  const events = [];
  for (let i = 0; i < 600; i++) {
    events.push({
      event_id: `old-${i}`,
      timestamp: new Date(NOW - 30 * DAY - i * 1000).toISOString(),
      project: 'p',
      summary: 'widget widget widget widget widget',
    });
  }
  for (let i = 0; i < 5; i++) {
    events.push({
      event_id: `new-${i}`,
      timestamp: new Date(NOW - i * 60_000).toISOString(),
      project: 'p',
      summary: 'widget widget mentioned here',
    });
  }
  noise(1500, events);
  return events;
}

test('the window is applied before the BM25 ladder is truncated', () => {
  const index = buildIndex(corpus());

  const unwindowed = scoreBM25(index, 'widget', { project: 'p' });
  const inWindowRank = unwindowed.items.findIndex((it) => it.id.startsWith('new-'));
  assert.ok(inWindowRank >= 500,
    `the fixture must put in-window rows past FUSION_DEPTH (got rank ${inWindowRank})`);

  const windowed = scoreBM25(index, 'widget', { project: 'p', sinceMs: SINCE });
  assert.equal(windowed.items.length, 5, 'every in-window match must survive');
  assert.ok(windowed.items.every((it) => it.id.startsWith('new-')));
});

test('windowing does not change what an in-window document scores', () => {
  // N, df and avgdl come from the whole index, so narrowing the result set must
  // not reweight it. If this drifts, the window silently became a re-ranking.
  const index = buildIndex(corpus());
  const unwindowed = scoreBM25(index, 'widget', { project: 'p' });
  const windowed = scoreBM25(index, 'widget', { project: 'p', sinceMs: SINCE });

  const before = new Map(unwindowed.items.map((it) => [it.id, it.score]));
  for (const item of windowed.items) {
    assert.equal(item.score, before.get(item.id), `${item.id} rescored under a window`);
  }
});

test('hybridSearch surfaces in-window keyword rows that truncation would have dropped', async () => {
  const index = buildIndex(corpus());
  const res = await hybridSearch(index, 'widget', { project: 'p', sinceMs: SINCE });

  assert.ok(res.items.length > 0, 'the keyword ladder must reach fusion non-empty');
  assert.ok(res.items.every((it) => String(it.event_id ?? it.id).startsWith('new-')),
    'only in-window rows may survive');
});

test('a document with no parseable timestamp is dropped only when a window is active', () => {
  const events = [
    { event_id: 'undated', project: 'p', summary: 'widget' },
    { event_id: 'dated', timestamp: new Date(NOW).toISOString(), project: 'p', summary: 'widget' },
  ];
  noise(20, events);
  const index = buildIndex(events);

  assert.equal(scoreBM25(index, 'widget', { project: 'p' }).items.length, 2);
  const windowed = scoreBM25(index, 'widget', { project: 'p', sinceMs: SINCE });
  assert.deepEqual(windowed.items.map((it) => it.id), ['dated']);
});

test('epochMsFromTimestamp is the single parser both windows use', () => {
  assert.equal(epochMsFromTimestamp('2026-09-08T12:00:00Z'), NOW);
  assert.equal(epochMsFromTimestamp('2026-09-08T05:00:00-07:00'), NOW);
  assert.equal(epochMsFromTimestamp(NOW), NOW);          // already ms
  assert.equal(epochMsFromTimestamp(NOW / 1000), NOW);   // seconds
  assert.equal(epochMsFromTimestamp(undefined), null);
  assert.equal(epochMsFromTimestamp('not a date'), null);
});
