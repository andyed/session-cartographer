import { useCallback, useEffect, useRef, useState } from 'react';
import { apiRequest } from '../api';
import { formatImageWindow, IMAGE_WALL_DAYS, imageCollectionUrl, imageWallSearch, readImageWallRoute } from './image-wall-route.js';
import '../styles/image-wall.css';

const BASE = import.meta.env.BASE_URL || '/';
// Wunderkammer's own embed API, served from its pinned package by the UI host
// (server/wunderkammer-static.js). A runtime import, so Vite leaves it alone.
const EMBED_URL = `${BASE}wunderkammer/wall/embed.mjs`;
const SCOPES = [
  { id: 'changed', label: 'Written in a session', short: 'Written', hint: 'The file last changed while a session that names it was running.' },
  { id: 'named', label: 'Any a session named', short: 'Named', hint: 'Every existing image a session read, produced, linked or sent, wherever it came from.' },
];

const plural = (n, one, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

function summary(stats) {
  const what = stats.scope === 'changed' ? 'written in sessions' : 'named by sessions';
  return `${plural(stats.shown, 'image')} ${what} · last ${stats.days === 1 ? '24 hours' : `${stats.days} days`}`;
}

function detail(stats) {
  const parts = [`${plural(stats.transcripts, 'transcript')} read in ${(stats.ms / 1000).toFixed(1)} s`];
  if (stats.scope === 'changed' && stats.namedOnly) parts.push(`${plural(stats.namedOnly, 'image')} only named`);
  if (stats.missing) parts.push(`${plural(stats.missing, 'named file')} no longer on disk`);
  if (stats.blocked) parts.push(`${plural(stats.blocked, 'image')} in ${stats.blockedRoots.join(', ')} skipped: macOS has not let the Explorer read ${stats.blockedRoots.length === 1 ? 'that folder' : 'those folders'}`);
  if (stats.failed) parts.push(`${plural(stats.failed, 'transcript')} could not be read`);
  return parts.join(' · ');
}

/** A Wunderkammer wall of the images sessions wrote, with provenance links back into each transcript. */
export default function ImageWall({ isActive }) {
  const [route, setRoute] = useState(() => readImageWallRoute());
  const [state, setState] = useState({ status: 'idle' });
  const [wallError, setWallError] = useState('');
  const [reload, setReload] = useState(0);
  const host = useRef(null);
  const loaded = useRef('');

  useEffect(() => {
    const onPop = () => { if (window.location.pathname.endsWith('/images')) setRoute(readImageWallRoute()); };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const choose = useCallback(next => {
    const merged = { ...route, ...next };
    window.history.replaceState({ ...window.history.state, tab: 'images' }, '', `${BASE}images${imageWallSearch(merged)}`);
    setRoute(merged);
  }, [route]);

  // Load when first shown and when the window or scope changes, not on every
  // return to the tab: the mounted wall keeps its own pan, piles and filters.
  useEffect(() => {
    const key = `${route.days}:${route.scope}:${reload}`;
    if (!isActive || loaded.current === key) return undefined;
    loaded.current = key;
    const controller = new AbortController();
    let done = false;
    setState(previous => ({ status: 'loading', stats: previous.stats }));
    apiRequest(imageCollectionUrl(route), { signal: controller.signal })
      .then(({ collection, stats }) => setState({ status: collection ? 'ready' : 'empty', collection, stats }))
      .catch(error => { if (!controller.signal.aborted) setState({ status: 'error', error: error.message }); })
      .finally(() => { done = true; });
    // Leaving mid-request must not strand the view in "loading" on return.
    return () => { if (!done) { controller.abort(); loaded.current = ''; } };
  }, [isActive, route, reload]);

  useEffect(() => {
    if (state.status !== 'ready' || !host.current) return undefined;
    let wall = null, cancelled = false;
    setWallError('');
    import(/* @vite-ignore */ EMBED_URL).then(({ mount }) => {
      if (cancelled) return;
      wall = mount(host.current, state.collection, { title: 'Image wall' });
      wall.ready.catch(error => { if (!cancelled) setWallError(error.message); });
    }).catch(error => { if (!cancelled) setWallError(`The wall could not load: ${error.message}`); });
    return () => { cancelled = true; wall?.destroy(); };
  }, [state]);

  const stats = state.stats;
  return (
    <section className="image-wall" aria-label="Image wall">
      <header className="image-wall-bar">
        <div className="image-wall-status" role="status" aria-live="polite">
          {state.status === 'loading' && <strong>Reading session transcripts for images…</strong>}
          {state.status === 'error' && <strong>Images could not be listed: {state.error}</strong>}
          {state.status === 'empty' && <strong>No images {route.scope === 'changed' ? 'written in sessions' : 'named by sessions'} in the last {route.days === 1 ? '24 hours' : `${route.days} days`}.</strong>}
          {state.status === 'ready' && <strong>{summary(stats)}</strong>}
          {stats && state.status !== 'error' && <span>{detail(stats)}</span>}
          {wallError && <span className="image-wall-error">{wallError}</span>}
        </div>
        <div className="image-wall-controls">
          <div className="image-wall-segment" role="group" aria-label="Window">
            {IMAGE_WALL_DAYS.map(days => (
              <button key={days} type="button" aria-pressed={route.days === days} onClick={() => choose({ days })}>{formatImageWindow(days)}</button>
            ))}
          </div>
          <div className="image-wall-segment" role="group" aria-label="Which images">
            {SCOPES.map(scope => (
              <button key={scope.id} type="button" aria-pressed={route.scope === scope.id} aria-label={scope.label} title={scope.hint} onClick={() => choose({ scope: scope.id })}>
                <span className="iw-long">{scope.label}</span><span className="iw-short" aria-hidden="true">{scope.short}</span>
              </button>
            ))}
          </div>
          <button type="button" className="image-wall-action" onClick={() => setReload(n => n + 1)} disabled={state.status === 'loading'}>Refresh</button>
          {state.status === 'ready' && (
            <a className="image-wall-action" href={`${BASE}wunderkammer/?collection=${encodeURIComponent(imageCollectionUrl(route, { document: true }))}`} target="_blank" rel="noopener noreferrer" aria-label="Open wall in a new tab"><span className="iw-long">Open wall in a new tab ↗</span><span className="iw-short" aria-hidden="true">New tab ↗</span></a>
          )}
        </div>
      </header>
      <div className="image-wall-stage" ref={host} data-state={state.status} />
    </section>
  );
}
