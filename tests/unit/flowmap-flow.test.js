import test from 'node:test';
import assert from 'node:assert/strict';

import { DARK } from '../../explorer/shared/flowmap/palette.js';
import { STATIONS, setupFrom } from '../../explorer/shared/flowmap/setup.js';
import { boardLayout, boardRoute, drawFlow, drawTape, flowBoxes, flowLevel, flowState, holdFor, ringLayout, tapeHeight, tapeOf } from '../../explorer/shared/flowmap/flow.js';

const T0 = Date.parse('2026-11-13T18:00:00.000Z');
const call = (s, station, more = {}) => ({ station, label: station, from: 'core', startedAt: T0 + s * 1000, endedAt: T0 + s * 1000 + 400, status: 'ok', tool: 'x', ...more });
const names = setupFrom({}).t.stations;
const setup = setupFrom({ theme: 'dark' });
const layouts = { ring: ringLayout(setup), board: boardLayout() };
// You asks, the agent reads a file, runs a command, reads again, runs again, then fetches a page.
const session = [call(0, 'you', { from: 'inbound' }), call(1, 'model'), call(2, 'files'), call(3, 'model'), call(4, 'shell'), call(5, 'files'), call(6, 'shell'), call(7, 'web')];
const lum = hex => {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a, b) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

test('the route is the sequence of stations, oldest first, with the model left out', () => {
  const legs = at => flowState(session, T0 + at * 1000).legs.map(l => `${l.from}>${l.to}`);
  // The person is not a stop: the route is where the agent's work went after the message.
  assert.deepEqual(legs(7.5), ['files>shell', 'shell>files', 'files>shell', 'shell>web']);
  // Earlier in the session the route is shorter: a leg appears when its call starts, not before.
  assert.deepEqual(legs(4.5), ['files>shell']);
  assert.deepEqual(legs(2.5), []);
});

test('a leg holds, then fades, then goes; a replay stretches both', () => {
  const head = (at, opts) => flowState(session, T0 + at * 1000, opts).legs.at(-1);
  assert.equal(head(8).strength, 1);
  assert.equal(head(8).from + '>' + head(8).to, 'shell>web');
  // Live: 40 s held, 20 s fading, as on the hub.
  assert.equal(head(46).strength, 1);
  assert.ok(head(57).strength > 0 && head(57).strength < 1);
  assert.equal(head(68), undefined, 'a leg is still drawn 61 s after it was made');
  assert.deepEqual([holdFor(1), holdFor(60)], [40_000, 480_000]);
  // At 60x the same leg is still whole 7 display-seconds (7 session-minutes) later.
  assert.equal(head(7 + 7 * 60, { hold: holdFor(60) }).strength, 1);
  // The pulse on the newest leg runs once, then stops.
  assert.ok(head(7.2, { travel: 700 }).f > 0 && head(7.2, { travel: 700 }).f < 1);
  assert.equal(head(9, { travel: 700 }).f, 1);
});

