/**
 * SessionMap — one recorded session as a work map.
 *
 * The drawing is a fork of lot-map's (MIT, see shared/workmap/LICENSE-lot-map).
 * lot-map draws a live Claude Code session from mod events and forgets it when
 * the session ends. This draws from the transcript, so it works for Claude and
 * Codex alike and for a session of any age, and the moment it shows is a
 * position in the record, not "now".
 *
 * The map is one image. Stations are pressed through controls laid over it
 * (session-map.js, stationBoxes), which keeps the drawing out of the DOM: the
 * labels in it come from the corpus, and an image cannot run script.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import AgentBadge from './AgentBadge';
import SessionDirections from './SessionDirections.jsx';
import SessionSizes from './SessionSizes.jsx';
import { apiRequest, fetchSessions } from '../api';
import { boardAt } from '../../shared/workmap/board.js';
import { formatMs, shortModel } from '../../shared/workmap/classify.js';
import { boardLayout, drawFlow, drawTape, flowBoxes, flowCoreBox, flowState, holdFor, ringLayout, tapeHeight, tapeOf } from '../../shared/workmap/flow.js';
import { drawMap } from '../../shared/workmap/draw.js';
import { drawHub, hubBoxes, hubCoreBox, hubLayout, hubState } from '../../shared/workmap/hub.js';
import { seatScreen } from '../../shared/workmap/kinds.js';
import { drawRibbon, ribbonCapacity, ribbonOf } from '../../shared/workmap/ribbon.js';
import { setupFrom } from '../../shared/workmap/setup.js';
import { MAP_PATH, contextAt, tokenText, clockTime, mapHref, readMapRoute, recallIndex, reviewableFiles, rowDetail, rowTarget, rowsFor, spanText, stampFor, svgDataUri } from './session-map.js';
import '../styles/session-map.css';

const BASE = import.meta.env.BASE_URL || '/';
/** A frame this long after a call starts shows its pulse leaving the core. */
const AFTER_START_MS = 120;

function sessionLabel(s) {
  const start = new Date(s.start);
  const day = Number.isFinite(start.getTime()) ? `${start.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${clockTime(start.getTime()).slice(0, 5)}` : '';
  return `${day} · ${s.project || 'no project'} · ${s.provider || 'agent unknown'}`;
}

/** Where a row's link leads, as its tooltip. */
const TARGET_TITLE = { recall: 'Ranked results and what was used', review: 'Diff for this session', reader: 'In the conversation' };

const EMPTY_LIST = { rows: [], total: 0, failed: 0, byAgents: 0, steps: 0, told: 0 };
/** The ribbon under the map: tall enough to tell a call from one beside the main loop. */
const RIBBON_HEIGHT = 20;
const SCREEN_NAME = 'Your screen';
/** Calls the tape holds: enough to see a loop repeat, few enough that each is a mark. */
const TAPE_CALLS = 60;

/** The width an element has on screen, so a drawing can pick its level of detail and keep its names at 16 px. */
function useWidth(fallback) {
  const [width, setWidth] = useState(fallback);
  const observer = useRef(null);
  // A callback ref: the element is not there until the map has loaded, and it is replaced when the session changes.
  const ref = useCallback(node => {
    observer.current?.disconnect();
    observer.current = null;
    if (!node || typeof ResizeObserver === 'undefined') return;
    observer.current = new ResizeObserver(([entry]) => setWidth(Math.max(24, Math.round(entry.contentRect.width))));
    observer.current.observe(node);
  }, []);
  return [ref, width];
}

/** Replay speeds: session seconds per second on screen. */
const SPEEDS = [1, 10, 60, 600];
/** How often a replay or a live view draws a frame. */
const FRAME_MS = 80;
/** How often a live view re-reads the transcript, and how far behind now it draws, so a call arrives before its moment does. */
const LIVE_POLL_MS = 4000;
const LIVE_LAG_MS = 6500;

