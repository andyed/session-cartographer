import { useEffect, useMemo, useRef, useState } from 'react';
import { useEventStream } from '../hooks/useEventStream.js';
import { eventStreamPresentation } from '../hooks/event-stream-state.js';
import useFocusWorkspace from '../hooks/useFocusWorkspace.js';
import useSavedFocus from '../hooks/useSavedFocus.js';
import { activityFromMemory } from '../../shared/activity-scope.js';
import EventGroup, { groupEvents } from './EventGroup.jsx';
import SessionCard from './SessionCard.jsx';
import ConcurrentTimeline from './ConcurrentTimeline.jsx';
import FocusToolbar from './FocusToolbar.jsx';
import MemoryInspector from './MemoryInspector.jsx';
import '../styles/focus-workspace.css';
import '../styles/concurrent-focus.css';

const EVENT_PAGE = 100, SESSION_PAGE = 30;
const asEvent = record => ({ ...record, event_id: record.event_id || record.id,
  session_id: record.session_id || record.sessionId, timestamp: record.timestamp || (Number.isFinite(record.t) ? new Date(record.t).toISOString() : undefined), summary: record.summary || record.text,
  _source: record.source, diff_shape: record.quadrant ? { quadrant: record.quadrant, commit_type: record.commit_type } : undefined });

function sessionCards(snapshot) {
  if (!snapshot) return [];
  const events = new Map(), anonymous = new Map();
  for (const record of snapshot.evidenceIndex || []) {
    if (!record.sessionId) {
      const key = `Unattributed records · ${record.project || 'Unknown project'} · ${new Date(record.t).toISOString().slice(0, 10)}`;
      if (!anonymous.has(key)) anonymous.set(key, []);
      anonymous.get(key).push(asEvent(record)); continue;
    }
    if (!events.has(record.sessionId)) events.set(record.sessionId, []);
    events.get(record.sessionId).push(asEvent(record));
  }
  return [...activityFromMemory(snapshot).sessions.map(session => ({ ...session, events: events.get(session.session_id) || [] })),
    ...[...anonymous].map(([key, records]) => ({ session_id: `Legacy ${key}`, anonymous: true, events: records, lastObserved: Math.max(...records.map(record => record.t)), providers: [...new Set(records.map(record => record.provider).filter(Boolean))] }))]
    .sort((a, b) => (b.lastObserved || 0) - (a.lastObserved || 0));
}