test('every size keeps the route, down to the glyph', () => {
  const state = flowState(session, T0 + 7500);
  const present = new Set(['you', 'model', 'files', 'shell', 'web']);
  assert.deepEqual([460, 400, 399, 96, 95, 24].map(flowLevel), [3, 3, 2, 2, 1, 1]);
  for (const [kind, layout] of Object.entries(layouts)) {
    const routeMarks = size => {
      const svg = drawFlow(state, { layout, size, names, present, motion: 'reduced' });
      // A leg is a path with no fill, a round cap, and a colour on the way to the trail colour; spokes and copper are not round-capped.
      return [...svg.matchAll(/<path d="([^"]+)" fill="none" stroke="(#[0-9a-f]{6})" stroke-width="([\d.]+)" stroke-linecap="round"/g)].map(m => ({ d: m[1], colour: m[2], width: Number(m[3]) }));
    };
    assert.equal(routeMarks(160).length, 4, `${kind} at 160 px`);
    // A glyph keeps the three newest legs, and each is at least 1.5 px wide on screen.
    for (const size of [64, 24]) {
      const marks = routeMarks(size);
      assert.equal(marks.length, 3, `${kind} at ${size} px draws ${marks.length} legs`);
      for (const m of marks) assert.ok((m.width * size) / layout.width >= 1.5, `${kind} at ${size} px: a leg is ${((m.width * size) / layout.width).toFixed(2)} px wide`);
      // The newest is the brightest: order survives as brightness when there is no room for anything else.
      assert.ok(lum(marks.at(-1).colour) > lum(marks[0].colour));
    }
    // Control: with no calls there is no route, so the marks above are the session's.
    assert.equal([...drawFlow(flowState([], T0), { layout, size: 24, names, present }).matchAll(/stroke-linecap="round"/g)].length, 0);
  }
});

test('stations hold their places across sizes, and an unused one gets no ink', () => {
  const state = flowState(session, T0 + 7500);
  const present = new Set(['you', 'model', 'files', 'shell', 'web']);
  // Ring: a station's circle is centred where the full hub has it, at every size.
  const ring = layouts.ring;
  for (const size of [160, 64, 24]) {
    const svg = drawFlow(state, { layout: ring, size, names, present });
    for (const id of present) {
      const { x, y } = ring.stations[id];
      assert.ok(svg.includes(`<circle cx="${Math.round(x * 10) / 10}" cy="${Math.round(y * 10) / 10}"`), `${id} moved at ${size} px`);
    }
    const idle = ring.stations.hooks;
    assert.ok(!svg.includes(`cx="${Math.round(idle.x * 10) / 10}" cy="${Math.round(idle.y * 10) / 10}"`), `hooks is drawn at ${size} px`);
  }
  // Board: the controls laid over it cover exactly the components that are drawn.
  const boxes = flowBoxes(layouts.board, present);
  assert.deepEqual(boxes.map(b => b.id).sort(), [...present].sort());
  const full = drawFlow(state, { layout: layouts.board, size: 460, names, present, coreName: 'CLAUDE' });
  for (const id of present) assert.ok(full.includes(`>${names[id]}</text>`), `${id} has no name`);
  assert.ok(!full.includes(`>${names.hooks}</text>`));
});

test('on the board every leg runs on its own lane, square to the grid, between its two components', () => {
  const board = layouts.board;
  const pairs = [['you', 'files'], ['files', 'shell'], ['shell', 'web'], ['agents', 'memory'], ['hooks', 'browser'], ['model', 'skills']];
  const routes = pairs.map(([from, to], lane) => boardRoute(board, from, to, lane));
  routes.forEach((points, i) => {
    const [from, to] = pairs[i];
    // Starts and ends inside its components.
    for (const [id, [x, y]] of [[from, points[0]], [to, points.at(-1)]]) {
      const s = board.stations[id];
      assert.ok(Math.abs(x - s.x) <= s.w / 2 && Math.abs(y - s.y) <= s.h / 2, `${from}>${to} does not reach ${id}`);
    }
    // Every segment is horizontal or vertical.
    for (let k = 1; k < points.length; k++) assert.ok(points[k][0] === points[k - 1][0] || points[k][1] === points[k - 1][1], `${from}>${to} has a diagonal`);
    // It never crosses the processor.
    const c = board.core;
    for (const [x, y] of points) assert.ok(Math.abs(x - c.x) > c.w / 2 || Math.abs(y - c.y) > c.h / 2, `${from}>${to} runs under the processor`);
  });
  // Two legs between the same pair, on different lanes, share no bus segment.
  const inner = boardRoute(board, 'web', 'shell', 0).slice(1, -1).map(p => p.join(','));
  const outer = boardRoute(board, 'web', 'shell', 3).slice(1, -1).map(p => p.join(','));
  assert.equal(inner.filter(p => outer.includes(p)).length, 0);
});

test('names on the board are 16 px and hold 8:1 on the fill behind them', () => {
  // One station bright, one dim, one idle: the three grounds a name can sit on.
  const state = flowState([call(0, 'files'), ...Array.from({ length: 12 }, (_, i) => call(59 + i * 0.02, 'shell')), call(40, 'web')], T0 + 60_000, { tau: 20_000 });
  const present = new Set(['files', 'shell', 'web', 'memory']);
  for (const size of [400, 460, 560]) {
    const svg = drawFlow(state, { layout: layouts.board, size, names, present, coreName: 'CLAUDE', model: 'fable 5.2' });
    for (const [, units] of svg.matchAll(/<text [^>]*font-size="([\d.]+)"/g)) assert.ok((Number(units) * size) / 460 >= 15.99, `a name is ${((Number(units) * size) / 460).toFixed(1)} px at ${size} px`);
    // Each component's two lines of text are preceded by the rect they sit on.
    const pairs = [...svg.matchAll(/<rect [^>]*fill="(#[0-9a-f]{6})"\/><text [^>]*fill="(#[0-9a-f]{6})">[^<]*<\/text><text [^>]*fill="(#[0-9a-f]{6})">/g)];
    assert.equal(pairs.length, present.size);
    for (const [, ground, name, count] of pairs) {
      assert.ok(ratio(name, ground) >= 8, `name ${name} on ${ground}: ${ratio(name, ground).toFixed(2)}`);
      assert.ok(ratio(count, ground) >= 8, `count ${count} on ${ground}: ${ratio(count, ground).toFixed(2)}`);
    }
  }
  assert.ok(ratio(DARK.bone, DARK.raised) >= 8 && ratio(DARK.ash, DARK.raised) >= 8);
});

test('the tape is the last calls in order, one lane per station, with a subagent drawn apart', () => {
  const actions = [...session, call(8, 'web', { agentId: 'a1' }), call(9, 'shell', { agentId: 'a1' }), call(10, 'shell', { status: 'err' }), { ...call(11, 'files'), endedAt: undefined }];
  const rows = tapeOf(actions, T0 + 11_500, 60);
  // In order, without the model's steps.
  assert.deepEqual(rows.map(r => r.station), ['you', 'files', 'shell', 'files', 'shell', 'web', 'web', 'shell', 'shell', 'files']);
  assert.deepEqual(rows.map(r => r.person), [true, false, false, false, false, false, false, false, false, false]);
  assert.deepEqual(rows.slice(-2).map(r => r.status), ['err', 'run']);
  assert.equal(tapeOf(actions, T0 + 11_500, 3).length, 3);
  // Stopped earlier, the tape ends earlier: it never shows a call that had not started.
  assert.deepEqual(tapeOf(actions, T0 + 4500, 60).map(r => r.station), ['you', 'files', 'shell']);

  const svg = drawTape(rows, { width: 460, names });
  const lanes = [...svg.matchAll(/<text [^>]*>([^<]+)<\/text>/g)].map(m => m[1]);
  // Lanes follow the hub's order, and only stations in view get one.
  assert.deepEqual(lanes, STATIONS.map(s => s.id).filter(id => rows.some(r => r.station === id)).map(id => names[id]));
  // One mark per call. The person's message is a diamond, not a dot; the subagent's two and the running one are hollow; the failure is red.
  const marks = [...svg.matchAll(/<circle cx="([\d.]+)" cy="([\d.]+)" r="[\d.]+" fill="(#[0-9a-f]{6})"( stroke="(#[0-9a-f]{6})")?/g)];
  assert.equal(marks.length, rows.length - 1);
  assert.equal([...svg.matchAll(/<path d="M[\d.]+ [\d.]+L[\d.]+ [\d.]+L[\d.]+ [\d.]+L[\d.]+ [\d.]+Z" fill="#edf0f5"\/>/g)].length, 1);
  assert.equal(marks.filter(m => m[5] !== undefined).length, 3);
  assert.equal(marks.filter(m => m[3] === DARK.red).length, 1);
  // Left to right is oldest to newest, one equal step per call.
  const xs = marks.map(m => Number(m[1]));
  assert.ok(xs.every((x, i) => i === 0 || x > xs[i - 1]));
  // The subagent's calls are joined by their own dashed line, apart from the main one.
  assert.equal([...svg.matchAll(/stroke-dasharray/g)].length, 1);

  // Given the session's stations, the tape keeps its height whatever is in view.
  const fixed = ['you', 'files', 'shell', 'web', 'memory', 'hooks'];
  assert.equal(tapeHeight(rows.slice(0, 2), fixed), tapeHeight(rows, fixed));
  assert.ok(tapeHeight(rows.slice(0, 2)) < tapeHeight(rows));
  for (const [, fill] of svg.matchAll(/<text [^>]*fill="(#[0-9a-f]{6})"/g)) assert.ok(ratio(fill, DARK.ground) >= 8);
});

test('the person is never a stop on the route, and a message starts it over', () => {
  // Work, a report, then the person speaks, then more work. lot-map drew shell>you and you>files here.
  const step = (s, station, more = {}) => call(s, station, more);
  const turn = [
    step(0, 'you', { from: 'inbound' }), step(1, 'files'), step(2, 'shell'), step(3, 'tells'),
    step(4, 'you', { from: 'inbound' }), step(5, 'files'), step(6, 'web'),
  ];
  const state = flowState(turn, T0 + 6500);
  assert.deepEqual(state.legs.map(l => `${l.from}>${l.to}`), ['files>shell', 'shell>tells', 'files>web']);
  assert.ok(state.legs.every(l => l.from !== 'you' && l.to !== 'you'));
  // The person's message still lights its own station and still counts.
  assert.equal(state.stations.you.count, 2);
  assert.equal(state.stations.tells.count, 1);

  // A task-list update sent in the same step as a command rode beside it: the step went to the shell.
  const beside = [step(0, 'you', { from: 'inbound' }), step(1, 'files'), step(2, 'tells', { aside: true }), step(2, 'shell'), step(3, 'tells')];
  assert.deepEqual(flowState(beside, T0 + 3500).legs.map(l => `${l.from}>${l.to}`), ['files>shell', 'shell>tells']);
  // Control: without the mark the same calls make the bounce lot-map drew.
  const bounce = beside.map(a => ({ ...a, aside: undefined }));
  assert.deepEqual(flowState(bounce, T0 + 3500).legs.map(l => `${l.from}>${l.to}`), ['files>tells', 'tells>shell', 'shell>tells']);

  // On the tape the agent's line breaks at the person's message and skips the report sent beside other work.
  const svg = drawTape(tapeOf(turn, T0 + 6500, 60), { width: 460, names });
  const lines = [...svg.matchAll(/<path d="(M[^"]+)" fill="none" stroke="#[0-9a-f]{6}" stroke-width="1.3"/g)].map(m => m[1].split('L').length);
  assert.deepEqual(lines, [3, 2], 'one line per turn: files-shell-tells, then files-web');
});
