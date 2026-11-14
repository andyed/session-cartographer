import test from 'node:test';
import assert from 'node:assert/strict';

import { DARK } from '../../explorer/shared/workmap/palette.js';
import { PORTRAIT_FULL, PORTRAIT_TIGHT, drawPortrait, mix, portraitLevel, portraitState, regionOf } from '../../explorer/shared/workmap/portrait.js';
import { mapHref, readMapRoute } from '../../explorer/src/components/session-map.js';

const T0 = Date.parse('2026-11-13T18:00:00.000Z');
const call = (s, station, more = {}) => ({ station, label: station, from: 'core', startedAt: T0 + s * 1000, endedAt: T0 + s * 1000 + 500, status: 'ok', tool: 'x', ...more });
const names = { model: 'Model', memory: 'Memory', skills: 'Skills', hooks: 'Hooks', web: 'Network', browser: 'Browser', you: 'You', shell: 'Shell', agents: 'Agents' };
const lum = hex => {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a, b) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

test('each call lands on one organ, with the direction its information ran', () => {
  const where = a => { const { region, dir } = regionOf(a); return `${region}:${dir}`; };
  assert.equal(where(call(0, 'web')), 'eye:in');
  assert.equal(where(call(0, 'browser')), 'eye:in');
  assert.equal(where(call(0, 'files', { op: 'read' })), 'eye:in');
  assert.equal(where(call(0, 'files', { op: 'search' })), 'eye:in');
  // The same station, the other way: an edit is the hand, not the eye.
  assert.equal(where(call(0, 'files', { op: 'edit' })), 'hand:out');
  assert.equal(where(call(0, 'files', { op: 'write' })), 'hand:out');
  assert.equal(where(call(0, 'shell')), 'hand:out');
  assert.equal(where(call(0, 'you', { from: 'inbound' })), 'ear:in');
  assert.equal(where(call(0, 'you')), 'mouth:out');
  assert.equal(where(call(0, 'model')), 'cortex:think');
  assert.equal(where(call(0, 'memory')), 'hippocampus:in');
  assert.equal(where(call(0, 'memory', { op: 'edit' })), 'hippocampus:out');
  assert.equal(where(call(0, 'skills')), 'cerebellum:in');
  assert.equal(where(call(0, 'hooks')), 'brainstem:reflex');
  // A subagent's fetch is another mind looking: it lights the small heads, not this head's eye.
  assert.equal(where(call(0, 'web', { agentId: 'a1' })), 'peers:out');
});

test('a call is a flash that fades, a burst is a glow that saturates, and speed does not change either', () => {
  const one = [call(0, 'shell')];
  const level = (actions, s, opts) => portraitState(actions, T0 + s * 1000, opts).regions.hand.level;
  assert.ok(level(one, 0.6) > level(one, 4) && level(one, 4) > level(one, 12), 'the light does not fall with age');
  assert.ok(level(one, 40) < 0.01, 'a call is still lit 40 s later');
  // Control: before the call there is nothing, so the light above is the call's.
  assert.equal(portraitState(one, T0 - 1).regions.hand.count, 0);

  const burst = Array.from({ length: 10 }, (_, i) => call(i * 0.05, 'shell'));
  assert.ok(level(burst, 0.6) > level(one, 0.6));
  assert.ok(level(burst, 0.6) <= 1);

  // A replay at 60x stretches tau by 60: the same picture one display-second after the call.
  const slow = portraitState(one, T0 + 1000, { tau: 4000, travel: 900 }).regions.hand;
  const fast = portraitState(one, T0 + 60_000, { tau: 4000 * 60, travel: 900 * 60 }).regions.hand;
  assert.ok(Math.abs(slow.level - fast.level) < 1e-9);

  // A call that has not answered holds its region lit however old it is.
  const open = [{ ...call(0, 'shell'), endedAt: undefined }];
  assert.ok(portraitState(open, T0 + 120_000).regions.hand.level > 0.4);
  assert.equal(portraitState(open, T0 + 120_000).regions.hand.running, 1);
});

test('counts, faults and pulses follow the session', () => {
  const actions = [
    call(0, 'you', { from: 'inbound' }),
    call(1, 'shell', { status: 'err' }),
    call(2, 'files', { op: 'read' }),
    call(3, 'web', { agentId: 'a1' }),
    call(4, 'you', { from: 'inbound' }),
    ...Array.from({ length: 6 }, (_, i) => call(5 + i * 0.01, 'web')),
  ];
  const before = portraitState(actions, T0 + 3500).regions;
  assert.equal(before.hand.faults, 1);
  assert.deepEqual(before.eye.parts, { reads: 1 });
  assert.deepEqual(before.peers.parts, { calls: 1 });
  // The person's next message clears the fault, as on the hub.
  assert.equal(portraitState(actions, T0 + 4500).regions.hand.faults, 0);
  // Six fetches inside one pulse's travel: three dots, not six.
  const after = portraitState(actions, T0 + 5200).regions;
  assert.equal(after.eye.parts.web, 6);
  assert.equal(after.eye.pulses.length, 3);
});

