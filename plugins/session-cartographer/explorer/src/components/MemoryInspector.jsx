import { useEffect, useMemo, useRef, useState } from 'react';
import { apiRequest } from '../api.js';
import { containsTimestamp } from '../../shared/focus.js';
import MemorySession from './MemorySession.jsx';
import MemoryArtifact from './MemoryArtifact.jsx';
import { SessionHandoff } from './MemoryDesk.jsx';
import { workspaceHref } from '../hooks/useFocusWorkspace.js';

export default function MemoryInspector({ workspace, tab = 'memory', onClose, onCloseFile }) {
  const { route, data, scoped, interval, navigate } = workspace;
  const [fallback, setFallback] = useState(null);
  const [review, setReview] = useState(null);
  const heading = useRef(null), panel = useRef(null), previousReview = useRef(null);
  const selected = scoped?.sessions.find(s => s.id === route.session);
  const contextSession = data?.sessions.find(s => s.id === route.session);
  const requestKey = `${route.session}:${route.contributor}:${route.file}:${interval?.from}:${interval?.through}`;
  const currentFallback = fallback?.key === route.session ? fallback : null;
  const source = selected ? scoped : contextSession ? data : currentFallback?.data;
  const session = selected || contextSession || source?.sessions.find(s => s.id === route.session);
  const outside = Boolean(session && !selected);
  useEffect(() => {
    if (!route.session || contextSession) return;
    const controller = new AbortController();
    apiRequest(`/api/memory/session?${new URLSearchParams({ session: route.session, hours: 24 })}`, { signal: controller.signal })
      .then(result => { if (!controller.signal.aborted) setFallback({ key: route.session, data: result }); })
      .catch(error => { if (!controller.signal.aborted) setFallback({ key: route.session, error: error.message }); });
    return () => controller.abort();
  }, [route.session, Boolean(contextSession)]);
  useEffect(() => {
    if (!route.review || !route.file || !route.session) { setReview(null); return; }
    const controller = new AbortController();
    const params = new URLSearchParams({ session: route.contributor || route.session, path: route.file, hours: Math.min(2160, Math.max(1, Math.ceil(((interval?.through || 0) - (interval?.from || 0)) / 3600000))) });
    if (interval) { params.set('from', new Date(interval.from).toISOString()); params.set('through', new Date(interval.through).toISOString()); params.set('lower', interval.lower); }
    setReview({ key: requestKey, loading: true });
    apiRequest(`/api/memory/file?${params}`, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]) })
      .then(result => { if (!controller.signal.aborted) setReview({ ...result, key: requestKey }); })
      .catch(error => { if (!controller.signal.aborted) setReview({ key: requestKey, error: error.message }); });
    return () => controller.abort();
  }, [route.session, route.contributor, route.file, Boolean(route.review), requestKey]);
  useEffect(() => {
    const returnPath = previousReview.current;
    previousReview.current = route.review ? route.file : null;
    if (returnPath && !route.review) {
      requestAnimationFrame(() => {
        const target = panel.current?.querySelector(`[data-file-path="${CSS.escape(returnPath)}"]`);
        (target || heading.current)?.focus({ preventScroll: true });
      });
    } else {
      heading.current?.focus({ preventScroll: true });
      if (window.matchMedia('(max-width: 1000px)').matches) panel.current?.scrollIntoView({ block: 'start' });
    }
  }, [route.session, session?.id, route.file, Boolean(route.review)]);
  const contributors = useMemo(() => (scoped?.sessions || []).filter(s => (scoped.files[s.id] || []).some(f => f.path === route.file)), [scoped, route.file]);
  const taskTimes = (session?.events || []).map(event => event[0]).filter(Number.isFinite);
  const taskInWindow = taskTimes.some(time => interval && containsTimestamp(time, interval));
  const recordsRoute = { q: '', project: null, providers: [], evidence: [], filter: 'all', kind: 'all', timelineView: 'chronological', brush: [session?.id], session: null, file: null, review: null, contributor: null, offset: 0, ...(!taskInWindow && taskTimes.length ? { from: Math.min(...taskTimes), through: Math.max(...taskTimes), lower: 'closed', mode: 'fixed', durationMs: null } : {}) };
  const fileName = route.file?.split('/').at(-1);
  const openReview = (owner, file, mode = 'changes') => navigate({ session: owner.id, contributor: owner.id, file: file.path, review: mode });
  if (!route.session) return null;
  return <aside ref={panel} className="fw-inspector" aria-label="Evidence inspector" onKeyDown={event => {
    if (event.key !== 'Escape' || event.defaultPrevented || event.target.closest('[data-focus-control]')) return;
    event.stopPropagation(); event.preventDefault();
    route.review ? onCloseFile() : onClose();
  }}>
    <div className="fw-inspector-top">
      <button onClick={route.review ? onCloseFile : onClose} aria-label={route.review ? 'Back to task' : 'Back to results'}>← {route.review ? 'Task' : 'Results'}</button>
      <span>{outside ? 'Outside current filters' : 'Evidence in focus'}</span>
      {tab === 'timeline' && <button onClick={() => workspace.handoff('memory')}>Review in Memory ↗</button>}
    </div>
    {interval && <p className="fw-inspector-range">Focus: {new Date(interval.from).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} – {new Date(interval.through).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</p>}
    {outside && <p className="fw-notice">This task is outside the current filters. Its recorded context remains available.</p>}
    {!session && <p role="status">{currentFallback?.error || 'Reading this task…'}</p>}
    {session && !route.review && <>
      <div className="fw-inspector-identity"><h2 ref={heading} tabIndex={-1}>{session.title}</h2><SessionHandoff session={session} /><button className="fw-link" onClick={() => workspace.handoff('timeline', recordsRoute)}>{taskInWindow ? 'Task records in this window ↗' : 'Focus recorded task activity ↗'}</button>{session.fullTitle && session.fullTitle !== session.title && <details><summary>Full task prompt</summary><p>{session.fullTitle}</p></details>}</div>
      <MemorySession session={session} files={source?.files[session.id] || []} at={source?.end ?? interval?.through}
        onBack={onClose} onReview={openReview} selectedPath={route.file}
        onSelectFile={file => openReview(session, file, /\.(md|markdown)$/i.test(file.path) ? 'file' : 'changes')}
        hrefForFile={(file, review = 'changes') => workspaceHref({ ...route, file: file.path, review, contributor: session.id }, tab)} compact />
    </>}
    {route.review && <section className="memory-review" aria-label="File review">
      <h2 ref={heading} tabIndex={-1}>{fileName}</h2>
      <p className="memory-path">{route.file}</p>
      <label className="fw-contributor">Evidence from <select aria-label="Contributing task" value={route.contributor || route.session} onChange={e => navigate({ session: e.target.value, contributor: e.target.value })}>
        {!contributors.some(s => s.id === route.session) && <option value={route.session}>{session?.title || route.session}</option>}
        {contributors.map(s => <option key={s.id} value={s.id}>{s.title}</option>)}
      </select></label>
      <p className="fw-muted">{contributors.length > 1 ? `${contributors.length} contributing tasks in focus. ` : ''}Selected: {session?.title || route.session}</p>
      <nav className="fw-tabs" aria-label="File evidence mode">
        <button aria-pressed={route.review === 'changes'} onClick={() => navigate({ review: 'changes' })}>Changes</button>
        <button aria-pressed={route.review === 'file'} onClick={() => navigate({ review: 'file' })}>Current file</button>
      </nav>
      <p className="fw-muted">{route.review === 'changes' ? 'Session changes use the actual commit range; they are not a reconstruction of the focus interval.' : 'Current workspace state may include edits from other tasks.'}</p>
      {review?.key !== requestKey || review?.loading ? <p role="status">Reading file evidence…</p> : review.error ? <p role="alert">{review.error}</p> : <>
        <MemoryArtifact key={route.file} review={review} mode={route.review} layout={route.diff} onLayout={diff => navigate({ diff })} documentMode={route.doc} onDocumentMode={doc => navigate({ doc })} />
        {route.review === 'changes' && !review.diff && <button className="fw-link" onClick={() => navigate({ review: 'file' })}>Open current file</button>}
        <details><summary>Recorded edit evidence</summary><ul>{(review.evidence || []).map((edit, i) => <li key={edit.id || i}>{new Date(edit.t).toLocaleString()} · {edit.id || 'Unidentified record'}</li>)}</ul></details>
      </>}
    </section>}
  </aside>;
}
