/**
 * SessionDirections — the candidate directions for the work map, side by side
 * on the session and moment the page is showing. The map on the left of the
 * page is the hub as it is; everything here is a candidate.
 *
 * A comparison page, not product UI: each figure names what it is and gives
 * the numbers that were measured from its own drawing. Every picture is an
 * image, as on the map.
 */

import { useMemo, useState } from 'react';
import { drawFlow, drawTape, flowState, tapeHeight, tapeOf } from '../../shared/workmap/flow.js';
import { CONTEXT_FULL, CONTEXT_NEAR, ROUTE_PX, drawHub, hubLayout, hubLevel, hubState, movesOf } from '../../shared/workmap/hub.js';
import { FAMILIES, FAMILY_NAMES, FAULT, HEAD_HUES, KIND, familyOfStation, seatScreen } from '../../shared/workmap/kinds.js';
import { drawPortrait, portraitAspect, portraitState } from '../../shared/workmap/portrait.js';
import { coloursShown, drawRibbon, ribbonCapacity, ribbonOf } from '../../shared/workmap/ribbon.js';
import { mapHref, rowsFor, svgDataUri } from './session-map.js';

export const GLYPH_SIZES = [160, 96, 64, 48, 32, 24];
const SCREEN_NAME = 'Your screen';
/** A frame this long after an event shows the leg it made. */
const AFTER_MS = 150;
/** The ribbon's height under a hub of a given width: tall enough to tell a call from a call beside the loop. */
const ribbonHeight = size => (size >= 300 ? 20 : size >= 128 ? 14 : size >= 64 ? 10 : 8);
/** Moves in the sequence strip, and the sizes it is drawn at. */
const STRIP_MOVES = 6;
const STRIP_SIZES = [64, 48, 32, 24];
/** The stations whose list in the pane is pages: the three a person asks "where did it go" of. */
const PAGE_STATIONS = ['web', 'browser', 'screen'];

const Img = ({ svg, width, aspect, label }) => <img src={svgDataUri(svg)} alt={label ?? ''} draggable="false" style={{ width, aspectRatio: String(aspect) }} />;

function Ribbon({ cells, width, height }) {
  return <Img svg={drawRibbon(cells, { width, height })} width={width} aspect={width / height} />;
}

/** What the ribbon's shapes mean, drawn with the ribbon's own cells. */
function RibbonKey() {
  const cell = more => ({ station: 'shell', family: 'shell', kind: 'call', fault: false, running: false, beside: false, ...more });
  const items = [
    [cell({ kind: 'person', family: 'you' }), 'the person spoke'],
    [cell({ kind: 'wake', family: 'own' }), 'a task or the harness woke the agent'],
    [cell({}), 'a call, in its station\u2019s colour'],
    [cell({ beside: true }), 'beside the main loop: a subagent\u2019s call, or a report sent along with other work'],
    [cell({ fault: true }), 'the call failed'],
  ];
  return (
    <ul className="sd-key sd-shapes">
      {items.map(([c, said]) => (
        <li key={said}>
          <Img svg={drawRibbon([c], { width: 8, height: 20 })} width={8} aspect={8 / 20} />
          {said}
        </li>
      ))}
    </ul>
  );
}

/** The newest event of a kind at or before `at`, and the frame that shows what it led to. */
function lastEvent(actions, at, test) {
  for (let i = actions.length - 1; i >= 0; i--) {
    const a = actions[i];
    if (a.startedAt > at || !test(a)) continue;
    // A message or a wake is drawn with the first call it led to, when there is one before the moment shown.
    const after = a.from === 'inbound' ? actions.slice(i + 1).find(b => b.agentId === undefined && b.station !== 'model' && b.aside !== true) : undefined;
    // The next arrival is another stretch: this one then led to no call at all.
    const next = after && after.from !== 'inbound' && after.startedAt <= at ? after : undefined;
    return { action: a, frame: Math.min(at, (next ? next.startedAt : a.startedAt) + AFTER_MS) };
  }
  return null;
}

/**
 * The pane as a column of its own width: the ribbon, the map, station buttons, and what the pressed one did.
 * `buttons` is `all` (a button per station the session used, as the forked pane has now) or `pages`
 * (the three stations whose list is pages, always there so none of them moves).
 */