/** A click the browser should handle itself: a new tab, a new window, a download. */
const leavesThePage = e => e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey;

export default function SessionMap({ isActive, onOpenTranscript }) {
  const [route, setRoute] = useState(() => readMapRoute(window.location.search));
  const [sessions, setSessions] = useState([]);
  const [map, setMap] = useState(null);
  const [error, setError] = useState('');

  // The address is the state: a pressed station or a moved moment rewrites it in place, a new session pushes.
  const go = useCallback((next, { push = false } = {}) => {
    setRoute(prev => {
      const merged = { ...prev, ...next };
      window.history[push ? 'pushState' : 'replaceState']({ tab: 'map' }, '', mapHref(BASE, merged));
      return merged;
    });
  }, []);

  useEffect(() => {
    const onPop = () => {
      if (!MAP_PATH.test(window.location.pathname.slice(BASE.replace(/\/$/, '').length))) return;
      const next = readMapRoute(window.location.search);
      // The tab bar links to a bare /map. Coming back that way keeps the session that was open.
      setRoute(prev => {
        if (next.session || !prev.session) return next;
        window.history.replaceState({ tab: 'map' }, '', mapHref(BASE, prev));
        return prev;
      });
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  useEffect(() => {
    let live = true;
    fetchSessions({ days: 7 })
      .then(body => {
        if (!live) return;
        const list = (body.sessions || []).filter(s => s.session_id);
        setSessions(list);
        // No session named: open the newest, so the address alone is enough to land somewhere.
        if (!readMapRoute(window.location.search).session && list[0]) go({ session: list[0].session_id });
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [go]);

  // A replay or a live view owns the moment while it runs; the address gets it back on pause.
  const [playing, setPlaying] = useState(false);
  const [live, setLive] = useState(false);
  const [speed, setSpeed] = useState(60);
  const [playAt, setPlayAt] = useState(null);
  const [clock, setClock] = useState(0);
  const [refresh, setRefresh] = useState(0);
  const reducedMotion = useMemo(() => typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches, []);
  const frame = useRef({ end: 0, speed: 60 });

  useEffect(() => {
    if (!route.session) return undefined;
    const controller = new AbortController();
    setError('');
    const key = /[/\\]/.test(route.session) ? 'path' : 'session_id';
    apiRequest(`/api/workmap?${key}=${encodeURIComponent(route.session)}`, { signal: controller.signal })
      .then(setMap)
      .catch(e => {
        if (e.name === 'AbortError') return;
        setMap(null);
        setError(e.message || 'The session map could not be read');
      });
    return () => controller.abort();
  }, [route.session, refresh]);

  // What the Memory Desk holds for this session: its recall calls and the files it can show a diff for.
  // Both are optional. Without them every row still opens in the reader.
  const [extras, setExtras] = useState({ calls: new Map(), files: new Set() });
  useEffect(() => {
    setExtras({ calls: new Map(), files: new Set() });
    const session = map?.session_id;
    if (!session || !map.span) return undefined;
    const controller = new AbortController();
    const { signal } = controller;
    const quiet = promise => promise.catch(() => null);
    const from = Math.floor(map.span.first) - 60_000;
    const through = Math.ceil(map.span.last) + 60_000;
    Promise.all([
      quiet(apiRequest(`/api/memory/recall?session=${encodeURIComponent(session)}&from=${from}&through=${through}`, { signal })),
      // Every call in the window too: the desk records some calls with no session (session-map.js, recallIndex).
      quiet(apiRequest(`/api/memory/recall?from=${from}&through=${through}`, { signal })),
      quiet(apiRequest(`/api/memory/session?session=${encodeURIComponent(session)}&hours=2160`, { signal })),
    ]).then(([own, all, desk]) => {
      if (!signal.aborted) setExtras({ calls: recallIndex(own, all), files: reviewableFiles(desk, session) });
    });
    return () => controller.abort();
    // Keyed on the session, not the map: a live view replaces the map every few seconds.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map?.session_id]);

  const setup = useMemo(() => {
    if (!map) return null;
    return { ...setupFrom({ coreName: String(map.provider || 'agent').toUpperCase(), theme: 'dark' }), present: new Set(map.present) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map?.provider, map?.present.join(',')]);

  // The hub as it is drawn since 2026-11-13: You is two-way, and what the person has open is its own station.
  const hub = useMemo(() => hubLayout(), []);
  const seated = useMemo(() => (map ? seatScreen(map.actions) : []), [map]);
  const seatedPresent = useMemo(() => new Set(seated.map(a => a.station)), [seated]);
  const end = map?.span ? map.span.last + 400 : 0;
  const at = map?.span ? (live && playAt !== null ? playAt : Math.min(end, Math.max(map.span.first, playAt ?? route.at ?? end))) : 0;
  frame.current = { end, speed };

  useEffect(() => {
    if (!playing && !live) return undefined;
    const started = performance.now();
    let last = started;
    const timer = setInterval(() => {
      const now = performance.now();
      const dt = now - last;
      last = now;
      setClock(now - started);
      if (live) setPlayAt(Date.now() - LIVE_LAG_MS);
      else {
        setPlayAt(prev => {
          const next = (prev ?? frame.current.end) + dt * frame.current.speed;
          if (next >= frame.current.end) setPlaying(false);
          return Math.min(next, frame.current.end);
        });
      }
    }, FRAME_MS);
    return () => clearInterval(timer);
  }, [playing, live]);

  useEffect(() => {
    if (!live) return undefined;
    const timer = setInterval(() => setRefresh(n => n + 1), LIVE_POLL_MS);
    return () => clearInterval(timer);
  }, [live]);

  // A replay that reaches the end, or is paused, hands its moment back to the address.
  useEffect(() => {
    if (playing || live || playAt === null) return;
    go({ at: playAt });
    setPlayAt(null);
  }, [playing, live, playAt, go]);

  const play = () => {
    setLive(false);
    // Starting from the end would be a replay of nothing: start over.
    if (!playing && map?.span && at >= end - 1000) setPlayAt(map.span.first);
    else if (!playing) setPlayAt(at);
    setPlaying(p => !p);
  };
  const follow = () => {
    setPlaying(false);
    setLive(l => !l);
  };
  const scrub = value => (playing ? setPlayAt(value) : (setLive(false), go({ at: value })));
  const onBoard = route.layout === 'board';
  // On the hub what the agent tells the person is part of You, so an address that names it opens You.
  const asked = !onBoard && route.station === 'tells' ? 'you' : route.station;
  const inPlay = onBoard ? map?.present.includes(asked) : hub.stations[asked] !== undefined && (seatedPresent.has(asked) || (asked === 'you' && seatedPresent.has('tells')));
  const station = map && asked && inPlay ? asked : '';

  // The context window at this moment: the ring round the core, as lot-map draws it live.
  const context = useMemo(() => (map ? contextAt(map, at) : null), [map, at]);

  // The flow: each station's light and the route, for the board, the small sizes and the tape.
  const pace = live ? 1 : speed;
  const hold = holdFor(pace);

  const [stageRef, stageWidth] = useWidth(460);
  const [sideRef, sideWidth] = useWidth(640);
  const names = useMemo(() => ({ ...(setup?.t.stations ?? {}), screen: SCREEN_NAME }), [setup]);
  const coreName = String(map?.provider || 'agent').toUpperCase();

  const src = useMemo(() => {
    if (!map || !setup) return '';
    const state = hubState(seated, at, { tau: 4000 * pace, hold, travel: 700 * pace, context: context?.percent });
    return svgDataUri(drawHub(state, { layout: hub, size: stageWidth, names, coreName, present: seatedPresent, motion: reducedMotion ? 'reduced' : 'full', pressed: onBoard ? '' : station }));
  }, [map, setup, seated, seatedPresent, hub, at, pace, hold, context?.percent, stageWidth, names, coreName, reducedMotion, station, onBoard]);

  // lot-map's hub, which this view drew until 2026-11-13: kept for the two looks that compare against it.
  const beforeSrc = useMemo(() => {
    if (!map || !setup || route.look === '') return '';
    const board = boardAt(map.actions, at, { ...(map.model ? { model: map.model } : {}), ...(context ? { context: context.percent } : {}) });
    return svgDataUri(drawMap(board, at, { ...setup, trail: { hold, fade: hold / 2 } }));
  }, [map, setup, at, context, hold, route.look]);

  // The same calls in one row under the map, in the stations' colours.
  const ribbon = useMemo(() => {
    if (!map) return null;
    const width = Math.max(120, stageWidth);
    const cells = ribbonOf(seated, at, 80);
    return { src: svgDataUri(drawRibbon(cells, { width, height: RIBBON_HEIGHT })), width, shown: Math.min(cells.length, ribbonCapacity(width, RIBBON_HEIGHT)) };
  }, [map, seated, at, stageWidth]);

  const flow = useMemo(() => (map ? flowState(map.actions, at, { tau: 4000 * pace, hold, travel: 700 * pace }) : null), [map, at, pace]);
  const layouts = useMemo(() => (setup ? { ring: ringLayout(setup), board: boardLayout() } : null), [setup]);
  const drawOptions = useMemo(
    () => (map && setup ? { names: setup.t.stations, coreName: String(map.provider || 'agent').toUpperCase(), model: map.model ? shortModel(map.model) : '', present: setup.present } : null),
    [map, setup],
  );
  const boardSrc = useMemo(
    () => (onBoard && flow && layouts && drawOptions ? svgDataUri(drawFlow(flow, { ...drawOptions, layout: layouts.board, size: stageWidth, motion: reducedMotion ? 'reduced' : 'full' })) : ''),
    [onBoard, flow, layouts, drawOptions, stageWidth, reducedMotion],
  );
  // Lanes are the stations the session used, fixed for the session, so the tape does not change height as it plays.
  const tape = useMemo(() => {
    if (!map || !setup) return null;
    // As on the hub: the stations' colours, one You lane for both directions, and Your screen its own lane.
    const lanes = hub.order.filter(id => id !== 'model' && (seatedPresent.has(id) || (id === 'you' && seatedPresent.has('tells'))));
    const rows = tapeOf(seated, at, TAPE_CALLS);
    const width = Math.max(300, Math.min(860, sideWidth));
    return { src: svgDataUri(drawTape(rows, { width, names, capacity: TAPE_CALLS, lanes, kinds: true, tells: 'lane' })), width, aspect: width / tapeHeight(rows, lanes), shown: rows.length };
  }, [map, setup, seated, seatedPresent, hub, names, at, sideWidth]);

  // The list is not on screen beside the sizes, and a replay moves `at` twelve times a second: skip the fold then.
  const listed = route.look === '';
  // The list reads the same actions as the drawing beside it: seated and two-way for the hub, as recorded for the board.
  const list = useMemo(() => (map && listed ? (onBoard ? rowsFor(map.actions, station, at) : rowsFor(seated, station, at, { tells: 'lane' })) : EMPTY_LIST), [map, seated, station, at, listed, onBoard]);
  const stamp = useMemo(() => (map?.span ? stampFor(map.span) : clockTime), [map]);

  if (!isActive) return null;

  const shape = onBoard && layouts ? layouts.board : hub;
  // Read at render, after `go` has written the frame into the address: the reader's Back returns to this frame.
  const here = window.location.pathname + window.location.search;
  const known = sessions.some(s => s.session_id === route.session);

  return (
    <div className="session-map">
      <header className="sm-head">
        <select aria-label="Session" value={route.session} onChange={e => go({ session: e.target.value, station: '', at: null }, { push: true })}>
          {!known && route.session && <option value={route.session}>{route.session}</option>}
          {sessions.map(s => (
            <option key={s.session_id} value={s.session_id}>
              {sessionLabel(s)}
            </option>
          ))}
        </select>
        {map && <AgentBadge provider={map.provider} />}
        {map?.span && (
          <span className="sm-span">
            {stamp(map.span.first)} to {stamp(map.span.last)} · {spanText(map.span.last - map.span.first)}
          </span>
        )}
        <div className="sm-look" role="group" aria-label="Beside the map">
          <button type="button" aria-pressed={listed} onClick={() => go({ look: '' })}>
            Calls
          </button>
          <button type="button" aria-pressed={route.look === 'sizes'} onClick={() => go({ look: 'sizes' })}>
            Sizes
          </button>
          <button type="button" aria-pressed={route.look === 'directions'} onClick={() => go({ look: 'directions' })}>
            Directions
          </button>
        </div>
        <div className="sm-look sm-layout" role="group" aria-label="Layout">
          <button type="button" aria-pressed={!onBoard} onClick={() => go({ layout: '' })}>
            Hub
          </button>
          <button type="button" aria-pressed={onBoard} onClick={() => go({ layout: 'board' })}>
            Board
          </button>
        </div>
      </header>

      {error && <p className="sm-error" role="alert">{error}</p>}

      {map && setup && layouts && list && (
        <div className="sm-body">
          <section className="sm-stage" aria-label="Work map">
            <div className="sm-mapbox" style={{ '--sm-aspect': shape.width / shape.height }}>
            <div className="sm-map" data-layout={onBoard ? 'board' : 'hub'} ref={stageRef} style={{ aspectRatio: `${shape.width} / ${shape.height}`, '--sm-aspect': shape.width / shape.height }}>
              <img src={onBoard ? boardSrc : src} alt="" draggable="false" />
              <button
                type="button"
                className="sm-hit sm-core"
                style={onBoard ? flowCoreBox(layouts.board) : hubCoreBox(hub)}
                aria-pressed={station === ''}
                aria-label="All stations"
                onClick={() => go({ station: '' })}
              />
              {(onBoard ? flowBoxes(layouts.board, setup.present) : hubBoxes(hub, seatedPresent)).map(box => (
                <button
                  key={box.id}
                  type="button"
                  className="sm-hit"
                  style={{ left: box.left, top: box.top, width: box.width, height: box.height }}
                  aria-pressed={station === box.id}
                  aria-label={names[box.id]}
                  onClick={() => go({ station: station === box.id ? '' : box.id })}
                />
              ))}
            </div>
            </div>
            {ribbon && <img className="sm-ribbon" src={ribbon.src} alt={`The last ${ribbon.shown} calls, oldest to newest`} draggable="false" style={{ width: ribbon.width, aspectRatio: String(ribbon.width / RIBBON_HEIGHT) }} />}
            <div className="sm-scrub">
              <input
                type="range"
                aria-label="Moment in the session"
                min={map.span.first}
                max={end}
                step={1000}
                value={at}
                onChange={e => scrub(Number(e.target.value))}
              />
              <output>
                {stamp(at)} · {spanText(at - map.span.first)} of {spanText(map.span.last - map.span.first)}
                {context && ` · context ${Math.round(context.percent)}% of ${tokenText(context.window)} tokens`}
              </output>
              <div className="sm-transport">
                <button type="button" className="sm-play" aria-pressed={playing} onClick={play}>
                  {playing ? 'Pause' : 'Play'}
                </button>
                <select aria-label="Replay speed" value={speed} onChange={e => setSpeed(Number(e.target.value))}>
                  {SPEEDS.map(s => (
                    <option key={s} value={s}>
                      {s}× speed
                    </option>
                  ))}
                </select>
                <button type="button" className="sm-play" aria-pressed={live} onClick={follow}>
                  Live
                </button>
              </div>
            </div>
          </section>

          {route.look === 'directions' && flow && layouts && drawOptions && (
            <div className="sm-side" ref={sideRef}>
              <SessionDirections
                map={map}
                at={at}
                speed={pace}
                hold={hold}
                names={setup.t.stations}
                coreName={drawOptions.coreName}
                before={beforeSrc}
                stamp={stamp}
                reducedMotion={reducedMotion}
                context={context}
                width={sideWidth}
                now={{ flow, layout: layouts.ring, options: drawOptions }}
              />
            </div>
          )}

          {route.look === 'sizes' && flow && layouts && drawOptions && (
            <SessionSizes
              actions={map.actions}
              at={at}
              speed={pace}
              flow={flow}
              layouts={layouts}
              drawOptions={drawOptions}
              hubSrc={beforeSrc}
              names={names}
              reducedMotion={reducedMotion}
            />
          )}

          <div className="sm-side" hidden={!listed} ref={listed ? sideRef : undefined}>
          {tape && (
            <figure className="sm-tape">
              <figcaption>
                Last {tape.shown} calls, oldest to newest
              </figcaption>
              <img src={tape.src} alt="" draggable="false" style={{ width: tape.width, aspectRatio: String(tape.aspect) }} />
            </figure>
          )}
          <section className="sm-list" aria-label={station ? names[station] : 'All stations'}>
            <h2>
              {station ? names[station] : 'All stations'}
              <span>
                {station === 'model'
                  ? `${list.total} ${list.total === 1 ? 'step' : 'steps'} · ${list.byAgents} by subagents`
                  : station === 'you' && !onBoard
                  ? `${list.total - list.told} said · ${list.told} told`
                  : `${list.total} ${list.total === 1 ? 'call' : 'calls'} · ${list.failed} failed · ${list.byAgents} by subagents${station === '' ? ` · ${list.steps} model steps not listed` : ''}`}
              </span>
            </h2>
            <ol>
              {list.rows.map(({ key, action, status, tookMs }) => {
                const target = rowTarget(BASE, map, action, extras, here);
                const detail = rowDetail(action, extras.calls);
                const body = (
                  <>
                    {station === '' && <span className="sm-where">{names[action.station]}</span>}
                    <span className="sm-text">
                      <span className="sm-label">{action.label}</span>
                      {detail && <span className="sm-detail">{detail}</span>}
                    </span>
                    {action.agentId !== undefined && <span className="sm-agent">subagent {String(action.agentId).slice(0, 7)}</span>}
                    {status === 'run' && <span className="sm-state">running</span>}
                    {(status === 'err' || status === 'block') && <span className="sm-state">failed</span>}
                    <span className="sm-took">{tookMs === null || tookMs < 1 ? '' : formatMs(tookMs, setup.t)}</span>
                  </>
                );
                return (
                  <li key={key} className={`sm-item sm-${status}`}>
                    {/* The time sets the map's moment; the rest of the row opens the call in the reader. */}
                    <button type="button" className="sm-at" aria-label={`Map at ${stamp(action.startedAt)}`} onClick={() => go({ at: action.startedAt + AFTER_START_MS })}>
                      <time>{stamp(action.startedAt)}</time>
                    </button>
                    {target ? (
                      <a
                        className="sm-row"
                        href={target.href}
                        title={TARGET_TITLE[target.kind]}
                        onClick={e => {
                          // The Memory Desk reads its state from the address on load, so its links are followed as links.
                          if (target.kind !== 'reader' || leavesThePage(e) || !onOpenTranscript) return;
                          e.preventDefault();
                          onOpenTranscript(target.location.path, target.location.uuid, '', target.location.blockId);
                        }}
                      >
                        {body}
                      </a>
                    ) : (
                      <span className="sm-row">{body}</span>
                    )}
                  </li>
                );
              })}
            </ol>
            {list.total > list.rows.length && <p className="sm-more">{list.total - list.rows.length} earlier calls not listed</p>}
          </section>
          </div>
        </div>
      )}
    </div>
  );
}