export default function Timeline({ onOpenTranscript, isActive = true }) {
  const workspace = useFocusWorkspace({ isActive, tab: 'timeline' });
  const focus = useSavedFocus(workspace);
  const { route, scoped, interval, data, error, refreshing } = workspace;
  const scrollRef = useRef(null), origin = useRef(null), heading = useRef(null), priorSelection = useRef(null);
  const order = useRef({ key: null, events: [], sessions: [] });
  const [newCount, setNewCount] = useState(0);
  const streamStatus = useEventStream(() => {
    if (!isActive) return;
    if ((scrollRef.current?.scrollTop || 0) > 50) setNewCount(value => value + 1);
  });
  const streamPresentation = eventStreamPresentation(streamStatus);
  const sortedEvents = useMemo(() => [...(scoped?.evidenceIndex || [])].map(asEvent).sort((a, b) => b.t - a.t), [scoped]);
  const sortedSessions = useMemo(() => sessionCards(scoped), [scoped]);
  const orderKey = JSON.stringify([route.q, route.project, route.providers, route.evidence, route.brush, route.kind, route.sort, route.mode === 'fixed' ? [route.from, route.through, route.lower] : route.mode]);
  if (order.current.key !== orderKey) order.current = { key: orderKey, events: [], sessions: [] };
  const stabilize = (items, kind, getId) => {
    const byId = new Map(items.map(item => [getId(item), item]));
    const known = new Set(order.current[kind]);
    order.current[kind] = [...order.current[kind].filter(id => byId.has(id)), ...items.map(getId).filter(id => !known.has(id))];
    return order.current[kind].map(id => byId.get(id));
  };
  const events = stabilize(sortedEvents, 'events', item => item.event_id || item.key || `${item.t}:${item.session_id}:${item.type}`);
  const sessions = stabilize(sortedSessions, 'sessions', item => item.session_id);
  const total = route.timelineView === 'sessions' ? sessions.length : events.length;
  const pageSize = route.timelineView === 'sessions' ? SESSION_PAGE : EVENT_PAGE;
  const offset = Math.min(route.offset || 0, Math.max(0, total - 1));
  const visibleEvents = events.slice(offset, offset + pageSize), visibleSessions = sessions.slice(offset, offset + pageSize);
  const groups = useMemo(() => groupEvents(visibleEvents), [visibleEvents]);
  const openSession = (session, element) => {
    origin.current = { element, scrollTop: scrollRef.current?.scrollTop || 0 };
    workspace.navigate({ session: session.session_id || session.id, file: null, contributor: null, review: null });
  };
  const restoreOrigin = () => requestAnimationFrame(() => {
    if (scrollRef.current && origin.current) scrollRef.current.scrollTop = origin.current.scrollTop;
    if (origin.current?.element?.isConnected) origin.current.element.focus({ preventScroll: true });
    else heading.current?.focus({ preventScroll: true });
  });
  useEffect(() => {
    if (priorSelection.current && !route.session) restoreOrigin();
    priorSelection.current = route.session;
  }, [route.session]);
  const closeInspector = () => { workspace.up({ session: null, file: null, contributor: null, review: null }); restoreOrigin(); };

  return <div className="focus-timeline-workspace timeline-focus-shell" data-inspecting={Boolean(route.session)}>
    <section className="fw-main timeline-focus-main" aria-label="Activity timeline">
      <header className="timeline-focus-header">
        <div className="timeline-focus-status" role="status" aria-live="polite">
          <span ref={heading} tabIndex={-1}>Recorded activity</span>
          {streamPresentation && <span title={streamPresentation.detail} data-tone={streamPresentation.tone}>{streamPresentation.label}</span>}
          {refreshing && data && <span>Refreshing…</span>}
        </div>
        <nav className="timeline-focus-views" aria-label="Timeline view">
          {[['concurrent','Concurrent'],['sessions','Sessions'],['chronological','Event Feed']].map(([id,label]) => <button key={id} aria-pressed={route.timelineView === id}
            onClick={() => workspace.navigate({ timelineView: id, offset: 0 })}>{label}</button>)}
        </nav>
      </header>
      <FocusToolbar workspace={workspace} focus={focus} showInterval />
      {error && <div className="timeline-focus-error" role="alert"><span>{error}</span><button onClick={workspace.retry}>Retry</button></div>}
      {route.routeError && data && <div className="timeline-focus-error" role="alert"><span><strong>Cannot open this interval.</strong> {route.routeError.message}</span><button onClick={() => workspace.activate({ from: data.end - 86400000, through: data.end, lower: 'closed' })}>Choose last 24 hours</button></div>}
      {!data && !error && <p className="timeline-focus-loading" role="status">Loading recorded activity…</p>}
      {newCount > 0 && <button className="timeline-focus-new" onClick={() => { setNewCount(0); workspace.navigate({ sort: Date.now() }, { replace: true }); workspace.retry(); scrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' }); }}>{newCount} new record{newCount === 1 ? '' : 's'} · refresh order</button>}
      {data && interval && route.timelineView === 'concurrent' && <ConcurrentTimeline workspace={workspace} focus={focus} onSession={openSession} scrollRef={scrollRef} />}
      {data && interval && route.timelineView !== 'concurrent' && <div ref={scrollRef} className="timeline-focus-list" onScroll={() => { if ((scrollRef.current?.scrollTop || 0) < 50) setNewCount(0); }}>
        {!total ? <p className="timeline-focus-empty">No recorded {route.timelineView === 'sessions' ? 'tasks' : 'events'} match this focus.</p>
          : route.timelineView === 'sessions' ? visibleSessions.map(session => <article className="timeline-session-result" key={session.session_id}>
            {!session.anonymous && <button className="timeline-inspect" onClick={event => openSession(session, event.currentTarget)}>Inspect evidence</button>}
            <SessionCard session={session} onOpenTranscript={onOpenTranscript}
              onProjectClick={project => workspace.navigate({ project, offset: 0 })}
              onProviderClick={provider => workspace.navigate({ providers: provider ? [provider] : [], offset: 0 })} />
          </article>)
          : groups.map((group, index) => <EventGroup key={group.events[0]?.event_id || index} group={group} onOpenTranscript={onOpenTranscript}
            onProjectClick={project => workspace.navigate({ project, offset: 0 })} />)}
        {total > pageSize && <nav className="timeline-focus-pages" aria-label="Timeline pages"><button disabled={!offset} onClick={() => workspace.navigate({ offset: Math.max(0, offset - pageSize) })}>← Previous</button><span>{offset + 1}–{Math.min(total, offset + pageSize)} of {total}</span><button disabled={offset + pageSize >= total} onClick={() => workspace.navigate({ offset: offset + pageSize })}>Next →</button></nav>}
      </div>}
    </section>
    {route.session && <MemoryInspector workspace={workspace} tab="timeline" onClose={closeInspector} onCloseFile={() => workspace.up({ review: null })} />}
  </div>;
}
