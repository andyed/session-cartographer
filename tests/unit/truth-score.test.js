/**
 * tests/unit/truth-score.test.js
 *
 * scripts/truth-score.js is the one definition of relevance against the
 * demo/truth labels, shared by eval-search.js and age-curve.js's topical
 * cases. The labels themselves are gitignored, so these use a synthetic one.
 *
 * Two properties carry the topical comparison and get their own tests: a
 * grade-0 noise exemplar overrides the session fallback (or a session full of
 * routine events scores as relevant noise), and judged precision differs from
 * plain precision exactly when unjudged results lead the list (or it would
 * not be the check on the labels' age that it is used as).
 */
process.env.CARTOGRAPHER_SEMANTIC = '0';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { eventFromCliRow, eventFromItem, loadTruth, matchTruth, scoreTruth } from '../../scripts/truth-score.js';

const truth = {
  query_id: 'widget-palette',
  query: 'widget palette',
  sessions: {
    'aaaaaaaa-1111-2222-3333-444444444444': { relevant: true, role: 'primary' },
    'bbbbbbbb-1111-2222-3333-444444444444': { relevant: true, role: 'context' },
    'cccccccc-1111-2222-3333-444444444444': { relevant: false },
  },
  events: [
    { summary: 'Shipped the widget palette picker with OKLCH swatches', grade: 3 },
    { summary: 'grep for palette in the shader repo', grade: 0, noise: 'single_word_match' },
    { summary: 'Modified: PalettePicker.jsx', grade: 3 },
    { summary: 'Palette timeline for the travel memoir site', grade: 1, relevant: false },
    { event_id: 'evt-shipped', summary: 'Commit 1a2b3c4: feat: picker', grade: 2 },
  ],
};
const PRIMARY = 'aaaaaaaa-1111-2222-3333-444444444444';
const CONTEXT = 'bbbbbbbb-1111-2222-3333-444444444444';
const OTHER = 'cccccccc-1111-2222-3333-444444444444';

test('matchTruth: an event-level match wins, a noise exemplar overrides its session, roles grade the fallback', () => {
  assert.equal(matchTruth({ summary: 'widget palette picker OKLCH swatches shipped', session: OTHER }, truth).grade, 3);
  const noise = matchTruth({ summary: 'grep for palette in the shader repo', session: PRIMARY }, truth);
  assert.equal(noise.grade, 0, 'a labeled noise event stays noise inside a relevant session');
  assert.equal(noise.noise, 'single_word_match');
  assert.equal(matchTruth({ summary: 'Modified: app.js', session: PRIMARY }, truth).grade, 3);
  assert.equal(matchTruth({ summary: 'Modified: app.js', session: CONTEXT }, truth).grade, 1);
  assert.equal(matchTruth({ summary: 'Modified: app.js', session: OTHER }, truth), null, 'an irrelevant session is unjudged');
  // Session ids are matched on a 12-character prefix in both directions.
  assert.equal(matchTruth({ summary: 'x', session: PRIMARY.slice(0, 12) }, truth).grade, 3);
});

test('matchTruth: one shared word is not a match, relevant:false is judged not relevant, an event_id is exact', () => {
  // The bug this pins: half of a two-word label is one word, so every
  // "Modified:" row matched "Modified: PalettePicker.jsx" at grade 3.
  assert.equal(matchTruth({ summary: 'Modified: Sidebar.jsx', session: OTHER }, truth), null);
  assert.equal(matchTruth({ summary: 'Modified: PalettePicker.jsx', session: OTHER }, truth).grade, 3);
  assert.equal(matchTruth({ summary: 'palette swatches for the gaze plot', session: OTHER }, truth), null,
    'two of six words is under half');
  const tangential = matchTruth({ summary: 'palette timeline travel memoir', session: OTHER }, truth);
  assert.deepEqual([tangential.grade, tangential.relevant], [1, false]);
  const exact = matchTruth({ event_id: 'evt-shipped', summary: 'unrelated words', session: OTHER }, truth);
  assert.deepEqual([exact.grade, exact.via], [2, 'event_id']);
  const s = scoreTruth(truth, [{ summary: 'palette timeline travel memoir', session: OTHER }]);
  assert.deepEqual([s.precision5, s.judged, s.judgedP10], [0, 1, 0], 'a tangential label is judged, and not relevant');
  assert.equal(s.noiseBreakdown.judged_not_relevant, 1);
});

test('scoreTruth: judged precision differs from plain precision when unjudged results lead', () => {
  const unjudged = (i) => ({ summary: `routine event ${i}`, session: `zzzz${i}-0000-0000-0000-000000000000` });
  const events = [
    ...Array.from({ length: 6 }, (_, i) => unjudged(i)),
    { summary: 'Modified: picker.js', session: PRIMARY },
    { summary: 'grep for palette in the shader repo', session: OTHER },
    { summary: 'Modified: notes.md', session: CONTEXT },
    unjudged(6),
    { summary: 'Modified: swatch.js', session: PRIMARY },
  ];
  const s = scoreTruth(truth, events);
  assert.equal(s.precision5, 0);
  assert.equal(s.precision10, 0.2, 'two of the top ten are relevant');
  assert.equal(s.unjudged10, 7);
  assert.equal(s.judged, 4);
  assert.equal(s.judgedP10, 0.75, 'three of the four judged results are relevant');
  assert.ok(Math.abs(s.gain10 - (3 + 1) / 3 / 10) < 1e-9, `gain@10 weighs primary over context (got ${s.gain10})`);
  assert.equal(s.sessionRecall, 1);
  assert.equal(scoreTruth(truth, []).judgedP10, 0, 'nothing judged scores zero, not NaN');
});

test('result shapes: an API item and a CLI jsonl row reach the scorer with the same fields', () => {
  const item = eventFromItem({ event_id: 'evt-1', summary: 'first line\nsecond', session_id: PRIMARY,
    _sources: 'changelog+semantic', timestamp: '2026-04-01T00:00:00Z' });
  assert.deepEqual([item.summary, item.session, item.sources], ['first line', PRIMARY, 'changelog+semantic']);
  // extras is key:value|key:value, and a value may itself hold colons.
  const row = eventFromCliRow({ event_id: 'evt-2', summary: 's', source: 'prompts',
    extras: `project:demo|transcript:/Users/x/a:b.jsonl|session:${CONTEXT}|cwd:/tmp` });
  assert.deepEqual([row.session, row.sources], [CONTEXT, 'prompts']);
  assert.equal(eventFromCliRow({ event_id: 'evt-3', extras: 'transcript:/p/session:x.jsonl' }).session, '',
    'a "session:" inside another value is not the session');
});

test('loadTruth reads every label file, and returns null for a missing directory', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-truth-'));
  try {
    fs.writeFileSync(path.join(dir, 'b.json'), JSON.stringify({ ...truth, query: 'b' }));
    fs.writeFileSync(path.join(dir, 'a.json'), JSON.stringify({ ...truth, query: 'a' }));
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'not a label');
    assert.deepEqual(loadTruth(dir).map((t) => t.query), ['a', 'b']);
    assert.equal(loadTruth(path.join(dir, 'absent')), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
