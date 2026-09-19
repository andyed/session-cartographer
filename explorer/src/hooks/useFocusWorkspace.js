import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiRequest, isDemoMode } from '../api.js';
import { memoryHref, normalizeMemoryRoute, parseMemoryRoute } from '../components/memory-route.js';
import { getFocusRange, advanceFocusRange, MAX_FOCUS_DURATION_MS } from '../../shared/focus.js';
import { projectMemoryScope } from '../../shared/activity-scope.js';

const BASE = import.meta.env.BASE_URL || '/';
const HOUR = 3600000;
const LENSES = ['concurrent', 'sessions', 'chronological'];
export function readWorkspaceRoute() {
  const params = new URLSearchParams(window.location.search);
  return { ...parseMemoryRoute(window.location.search),
    timelineView: LENSES.includes(params.get('view')) ? params.get('view') : 'concurrent',
    days: [1, 3, 7, 30].includes(Number(params.get('days'))) ? Number(params.get('days')) : 7,
    zoom: params.get('zoom') === 'detail' ? 'detail' : 'overview' };
}
function normalized(value) {
  return { ...normalizeMemoryRoute(value), timelineView: LENSES.includes(value.timelineView) ? value.timelineView : 'concurrent',
    days: [1, 3, 7, 30].includes(value.days) ? value.days : 7, zoom: value.zoom === 'detail' ? 'detail' : 'overview' };
}
export function workspaceHref(value, tab = 'memory') {
  const route = normalized(value);
  const url = new URL(memoryHref(route, `${BASE}${tab}`), window.location.origin);
  if (tab === 'timeline') {
    url.searchParams.set('view', route.timelineView);
    if (route.days !== 7) url.searchParams.set('days', route.days);
    if (route.zoom !== 'overview') url.searchParams.set('zoom', route.zoom);
  }
  return url.pathname + url.search;
}
function initialWindow(route, tab) {
  if (route.from != null && route.through != null) {
    const span = Math.min(MAX_FOCUS_DURATION_MS, Math.max(route.through - route.from, (tab === 'timeline' ? route.days * 24 : 24) * HOUR));
    return { from: route.through - span, through: route.through, live: route.mode !== 'fixed', rolling: route.mode === 'rolling', span };
  }
  return { hours: tab === 'timeline' ? route.days * 24 : route.hours, end: route.end, live: route.end == null };
}

export function resolveViewportRange(spec, at = Date.now()) {
  if (spec.from != null) {
    const through = spec.live ? at : spec.through;
    const span = spec.span ?? spec.through - spec.from;
    return { from: spec.rolling || spec.live ? through - span : spec.from, through };
  }
  const through = spec.end ?? at;
  return { from: through - Math.min(2160, spec.hours || 24) * HOUR, through };
}

export function unionLoadedRange(route, viewport, followThrough = viewport.through) {
  if (route.from == null || route.through == null || route.routeError) return viewport;
  let focusFrom = route.from, focusThrough = route.through;
  if (route.mode === 'rolling' && Number.isSafeInteger(route.durationMs)) {
    focusThrough = Math.max(focusThrough, followThrough);
    focusFrom = focusThrough - route.durationMs;
  } else if (route.mode === 'since-saved') {
    focusThrough = Math.max(focusThrough, followThrough);
  }
  return { from: Math.min(viewport.from, focusFrom), through: Math.max(viewport.through, focusThrough) };
}

