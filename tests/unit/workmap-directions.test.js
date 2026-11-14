import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { claudeActions, WORKMAP_OPTIONS } from '../../explorer/server/workmap.js';
import { boardAt } from '../../explorer/shared/workmap/board.js';
import { drawMap, routeOf } from '../../explorer/shared/workmap/draw.js';
import { drawTape, holdFor, tapeOf } from '../../explorer/shared/workmap/flow.js';
import { CONTEXT_FULL, CONTEXT_NEAR, HUB_ORDER, HUB_ORDER_TWO_WAY, ROUTE_PX, drawHub, hubBoxes, hubCoreBox, hubLayout, hubLeg, hubLevel, hubState, movesOf } from '../../explorer/shared/workmap/hub.js';
import { FAMILIES, FAULT, HEAD_HUES, KIND, familyOf, familyOfStation, isScreen, seatScreen, starterOf, wakeLabel } from '../../explorer/shared/workmap/kinds.js';
import { DARK } from '../../explorer/shared/workmap/palette.js';
import { drawPortrait, portraitState } from '../../explorer/shared/workmap/portrait.js';
import { SLOT_CALLS, coloursShown, drawRibbon, drawSlotRibbon, ribbonCapacity, ribbonCell, ribbonOf } from '../../explorer/shared/workmap/ribbon.js';
import { STATIONS, setupFrom } from '../../explorer/shared/workmap/setup.js';
import { LOOKS, mapHref, readMapRoute, rowsFor } from '../../explorer/src/components/session-map.js';

const T0 = Date.parse('2026-11-13T18:00:00.000Z');
const call = (s, station, more = {}) => ({ station, label: station, from: 'core', startedAt: T0 + s * 1000, endedAt: T0 + s * 1000 + 400, status: 'ok', tool: 'x', ...more });
const said = s => call(s, 'you', { from: 'inbound', tool: undefined });
const woke = (s, by) => call(s, 'hooks', { from: 'inbound', wake: by, tool: undefined });
const names = { ...setupFrom({}).t.stations, screen: 'Your screen' };
const layout = hubLayout();
// The person asks; the agent reads a file, runs a command, reads again, runs again, then fetches a page.
const session = [said(0), call(1, 'model'), call(2, 'files'), call(3, 'model'), call(4, 'shell'), call(5, 'files'), call(6, 'shell'), call(7, 'web')];

// ─── Colour ─────────────────────────────────────────────────────────────────

const rgb = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255);
const linear = c => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const lum = hex => {
  const [r, g, b] = rgb(hex).map(linear);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a, b) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
// Machado, Oliveira and Fernandes 2009, severity 1.0, applied in linear RGB.
const CVD = {
  protan: [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]],
  deutan: [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.01182, 0.04294, 0.968881]],
};
const seenAs = (hex, kind) => {
  const l = rgb(hex).map(linear);
  return kind ? CVD[kind].map(r => Math.min(1, Math.max(0, r[0] * l[0] + r[1] * l[1] + r[2] * l[2]))) : l;
};
const oklab = ([r, g, b]) => {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
};
/** OKLab distance x100 between two colours as one kind of vision sees them. */
const apart = (a, b, kind) => {
  const [x, y] = [oklab(seenAs(a, kind)), oklab(seenAs(b, kind))];
  return 100 * Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
};
const nearest = (colours, kind) => {
  let best = { d: Infinity };
  const ids = Object.keys(colours);
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
    const d = apart(colours[ids[i]], colours[ids[j]], kind);
    if (d < best.d) best = { d, pair: `${ids[i]}/${ids[j]}` };
  }
  return best;
};

test('five hues and two neutrals colour every station, and red is not one of them', () => {
  const stations = [...STATIONS.map(s => s.id), 'screen'];
  for (const id of stations) assert.ok(KIND[familyOfStation(id)], `${id} has a colour`);
  assert.deepEqual([...FAMILIES].sort(), Object.keys(KIND).sort());
  // Two neutrals (the person's side, and the agent's own machinery) and at most six hues.
  const hues = FAMILIES.filter(id => id !== 'you' && id !== 'own');
  assert.ok(hues.length <= 6, `${hues.length} hue families`);
  assert.ok(!Object.values(KIND).includes(FAULT), 'red means a failed call and nothing else');
  assert.equal(FAULT, DARK.red);
  // A family's colour is a mark on the map's ground, never letters: it has to be seen, at 4.5:1 or more.
  for (const [id, hex] of Object.entries({ ...KIND, FAULT })) assert.ok(ratio(hex, DARK.ground) >= 4.5, `${id} ${ratio(hex, DARK.ground).toFixed(2)}:1 on the ground`);
  // The person's side is one family: what the person has open is theirs, like what they say.
  assert.deepEqual(['you', 'tells', 'screen'].map(familyOfStation), ['you', 'you', 'you']);
});

test('the families stay apart for a red-green colour-blind reader, which hues of one lightness do not', () => {
  const floors = { normal: 11, protan: 6, deutan: 6 };
  for (const [kind, floor] of Object.entries(floors)) {
    const found = nearest(KIND, kind === 'normal' ? undefined : kind);
    assert.ok(found.d >= floor, `${kind}: ${found.pair} are ${found.d.toFixed(1)} apart, under ${floor}`);
  }
  // Red against every family: the nearest is the grey of the agent's own machinery, and a failed cell is taller too.
  for (const kind of [undefined, 'protan', 'deutan']) {
    for (const [id, hex] of Object.entries(KIND)) assert.ok(apart(hex, FAULT, kind) >= 5.5, `${id} and red, ${kind ?? 'normal'}: ${apart(hex, FAULT, kind).toFixed(1)}`);
  }
  // The control: the first palette tried, five hues at one lightness. It measures fine for normal vision and
  // collapses for a deuteranope, so this test can fail.
  const flat = { files: '#e9ae66', shell: '#c5a8ff', out: '#86bcff', memory: '#5fd0bd', agents: '#b7db62' };
  assert.ok(nearest(flat).d >= 9);
  assert.ok(nearest(flat, 'deutan').d < 3, `flat palette under deutan: ${nearest(flat, 'deutan').d.toFixed(1)}`);
});

