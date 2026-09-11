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

test('a shared field camera survives the round trip and rejects impossible ones', () => {
  const cam = { x: -120.46, y: 44.1, scale: 3.38 };
  const href = memoryHref({ cam });
  assert.deepEqual(parseMemoryRoute(href.slice(href.indexOf('?'))).cam, cam);

  // The default camera is not worth a parameter.
  assert.equal(memoryHref({ cam: { x: 0, y: 0, scale: 1 } }), '/memory');
  assert.equal(normalizeMemoryRoute({}).cam, null);

  // A link cannot place the field somewhere the controls could never reach,
  // which would strand the viewer on an empty canvas with no way back.
  for (const bad of ['0,0,99', '0,0,0.01', '9e9,0,2', 'a,b,c', '1,2', '', 'NaN,0,1']) {
    assert.equal(normalizeMemoryRoute({ cam: bad }).cam, null, `rejects ${JSON.stringify(bad)}`);
  }
  assert.equal(normalizeMemoryRoute({ cam: {} }).cam, null);
  assert.equal(normalizeMemoryRoute({ cam: { x: 1, y: 1 } }).cam, null, 'a partial camera is not a camera');
});

test('a chosen set of panels travels with the link, and cannot be emptied', () => {
  const href = memoryHref({ panels: ['field', 'compare'] });
  assert.deepEqual(parseMemoryRoute(href.slice(href.indexOf('?'))).panels, ['field', 'compare']);

  // All of them is the default and costs no parameter.
  assert.equal(memoryHref({ panels: ['field', 'wake', 'compare'] }), '/memory');
  assert.equal(normalizeMemoryRoute({}).panels, null);

  // Order is the canonical one, not whatever the link happened to carry.
  assert.deepEqual(normalizeMemoryRoute({ panels: ['compare', 'field'] }).panels, ['field', 'compare']);
  assert.deepEqual(normalizeMemoryRoute({ panels: 'field,bogus' }).panels, ['field']);

  // A link that selects nothing renderable falls back to every panel.
  for (const bad of ['', 'a,b', 'null']) {
    assert.equal(normalizeMemoryRoute({ panels: bad }).panels, null, `refuses ${JSON.stringify(bad)}`);
  }
});


test('a brushed cohort and semantic camera share one stable permalink', () => {
  const href = memoryHref({ brush: ['session-b', 'session-a', 'session-b'], cam: {x:-120,y:20,scale:2.6} });
  const route = parseMemoryRoute(href.slice(href.indexOf('?')));
  assert.deepEqual(route.brush, ['session-a', 'session-b']);
  assert.equal(route.cam.scale, 2.6);
  assert.equal(memoryHref(route), href);
  assert.equal(parseMemoryRoute('?brush=../../secret').brush, null);
});
