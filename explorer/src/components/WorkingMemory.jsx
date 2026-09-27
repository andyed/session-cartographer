import { useEffect, useRef } from 'react';
import useFocusWorkspace, { workspaceHref } from '../hooks/useFocusWorkspace.js';
import useSavedFocus from '../hooks/useSavedFocus.js';
import FocusToolbar from './FocusToolbar.jsx';
import FocusTimeline from './FocusTimeline.jsx';
import MemoryDesk from './MemoryDesk.jsx';
import MemoryInspector from './MemoryInspector.jsx';
import MemoryActivity from './MemoryActivity.jsx';
import MemoryRecall from './MemoryRecall.jsx';
import MemoryDay from './MemoryDay.jsx';
import '../styles/memory.css';
import '../styles/focus-workspace.css';

export default function WorkingMemory({ isActive }) {
  const workspace = useFocusWorkspace({ isActive, tab: 'memory' });
  const focus = useSavedFocus(workspace);
  const { route, data, scoped, context, interval, bounds, navigate, up } = workspace;
  const origin = useRef(null), container = useRef(null), previousSelection = useRef(null);
  const previousSurface = useRef(route.surface);
  useEffect(() => {
    if (previousSurface.current !== route.surface) container.current?.querySelector('.fw-view-nav button[aria-pressed=true]')?.focus({ preventScroll: true });
    previousSurface.current = route.surface;
  }, [route.surface]);
  const openSession = session => {
    origin.current = { element: document.activeElement, scrollTop: container.current?.scrollTop || 0 };
    navigate({ session: session.id, contributor: null, file: null, review: null });
  };
  const openReview = (session, file, review) => {
    origin.current = { element: document.activeElement, scrollTop: container.current?.scrollTop || 0 };
    navigate({ session: session.id, contributor: session.id, file: file.path, review });
  };
  const restore = () => requestAnimationFrame(() => {
    const target = origin.current?.element?.isConnected ? origin.current.element : container.current?.querySelector(`[data-entry="${CSS.escape(previousSelection.current || '')}"] .fw-result-open`) || container.current?.querySelector('input[type=search]');
    if (container.current && origin.current) container.current.scrollTop = origin.current.scrollTop;
    target?.focus({ preventScroll: true });
  });
  useEffect(() => {
    if (!route.session && previousSelection.current) restore();
    if (route.session) previousSelection.current = route.result === 'files' ? route.file : route.session;
  }, [route.session]);
  const closeSession = () => { up({ session: null, contributor: null, file: null, review: null }); restore(); };
  const closeFile = () => up({ review: null });
  const hrefForSession = session => workspaceHref({ ...route, session: session.id, file: null, review: null }, 'memory');
  const action = { enable: 'Enable Turbo', start: 'Start Turbo', refresh: 'Refresh Turbo' }[workspace.status?.action];
  // Tasks and Files are two result modes of one surface; Activity, Recall and Day are their own.
  const VIEWS = [['tasks', 'Tasks'], ['files', 'Files'], ['activity', 'Activity'], ['recall', 'Recall'], ['day', 'Day']];
  const surfaceOf = view => view === 'activity' || view === 'recall' || view === 'day' ? view : 'results';
  const viewNavigation = <nav className="fw-tabs fw-view-nav" aria-label="Memory view">
    {VIEWS.map(([view, label]) => <button key={view} aria-pressed={surfaceOf(view) === 'results' ? route.surface === 'results' && route.result === view : route.surface === view} onClick={() => navigate({ surface: surfaceOf(view), ...(surfaceOf(view) === 'results' ? { result: view } : {}), offset: 0 })}>{label}</button>)}
  </nav>;
  return <section ref={container} className="focus-workspace" aria-label="Working memory" data-inspecting={Boolean(route.session)}>
    <div className="fw-page-heading"><div><h1>Memory</h1></div><div className="fw-view-actions"><button onClick={() => workspace.handoff('timeline', { timelineView: 'concurrent' })}>Timeline ↗</button></div></div>
    {!data && <div className="fw-entry"><h2>{workspace.status?.ready ? 'Reading recorded activity…' : 'Your work, in context'}</h2><p>{workspace.status ? 'Memory uses the shared Cartographer source.' : 'Connecting to Cartographer…'}</p>{action && <button disabled={workspace.busy} onClick={workspace.launch}>{workspace.busy ? 'Starting…' : action}</button>}</div>}
    {workspace.error && <div className="fw-error" role="alert"><span>{workspace.error}</span><button onClick={workspace.retry}>Retry</button></div>}
    {data && workspace.status && !workspace.status.ready && <div className="fw-error" role="status"><span>Offline · last successful snapshot remains visible.</span>{action && <button onClick={workspace.launch}>{action}</button>}</div>}
    {data && <><FocusToolbar workspace={workspace} focus={focus} />
      {route.routeError ? <div className="fw-error" role="alert"><h2>Cannot open this interval</h2><p>{route.routeError.message}</p><button onClick={() => workspace.activate({ from: data.end - 86400000, through: data.end, lower: 'closed' })}>Choose last 24 hours</button></div> : interval && bounds && <>
        <div className="fw-focus-strip"><FocusTimeline interval={interval} bounds={bounds} savedInterval={focus.saved} events={context?.sessions.flatMap(s => s.events) || []} onPreview={workspace.preview} onCommit={workspace.commitRange} /></div>
        <div className="fw-workbench" data-inspecting={Boolean(route.session)}>
          <div className="fw-primary" aria-hidden={undefined}>
            {route.surface === 'activity' ? <MemoryActivity workspace={workspace} onSession={openSession} hrefForSession={hrefForSession} viewNavigation={viewNavigation} /> : route.surface === 'recall' ? <MemoryRecall workspace={workspace} onSession={openSession} hrefForSession={hrefForSession} viewNavigation={viewNavigation} /> : route.surface === 'day' ? <MemoryDay workspace={workspace} viewNavigation={viewNavigation} /> : scoped && <MemoryDesk data={scoped} route={route} interval={interval} onSession={openSession} onReview={openReview} hrefForSession={hrefForSession} onFilter={patch => navigate({ offset: 0, ...patch })} viewNavigation={viewNavigation} />}
          </div>
          {route.session && <MemoryInspector workspace={workspace} onClose={closeSession} onCloseFile={closeFile} />}
        </div>
      </>}
    </>}
  </section>;
}
