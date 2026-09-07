// Ranking is global, so truncating to FUSION_DEPTH before applying --since kept
// the best 500 matches across ALL time and only then asked which fell inside
// the window. On a six-figure corpus a 24-hour window is barely 1% of events,
// so nearly everything recent was discarded before the filter ever saw it: the
// daily pulse returned 2 results where the portable path returned 15, against
// 1,641 changelog rows written in that same window.
process.env.CARTOGRAPHER_SEMANTIC = '0';

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildIndex } from '../../explorer/server/bm25.js';
import { hybridSearch } from '../../explorer/server/search.js';

const DAY = 86400000;

function corpus() {
  const events = [];
  // Filler that does NOT contain the probe term. Without it the term appears in
  // every document, BM25's IDF goes to zero, and the fixture scores nothing —
  // the corpus has to look like a corpus for the ranking to mean anything.
  for (let i = 0; i < 1500; i++) {
    events.push({
      event_id: `evt-filler-${i}`,
      timestamp: new Date(Date.now() - 60 * DAY - i * 1000).toISOString(),
      project: 'archive',
      summary: `unrelated maintenance chore ${i} touching build config`,
      salience: 0.5,
    });
  }
  // 520 older matches — just over FUSION_DEPTH — that outrank anything recent
  // on relevance alone (term repeated, short document).
  for (let i = 0; i < 520; i++) {
    events.push({
      event_id: `evt-old-${i}`,
      timestamp: new Date(Date.now() - 30 * DAY - i * 1000).toISOString(),
      project: 'archive',
      summary: 'windowprobe windowprobe windowprobe archived material',
      salience: 0.5,
    });
  }
  // A handful of recent matches that a global ranking sorts below all 520.
  for (let i = 0; i < 4; i++) {
    events.push({
      event_id: `evt-recent-${i}`,
      timestamp: new Date(Date.now() - 2 * 3600000 - i * 1000).toISOString(),
      project: 'live',
      summary: `windowprobe recent note ${i} with much other unrelated filler text here`,
      salience: 0.5,
    });
  }
  return events;
}

test('a --since window is applied before the fusion-depth truncation', async () => {
  const events = corpus();
  const index = buildIndex(events);

  const scoped = await hybridSearch(index, 'windowprobe', { sinceMs: Date.now() - DAY });
  const ids = scoped.items.map((item) => item.event_id);

  assert.ok(ids.length > 0, 'a recency-scoped query returned nothing at all');
  assert.ok(
    ids.every((id) => id.startsWith('evt-recent-')),
    'results outside the requested window leaked through',
  );
  assert.equal(
    ids.length, 4,
    `every in-window event must survive truncation; got ${ids.length} of 4`,
  );
});

test('an unscoped query still ranks the whole corpus', async () => {
  const events = corpus();
  const unscoped = await hybridSearch(buildIndex(events), 'windowprobe', {});
  assert.ok(
    unscoped.items.some((item) => item.event_id.startsWith('evt-old-')),
    'removing the window must not also remove the older material',
  );
});