test('names are 16 px or absent, and only in colours that hold 8:1', () => {
  const state = portraitState([call(0, 'shell'), call(0, 'web'), call(0, 'memory'), call(0, 'model'), call(0, 'you', { from: 'inbound' })], T0 + 500);
  const fonts = svg => [...svg.matchAll(/<text [^>]*font-size="([\d.]+)"/g)].map(m => Number(m[1]));
  for (const size of [720, 594, 500, 396]) {
    assert.equal(portraitLevel(size), 3);
    const svg = drawPortrait(state, { size, names });
    assert.ok(fonts(svg).length >= 4, `no names at ${size} px`);
    for (const units of fonts(svg)) assert.ok((units * size) / PORTRAIT_FULL.w >= 15.99, `a name is ${((units * size) / PORTRAIT_FULL.w).toFixed(1)} px at ${size} px`);
    for (const [, fill] of svg.matchAll(/<text [^>]*fill="(#[0-9a-f]{6})"/g)) {
      for (const ground of [DARK.ground, DARK.raised]) assert.ok(ratio(fill, ground) >= 8, `${fill} on ${ground} at ${size} px`);
    }
  }
  for (const size of [395, 300, 160, 96, 64, 24]) assert.equal(fonts(drawPortrait(state, { size, names })).length, 0, `names drawn at ${size} px`);
  assert.deepEqual([395, 96, 95, 24].map(portraitLevel), [2, 2, 1, 1]);
});

test('the anatomy holds its place at every size, and a glyph spends ink only on what is lit', () => {
  const lit = portraitState([call(0, 'web'), call(0, 'model')], T0 + 500);
  const svgs = Object.fromEntries([594, 160, 64, 24].map(size => [size, drawPortrait(lit, { size, names })]));
  const head = /<path d="(M206 452[^"]+)"/;
  const cortex = /<path d="(M120 214[^"]+)"/;
  for (const re of [head, cortex]) {
    const paths = Object.values(svgs).map(svg => re.exec(svg)?.[1]);
    assert.ok(paths[0], 'landmark missing at full size');
    assert.ok(paths.every(d => d === paths[0]), 'a landmark moved between sizes');
  }
  // The frame closes in below the labelled size and then stays put.
  const box = svg => /viewBox="([^"]+)"/.exec(svg)[1];
  assert.equal(box(svgs[594]), `${PORTRAIT_FULL.x} ${PORTRAIT_FULL.y} ${PORTRAIT_FULL.w} ${PORTRAIT_FULL.h}`);
  for (const size of [160, 64, 24]) assert.equal(box(svgs[size]), `${PORTRAIT_TIGHT.x} ${PORTRAIT_TIGHT.y} ${PORTRAIT_TIGHT.w} ${PORTRAIT_TIGHT.h}`);

  // The ear was never used. At 160 px its outline is still there; at 24 px it is not drawn at all.
  const ear = 'M252 286';
  assert.ok(svgs[160].includes(ear));
  assert.ok(!svgs[24].includes(ear) && !svgs[64].includes(ear));
  // The eye is lit, so the glyph shows it as a spot at least 3 px across on screen.
  const spot = /<circle cx="346" cy="230" r="([\d.]+)" fill="#[0-9a-f]{6}" fill-opacity/.exec(svgs[24]);
  assert.ok(spot, 'the lit eye has no spot at 24 px');
  assert.ok((Number(spot[1]) * 2 * 24) / PORTRAIT_TIGHT.w >= 3, `the eye's spot is ${((Number(spot[1]) * 2 * 24) / PORTRAIT_TIGHT.w).toFixed(1)} px`);
  // Control: with nothing lit, the glyph has no spot there.
  const dark = drawPortrait(portraitState([call(0, 'web')], T0 + 600_000), { size: 24, names });
  assert.ok(!/<circle cx="346" cy="230"[^>]*fill-opacity/.test(dark));
});

test('hue is the direction: cool for what comes in, warm for what goes out', () => {
  const fillAt = (actions, d) => new RegExp(`<path d="${d}[^"]*" fill="(#[0-9a-f]{6})"`).exec(drawPortrait(portraitState(actions, T0 + 300), { size: 594, names }))[1];
  const warmth = hex => parseInt(hex.slice(1, 3), 16) - parseInt(hex.slice(5, 7), 16);
  const eye = fillAt([call(0, 'web')], 'M326 230');
  const hand = fillAt([call(0, 'shell')], 'M392 416');
  assert.ok(warmth(hand) > 40, `the hand is ${hand}`);
  assert.ok(warmth(eye) < 0, `the eye is ${eye}`);
  assert.equal(mix('#000000', '#ffffff', 0.5), '#808080');
  assert.equal(mix('#102030', '#405060', 2), '#405060');
});

test('the address carries the look and the layout, and leaves both out by default', () => {
  const route = { session: 'abc', station: '', at: 5, look: 'sizes', layout: 'board' };
  assert.deepEqual(readMapRoute(new URL(mapHref('/', route), 'http://x').search), route);
  assert.equal(mapHref('/', { session: 'abc', station: '', at: null, look: '', layout: '' }), '/map?session=abc');
  assert.deepEqual([readMapRoute('?look=anything-else').look, readMapRoute('?layout=anything-else').layout], ['', '']);
});
