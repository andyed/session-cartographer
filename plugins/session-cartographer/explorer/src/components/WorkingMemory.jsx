import { useCallback, useEffect, useRef, useState } from 'react';
import { createMemoryWeather } from './memory-weather';
import MemorySession from './MemorySession';
import MemoryDesk, { SessionHandoff } from './MemoryDesk';
import MemoryArtifact from './MemoryArtifact';
import { parseMemoryRoute, normalizeMemoryRoute, memoryHref } from './memory-route';
import { apiRequest as request, isDemoMode, memoryAxes } from '../api';
import '../styles/memory.css';

const actions = { enable: 'Enable Turbo', start: 'Start Turbo', refresh: 'Refresh Turbo' };
const memoryPath = `${import.meta.env.BASE_URL || '/'}memory`;

export default function WorkingMemory({ isActive }) {
  const [hovered, setHovered] = useState(null);
  const [focus, setFocus] = useState('overview');
  const sessionTrigger = useRef(null);
  const [status, setStatus] = useState(null);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [launchError, setLaunchError] = useState('');
  const [busy, setBusy] = useState(false);
  const [review, setReview] = useState(null);
  const [route, setRoute] = useState(() => parseMemoryRoute(window.location.search));
  const routeRef = useRef(route);
  routeRef.current = route;
  const [sessionSnapshot, setSessionSnapshot] = useState(null);
  const [copied, setCopied] = useState('');
  const [copyError, setCopyError] = useState('');
  const [retry, setRetry] = useState(0);
  const host = useRef(null);
  const weather = useRef(null);
  const starting = useRef(false);
  const reviewRequest = useRef(null);
  const reviewHeading = useRef(null);
  const reviewTrigger = useRef(null);
  const launchRequest = useRef(null);
  const loadedWindow = useRef(route.end);
  // null until known. The field is only built once, so the axis list has to be
  // in hand before construction rather than patched in afterwards.
  const [axes, setAxes] = useState(isDemoMode ? null : []);
  useEffect(() => {
    if (!isDemoMode) return;
    let live = true;
    memoryAxes().then(next => live && setAxes(next)).catch(() => live && setAxes([]));
    return () => { live = false; };
  }, []);

  const navigate = useCallback((patch, { replace = false } = {}) => {
    const next = normalizeMemoryRoute({ ...routeRef.current, ...patch });
    const href = memoryHref(next, memoryPath);
    const current = window.location.pathname + window.location.search;
    if (href !== current) {
      const state = replace ? { ...window.history.state, tab: 'memory' } : { tab: 'memory', memoryParent: current };
      window.history[replace ? 'replaceState' : 'pushState'](state, '', href);
    }
    routeRef.current = next;
    setRoute(next);
  }, []);

  useEffect(() => {
    if (!isActive) return;
    const restore = () => {
      if (window.location.pathname.replace(/\/$/, '') !== memoryPath.replace(/\/$/, '')) return;
      const next = parseMemoryRoute(window.location.search);
      routeRef.current = next;
      setRoute(next);
    };
    restore();
    window.addEventListener('popstate', restore);
    return () => window.removeEventListener('popstate', restore);
  }, [isActive]);

  function up(patch) {
    const href = memoryHref({ ...routeRef.current, ...patch }, memoryPath);
    if (window.history.state?.memoryParent === href) window.history.back();
    else navigate(patch);
  }

  const stateURL = '/api/memory/state' + (route.end === null ? '' : `?end=${route.end}`);

  // The UI host remains alive when Turbo is stopped. Reading status never
  // enables the preference or starts a process; only the explicit action does.
  useEffect(() => {
    if (!isActive) { weather.current?.pause(); return; }
    const controller = new AbortController();
    if (loadedWindow.current !== route.end) { setData(null); loadedWindow.current = route.end; }
    let timer;
    const poll = async () => {
      if (starting.current) { timer = setTimeout(poll, 5000); return; }
      try {
        const next = await request('/api/turbo/status', {
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]),
        });
        if (controller.signal.aborted || starting.current) return;
        setStatus(next);
        if (next.ready) {
          const snapshot = await request(stateURL, {
            signal: AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]),
          });
          if (controller.signal.aborted || starting.current) return;
          setData(snapshot);
          setLaunchError('');
          weather.current?.setConnected(true);
        } else {
          weather.current?.setConnected(false);
        }
        setError(next.error || '');
      } catch (e) {
        if (!controller.signal.aborted) {
          setError(e.message);
          weather.current?.setConnected(false);
        }
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(poll, 5000);
      }
    };
    poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [isActive, retry, stateURL]);

  const fallbackKey = `${route.session}:${route.end}`;
  const fieldSession = data?.sessions.find(session => session.id === route.session);
  useEffect(() => {
    if (!isActive || !route.session || !data || fieldSession) return;
    const controller = new AbortController();
    const params = new URLSearchParams({ session: route.session });
    if (route.end !== null) params.set('end', route.end);
    request(`/api/memory/session?${params}`, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]) })
      .then(snapshot => { if (!controller.signal.aborted) setSessionSnapshot({ key: fallbackKey, data: snapshot }); })
      .catch(error => { if (!controller.signal.aborted) setSessionSnapshot({ key: fallbackKey, error: error.message }); });
    return () => controller.abort();
  }, [isActive, data, route.session, route.end, fieldSession, fallbackKey]);

  const changeBrush = useCallback(ids => navigate({ brush: ids }, { replace: true }), [navigate]);
  useEffect(() => {
    if (!isActive || route.session) return;
    const clear = event => {
      if (event.key !== 'Escape' || (!route.brush && !hovered)) return;
      event.preventDefault();
      changeBrush(null);
      setHovered(null);
    };
    window.addEventListener('keydown', clear);
    return () => window.removeEventListener('keydown', clear);
  }, [isActive, route.session, route.brush, hovered, changeBrush]);

  const changeDepth = useCallback(scale => {
    if (weather.current) weather.current.setScale(scale, routeRef.current.brush);
    else navigate({ cam: scale === 1 ? null : { x: 0, y: 0, scale } }, { replace: true });
  }, [navigate]);

  useEffect(() => { weather.current?.setFocus(hovered, route.brush); }, [hovered, route.brush]);

  const openReview = useCallback((session, file, mode = 'changes') => {
    reviewTrigger.current = document.activeElement;
    navigate({ session: session.id, file: file.path, review: mode });
  }, [navigate]);

  useEffect(() => {
    reviewRequest.current?.abort();
    if (!isActive || !route.review || !status?.ready) { setReview(null); return; }
    const controller = new AbortController();
    reviewRequest.current = controller;
    const path = route.file;
    const name = path.split('/').at(-1);
    setReview({ loading: true, name, path });
    const params = new URLSearchParams({ session: route.session, path });
    if (route.end !== null) params.set('end', route.end);
    request(`/api/memory/file?${params}`, {
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]),
      }).then(result => {
      if (!controller.signal.aborted) {
        setReview(result);
        if (!result.diff && routeRef.current.review === 'changes') navigate({ review: 'file' }, { replace: true });
      }
    }).catch(e => {
      if (!controller.signal.aborted) setReview({ name, path, error: e.message });
    });
    return () => controller.abort();
  }, [isActive, route.session, route.file, Boolean(route.review), route.end, Boolean(status?.ready), navigate]);

  const openSession = useCallback((session, view) => {
    sessionTrigger.current = document.activeElement;
    // Pin the current replay frame in the parent entry before drilling down.
    navigate({ ...view, session: null, file: null, review: null }, { replace: true });
    navigate({ ...view, session: session.id, file: null, review: null });
  }, [navigate]);
  const hrefForSession = useCallback((session, view) => memoryHref({ ...view, session: session.id }, memoryPath), []);

  const restoreSessionFocus = useCallback(() => {
    const trigger = sessionTrigger.current;
    if (!trigger?.isConnected || !trigger.closest('.md-page')) return false;
    trigger.focus({preventScroll:true});
    return true;
  }, []);

  function closeSession() {
    up({ session: null, file: null, review: null });
  }

  useEffect(() => {
    if (!data || !host.current || axes === null) return;
    if (!weather.current) weather.current = createMemoryWeather(host.current, data, { onSelect: openSession, onNavigate: navigate, hrefForSession, route: routeRef.current, axes, compact: true, onHover: setHovered, onBrush: changeBrush, onRestoreFocus: restoreSessionFocus });
    else weather.current.update(data, Boolean(status?.ready));
  }, [data, axes, openSession, navigate, hrefForSession, changeBrush, restoreSessionFocus]);

  useEffect(() => { weather.current?.applyRoute(route); }, [route]);

  useEffect(() => () => {
    weather.current?.destroy();
    reviewRequest.current?.abort();
    launchRequest.current?.abort();
  }, []);

  useEffect(() => {
    if (route.review) reviewHeading.current?.focus({ preventScroll: true });
    if (route.review) reviewHeading.current?.scrollIntoView({ block: 'start' });
    else reviewTrigger.current?.focus({ preventScroll: true });
  }, [Boolean(route.review && review)]);

  function closeReview() {
    reviewRequest.current?.abort();
    up({ review: null });
  }

  async function copyLink() {
    const next = normalizeMemoryRoute({ ...routeRef.current, ...(!route.session ? weather.current?.viewState() : {}) });
    navigate(next, { replace: true });
    const href = new URL(memoryHref(next, memoryPath), window.location.origin).href;
    try { await navigator.clipboard.writeText(href); setCopied(href); setCopyError(''); }
    catch { setCopyError('Copy the link from your browser’s address bar.'); }
  }

  async function launch() {
    if (starting.current || !status?.action) return;
    starting.current = true;
    setBusy(true);
    setError('');
    setLaunchError('');
    const controller = new AbortController();
    launchRequest.current = controller;
    try {
      const next = await request('/api/turbo/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Cartographer-Action': 'start' },
        body: JSON.stringify({ action: status.action }),
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(55000)]),
      });
      setStatus(next);
      if (next.ready) setData(await request(stateURL, {
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]),
      }));
    } catch (e) {
      if (!controller.signal.aborted) setLaunchError(e.message);
    } finally {
      starting.current = false;
      setBusy(false);
      setRetry(n => n + 1);
    }
  }

  const action = actions[status?.action];
  const fallback = sessionSnapshot?.key === fallbackKey ? sessionSnapshot : null;
  const source = fieldSession ? data : fallback?.data;
  const selectedSession = fieldSession || source?.sessions[0];
  const reviewMode = route.review === 'changes' && review?.diff ? 'changes' : 'file';
  return (
    <section className={`memory-view ${data && !route.session ? 'memory-overview' : 'memory-detail'}`} aria-label="Working memory" onKeyDownCapture={e => {
      if (e.key === 'Escape' && !route.session && (route.brush || hovered)) { e.stopPropagation(); changeBrush(null); setHovered(null); }
      else if (e.key === 'Escape' && route.review) { e.stopPropagation(); closeReview(); }
      else if (e.key === 'Escape' && route.session) { e.stopPropagation(); closeSession(); }
    }}>
      {!data && (
        <div className="memory-entry">
          <div className="memory-entry-mark" aria-hidden="true" />
          <h1>Working memory</h1>
          <p>{busy ? 'Starting Turbo…' : !status ? 'Connecting…'
            : status.ready ? 'Reading session activity…'
            : status.action === 'refresh' ? 'Refresh Turbo to open the live field.'
            : status.action === 'enable' ? 'A live field of your sessions. Enable Turbo for Claude Code and Codex.'
            : 'A live field of your sessions, powered by Turbo.'}</p>
          {action && <button className="memory-start" disabled={busy} onClick={launch}>{busy ? 'Starting…' : action}</button>}
        </div>
      )}
      {(error || launchError) && <div className="memory-error" role="alert"><span>{launchError || error}</span><button onClick={() => { setLaunchError(''); setRetry(n => n + 1); }}>Retry connection</button></div>}
      {data && !status?.ready && action && (
        <div className="memory-error" role="status"><span>Turbo is offline. Last received activity is still here.</span><button disabled={busy} onClick={launch}>{busy ? 'Starting…' : action}</button></div>
      )}
      {data && <div className="memory-link-tools">{!route.session && <nav className="memory-focus" aria-label="Workspace focus">{['overview','charts'].map(id=><button key={id} aria-pressed={focus===id} onClick={()=>setFocus(id)}>{id==='overview'?'Overview':'Charts'}</button>)}</nav>}<button onClick={copyLink}>{copied === window.location.href ? 'Link copied' : 'Copy link'}</button><span role="status">{copyError}</span></div>}
      <div className="memory-workspace" data-focus={focus} hidden={!data || Boolean(route.session)}>
        {data && <MemoryDesk data={data} route={route} onSession={openSession} hrefForSession={hrefForSession} onReview={openReview} hovered={hovered} onHover={setHovered} onBrush={changeBrush} onDepth={changeDepth} connected={Boolean(status?.ready) && !error} />}
        <aside className="md-instruments" aria-label="Session charts">
          <div id="memory-weather" ref={host} />
        </aside>
      </div>
      {route.session && selectedSession && <div className="memory-switch-row">
        <label>Switch thread <select className="memory-switch" aria-label="Switch thread" value={route.session} onChange={e => navigate({ session: e.target.value, file: null, review: null })}>
          {!fieldSession && <option value={selectedSession.id}>{selectedSession.title}</option>}
          {(data?.sessions || []).map(session => <option key={session.id} value={session.id}>{session.title} · {session.group}</option>)}
        </select></label>
        <SessionHandoff key={selectedSession.id} session={selectedSession} />
      </div>}
      {data && route.session && !selectedSession && !route.review && <div className="memory-missing-session"><button onClick={closeSession}>← All sessions</button><p role="status">{fallback?.error || 'Reading this session…'}</p></div>}
      {route.session && selectedSession && <div hidden={Boolean(route.review)}>
      {source.end < data?.start && <p className="memory-archive-note">Last recorded window · {new Date(source.end).toLocaleString()}</p>}
      <MemorySession
        session={selectedSession} files={source.files[selectedSession.id] || []}
        at={route.at ?? source.end} onBack={closeSession} onReview={openReview}
        selectedPath={route.file}
        onSelectFile={file => navigate({ file: file.path, review: null })}
        hrefForFile={(file, review = null) => memoryHref({ ...route, file: file.path, review }, memoryPath)}
      /></div>}
      {route.review && review && (
        <section className="memory-review" aria-label="File review">
          <header>
            <button onClick={closeReview} aria-label="Close file review">←</button>
            <h2 ref={reviewHeading} tabIndex={-1}>{review.name}</h2>
            {!review.loading && !review.error && <>
              {review.diff && <button aria-pressed={reviewMode === 'changes'} onClick={() => navigate({ review: 'changes' })}>Current changes</button>}
              <button aria-pressed={reviewMode === 'file'} onClick={() => navigate({ review: 'file' })}>Current file</button>
            </>}
          </header>
          <p className="memory-path">{review.path}</p>
          {review.loading ? <p role="status">Reading file…</p> : review.error ? <p role="alert">{review.error}</p> : <>
            <p>Current workspace state; it may include edits from other sessions.</p>
            <MemoryArtifact key={review.path} review={review} mode={reviewMode} />
            <details><summary>Session edit evidence</summary><ul>{(review.evidence || []).map(e => <li key={e.id}>{new Date(e.t).toLocaleString()} · {e.id}</li>)}</ul></details>
          </>}
        </section>
      )}
    </section>
  );
}