/** One route/history and source owner. Renderers only preview or commit intent. */
export default function useFocusWorkspace({ isActive = true, tab = 'memory' } = {}) {
  const [route, setRoute] = useState(readWorkspaceRoute);
  const routeRef = useRef(route); routeRef.current = route;
  const [viewportSpec, setViewportSpec] = useState(() => initialWindow(route, tab));
  const [viewportBounds, setViewportBounds] = useState(null);
  const [data, setData] = useState(null);
  const [status, setStatus] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [retry, setRetry] = useState(0);
  const [draft, setDraft] = useState(null);
  const [frozen, setFrozen] = useState(null);
  const [frozenBounds, setFrozenBounds] = useState(null);
  const queryTransaction = useRef(false);
  const sourceRequest = useRef(null);
  const dataRef = useRef(data); dataRef.current = data;
  const navigate = useCallback((patch, { replace = false, typing = false } = {}) => {
    if (!typing) queryTransaction.current = false;
    const next = normalized({ ...routeRef.current, ...patch });
    const href = workspaceHref(next, tab);
    const current = window.location.pathname + window.location.search;
    if (current !== href) window.history[replace ? 'replaceState' : 'pushState'](
      replace ? { ...window.history.state, tab } : { tab, scopeParent: current }, '', href);
    routeRef.current = next; setRoute(next);
  }, [tab]);
  useEffect(() => {
    if (!isActive) return;
    const restore = () => {
      const pathname = window.location.pathname.replace(/\/$/, '');
      if (tab === 'memory' ? pathname !== `${BASE}memory`.replace(/\/$/, '') : ![`${BASE}timeline`.replace(/\/$/, ''), BASE.replace(/\/$/, '')].includes(pathname)) return;
      const next = readWorkspaceRoute();
      queryTransaction.current = false; routeRef.current = next; setRoute(next); setDraft(null); setFrozen(null); setFrozenBounds(null);
      const spec = initialWindow(next, tab);
      setViewportBounds(spec.from != null || spec.end != null ? resolveViewportRange(spec) : null); setViewportSpec(spec);
    };
    restore(); window.addEventListener('popstate', restore);
    return () => window.removeEventListener('popstate', restore);
  }, [isActive, tab]);

  useEffect(() => {
    if (!isActive) return;
    const controller = new AbortController(); sourceRequest.current = controller;
    let timer;
    async function poll() {
      setRefreshing(true);
      try {
        let nextStatus = { ready: true };
        if (tab === 'memory') {
          nextStatus = await apiRequest('/api/turbo/status', { signal: controller.signal });
          if (controller.signal.aborted) return;
          setStatus(nextStatus);
          if (!nextStatus.ready) return;
        }
        const params = new URLSearchParams();
        const unresolvedDemo = isDemoMode && viewportSpec.from == null && viewportSpec.end == null && !dataRef.current;
        const viewport = unresolvedDemo ? null : resolveViewportRange(viewportSpec);
        const loaded = viewport ? unionLoadedRange(routeRef.current, viewport, viewport.through) : null;
        if (loaded && loaded.through - loaded.from > MAX_FOCUS_DURATION_MS) throw new Error('The focus and context together are wider than 90 days. Choose a narrower context; your saved focus is unchanged.');
        if (loaded) {
          params.set('from', new Date(loaded.from).toISOString()); params.set('through', new Date(loaded.through).toISOString());
        } else {
          params.set('hours', Math.min(2160, viewportSpec.hours || 24));
          if (viewportSpec.end != null) params.set('end', viewportSpec.end);
        }
        const endpoint = tab === 'timeline' ? '/api/activity-scope' : '/api/memory/state';
        if (tab === 'timeline') params.set('shape', 'context');
        const result = await apiRequest(`${endpoint}?${params}`, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(60000)]) });
        if (controller.signal.aborted) return;
        const snapshot = tab === 'timeline' ? result.context : result;
        if (!snapshot?.sessions) throw new Error('The running backend does not support focus windows. Open this preview with its matching backend.');
        const resolvedViewport = viewport || { from: snapshot.start, through: snapshot.end };
        setData(snapshot); setViewportBounds(resolvedViewport); setError(''); setStatus(nextStatus);
        if (unresolvedDemo) setViewportSpec({ ...resolvedViewport, live: false });
        const current = routeRef.current;
        if (current.from == null && !current.routeError) {
          const range = getFocusRange(current, snapshot) || { from: snapshot.start, through: snapshot.end, lower: 'closed' };
          const live = current.end == null && !isDemoMode;
          navigate({ ...range, mode: live ? 'rolling' : 'fixed', durationMs: live ? range.through - range.from : null, at: null, end: null }, { replace: true });
        } else if (current.mode !== 'fixed' && !isDemoMode && !current.routeError) {
          const range = advanceFocusRange(current, current.mode, current.durationMs, snapshot.source?.snapshotAt || snapshot.end);
          if (range) navigate(range, { replace: true });
        }
      } catch (failure) {
        if (!controller.signal.aborted) setError(failure.message);
      } finally {
        if (!controller.signal.aborted) { setRefreshing(false); timer = setTimeout(poll, routeRef.current.mode === 'fixed' || isDemoMode ? 30000 : 10000); }
      }
    }
    poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [isActive, tab, viewportSpec, retry, navigate]);

  const shownData = frozen || data;
  const interval = useMemo(() => draft || (shownData && getFocusRange(route, shownData)), [draft, shownData, route.from, route.through, route.lower, route.mode, route.routeError, route.hours, route.end, route.at, route.catchup, route.checkpoint]);
  const bounds = frozenBounds || viewportBounds || (shownData ? { from: shownData.start, through: shownData.end } : null);
  const scoped = useMemo(() => shownData && interval && !route.routeError ? projectMemoryScope(shownData, { ...route, ...interval }) : null, [shownData, route, interval]);
  const context = useMemo(() => shownData && bounds ? projectMemoryScope(shownData, { ...route, ...bounds, lower: 'closed' }) : null, [shownData, bounds?.from, bounds?.through, route.q, route.project, route.result, route.kind, JSON.stringify(route.brush), JSON.stringify(route.providers), JSON.stringify(route.evidence)]);
  const preview = useCallback(range => { setDraft(range); setFrozen(current => range ? current || dataRef.current : null); setFrozenBounds(current => range ? current || viewportBounds : null); }, [viewportBounds]);
  const commitRange = useCallback(range => {
    setDraft(null); setFrozen(null); setFrozenBounds(null);
    navigate({ ...range, mode: 'fixed', durationMs: null, lower: 'closed', at: null, end: null, offset: 0 });
    setRetry(value => value + 1);
  }, [navigate]);
  const activate = useCallback((range, scope = {}, mode = 'fixed') => {
    const next = { ...scope, ...range, mode, durationMs: mode === 'rolling' ? range.through - range.from : null, at: null, end: null, offset: 0 };
    navigate(next);
    const spec = initialWindow({ ...routeRef.current, ...next }, tab);
    setViewportBounds(resolveViewportRange(spec)); setViewportSpec(spec);
  }, [navigate, tab]);
  const frame = useCallback(days => {
    const live = routeRef.current.mode !== 'fixed' && !isDemoMode;
    const through = live ? Date.now() : routeRef.current.through ?? viewportBounds?.through ?? dataRef.current?.end ?? Date.now();
    const spec = { from: through - days * 24 * HOUR, through, span: days * 24 * HOUR, rolling: live, live };
    setViewportBounds(resolveViewportRange(spec, through)); setViewportSpec(spec);
    navigate({ days }, { replace: true });
  }, [navigate, viewportBounds]);
  const fit = useCallback(() => {
    const value = getFocusRange(routeRef.current, dataRef.current);
    if (!value) return;
    const padding = Math.min(Math.max(60000, (value.through - value.from) * 0.05), (MAX_FOCUS_DURATION_MS - (value.through - value.from)) / 2);
    const spec = { from: Math.max(0, Math.floor(value.from - padding)), through: Math.min(Math.ceil(value.through + padding), Math.max(dataRef.current?.end || 0, value.through)), live: false };
    setViewportBounds(resolveViewportRange(spec)); setViewportSpec(spec);
  }, []);
  const query = useCallback(q => {
    navigate({ q, offset: 0 }, { replace: queryTransaction.current, typing: true });
    queryTransaction.current = true;
  }, [navigate]);
  const endQuery = useCallback(() => { queryTransaction.current = false; }, []);
  const handoff = useCallback((destination, patch = {}) => {
    const href = workspaceHref({ ...routeRef.current, ...(interval || {}), ...patch }, destination);
    const state = { tab: destination, origin: window.location.pathname + window.location.search };
    window.history.pushState(state, '', href); window.dispatchEvent(new PopStateEvent('popstate', { state }));
  }, [interval]);
  const up = useCallback(patch => {
    const href = workspaceHref({ ...routeRef.current, ...patch }, tab);
    if (window.history.state?.scopeParent === href) window.history.back(); else navigate(patch);
  }, [navigate, tab]);
  const launch = useCallback(async () => {
    if (!status?.action || busy) return;
    setBusy(true); setError('');
    try {
      await apiRequest('/api/turbo/start', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Cartographer-Action': 'start' }, body: JSON.stringify({ action: status.action }), signal: AbortSignal.timeout(60000) });
      setRetry(n => n + 1);
    } catch (failure) { setError(failure.message); } finally { setBusy(false); }
  }, [status, busy]);
  return { route, navigate, up, query, endQuery, data: shownData, scoped, context, interval, bounds, preview, commitRange, activate, frame, fit, handoff,
    status, error, busy, refreshing, launch, retry: () => setRetry(n => n + 1), sourceId: `${isDemoMode ? 'demo' : 'live'}:${data?.source?.corpusId || 'default'}` };
}