test('by place a station has one colour; by organ Files has two and an edit shares one with a command', () => {
  const read = call(1, 'files', { op: 'read' });
  const edit = call(2, 'files', { op: 'edit' });
  const run = call(3, 'shell');
  assert.deepEqual([read, edit, run].map(a => familyOf(a, 'place')), ['files', 'files', 'shell']);
  assert.deepEqual([read, edit, run].map(a => familyOf(a, 'head')), ['out', 'shell', 'shell']);
  // What each model hides, counted on one stretch: read, edit, run, fetch, browse.
  const stretch = [said(0), read, edit, run, call(4, 'web'), call(5, 'browser')];
  const shown = model => coloursShown(ribbonOf(stretch, T0 + 60_000, 60, model));
  // Four handoffs. Place cannot show read to edit or fetch to browse; the head cannot show edit to run or fetch to browse.
  assert.deepEqual(shown('place'), { handoffs: 4, seen: 2 });
  assert.deepEqual(shown('head'), { handoffs: 4, seen: 2 });
  // The head drawn as a key wears its regions' colours at rest.
  const svg = drawPortrait(portraitState(stretch, T0 + 60_000), { size: 220, names, motion: 'reduced', hues: HEAD_HUES });
  assert.ok(Object.values(HEAD_HUES).every(hex => Object.values(KIND).includes(hex)));
  assert.match(svg, /<svg /);
});

// ─── Who started it ─────────────────────────────────────────────────────────

