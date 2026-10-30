import { useMemo, useRef, useState } from 'react';
import { projectDesk, resumeCommand } from './memory-desk';
import { plainLinkClick } from './memory-route';
import PathContext from './PathContext.jsx';
import { commonDirectory, relativeDisplayPath } from './path-presentation.js';
import { isDemoMode } from '../api';
const MATCH_LABELS = { 'query:file': 'Matches file name', 'query:task': 'Matches task', 'query:evidence': 'Matches recorded evidence', 'from-matching-task:query': 'From a matching task', 'from-matching-task:evidence': 'From a task with matching evidence', project: 'Matches project', provider: 'Matches provider', evidence: 'Matches evidence filter' };
const stamp = t => new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const codexLink = session => !isDemoMode && session.provider === 'codex' && /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(session.id) ? `codex://threads/${session.id}` : null;
export function SessionHandoff({ session, hideConversation = false }) {
  const [message, setMessage] = useState('');
  const command = !isDemoMode && resumeCommand(session);
  return <div className="md-handoff">
    {codexLink(session) && <a href={codexLink(session)}>Open in Codex ↗</a>}
    {!hideConversation && !isDemoMode && session.transcript && <a href={`${import.meta.env.BASE_URL || '/'}session/${encodeURIComponent(session.transcript)}?reader=conversation&return=${encodeURIComponent(window.location.pathname + window.location.search)}`}>Read conversation ↗</a>}
    {command && <button onClick={async () => {
      try { await navigator.clipboard.writeText(command); setMessage('Resume command copied'); }
      catch { setMessage(command); }
    }}>Copy resume command</button>}
    <span role="status">{message}</span>
  </div>;
}
export default function MemoryDesk({ data, route, interval, onSession, hrefForSession, hrefForFile, onReview, onFilter, viewNavigation }) {
  const pageSize = 60;
  const orders = useRef(new Map());
  const scopeKey = JSON.stringify([route.q, route.project, route.providers, route.evidence, route.result, route.kind, route.brush, route.sort, route.mode === 'fixed' ? interval : route.mode]);
  const desk = useMemo(() => projectDesk(data, { at: interval.through, since: interval.from - (interval.lower === 'closed' ? 1 : 0), kind: route.kind, query: '', filter: route.filter === 'flight' ? 'flight' : 'all' }), [data, interval, route.kind, route.filter]);
  const files = route.result === 'files';
  const entries = files ? desk.artifacts : desk.sessions.map(row => ({ ...row, id: row.session.id }));
  if (!orders.current.has(scopeKey)) {
    if (orders.current.size > 30) orders.current.delete(orders.current.keys().next().value);
    orders.current.set(scopeKey, { ids: entries.map(row => row.id), initial: new Set(entries.map(row => row.id)) });
  }
  const order = orders.current.get(scopeKey);
  const byId = new Map(entries.map(row => [row.id, row]));
  const known = new Set(order.ids);
  order.ids = [...order.ids.filter(id => byId.has(id)), ...entries.filter(row => !known.has(row.id)).map(row => row.id)];
  const rows = order.ids.map(id => byId.get(id));
  const pathRoot = files ? commonDirectory(rows.map(row => row.path)) : '';
  const newCount = rows.filter(row => !order.initial.has(row.id)).length;
  const offset = Math.min(route.offset || 0, Math.max(0, Math.floor((rows.length - 1) / pageSize) * pageSize));
  const noun = files ? 'files' : 'tasks';
  const open = (event, session) => { if (plainLinkClick(event)) { event.preventDefault(); onSession(session); } };
  return <section className="fw-results" aria-label="Work results">
    <div className="fw-results-head">{viewNavigation}
      {files && <label><span className="md-sr">File kind</span><select aria-label="File kind" value={route.kind} onChange={e => onFilter({ kind: e.target.value })}><option value="all">All files</option><option value="md">Markdown</option></select></label>}
      <span className="fw-result-count" role="status">{data.evidenceComplete === false ? 'At least ' : ''}{rows.length} {noun}</span>
      <button onClick={() => onFilter({ sort: Date.now() })}>{newCount ? `${newCount} new ${noun} · refresh order` : 'Latest first'}</button>
    </div>
    {files && <PathContext root={pathRoot} />}
    <div className="fw-result-list" role="list" aria-label={`${files ? 'File' : 'Task'} results`}>
      {rows.slice(offset, offset + pageSize).map(row => files ? <article role="listitem" key={row.id} data-entry={row.id} className="fw-file-row" data-selected={route.file === row.path || undefined}>
        <a className="fw-result-open" title={row.path} href={hrefForFile(row.threads[0].session, row.threads[0].file, row.isDoc ? 'file' : 'changes')}
          onClick={event => { if (plainLinkClick(event)) { event.preventDefault(); onReview(row.threads[0].session, row.threads[0].file, row.isDoc ? 'file' : 'changes'); } }}>
          <strong>{relativeDisplayPath(row.path,pathRoot)}</strong>
          <span data-copy-content>{row.threads.length} {row.threads.length === 1 ? 'task' : 'tasks'} · {stamp(row.last)}</span>
          <span className="fw-match">{[...new Set(row.threads.flatMap(owner => owner.file.matchReasons || owner.session.matchReasons || []))].map(reason => typeof reason === 'string' ? MATCH_LABELS[reason] || 'Matches current filters' : reason.label || 'Matches current filters').filter(Boolean).join(' · ')}</span>
        </a>
        {row.threads.length > 1 && <span className="fw-provenance">Opens latest evidence; choose a contributing task in the inspector.</span>}
      </article> : <article role="listitem" key={row.id} data-entry={row.id} data-selected={route.session === row.id || undefined} className="fw-task-row">
        <a className="fw-result-open" href={hrefForSession(row.session)} onClick={e => open(e, row.session)}>
          <strong>{row.session.title}</strong>
          {row.outcomes[0] ? <span className="fw-row-outcome">{row.outcomes[0].text}</span> : <span data-copy-content>{row.files.length > 0 ? `${row.files.length} files · ` : ''}{row.events.length} records</span>}
          <span className="fw-row-meta">{[row.session.group, row.session.provider, stamp(row.state.last)].filter(Boolean).join(' · ')}</span>
          <span className="fw-row-state" title={row.state.label} aria-label={row.state.label}><span aria-hidden="true">{row.state.id === 'settled' ? '✓' : row.state.id === 'flight' ? '◷' : '–'}</span></span>
        </a>
      </article>)}
      {!rows.length && <div className="fw-empty"><h2>No {noun} match in the loaded records</h2><p>Try a wider interval or remove a filter.</p>{route.q && <button onClick={() => onFilter({ q: '' })}>Clear Find</button>}{(route.project || route.providers?.length || route.evidence?.length) && <button onClick={() => onFilter({ project: null, providers: [], evidence: [] })}>Clear scope filters</button>}</div>}
    </div>
    {rows.length > pageSize && <nav className="fw-result-pages" aria-label="Result pages"><button disabled={offset === 0} onClick={() => onFilter({ offset: Math.max(0, offset - pageSize) })}>← Previous</button><span>{offset + 1}–{Math.min(rows.length, offset + pageSize)} of {rows.length}</span><button disabled={offset + pageSize >= rows.length} onClick={() => onFilter({ offset: offset + pageSize })}>Next →</button></nav>}
  </section>;
}
