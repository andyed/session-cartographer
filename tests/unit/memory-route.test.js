import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeMemoryRoute, parseMemoryRoute, memoryHref } from '../../explorer/src/components/memory-route.js';

test('memory permalink round-trips comparison, session, exact file and replay window', () => {
  const value = normalizeMemoryRoute({ view: 'compare', x: 'activeMs', y: 'files', session: 'session-a', file: '/workspace/a b/é & #?.js', review: 'changes', at: Date.parse('2026-09-09T11:20:00Z'), end: Date.parse('2026-09-09T12:00:00Z') });
  const href = memoryHref(value, '/explorer/memory');
  assert.equal(new URL(href, 'http://localhost').pathname, '/explorer/memory');
  assert.deepEqual(parseMemoryRoute(href.slice(href.indexOf('?'))), value);
  assert.match(href, /session=session-a/);
});

test('live defaults stay compact, invalid parameters cannot create a phantom drilldown', () => {
  assert.equal(memoryHref({}), '/memory');
  assert.deepEqual(parseMemoryRoute('?view=unknown&x=bad&y=bad&session=../../secret&file=/secret&review=file&at=nonsense'), normalizeMemoryRoute());
  assert.equal(parseMemoryRoute('?session=real&file=relative.js&review=file').review, null);
  assert.equal(parseMemoryRoute('?session=real&file=%2Ftmp%2Fbad%00name').file, null);
});

test('a replay cursor pins its window and remains bounded to that window', () => {
  const at = Date.parse('2026-09-09T12:00:00Z');
  assert.equal(normalizeMemoryRoute({ at }).end, at);
  assert.equal(normalizeMemoryRoute({ at: at - 2 * 86400000, end: at }).at, at - 86400000);
  assert.equal(normalizeMemoryRoute({ at: at + 60000, end: at }).at, at);
  assert.equal(normalizeMemoryRoute({ end: at }).end, null, 'Live links do not retain a stale window');
});