test('only what the person typed is the person; a task and the harness wake the agent from Hooks', t => {
  assert.equal(starterOf('please look at the build'), 'person');
  assert.equal(starterOf('<command-name>/model</command-name>'), 'person');
  assert.equal(starterOf('[Request interrupted by user]'), 'person');
  assert.equal(starterOf('<task-notification> <task-id>b1</task-id>'), 'task');
  assert.equal(starterOf('<system-reminder> The session "Attribute Codex" ended a turn'), 'task');
  assert.equal(starterOf('<system-reminder>\nToday is Friday'), 'harness');
  assert.equal(starterOf('This session is being continued from a previous conversation'), 'harness');
  assert.equal(starterOf('<local-command-stdout>Set model</local-command-stdout>'), 'harness');

  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'carto-directions-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const at = s => new Date(T0 + s * 1000).toISOString();
  const file = path.join(dir, 'sess-w.jsonl');
  const rows = [
    { type: 'user', timestamp: at(0), message: { content: 'please look at the build' } },
    { type: 'assistant', timestamp: at(1), message: { id: 'm1', model: 'claude-fable-5-2', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test', description: 'Run the suite' } }] } },
    { type: 'user', timestamp: at(3), message: { content: [{ type: 'tool_result', tool_use_id: 't1' }] } },
    { type: 'user', timestamp: at(60), message: { content: '<task-notification>\n<task-id>bg1</task-id>\n<status>completed</status></task-notification>' } },
    { type: 'assistant', timestamp: at(61), message: { id: 'm2', model: 'claude-fable-5-2', content: [{ type: 'tool_use', id: 't2', name: 'Read', input: { file_path: '/repo/out.log' } }] } },
    { type: 'user', timestamp: at(62), message: { content: [{ type: 'tool_result', tool_use_id: 't2' }] } },
    { type: 'user', timestamp: at(90), message: { content: 'This session is being continued from a previous conversation that ran out of context.' } },
  ].map((r, i) => ({ uuid: `w-${i}`, ...r }));
  fs.writeFileSync(file, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  const { actions } = claudeActions(file, setupFrom(WORKMAP_OPTIONS));
  const arrivals = actions.filter(a => a.from === 'inbound').map(a => [a.station, a.wake ?? 'person']);
  assert.deepEqual(arrivals, [['you', 'person'], ['hooks', 'task'], ['hooks', 'harness']]);
  // A wake's row says what it was in words: the markup written for the agent never reaches a label.
  assert.deepEqual(actions.filter(a => a.wake).map(a => a.label), ['Background task bg1 completed', 'Continued from a summary of the conversation']);
  assert.equal(wakeLabel('<system-reminder> The session "Attribute Codex MCP calls" ended a turn'), 'Session “Attribute Codex MCP calls” reported back');
  assert.equal(wakeLabel('<system-reminder>\nsecret=abc123'), 'Reminder from the harness');
  assert.equal(wakeLabel('<task-notification><summary>token sk-live-1</summary></task-notification>'), 'Background task reported');
  // The count under You is the person's messages: one, not three.
  assert.equal(boardAt(actions).counts.you, 1);

  // The route starts over at a wake as it does at a message: no leg runs from Shell, before it, to Files, after it.
  const stops = routeOf(boardAt(actions).entries);
  assert.deepEqual(stops.map(s => [s.station, s.fresh === true, s.by]), [['shell', true, 'person'], ['files', true, 'task']]);
  const moves = movesOf(boardAt(actions).entries).map(m => `${m.from}>${m.to}${m.by ? ` by ${m.by}` : ''}`);
  assert.deepEqual(moves, ['you>core by person', 'core>shell', 'hooks>core by task', 'core>files', 'hooks>core by harness']);
  // A move keeps the moment it was made, for a strip that draws one frame per move.
  assert.deepEqual(movesOf(boardAt(actions).entries).map(m => (m.made - T0) / 1000), [0, 1, 60, 61, 90]);
});

test('what the person has open is its own station, and the built-in browser is not it', () => {
  const tools = ['mcp__claude-in-chrome__navigate', 'mcp__tabtopia__get_context', 'mcp__browsing-context__search_browsing_history', 'mcp__terminal__read_terminal', 'mcp__computer-use__app_screenshot', 'mcp__Claude_Browser__navigate', 'Bash'];
  assert.deepEqual(tools.map(tool => isScreen({ tool })), [true, true, true, true, true, false, false]);
  // A subagent's call is another mind's work, wherever it reached.
  assert.equal(isScreen({ tool: 'mcp__tabtopia__get_context', agentId: 'a1' }), false);
  const seated = seatScreen([call(1, 'browser', { tool: 'mcp__claude-in-chrome__navigate' }), call(2, 'browser', { tool: 'mcp__Claude_Browser__navigate' }), call(3, 'shell', { tool: 'mcp__terminal__read_terminal' })]);
  assert.deepEqual(seated.map(a => a.station), ['screen', 'browser', 'screen']);
});

// ─── The route ──────────────────────────────────────────────────────────────

const pathsOf = svg => [...svg.matchAll(/<path d="([^"]+)" fill="none" stroke="(#[0-9a-f]{6})" stroke-width="([\d.]+)" stroke-linecap="round"(?: stroke-dasharray="[^"]+")?\/>/g)].map(m => ({ d: m[1], colour: m[2], width: Number(m[3]) }));
const headsOf = svg => [...svg.matchAll(/<path d="(M[^"]+Z)" fill="(#[0-9a-f]{6})"\/>/g)].map(m => ({ d: m[1], colour: m[2] }));
const spokesOf = svg => [...svg.matchAll(/<line [^>]*stroke-width="([\d.]+)" stroke-linecap="round"/g)].map(m => Number(m[1]));

test('a stretch of the route starts with who woke the agent, and the person is never a stop', () => {
  const state = hubState(session, T0 + 7500);
  assert.deepEqual(state.legs.map(l => `${l.from}>${l.to}`), ['you>core', 'core>files', 'shell>files', 'files>shell', 'shell>web']);
  assert.ok(state.legs.every(l => l.to !== 'you'), 'nothing leads to the person: the agent reports to Tells you');
  // Files to Shell was made twice inside the window: one curve, counted.
  assert.equal(state.legs.find(l => l.from === 'files' && l.to === 'shell').n, 2);
  assert.equal(state.made, 6);
  // Before the first call there is only the message arriving.
  assert.deepEqual(hubState(session, T0 + 500).legs.map(l => `${l.from}>${l.to}`), ['you>core']);
});

test('out and back are two curves, and every leg ends in an arrowhead', () => {
  const out = hubLeg(layout, { from: 'files', to: 'shell' });
  const back = hubLeg(layout, { from: 'shell', to: 'files' });
  // On lot-map's hub these are one curve drawn twice. Here each keeps to the right of its own direction.
  const gap = Math.hypot(out.p1.x - back.p1.x, out.p1.y - back.p1.y);
  assert.ok(gap >= 30, `the two bends are ${gap.toFixed(1)} units apart`);
  // The same holds beside a spoke: the message in and the first call out do not share a line.
  const into = hubLeg(layout, { from: 'you', to: 'core' });
  const from = hubLeg(layout, { from: 'core', to: 'you' });
  assert.ok(Math.abs(into.p0.x - from.p2.x) >= 10);

  const state = hubState(session, T0 + 7500);
  const present = new Set(['you', 'model', 'files', 'shell', 'web']);
  for (const size of [560, 160]) {
    const svg = drawHub(state, { layout, size, names, present, motion: 'reduced' });
    assert.equal(pathsOf(svg).length, state.legs.length, `${size} px: a stroke per leg`);
    assert.equal(headsOf(svg).length, state.legs.length, `${size} px: a head per leg`);
  }
  // A glyph keeps the three newest legs, and only the newest has room for its head.
  const glyph = drawHub(state, { layout, size: 64, names, present, motion: 'reduced' });
  assert.equal(pathsOf(glyph).length, 3);
  assert.equal(headsOf(glyph).length, 1);
});

test('the route is the widest and brightest line on the hub at every size', () => {
  const state = hubState(session, T0 + 7500);
  const present = new Set(['you', 'model', 'files', 'shell', 'web']);
  for (const size of [560, 400, 160, 64, 24]) {
    const unit = layout.width / size;
    const svg = drawHub(state, { layout, size, names, present, motion: 'reduced' });
    const legs = pathsOf(svg).map(p => p.width / unit);
    const [headPx, , tailPx] = ROUTE_PX[hubLevel(size)];
    // Widths are written to a tenth of a drawing unit, so a stroke lands within a tenth of a pixel or so of its figure;
    // a leg made twice is 0.6 px wider where there is no room for its count.
    assert.ok(Math.abs(Math.max(...legs) - headPx) < 0.75, `${size} px: newest leg ${Math.max(...legs).toFixed(2)} px`);
    assert.ok(Math.min(...legs) >= tailPx - 0.15, `${size} px: oldest leg ${Math.min(...legs).toFixed(2)} px`);
    const spokes = spokesOf(svg).map(w => w / unit);
    // A spoke wears in to 2 px and no further; the oldest leg is never under 1.5.
    if (spokes.length > 0) assert.ok(Math.max(...spokes) <= 2.01 && Math.max(...spokes) <= Math.max(...legs), `${size} px: widest spoke ${Math.max(...spokes).toFixed(2)} px`);
    // The newest leg is drawn in the route's own white, the brightest colour on the map.
    assert.equal(pathsOf(svg).at(-1).colour, DARK.trail);
  }
});

test('legs come in three widths a reader can tell apart, and each is cased where it crosses another', () => {
  // Seven legs: a loop of distinct stations, so none collapses.
  const round = [said(0), ...['files', 'shell', 'web', 'browser', 'memory', 'agents', 'skills'].map((id, i) => call(i + 1, id))];
  const state = hubState(round, T0 + 8000);
  assert.equal(state.legs.length, 7);
  const present = new Set(round.map(a => a.station));
  const unit = layout.width / 560;
  const svg = drawHub(state, { layout, size: 560, names, present, motion: 'reduced' });
  const widths = pathsOf(svg).map(p => Math.round((p.width / unit) * 10) / 10);
  // Oldest first: four at the narrowest step, two at the middle one, the newest alone at the widest.
  assert.equal(new Set(widths).size, 3, `widths ${widths.join(' ')}`);
  assert.deepEqual(widths.map(w => [...new Set(widths)].sort((a, b) => a - b).indexOf(w)), [0, 0, 0, 0, 1, 1, 2]);
  const steps = [...new Set(widths)].sort((a, b) => a - b);
  assert.ok(steps[1] - steps[0] >= 0.6 && steps[2] - steps[1] >= 0.8, `steps ${steps.join(', ')} px`);
  // The same three steps in tone.
  assert.equal(new Set(pathsOf(svg).map(p => p.colour)).size, 3);
  // A casing in the ground's colour under every stroke and every head, wider than the stroke it backs.
  const casings = [...svg.matchAll(/<path class="casing" d="[^"]+" fill="none" stroke="(#[0-9a-f]{6})" stroke-width="([\d.]+)"/g)];
  assert.equal(casings.length, 7);
  assert.ok(casings.every(m => m[1] === DARK.ground));
  casings.forEach((m, i) => assert.ok(Number(m[2]) > pathsOf(svg)[i].width + 2 * unit, 'the casing shows on both sides'));
  assert.equal((svg.match(/class="casing" d="M[^"]+Z"/g) ?? []).length, 7);
  // Drawn oldest first, each casing before its own stroke: a newer leg passes over an older one.
  assert.ok(svg.indexOf('class="casing"') < svg.indexOf(pathsOf(svg)[0].d + '" fill="none" stroke="' + pathsOf(svg)[0].colour));
  // A glyph has no room for casings.
  assert.doesNotMatch(drawHub(state, { layout, size: 64, names, present, motion: 'reduced' }), /casing/);
});

test('names are 16 px on screen and stand outside the ring; under 400 px a station has its count and no name', () => {
  const state = hubState(session, T0 + 7500);
  const present = new Set(['you', 'model', 'files', 'shell', 'web']);
  for (const size of [400, 460, 560]) {
    const svg = drawHub(state, { layout, size, names, coreName: 'CLAUDE', present, motion: 'reduced' });
    // Letters are drawn in the map's two inks only, 17.29:1 and 10.78:1 on the ground: a quiet station is the grey one.
    const inks = new Set([...svg.matchAll(/<text [^>]*fill="(#[0-9a-f]{6})"/g)].map(m => m[1]));
    assert.ok([...inks].every(ink => ink === DARK.bone || ink === DARK.ash), `text inks ${[...inks].join(' ')}`);
    assert.ok(ratio(DARK.ash, DARK.ground) >= 8);
    const sizes = [...svg.matchAll(/font-size="([\d.]+)"/g)].map(m => Number(m[1]) / (layout.width / size));
    assert.ok(sizes.length > 0 && sizes.every(px => px >= 15.9), `${size} px wide: smallest text ${Math.min(...sizes).toFixed(1)} px`);
    // A name is further from the core than its station is.
    for (const id of present) {
      const s = layout.stations[id];
      const y = Number(new RegExp(`<text x="[\\d.]+" y="([\\d.]+)"[^>]*>${names[id]}</text>`).exec(svg)[1]);
      assert.ok(Math.abs(y - layout.core.y) > Math.abs(s.y - layout.core.y) - 8, `${id}'s name is outside its station`);
    }
  }
  // Under 400 px no station is named. What is written is the model, in the core, and each station's count.
  const words = svg => [...svg.matchAll(/<text [^>]*>([^<]+)<\/text>/g)].map(m => m[1]).filter(w => !/^\d+$/.test(w));
  assert.deepEqual(words(drawHub(state, { layout, size: 399, names, coreName: 'CLAUDE', present })), ['model']);
  assert.deepEqual(words(drawHub(state, { layout, size: 399, names, coreName: 'CLAUDE', present, model: '' })), []);
});

test('the core says the model first, at 16 px, at every width it fits', () => {
  const present = new Set(['you', 'model', 'files', 'shell', 'web']);
  const recorded = [said(0), call(1, 'model', { label: 'fable 5.2' }), call(2, 'files'), call(3, 'model', { label: 'haiku 5.5', agentId: 'a1' }), call(4, 'model', { label: 'opus 5.5' })];
  // The model of the main loop's last step: a subagent's is not the session's, and a later switch shows.
  assert.equal(hubState(recorded, T0 + 2500).model, 'fable 5.2');
  assert.equal(hubState(recorded, T0 + 3500).model, 'fable 5.2');
  assert.equal(hubState(recorded, T0 + 5000).model, 'opus 5.5');
  const words = (size, more = {}) => {
    const svg = drawHub(hubState(recorded, T0 + 2500, more.state), { layout, size, names: {}, coreName: 'CLAUDE', present, ...more.draw });
    // The core's own words: those written inside its circle.
    const texts = [...svg.matchAll(/<text x="[\d.]+" y="([\d.]+)"[^>]*font-size="([\d.]+)"[^>]*>([^<]+)<\/text>/g)].filter(m => Math.abs(Number(m[1]) - layout.core.y) < layout.core.r).map(m => [m[0], m[2], m[3]]);
    for (const m of texts) assert.ok(Number(m[1]) / (layout.width / size) >= 15.9, `${m[2]} at ${size} px`);
    return texts.map(m => m[2]);
  };
  // With names: the model, then the agent's own name under it.
  assert.deepEqual(words(560), ['fable 5.2', 'CLAUDE']);
  assert.deepEqual(words(460), ['fable 5.2', 'CLAUDE']);
  // At 400 px the letters are larger against the core and the two lines no longer fit: the model stays, alone.
  assert.deepEqual(words(400), ['fable 5.2']);
  assert.deepEqual(words(400, { state: { context: 91 } }), ['fable 5.2']);
  // Once the window nears its limit the second line is how full it is.
  assert.deepEqual(words(560, { state: { context: 91 } }), ['fable 5.2', '91% full']);
  // Without station names the model is still there, broken in two where one line would not fit at 16 px.
  assert.deepEqual(words(340), ['fable', '5.2']);
  assert.deepEqual(words(280), ['fable', '5.2']);
  // Smaller than that, letters of 16 px do not fit the core, so it says nothing sooner than say it small.
  assert.deepEqual(words(240), []);
  assert.deepEqual(words(200), []);
  // A long name keeps its two lines and gives up the line under it; one with nowhere to break is left out for the agent's name.
  assert.deepEqual(words(560, { draw: { model: 'gpt-5.1-codex-max' } }), ['gpt-5.1-', 'codex-max']);
  assert.deepEqual(words(560, { draw: { model: 'averyveryverylongmodelname' } }), ['CLAUDE']);
  // No model known: the agent's name alone, as before.
  assert.deepEqual(words(560, { draw: { model: '' } }), ['CLAUDE']);
});

test('the context ring is quiet until the window nears its limit, and is never red', () => {
  const present = new Set(['you', 'model', 'files', 'shell', 'web']);
  const draw = context => drawHub(hubState(session, T0 + 7500, { context }), { layout, size: 560, names, coreName: 'CLAUDE', present, motion: 'reduced' });
  const ring = svg => /<circle [^>]*stroke="(#[0-9a-f]{6})" stroke-width="([\d.]+)" pathLength="100" stroke-dasharray="(\d+) 100"/.exec(svg);
  const px = w => Number(w) / (layout.width / 560);
  const quiet = ring(draw(22));
  assert.equal(quiet[3], '22');
  // Quieter than any family colour (the dimmest of those is 5.36:1) and thinner than any leg of the route.
  assert.ok(px(quiet[2]) <= 1.5 && ratio(quiet[1], DARK.ground) < 4.5, `under the threshold: ${px(quiet[2]).toFixed(2)} px at ${ratio(quiet[1], DARK.ground).toFixed(2)}:1`);
  assert.doesNotMatch(draw(22), /% full/);
  assert.doesNotMatch(draw(CONTEXT_NEAR - 1), /% full/);
  const near = ring(draw(CONTEXT_NEAR));
  assert.equal(near[1], DARK.ash);
  assert.match(draw(CONTEXT_NEAR), new RegExp(`>${CONTEXT_NEAR}% full<`));
  const full = ring(draw(CONTEXT_FULL + 3));
  assert.equal(full[1], DARK.bone);
  assert.ok(px(full[2]) > px(near[2]), 'heavier again from the second threshold');
  // Even full, the ring is narrower than the newest leg: the route stays the strongest mark.
  assert.ok(px(full[2]) < ROUTE_PX[3][0], `ring ${px(full[2]).toFixed(2)} px against a ${ROUTE_PX[3][0]} px leg`);
  // No call failed in this session, so nothing on the hub is red however full the window is.
  assert.ok(!draw(99).includes(FAULT));
  // Without a figure there is no ring at all.
  assert.equal(ring(drawHub(hubState(session, T0 + 7500), { layout, size: 560, names, present })), null);
});

test('a station wears its family colour at rest, and a station never used gets no ink', () => {
  const state = hubState(session, T0 + 600_000);
  const present = new Set(['you', 'model', 'files', 'shell', 'web']);
  const svg = drawHub(state, { layout, size: 24, names, present, motion: 'reduced' });
  // At a glyph's size: one pad per station used, the person's side square, the rest round.
  assert.equal((svg.match(/<rect x=/g) ?? []).length, 1);
  assert.equal((svg.match(/<circle cx="[\d.]+" cy="[\d.]+" r="[\d.]+" fill="#/g) ?? []).length, 4 + 1, 'four round pads and the core');
  assert.deepEqual(HUB_ORDER.filter(id => !STATIONS.some(s => s.id === id)), ['screen']);
  // The person's side sits together at the top of the ring: You highest, Your screen in the next place round.
  const byHeight = Object.entries(layout.stations).sort((a, b) => a[1].y - b[1].y).map(([id]) => id);
  assert.equal(byHeight[0], 'you');
  assert.equal(Math.abs(layout.stations.screen.i - layout.order.length) % layout.order.length, 1, 'Your screen is next to You');
  assert.equal(layout.stations.tells, undefined, 'what the agent tells is a lane of You, not a place');
  // Drawn the earlier way, the three sit together.
  const three = Object.entries(hubLayout({ tells: 'station' }).stations).sort((a, b) => a[1].y - b[1].y).slice(0, 3).map(([id]) => id).sort();
  assert.deepEqual(three, ['screen', 'tells', 'you']);
});

test('two-way, You is one station: an arrow in is the person speaking, an arrow out is the agent telling', () => {
  // Two-way is what the hub draws unless told otherwise.
  const two = hubLayout();
  assert.equal(two.tells, 'lane');
  assert.deepEqual(HUB_ORDER_TWO_WAY, HUB_ORDER.filter(id => id !== 'tells'));
  assert.equal(Object.keys(two.stations).length, 11);
  assert.equal(two.stations.tells, undefined);
  // The person asks, the agent reads, reports, runs a command, reports twice more, then edits.
  const talk = [said(0), call(1, 'files'), call(2, 'tells'), call(3, 'shell'), call(4, 'tells'), call(5, 'tells'), call(6, 'files'), call(7, 'tells', { aside: true })];
  const moves = movesOf(boardAt(talk).entries, { tells: 'lane' }).map(m => `${m.from}>${m.to}`);
  // A report is not a place the work went: Files to Shell and Shell to Files are still legs, with the reports between them.
  assert.deepEqual(moves, ['you>core', 'core>files', 'core>you', 'files>shell', 'core>you', 'shell>files']);
  // With Tells you as a station the same stretch is six legs through it, and none between Files and Shell.
  assert.deepEqual(movesOf(boardAt(talk).entries, { tells: 'station' }).map(m => `${m.from}>${m.to}`), ['you>core', 'core>files', 'files>tells', 'tells>shell', 'shell>tells', 'tells>files']);
  // Two reports one after the other are one move, kept fresh by the second.
  const tell = movesOf(boardAt(talk).entries, { tells: 'lane' })[4];
  assert.deepEqual([(tell.made - T0) / 1000, (tell.at - T0) / 1000], [4, 5]);
  // A reply with no call in between: in, then out, and the stretch still waits for its first call.
  assert.deepEqual(movesOf([said(0), call(1, 'tells'), call(2, 'shell')], { tells: 'lane' }).map(m => `${m.from}>${m.to}`), ['you>core', 'core>you', 'core>shell']);

  const state = hubState(talk, T0 + 8000, { tells: 'lane' });
  assert.deepEqual([state.stations.you.count, state.stations.you.told], [1, 4]);
  assert.equal(state.stations.tells, undefined);
  // In and out keep to their own sides of the spoke.
  const into = hubLeg(two, { from: 'you', to: 'core' });
  const outward = hubLeg(two, { from: 'core', to: 'you' });
  assert.ok(Math.abs(into.p0.x - outward.p2.x) >= 10, 'two lanes');
  const svg = drawHub(state, { layout: two, size: 560, names, coreName: 'CLAUDE', present: new Set(talk.map(a => a.station)), motion: 'reduced' });
  // You says which count is which, and there is no Tells you on the ring.
  // Each count stands beside its own lane: said to the left of the lane in, told to the right of the lane out.
  const beside = Object.fromEntries([...svg.matchAll(/<text x="([\d.]+)" y="[\d.]+" text-anchor="(\w+)"[^>]*>(\d+ (?:said|told))<\/text>/g)].map(m => [m[3], { x: Number(m[1]), anchor: m[2] }]));
  assert.deepEqual(Object.keys(beside), ['1 said', '4 told']);
  assert.ok(beside['1 said'].x < two.core.x && beside['1 said'].anchor === 'end' && beside['4 told'].x > two.core.x && beside['4 told'].anchor === 'start');
  // You's name stands alone above it, so it cannot run into Your screen's name or Model's.
  assert.doesNotMatch(svg, /said · /);
  assert.doesNotMatch(svg, />Tells you</);
  // At rest the spoke is two lanes, each with a head: one pointing in, one pointing out.
  assert.equal((svg.match(/class="lane" d="M[^"]+Z"/g) ?? []).length, 2);
  // A session that only ever reported still draws You.
  assert.match(drawHub(hubState([call(1, 'tells')], T0 + 2000, { tells: 'lane' }), { layout: two, size: 560, names, present: new Set(['tells']) }), />You</);
  // A state made the earlier way, drawn on the two-way ring, loses its legs to Tells you and nothing else.
  const mixed = drawHub(hubState(talk, T0 + 8000, { tells: 'station' }), { layout: two, size: 560, names, present: new Set(talk.map(a => a.station)), motion: 'reduced' });
  assert.match(mixed, /<svg /);
  // Text stays 16 px, the longer count line included.
  const sizes = [...svg.matchAll(/font-size="([\d.]+)"/g)].map(m => Number(m[1]) / (two.width / 560));
  assert.ok(sizes.every(v => v >= 15.9));
});

test('every station on the hub can be pressed: a control over the node and its name, 40 px or more', () => {
  const present = new Set(['you', 'tells', 'model', 'files', 'shell', 'web', 'screen']);
  const boxes = hubBoxes(layout, present);
  // One control per station the session used; what the agent tells has none, it is part of You.
  assert.deepEqual(boxes.map(b => b.id), ['you', 'model', 'files', 'shell', 'web', 'screen']);
  // A session that only ever reported still has You to press.
  assert.deepEqual(hubBoxes(layout, new Set(['tells', 'shell'])).map(b => b.id), ['you', 'shell']);
  const num = v => Number(v.replace('%', ''));
  for (const b of boxes) {
    const s = layout.stations[b.id];
    const [left, top, width, height] = [num(b.left) * layout.width / 100, num(b.top) * layout.height / 100, num(b.width) * layout.width / 100, num(b.height) * layout.height / 100];
    // The node is inside it, whichever side the name stands on.
    assert.ok(left <= s.x - s.r && left + width >= s.x + s.r && top <= s.y - s.r && top + height >= s.y + s.r, `${b.id}'s node is inside its control`);
    assert.ok(top >= 0 && top + height <= layout.height && left >= 0 && left + width <= layout.width, `${b.id}'s control is on the map`);
    // On a map 300 px wide, the narrowest the page draws, the control is still 40 px each way.
    assert.ok(width * (300 / layout.width) >= 40 && height * (300 / layout.width) >= 40, `${b.id}: ${Math.round(width * 300 / layout.width)} by ${Math.round(height * 300 / layout.width)} px at 300`);
  }
  // No two controls overlap by more than a sliver: a press lands on one station.
  const rect = b => [num(b.left), num(b.top), num(b.left) + num(b.width), num(b.top) + num(b.height)];
  const all = hubBoxes(layout, new Set(HUB_ORDER)).map(rect);
  for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) {
    const w = Math.min(all[i][2], all[j][2]) - Math.max(all[i][0], all[j][0]);
    const h = Math.min(all[i][3], all[j][3]) - Math.max(all[i][1], all[j][1]);
    assert.ok(w <= 0 || h <= 0 || w * h < 12, `controls ${i} and ${j} overlap ${w.toFixed(1)}% by ${h.toFixed(1)}%`);
  }
  const core = hubCoreBox(layout);
  assert.ok(num(core.width) * 300 / 100 >= 40);
  // A station drawn before anything has happened at it has its name and no "0".
  const idle = drawHub(hubState(session, T0 + 7500), { layout, size: 560, names, present: new Set(HUB_ORDER) });
  assert.match(idle, />Memory</);
  assert.doesNotMatch(idle, />0</);
  // The pressed station is ringed in the drawing, round its node, in the page's accent; no other station is.
  const state = hubState(session, T0 + 7500);
  const ringed = svg => (svg.match(/class="pressed"/g) ?? []).length;
  assert.equal(ringed(drawHub(state, { layout, size: 560, names, present, pressed: 'shell' })), 1);
  assert.match(drawHub(state, { layout, size: 560, names, present, pressed: 'you' }), /<rect [^>]*class="pressed" fill="none" stroke="#72e6ef"/);
  assert.equal(ringed(drawHub(state, { layout, size: 560, names, present })), 0);
  assert.equal(ringed(drawHub(state, { layout, size: 560, names, present, pressed: 'browser' })), 0, 'a station the session never used cannot be pressed');
});

test('a live view that keeps only the newest calls draws the counts it was given', () => {
  // The pane holds eighty entries of a session of thousands, and a running count per station.
  const kept = [said(0), call(1, 'files'), call(2, 'tells'), call(3, 'shell')];
  const state = hubState(kept, T0 + 5000, { totals: { you: 41, tells: 122, files: 77, shell: 245, screen: 3 } });
  assert.deepEqual([state.stations.you.count, state.stations.you.told, state.stations.files.count, state.stations.shell.count, state.stations.screen.count], [41, 122, 77, 245, 3]);
  // The route and the light still come from the calls themselves.
  assert.deepEqual(state.legs.map(l => `${l.from}>${l.to}`), ['you>core', 'core>files', 'core>you', 'files>shell']);
  assert.ok(state.stations.shell.level > 0 && state.stations.screen.level === 0);
  // Drawn the earlier way the same totals keep Tells you as its own count.
  assert.equal(hubState(kept, T0 + 5000, { tells: 'station', totals: { tells: 122 } }).stations.tells.count, 122);
  // Those counts are in the picture wherever a figure fits: with the names from 400 px, alone from 280, and not under that.
  const layout = hubLayout();
  const figures = size => [...drawHub(state, { layout, size, model: 'fable 5.2', present: new Set(layout.order) }).matchAll(/<text [^>]*>([^<]+)<\/text>/g)].map(m => m[1]);
  for (const n of ['77', '245', '3']) assert.ok(figures(440).includes(n) && figures(300).includes(n), `${n} at 440 and 300 px`);
  assert.ok(figures(440).includes('41 said') && figures(440).includes('122 told'));
  assert.ok(figures(300).includes('41') && figures(300).includes('122'));
  assert.deepEqual(figures(300).filter(w => !/^\d+$/.test(w)), ['fable', '5.2']);
  // A station with nothing at it has no figure, and every figure is 16 px at the width it is drawn for.
  assert.ok(!figures(300).includes('0'));
  const sizes = [...drawHub(state, { layout, size: 300, model: 'fable 5.2', present: new Set(layout.order) }).matchAll(/font-size="([\d.]+)"/g)].map(m => Number(m[1]) * 300 / layout.width);
  assert.ok(Math.min(...sizes) >= 15.9, `smallest text ${Math.min(...sizes)} px`);
  assert.deepEqual(figures(260).filter(w => /^\d+$/.test(w)), []);
});

test('pressed on the hub, You lists what the person said and what the agent told, and counts them apart', () => {
  const talk = [said(0), call(1, 'files'), call(2, 'tells'), call(3, 'shell'), call(4, 'tells'), said(5)];
  const at = T0 + 60_000;
  const you = rowsFor(talk, 'you', at, { tells: 'lane' });
  assert.deepEqual([you.total, you.told], [4, 2]);
  assert.deepEqual(you.rows.map(r => r.action.station), ['you', 'tells', 'tells', 'you']);
  // The hub's own figures for the same moment.
  const st = hubState(talk, at).stations.you;
  assert.deepEqual([st.count, st.told], [you.total - you.told, you.told]);
  // As recorded, for the board: the two are two stations.
  assert.equal(rowsFor(talk, 'you', at).total, 2);
  assert.equal(rowsFor(talk, 'tells', at).total, 2);
  // Every other station is untouched by the option.
  assert.equal(rowsFor(talk, 'shell', at, { tells: 'lane' }).total, 1);
  assert.equal(rowsFor(talk, '', at, { tells: 'lane' }).total, 6);
});

// ─── The ribbon ─────────────────────────────────────────────────────────────

const rects = svg => [...svg.matchAll(/<rect x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)" fill="(#[0-9a-f]{6}|none)"/g)].map(m => ({ x: Number(m[1]), y: Number(m[2]), w: Number(m[3]), h: Number(m[4]), fill: m[5] }));

test('the ribbon is the calls in order, newest at the right edge, in the colours of the hub', () => {
  const failed = call(8, 'shell', { status: 'err' });
  const beside = call(9, 'tells', { aside: true });
  const cells = ribbonOf([...session, failed, beside, woke(10, 'task')], T0 + 60_000);
  // The model is left out, as on the route and the tape.
  assert.deepEqual(cells.map(c => c.station), ['you', 'files', 'shell', 'files', 'shell', 'web', 'shell', 'tells', 'hooks']);
  assert.deepEqual(cells.map(c => c.kind), ['person', 'call', 'call', 'call', 'call', 'call', 'call', 'call', 'wake']);
  const drawn = rects(drawRibbon(cells, { width: 320, height: 20 }));
  assert.equal(drawn.length, cells.length);
  // Oldest to newest, left to right, and the newest ends at the right edge.
  assert.deepEqual(drawn.map(r => r.x), [...drawn.map(r => r.x)].sort((a, b) => a - b));
  assert.ok(320 - (drawn.at(-1).x + drawn.at(-1).w) <= ribbonCell(20).w);
  const [person, read, , , , fetch, fault, aside, wake] = drawn;
  assert.deepEqual([person.fill, person.h], [KIND.you, 20], 'the person: full height, white');
  assert.deepEqual([read.fill, fetch.fill], [KIND.files, KIND.out]);
  assert.ok(read.h < 20 && read.h >= 10, 'a call is three fifths of the height');
  assert.deepEqual([fault.fill, fault.h], [FAULT, 20], 'a failed call: full height, red');
  assert.ok(aside.h < read.h, 'beside the main loop: shorter');
  assert.ok(wake.w < person.w && wake.fill === KIND.own, 'a wake nobody typed: narrow, grey');
});

test('the ribbon in slots: a run of calls a slot, each slot the same share of the width, the held station underlined', () => {
  const cell = (station, more = {}) => ({ station, family: familyOfStation(station), kind: 'call', fault: false, running: false, beside: false, changes: false, ...more });
  const runs = [
    { station: 'files', cells: [cell('files'), cell('files')] },
    { station: 'shell', cells: Array.from({ length: 11 }, () => cell('shell')) },
    { station: 'you', cells: [cell('you', { kind: 'person' })] },
  ];
  for (const [width, slots] of [[440, 10], [300, 5]]) {
    const svg = drawSlotRibbon(runs, { width, height: 20, slots, held: 'shell' });
    const slot = width / slots;
    const marks = rects(svg).filter(r => r.w < slot && r.h > 2);
    // Fewer runs than slots fill from the right: the newest run is in the last slot, and every mark is inside its own.
    const bySlot = marks.map(m => Math.floor(m.x / slot));
    assert.deepEqual([...new Set(bySlot)], [slots - 3, slots - 2, slots - 1], `${width} px`);
    assert.ok(marks.every(m => m.x >= Math.floor(m.x / slot) * slot && m.x + m.w <= (Math.floor(m.x / slot) + 1) * slot));
    // Two reads, the newest eight of eleven commands, one message; none under 2 px wide.
    assert.deepEqual([slots - 3, slots - 2, slots - 1].map(k => bySlot.filter(b => b === k).length), [2, SLOT_CALLS, 1]);
    assert.ok(marks.every(m => m.w >= 2));
    // One bar, under the held station's slot and no other.
    const bars = [...svg.matchAll(/<rect class="held" x="([\d.]+)" y="18" width="([\d.]+)" height="2"/g)];
    assert.equal(bars.length, 1);
    assert.equal(Math.floor(Number(bars[0][1]) / slot), slots - 2);
  }
  assert.ok(!drawSlotRibbon(runs, { width: 440, slots: 10 }).includes('class="held"'));
});

test('a smaller ribbon holds fewer calls and never a cell under 3 px', () => {
  const heights = { 160: 14, 96: 10, 64: 10, 48: 8, 32: 8, 24: 8 };
  const held = Object.entries(heights).map(([w, h]) => ribbonCapacity(Number(w), h));
  assert.deepEqual(held, [...held].sort((a, b) => a - b), `calls held: ${held.join(', ')}`);
  assert.deepEqual(held, [6, 8, 12, 13, 19, 20]);
  for (const h of [8, 10, 14, 20]) assert.ok(ribbonCell(h).w >= 3);
  const many = Array.from({ length: 80 }, (_, i) => call(i, i % 2 ? 'files' : 'shell'));
  const svg = drawRibbon(ribbonOf(many, T0 + 600_000, 80), { width: 24, height: 8 });
  const cells = rects(svg);
  assert.equal(cells.length, 6);
  assert.ok(cells.every(c => c.x >= 0 && c.x + c.w <= 24 && c.w === 3));
});

// ─── The page ───────────────────────────────────────────────────────────────

test('a call is one set on the list, the tape and the ribbon: the model\'s steps are counted apart', () => {
  const at = T0 + 60_000;
  const every = rowsFor(session, '', at);
  assert.equal(every.total, 6);
  assert.equal(every.steps, 2);
  assert.ok(every.rows.every(r => r.action.station !== 'model'));
  // The same six the tape and the ribbon draw.
  assert.equal(tapeOf(session, at).length, every.total);
  assert.equal(ribbonOf(session, at).length, every.total);
  // Under Model the steps are the list.
  assert.equal(rowsFor(session, 'model', at).total, 2);
  assert.equal(rowsFor(session, 'model', at).steps, 0);
});

test('the full-size hub holds a leg as long as its thumbnail does during a replay', () => {
  const setup = setupFrom({ theme: 'dark' });
  const trails = svg => (svg.match(new RegExp(`<path d="[^"]+" fill="none" stroke="${DARK.trail}"`, 'g')) ?? []).length;
  // Five minutes after the last call: a paused frame of a 60x replay.
  const at = T0 + 7000 + 300_000;
  const board = boardAt(session, at);
  assert.equal(trails(drawMap(board, at, setup)), 0, 'at lot-map\'s own 40 s hold the route is gone');
  const hold = holdFor(60);
  assert.equal(trails(drawMap(board, at, { ...setup, trail: { hold, fade: hold / 2 } })), 4, 'with the replay\'s hold it is whole');
  // And it is not the faintest line on the map: 1.6 px at least, where lot-map drew 1.1.
  const widths = [...drawMap(board, at, { ...setup, trail: { hold, fade: hold / 2 } }).matchAll(new RegExp(`stroke="${DARK.trail}" stroke-width="([\\d.]+)"`, 'g'))].map(m => Number(m[1]));
  assert.ok(Math.min(...widths) >= 1.6 && Math.max(...widths) >= 2.4);
});

test('two-way on the tape: what the agent told sits in You\'s lane and is off the agent\'s path', () => {
  const talk = [said(0), call(1, 'files'), call(2, 'tells'), call(3, 'shell')];
  const rows = tapeOf(talk, T0 + 60_000);
  const lanes = ['you', 'tells', 'files', 'shell'];
  const laneNames = svg => [...svg.matchAll(/text-anchor="end"[^>]*>([^<]+)</g)].map(m => m[1]);
  assert.deepEqual(laneNames(drawTape(rows, { width: 600, names, lanes })), ['You', 'Tells you', 'Files', 'Shell']);
  const svg = drawTape(rows, { width: 600, names, lanes, tells: 'lane' });
  assert.deepEqual(laneNames(svg), ['You', 'Files', 'Shell']);
  // The path is Files to Shell, two points: the report between them is not a stop.
  const path = /<path d="(M[^"]+)" fill="none" stroke="#[0-9a-f]{6}" stroke-width="1.3"/.exec(svg)[1];
  assert.equal(path.split('L').length, 2);
  // Drawn the earlier way it runs through Tells you: three points.
  assert.equal(/<path d="(M[^"]+)" fill="none" stroke="#[0-9a-f]{6}" stroke-width="1.3"/.exec(drawTape(rows, { width: 600, names, lanes }))[1].split('L').length, 3);
  // The person's diamond and the agent's dot share the lane, at the same height.
  const youY = Number(/<text x="[\d.]+" y="([\d.]+)"[^>]*>You</.exec(svg)[1]) - 5.5;
  assert.match(svg, new RegExp(`<circle cx="[\\d.]+" cy="${youY}" r="3.2"`));
});

test('the tape marks a wake, breaks its line there, and can wear the family colours', () => {
  const actions = [...session, woke(20, 'task'), call(21, 'files'), call(22, 'shell')];
  const rows = tapeOf(actions, T0 + 60_000);
  assert.equal(rows.filter(r => r.wake).length, 1);
  const svg = drawTape(rows, { width: 600, names, kinds: true });
  // Two runs of the agent's path: before the wake and after it.
  assert.equal((svg.match(/stroke-linejoin="round"\/>/g) ?? []).length, 2);
  assert.match(svg, new RegExp(`fill="${KIND.files}"`));
  assert.match(svg, new RegExp(`fill="${KIND.shell}"`));
  assert.doesNotMatch(drawTape(rows, { width: 600, names }), new RegExp(`fill="${KIND.shell}"`));
  // A long lane name is not cut off by the gutter.
  const wide = drawTape(tapeOf(seatScreen([call(1, 'shell', { tool: 'mcp__terminal__read_terminal' })]), T0 + 60_000), { width: 600, names, lanes: ['screen'] });
  const x = Number(/<text x="([\d.]+)"[^>]*text-anchor="end"[^>]*>Your screen</.exec(wide)[1]);
  assert.ok(x >= 'Your screen'.length * 8.6, `the name ends at ${x}`);
});

test('the address knows the directions look', () => {
  assert.deepEqual(LOOKS, ['sizes', 'directions']);
  assert.equal(readMapRoute('?session=s&look=directions').look, 'directions');
  assert.equal(readMapRoute('?session=s&look=other').look, '');
  assert.equal(mapHref('/', { session: 's', look: 'directions' }), '/map?session=s&look=directions');
});
