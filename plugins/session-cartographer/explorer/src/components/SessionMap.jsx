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

import { useCallback, useEffect, useMemo, useState } from 'react';
import AgentBadge from './AgentBadge';
import { apiRequest, fetchSessions } from '../api';
import { boardAt } from '../../shared/workmap/board.js';
import { formatMs } from '../../shared/workmap/classify.js';
import { drawMap, mapGeometry } from '../../shared/workmap/draw.js';
import { setupFrom } from '../../shared/workmap/setup.js';
import { MAP_PATH, clockTime, coreBox, mapHref, readMapRoute, recallIndex, reviewableFiles, rowDetail, rowTarget, rowsFor, spanText, stampFor, stationBoxes, svgDataUri } from './session-map.js';
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
  }, [route.session]);

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
  }, [map]);

  const setup = useMemo(() => {
    if (!map) return null;
    return { ...setupFrom({ coreName: String(map.provider || 'agent').toUpperCase(), theme: 'dark' }), present: new Set(map.present) };
  }, [map]);

  const geometry = useMemo(() => (setup ? mapGeometry(setup) : null), [setup]);
  const end = map?.span ? map.span.last + 400 : 0;
  const at = map?.span ? Math.min(end, Math.max(map.span.first, route.at ?? end)) : 0;
  const station = map && route.station && map.present.includes(route.station) ? route.station : '';

  const src = useMemo(() => {
    if (!map || !setup) return '';
    const board = boardAt(map.actions, at, map.model ? { model: map.model } : {});
    return svgDataUri(drawMap(board, at, setup));
  }, [map, setup, at]);

  const list = useMemo(() => (map ? rowsFor(map.actions, station, at) : null), [map, station, at]);
  const stamp = useMemo(() => (map?.span ? stampFor(map.span) : clockTime), [map]);

  if (!isActive) return null;

  const names = setup?.t.stations ?? {};
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
      </header>

      {error && <p className="sm-error" role="alert">{error}</p>}

      {map && setup && geometry && list && (
        <div className="sm-body">
          <section className="sm-stage" aria-label="Work map">
            <div className="sm-map" style={{ aspectRatio: `${geometry.width} / ${geometry.height}` }}>
              <img src={src} alt="" draggable="false" />
              <button
                type="button"
                className="sm-hit sm-core"
                style={coreBox(geometry)}
                aria-pressed={station === ''}
                aria-label="All stations"
                onClick={() => go({ station: '' })}
              />
              {stationBoxes(geometry, setup.present).map(box => (
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
            <div className="sm-scrub">
              <input
                type="range"
                aria-label="Moment in the session"
                min={map.span.first}
                max={end}
                step={1000}
                value={at}
                onChange={e => go({ at: Number(e.target.value) })}
              />
              <output>
                {stamp(at)} · {spanText(at - map.span.first)} of {spanText(map.span.last - map.span.first)}
              </output>
            </div>
          </section>

          <section className="sm-list" aria-label={station ? names[station] : 'All stations'}>
            <h2>
              {station ? names[station] : 'All stations'}
              <span>
                {list.total} calls · {list.failed} failed · {list.byAgents} by subagents
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
      )}
    </div>
  );
}
