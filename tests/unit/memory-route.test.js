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
  assert.equal(parseMemoryRoute('').catchupExplicit, false);
  assert.equal(parseMemoryRoute('?catchup=hour').catchupExplicit, true);
  assert.deepEqual(parseMemoryRoute('?view=unknown&x=bad&y=bad&session=../../secret&file=/secret&review=file&at=nonsense'), normalizeMemoryRoute());
  assert.equal(parseMemoryRoute('?session=real&file=relative.js&review=file').review, null);
  assert.equal(parseMemoryRoute('?session=real&file=%2Ftmp%2Fbad%00name').file, null);
  assert.equal(parseMemoryRoute('?diff=sideways').diff, 'split', 'an unknown diff layout falls back to split');
  assert.equal(parseMemoryRoute('?diff=unified').diff, 'unified');
  assert.match(memoryHref({ session: 'real', file: '/tmp/a.md', review: 'changes', diff: 'unified' }), /diff=unified/);
  assert.doesNotMatch(memoryHref({ diff: 'split' }), /diff=/, 'the default layout costs no parameter');
  assert.equal(parseMemoryRoute('?kind=md').kind, 'md');
  assert.equal(parseMemoryRoute('?kind=docs').kind, 'all', 'an unknown artifact kind falls back to every file');
  assert.match(memoryHref({ kind: 'md' }), /kind=md/);
  assert.doesNotMatch(memoryHref({ kind: 'all' }), /kind=/);
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

test('time, find, work filters and position compose into a portable desk state', () => {
  const route = normalizeMemoryRoute({ hours: 168, q: 'route & memory', filter: 'changed', catchup: 'return', checkpoint: 1788940000000, offset: 21, sort: 1788940000001, focus: 'charts', brush: ['one'], cam: { x: 40, y: 20, scale: 2.6 } });
  const href = memoryHref(route);
  assert.deepEqual(parseMemoryRoute(href.slice(href.indexOf('?'))), route);
  assert.equal(memoryHref(parseMemoryRoute('?hours=24&filter=all&offset=0&focus=overview&catchup=hour&sort=0')), '/memory?catchup=hour');
  for (const hours of ['wat', 0, 2161, 24.5, -1]) assert.equal(normalizeMemoryRoute({ hours }).hours, 24);
  assert.equal(normalizeMemoryRoute({ hours: 2160 }).hours, 2160);
  assert.equal(parseMemoryRoute('?offset=-1&sort=no&filter=bogus&focus=bad').offset, 0);
  const end = Date.parse('2026-09-09T12:00:00Z');
  assert.equal(normalizeMemoryRoute({ hours: 168, at: end - 2 * 86400000, end }).at, end - 2 * 86400000, 'historical cursors use the chosen window');
});

test('exact focus and shared scope serialize canonically and round-trip', () => {
  const route = normalizeMemoryRoute({
    from: '2026-09-01T12:00:00.123Z',
    through: '2026-09-02T15:30:00.456Z',
    project: 'cartographer',
    provider: 'codex,claude,codex',
    evidence: ['wrapup', 'commit'],
    result: 'files',
    surface: 'activity',
    doc: 'source',
    contributor: 'session-b',
    q: 'saved focus',
    session: 'session-a',
    file: '/tmp/readme.md',
  });
  const href = memoryHref(route, '/timeline');
  assert.match(href, /^\/timeline\?from=2026-09-01T12%3A00%3A00\.123Z&through=2026-09-02T15%3A30%3A00\.456Z/);
  assert.deepEqual(parseMemoryRoute(href.slice(href.indexOf('?'))), route);
  assert.deepEqual(route.providers, ['claude', 'codex']);
  assert.deepEqual(route.evidence, ['commit', 'wrapup']);
});

test('invalid, inconsistent, and over-90-day focus links retain an explicit route error', () => {
  const partial = parseMemoryRoute('?from=2026-09-01T00:00:00.000Z');
  assert.equal(partial.routeError.code, 'partial-range');
  const reversed = parseMemoryRoute('?from=2026-09-02T00:00:00.000Z&through=2026-09-01T00:00:00.000Z');
  assert.equal(reversed.routeError.code, 'reversed-range');
  const wide = parseMemoryRoute('?from=2026-01-01T00:00:00.000Z&through=2026-04-02T00:00:00.001Z');
  assert.equal(wide.routeError.code, 'range-too-wide');
  const mismatch = parseMemoryRoute('?from=2026-09-01T00:00:00.000Z&through=2026-09-02T00:00:00.000Z&mode=rolling&durationMs=1');
  assert.equal(mismatch.routeError.code, 'duration-mismatch');
  assert.equal(parseMemoryRoute('?mode=rolling&durationMs=86400000').routeError.code, 'unresolved-mode');
});

test('legacy pinned and catch-up links map to exact focus while retaining old fields', () => {
  const pinned = parseMemoryRoute('?hours=24&at=2026-09-02T06:00:00.000Z&end=2026-09-02T12:00:00.000Z');
  assert.equal(pinned.from, Date.parse('2026-09-01T12:00:00.000Z'));
  assert.equal(pinned.through, Date.parse('2026-09-02T06:00:00.000Z'));
  assert.equal(pinned.at, Date.parse('2026-09-02T06:00:00.000Z'));
  const catchup = parseMemoryRoute('?catchup=return&checkpoint=1788264000000&at=2026-09-02T12:00:00.000Z');
  assert.equal(catchup.from, 1788264000000);
  assert.equal(catchup.lower, 'open');
  assert.equal(catchup.mode, 'since-saved');
});

test('legacy chart and work filters migrate to canonical workspace fields', () => {
  assert.equal(parseMemoryRoute('?focus=charts').surface, 'activity');
  assert.equal(parseMemoryRoute('?view=wake').surface, 'activity');
  const changed = parseMemoryRoute('?filter=changed');
  assert.equal(changed.result, 'files');
  assert.equal(changed.filter, 'all');
  const landed = parseMemoryRoute('?filter=landed');
  assert.deepEqual(landed.evidence, ['commit', 'wrapup']);
  assert.equal(landed.filter, 'all');
  assert.equal(memoryHref(landed), '/memory?evidence=commit%2Cwrapup');
  assert.deepEqual(normalizeMemoryRoute({ ...landed, evidence: [] }).evidence, [], 'clearing canonical evidence does not resurrect the legacy filter');
});

test('explicit hourly catch-up survives canonical round-trip', () => {
  const route = parseMemoryRoute('?catchup=hour');
  assert.equal(route.catchupExplicit, true);
  const href = memoryHref(route);
  assert.equal(href, '/memory?catchup=hour');
  assert.deepEqual(parseMemoryRoute(href.slice(href.indexOf('?'))), route);
});

test('contributors use session-id validation and malformed times remain visible', () => {
  assert.equal(parseMemoryRoute('?contributor=session-ok').contributor, 'session-ok');
  assert.equal(parseMemoryRoute('?contributor=..%2Fsecret').contributor, null);
  assert.equal(parseMemoryRoute('?contributor=bad%20space').contributor, null);
  const invalid = parseMemoryRoute('?from=yesterday&through=2026-09-01T00:00:00.000Z');
  assert.equal(invalid.routeError.code, 'invalid-range');
  const href = memoryHref(invalid);
  assert.match(href, /from=yesterday/);
  assert.match(href, /through=2026-09-01T00%3A00%3A00\.000Z/);
  assert.equal(parseMemoryRoute(href.slice(href.indexOf('?'))).routeError.code, 'invalid-range');
});