function PaneMock({ width, buttons, actions, at, state, cells, drawOptions, stamp, counts, session }) {
  const [pressed, setPressed] = useState('');
  const layout = drawOptions.layout;
  const ids = buttons === 'pages' ? PAGE_STATIONS : Object.keys(layout.stations).filter(id => counts[id] > 0);
  const shown = pressed && ids.includes(pressed) ? pressed : '';
  const list = useMemo(() => rowsFor(actions, shown, at).rows.slice(0, 6), [actions, shown, at]);
  const pages = PAGE_STATIONS.includes(shown);
  return (
    <div className="sd-pane" style={{ width }}>
      <Ribbon cells={cells} width={width} height={20} />
      <Img svg={drawHub(state, { ...drawOptions, size: width })} width={width} aspect={layout.width / layout.height} />
      <div className="sd-stations" role="group" aria-label="Stations">
        {ids.map(id => (
          <button key={id} type="button" aria-pressed={shown === id} onClick={() => setPressed(shown === id ? '' : id)}>
            <i style={{ background: KIND[familyOfStation(id)] }} />
            <span>{drawOptions.names[id]}</span>
            <b>{counts[id] ?? 0}</b>
          </button>
        ))}
      </div>
      <h4>{shown ? `${drawOptions.names[shown]}: ${pages ? 'pages' : 'calls'}, newest first` : 'Calls, newest first'}</h4>
      <ol className="sd-rows">
        {list.map(({ key, action }) => (
          <li key={key}>
            <time>{stamp(action.startedAt)}</time>
            <span>{pages && action.detail ? action.detail : action.label}</span>
          </li>
        ))}
      </ol>
      <a className="sd-bounce" href={mapHref('/', { session, station: PAGE_STATIONS.includes(shown) && shown !== 'screen' ? shown : '', at })}>
        Whole session in the Explorer
      </a>
    </div>
  );
}

export default function SessionDirections({ map, at, speed, names: stationNames, coreName, stamp, reducedMotion, context, hold, width, now, before }) {
  const motion = reducedMotion ? 'reduced' : 'full';
  const names = useMemo(() => ({ ...stationNames, screen: SCREEN_NAME }), [stationNames]);
  // The candidate: You is one station with two lanes on its spoke. The reading with Tells you as its own station is kept beside it.
  const layout = useMemo(() => hubLayout(), []);
  const stationLayout = useMemo(() => hubLayout({ tells: 'station' }), []);
  // The candidate reading: what the person has open is its own station.
  const actions = useMemo(() => seatScreen(map.actions), [map.actions]);
  const present = useMemo(() => new Set(actions.map(a => a.station)), [actions]);
  const counts = useMemo(() => {
    const n = {};
    for (const a of actions) if (a.startedAt <= at) n[a.station] = (n[a.station] ?? 0) + 1;
    return n;
  }, [actions, at]);

  const timing = { tau: 4000 * speed, hold, travel: 700 * speed, tells: 'lane' };
  const state = useMemo(() => hubState(actions, at, { ...timing, context: context?.percent }), [actions, at, speed, hold, context?.percent]);
  const drawOptions = useMemo(() => ({ layout, names, coreName, present, motion }), [layout, names, coreName, present, motion]);
  const aspect = layout.width / layout.height;

  const hubWidth = Math.max(400, Math.min(560, Math.round(width) - 4));
  const cells = useMemo(() => ribbonOf(actions, at, 80, 'place'), [actions, at]);
  const headCells = useMemo(() => ribbonOf(actions, at, 80, 'head'), [actions, at]);

  // Measured from the drawing itself.
  const level = hubLevel(hubWidth);
  const made = state.made;
  const drawn = state.legs.length;

  // Who started it: the newest of each kind of arrival, each on its own frame.
  const frames = useMemo(() => {
    const pick = [
      ['The person spoke', lastEvent(actions, at, a => a.station === 'you' && a.from === 'inbound')],
      ['A task or the harness woke it', lastEvent(actions, at, a => a.wake !== undefined && a.from === 'inbound')],
      ['It looked at what the person has open', lastEvent(actions, at, a => a.station === 'screen')],
    ];
    return pick.map(([title, found]) => ({
      title,
      found,
      svg: found ? drawHub(hubState(actions, found.frame, { ...timing, travel: 1 }), { ...drawOptions, size: 220, motion: 'reduced' }) : null,
    }));
  }, [actions, at, speed, hold, drawOptions]);
  // The newest report the agent made in a step of its own, drawn both ways on the frame where it was made.
  const told = useMemo(() => {
    const found = lastEvent(actions, at, a => a.station === 'tells' && a.aside !== true && a.agentId === undefined);
    if (!found) return null;
    const still = { tau: 4000 * speed, hold, travel: 1 };
    return {
      found,
      lane: drawHub(hubState(actions, found.frame, { ...still, tells: 'lane' }), { ...drawOptions, size: 340, motion: 'reduced' }),
      station: drawHub(hubState(actions, found.frame, { ...still, tells: 'station' }), { ...drawOptions, layout: stationLayout, size: 340, motion: 'reduced' }),
    };
  }, [actions, at, speed, hold, drawOptions, stationLayout]);
  const tally = useMemo(() => {
    let person = 0;
    let task = 0;
    let harness = 0;
    for (const a of actions) {
      if (a.startedAt > at || a.from !== 'inbound') continue;
      if (a.station === 'you') person++;
      else if (a.wake === 'task') task++;
      else if (a.wake === 'harness') harness++;
    }
    return { person, task, harness, screen: counts.screen ?? 0 };
  }, [actions, at, counts]);

  // Colour: how much of the sequence each model shows, over every call so far.
  const shown = useMemo(() => {
    const all = n => ribbonOf(actions, at, actions.length, n);
    return { place: coloursShown(all('place')), head: coloursShown(all('head')) };
  }, [actions, at]);
  const portrait = useMemo(() => portraitState(map.actions, at, { tau: 4000 * speed, travel: 900 * speed }), [map.actions, at, speed]);

  // Sequence, not state: the last six moves, each on the frame where it was made.
  const strip = useMemo(() => {
    const upTo = [];
    for (const a of actions) {
      if (a.startedAt > at) break;
      upTo.push(a);
    }
    return movesOf(upTo, { tells: 'lane' }).slice(-STRIP_MOVES).map(move => {
      const t = Math.min(at, move.made + AFTER_MS);
      const still = { ...timing, travel: 1 };
      return { move, t, hub: hubState(actions, t, still), flow: flowState(map.actions, t, still), cells: ribbonOf(actions, t, 40, 'place') };
    });
  }, [actions, map.actions, at, speed, hold]);
  const place = id => (id === 'core' ? coreName : names[id]);

  const lanes = useMemo(() => [...present].filter(id => id !== 'model' && id !== 'tells'), [present]);
  const tapeWidth = Math.max(300, Math.round(width) - 4);
  const tape = useMemo(() => {
    const rows = tapeOf(actions, at, 60);
    return { svg: drawTape(rows, { width: tapeWidth, names, capacity: 60, lanes, kinds: true, tells: 'lane' }), aspect: tapeWidth / tapeHeight(rows, lanes), shown: rows.length };
  }, [actions, at, tapeWidth, names, lanes]);

  return (
    <section className="sm-directions" aria-label="Directions">
      <figure className="sd-fig">
        <figcaption>
          <h3>Route first</h3>
          <p>
            Adopted 2026-11-13: the map on the left is this drawing. Newest leg {ROUTE_PX[level][0]} px, the two before it {ROUTE_PX[level][1]} px, older ones {ROUTE_PX[level][2]} px, spokes 1 to 2 px. {drawn} {drawn === 1 ? 'curve' : 'curves'} for the last {made} {made === 1 ? 'move' : 'moves'}.
            Context ring a faint arc under {CONTEXT_NEAR}%, grey with its figure from there, white from {CONTEXT_FULL}%, never red{context ? `; now ${Math.round(context.percent)}%` : ''}.
          </p>
        </figcaption>
        <h4>Before: lot-map's hub at this moment</h4>
        {before && <img src={before} alt="" draggable="false" style={{ width: Math.min(hubWidth, 460), aspectRatio: String(now.layout.width / now.layout.height) }} />}
        <p className="sd-note">
          On the adopted hub the widest white arrow is the newest move, the next two are a step narrower, older ones narrower again. ×2 on an arrow: that move was made twice among the last {made}.
        </p>
        <RibbonKey />
      </figure>

      <figure className="sd-fig">
        <figcaption>
          <h3>Who started it</h3>
          <p>
            Up to this moment: {tally.person} messages typed by the person, {tally.task} wakes by a task or another session, {tally.harness} by the harness, {tally.screen} calls into what the person has open.
            Hooks counts those {tally.task + tally.harness} wakes with its {Math.max(0, (counts.hooks ?? 0) - tally.task - tally.harness)} hook runs. The {tally.screen} calls at Your screen are filed under Shell, Browser or Network on the hub at the left.
          </p>
        </figcaption>
        {told && (
          <div className="sd-row">
            <div className="sd-cell">
              <h4>You, both ways (chosen): one station, an arrow in and an arrow out</h4>
              <Img svg={told.lane} width={340} aspect={aspect} />
            </div>
            <div className="sd-cell">
              <h4>Before: Tells you as a station of its own</h4>
              <Img svg={told.station} width={340} aspect={aspect} />
            </div>
            <p className="sd-note">
              Both at {stamp(told.found.action.startedAt)}, when the agent reported: {String(told.found.action.label).slice(0, 64)}. Two-way, a report is the outward lane of You's spoke and is not a stop, so the next leg starts from the station the work was at.
            </p>
          </div>
        )}
        <div className="sd-row">
          {frames.map(f => (
            <div key={f.title} className="sd-cell">
              <h4>{f.title}</h4>
              {f.svg ? <Img svg={f.svg} width={220} aspect={aspect} /> : <p className="sd-none">None in this session yet</p>}
              {f.found && (
                <p className="sd-note">
                  {stamp(f.found.action.startedAt)} · {String(f.found.action.label).slice(0, 64)}
                </p>
              )}
            </div>
          ))}
        </div>
      </figure>

      <figure className="sd-fig">
        <figcaption>
          <h3>One colour per kind of work</h3>
          <ul className="sd-key">
            {FAMILIES.map(id => (
              <li key={id}>
                <i style={{ background: KIND[id] }} />
                {FAMILY_NAMES[id]}
              </li>
            ))}
            <li>
              <i style={{ background: FAULT }} />
              Failed
            </li>
          </ul>
        </figcaption>
        <div className="sd-row">
          <div className="sd-cell">
            <h4>By place: the hub is the key</h4>
            <Img svg={drawHub(state, { ...drawOptions, size: 220 })} width={220} aspect={aspect} />
            <Ribbon cells={cells} width={320} height={20} />
            <p className="sd-note">
              {shown.place.seen} of {shown.place.handoffs} handoffs change colour: more is better. A handoff is a change of station in the main loop, or at Files a change between reading and changing a file.
            </p>
          </div>
          <div className="sd-cell">
            <h4>By organ: the head is the key, and the same colours mean other things</h4>
            <Img svg={drawPortrait(portrait, { size: 220, names, motion, hues: HEAD_HUES })} width={220} aspect={portraitAspect(220)} />
            <Ribbon cells={headCells} width={320} height={20} />
            <ul className="sd-key">
              {[['out', 'Eye: takes in (network, browser, a file read)'], ['shell', 'Hand: acts (a command, a file edit)'], ['memory', 'Memory'], ['agents', 'Other agents'], ['you', 'Ear and mouth: the person'], ['own', 'Model, skills, hooks']].map(([id, said]) => (
                <li key={id}>
                  <i style={{ background: KIND[id] }} />
                  {said}
                </li>
              ))}
            </ul>
            <p className="sd-note">
              {shown.head.seen} of {shown.head.handoffs} handoffs change colour
            </p>
          </div>
        </div>
        <h4>Tape in the same colours: last {tape.shown} calls, a lane per station</h4>
        <Img svg={tape.svg} width="100%" aspect={tape.aspect} />
        <p className="sd-note">
          In the You lane a filled diamond is the person speaking and a dot is the agent telling; the agent's path does not pass through them. Hollow diamond: a task or the harness woke the agent. Hollow circle: a subagent's call, or one still running. Small dot: a report sent along with other work. Dashed line: a subagent's own path.
        </p>
      </figure>

      <figure className="sd-fig">
        <figcaption>
          <h3>One moment at small sizes</h3>
        </figcaption>
        <table className="sm-shrink">
          <thead>
            <tr>
              <th scope="col">Width</th>
              {GLYPH_SIZES.map(size => (
                <th key={size} scope="col">
                  {size} px
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr>
              <th scope="row">Hub as it is</th>
              {GLYPH_SIZES.map(size => (
                <td key={size}>
                  <Img svg={drawFlow(now.flow, { ...now.options, layout: now.layout, size, motion })} width={size} aspect={now.layout.width / now.layout.height} />
                </td>
              ))}
            </tr>
            <tr>
              <th scope="row">Hub, candidate</th>
              {GLYPH_SIZES.map(size => (
                <td key={size}>
                  <Img svg={drawHub(state, { ...drawOptions, size })} width={size} aspect={aspect} />
                </td>
              ))}
            </tr>
            <tr>
              <th scope="row">Hub over ribbon</th>
              {GLYPH_SIZES.map(size => (
                <td key={size}>
                  <div className="sd-stack">
                    <Img svg={drawHub(state, { ...drawOptions, size })} width={size} aspect={aspect} />
                    <Ribbon cells={cells} width={size} height={ribbonHeight(size)} />
                  </div>
                </td>
              ))}
            </tr>
            <tr>
              <th scope="row">Ribbon alone</th>
              {GLYPH_SIZES.map(size => (
                <td key={size}>
                  <Ribbon cells={cells} width={size} height={ribbonHeight(size)} />
                </td>
              ))}
            </tr>
            <tr>
              <th scope="row">Calls in the ribbon</th>
              {GLYPH_SIZES.map(size => (
                <td key={size}>{Math.min(cells.length, ribbonCapacity(size, ribbonHeight(size)))}</td>
              ))}
            </tr>
          </tbody>
        </table>
      </figure>

      <figure className="sd-fig">
        <figcaption>
          <h3>Sequence at small sizes</h3>
          <p>The last {strip.length} moves up to this moment, one frame each, oldest to newest. Each column's heading is what the recording says happened; the drawings under it should say the same.</p>
        </figcaption>
        <table className="sm-shrink sd-strip">
          <thead>
            <tr>
              <th scope="col">Width</th>
              {strip.map((f, i) => (
                <th key={i} scope="col">
                  {place(f.move.from)} → {place(f.move.to)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {STRIP_SIZES.map(size => (
              <tr key={`hub-${size}`}>
                <th scope="row">Candidate, {size} px</th>
                {strip.map((f, i) => (
                  <td key={i}>
                    <Img svg={drawHub(f.hub, { ...drawOptions, size, motion: 'reduced' })} width={size} aspect={aspect} />
                  </td>
                ))}
              </tr>
            ))}
            {[48, 24].map(size => (
              <tr key={`now-${size}`}>
                <th scope="row">As it is, {size} px</th>
                {strip.map((f, i) => (
                  <td key={i}>
                    <Img svg={drawFlow(f.flow, { ...now.options, layout: now.layout, size, motion: 'reduced' })} width={size} aspect={now.layout.width / now.layout.height} />
                  </td>
                ))}
              </tr>
            ))}
            {[48, 24].map(size => (
              <tr key={`ribbon-${size}`}>
                <th scope="row">Ribbon, {size} px</th>
                {strip.map((f, i) => (
                  <td key={i}>
                    <Ribbon cells={f.cells} width={size} height={ribbonHeight(size)} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </figure>

      <figure className="sd-fig">
        <figcaption>
          <h3>Sidebar pane</h3>
        </figcaption>
        <div className="sd-row">
          {[['pages', 320], ['pages', 240], ['all', 320], ['all', 240]].map(([buttons, w]) => (
            <div key={`${buttons}-${w}`} className="sd-cell">
              <h4>
                {buttons === 'pages' ? 'Page lists only' : 'Every station a button'}, {w} px wide
              </h4>
              <PaneMock width={w} buttons={buttons} actions={actions} at={at} state={state} cells={cells} drawOptions={drawOptions} stamp={stamp} counts={counts} session={map.session_id ?? map.path} />
            </div>
          ))}
        </div>
      </figure>
    </section>
  );
}

