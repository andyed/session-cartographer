import { useEffect, useMemo, useRef, useState } from 'react';
import { semanticLevel } from './memory-brush';
import { projectDesk, resumeCommand } from './memory-desk';
import { plainLinkClick } from './memory-route';
import { isDemoMode } from '../api';
import '../styles/memory-desk.css';

const stamp = t => new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const ago = (t, at) => { const minutes = Math.max(0, Math.floor((at - t) / 60000)); return minutes < 1 ? 'just now' : minutes < 60 ? `${minutes}m ago` : `${Math.floor(minutes / 60)}h ago`; };
const codexLink = session => !isDemoMode && session.provider === 'codex' && /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(session.id) ? `codex://threads/${session.id}` : null;
const BOOKMARK = 'cartographer.return-point.v1';
function readCheckpoint() {
  try { const n = Number(localStorage.getItem(BOOKMARK)); return n > 0 && n <= Date.now() ? n : null; } catch { return null; }
}
export function SessionHandoff({ session }) {
  const [message, setMessage] = useState('');
  const command = !isDemoMode && resumeCommand(session);
  return <div className="md-handoff">
    {codexLink(session) && <a href={codexLink(session)}>Open in Codex ↗</a>}
    {!isDemoMode && session.transcript && <a href={`${import.meta.env.BASE_URL || '/'}session/${encodeURIComponent(session.transcript)}`}>Read conversation ↗</a>}
    {command && <button onClick={async () => {
      try { await navigator.clipboard.writeText(command); setMessage('Resume command copied'); }
      catch { setMessage(command); }
    }}>Copy resume command</button>}
    <span role="status">{message}</span>
  </div>;
}
export default function MemoryDesk({ data, route, onSession, hrefForSession, onReview, connected, hovered, onHover, onBrush, onDepth }) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [checkpoint, setCheckpoint] = useState(readCheckpoint);
  const [window, setWindow] = useState(() => readCheckpoint() ? 'return' : 'hour');
  const [notice, setNotice] = useState('');
  const [capacity, setCapacity] = useState(1);
  const [offset, setOffset] = useState(0);
  const [orderEpoch, setOrderEpoch] = useState(0);
  const order = useRef({ key: '', ids: [] });
  const page = useRef(null);
  const search = useRef(null);
  useEffect(() => {
    const focusSearch = e => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey || e.target.isContentEditable || /INPUT|TEXTAREA|SELECT/.test(e.target.tagName) || !search.current?.getClientRects().length) return;
      e.preventDefault(); search.current.focus();
    };
    document.addEventListener('keydown', focusSearch);
    return () => document.removeEventListener('keydown', focusSearch);
  }, []);
  useEffect(() => {
    const el = page.current;
    const resize = new ResizeObserver(() => {
      if (!el.clientHeight) return;
      const rowHeight = parseFloat(getComputedStyle(el).getPropertyValue('--md-row-height')) || 72;
      setCapacity(Math.max(1, Math.floor(el.clientHeight / rowHeight)));
    });
    resize.observe(el);
    return () => resize.disconnect();
  }, []);
  const at = route.at ?? data.end;
  const since = window === 'return' && checkpoint ? checkpoint : window === 'day' ? data.start : at - 3600000;
  const level = semanticLevel(route.cam?.scale ?? 1);
  const focused = useMemo(() => route.brush?.length ? { ...data, sessions: data.sessions.filter(s => route.brush.includes(s.id)) } : data, [data, route.brush]);
  const desk = useMemo(() => projectDesk(focused, { at, since, query, filter }), [focused, at, since, query, filter]);
  const kind = filter === 'landed' ? 'outcomes' : level;
  const entries = kind === 'projects'
    ? [...new Set(desk.sessions.map(row => row.session.group))].map(group => ({ id: group, group, rows: desk.sessions.filter(row => row.session.group === group) }))
    : kind === 'outcomes' ? desk.outcomes.map(({session,note},i) => ({id:`${session.id}:${note.id || note.t}:${i}`,session,note}))
    : kind === 'artifacts' ? desk.sessions.flatMap(({session,files}) => files.map(file => ({id:`${session.id}:${file.path}`,session,file})))
    : desk.sessions.map(row => ({...row,id:row.session.id}));
  const scope = JSON.stringify([query,filter,level,route.brush,window,orderEpoch]);
  // Preserve the visible order across live polls. Explicit sorting or scope changes
  // start a fresh order; a new task never moves an existing row under the pointer.
  if (order.current.key !== scope) order.current = {key:scope,ids:entries.map(row=>row.id)};
  const byId = new Map(entries.map(row => [row.id,row]));
  const previous = new Set(order.current.ids);
  order.current.ids = [...order.current.ids.filter(id=>byId.has(id)),...entries.filter(row=>!previous.has(row.id)).map(row=>row.id)];
  const ordered = order.current.ids.map(id=>byId.get(id));
  useEffect(() => { setOffset(0); }, [scope]);
  const start = Math.min(offset, Math.max(0, ordered.length - 1));
  const shown = ordered.slice(start, start + capacity);
  const brushProps = session => ({
    'data-session': session.id,
    'data-brushed': hovered === session.id || route.brush?.includes(session.id) ? 'true' : undefined,
    onPointerEnter: () => onHover?.(session.id),
    onPointerLeave: () => onHover?.(null),
    onFocus: () => onHover?.(session.id),
    onBlur: event => { if (!event.currentTarget.contains(event.relatedTarget)) onHover?.(null); },
  });
  const isReplay = route.at !== null;
  const open = (event, session) => { if (plainLinkClick(event)) { event.preventDefault(); onSession(session, route); } };
  function mark() {
    const point = Date.now();
    try { localStorage.setItem(BOOKMARK, String(point)); setCheckpoint(point); setWindow('return'); setNotice('Return point saved in this browser. New activity will collect here.'); }
    catch { setNotice('This browser could not save a return point.'); }
  }
  return <section className="memory-desk" aria-label="Work desk" data-page-size={capacity}>
    <div className="md-topline"><h1 className="md-sr">Work desk</h1><div className="md-search"><label htmlFor="memory-desk-search" className="md-sr">Find sessions or artifacts</label><input id="memory-desk-search" ref={search} type="search" placeholder="Find in this 24h window…" value={query} onChange={e => setQuery(e.target.value)} />{query ? <button onClick={()=>setQuery('')} aria-label="Clear find">×</button> : <span aria-hidden="true">/</span>}</div><details className="md-return" onKeyDown={e=>{if(e.key==='Escape'){e.stopPropagation();e.currentTarget.open=false;e.currentTarget.querySelector('summary').focus();}}}>
      <summary>Catch up <span>{desk.changed} changed</span></summary>
      <section className="md-return-popover" aria-label="Catch up">
        <p>{desk.changed} sessions moved · {desk.commits} commits recorded</p>
        <label>Window <select aria-label="Catch-up window" value={window} onChange={e => setWindow(e.target.value)}><option value="hour">Last hour</option><option value="day">Shown 24 hours</option>{checkpoint && <option value="return">Since return point</option>}</select></label>
        <button disabled={isReplay || isDemoMode || !connected} onClick={mark}>Set return point</button>
        <p>{checkpoint ? stamp(checkpoint) : 'Save a place before stepping away.'}</p>
        <p role="status">{notice}</p>
        {since < data.start && <p>Your return point is older than this 24-hour window. Earlier activity is not included.</p>}
        {since > at && <p>Your return point is after this replay frame.</p>}
      </section>
    </details></div>

    <div className="md-navigation"><div className="md-semantic-tools"><nav aria-label="Semantic zoom">{[['projects', 'Projects', .65], ['sessions', 'Threads', 1], ['artifacts', 'Artifacts', 2.6]].map(([id, label, scale]) => <button key={id} aria-label={`Zoom to ${label.toLowerCase()}`} aria-pressed={level === id} onClick={() => onDepth(scale)}>{label}</button>)}</nav><span>{isDemoMode ? 'Recorded example' : isReplay ? 'Replay' : !connected ? 'Offline' : '24h'}</span></div>
    <nav className="md-filters" aria-label="Work filters">{[['all', 'All threads'], ['flight', 'In flight'], ['changed', 'Changed'], ['landed', 'Landed']].map(([id, label]) => <button key={id} aria-pressed={filter === id} onClick={() => setFilter(id)}>{label}</button>)}</nav></div>
    <div className="md-scope"><span>{ordered.length} {kind === 'sessions' ? 'threads' : kind}{route.brush?.length ? ` within ${focused.sessions.length} selected threads` : ''}</span>{route.brush?.length ? <button onClick={()=>onBrush(null)}>Clear selection</button> : <button onClick={()=>setOrderEpoch(n=>n+1)}>Latest first</button>}</div>
    {filter === 'flight' && <p className="md-context">Observed in the last 15 minutes; running status unavailable.</p>}
    {filter === 'landed' && <p className="md-context">Recorded commits and wrapups; not verified releases.</p>}
    <div className="md-page" ref={page} tabIndex={-1} onKeyDown={e=>{if(e.key==='PageDown'||e.key==='PageUp'){e.preventDefault();setOffset(Math.max(0,Math.min(ordered.length-1,start+(e.key==='PageDown'?capacity:-capacity))));}}}>
      {shown.map(row => kind === 'projects' ? <article className="md-project-summary" key={row.id} data-entry={row.id}>
        <button onClick={()=>{onBrush(row.rows.map(r=>r.session.id));onDepth(1);}}><strong>{row.group}</strong><span>{row.rows.length} threads · {row.rows.reduce((n,r)=>n+r.fresh.length,0)} new observations</span></button>
      </article> : kind === 'artifacts' ? <article className="md-artifact" key={row.id} data-entry={row.id} {...brushProps(row.session)}>
        <button onClick={()=>onReview(row.session,row.file,/\.md(?:own)?$/i.test(row.file.path)?'file':'changes')}><span className="md-file-kind">{/\.md(?:own)?$/i.test(row.file.path)?'MD':'DIFF'}</span><span><strong title={row.file.path}>{row.file.name}</strong><small>{row.session.title} · {row.session.group}</small></span><span aria-hidden="true">↗</span></button>
      </article> : kind === 'outcomes' ? <article className="md-outcome" key={row.id} data-entry={row.id} {...brushProps(row.session)}>
        <a href={hrefForSession(row.session,route)} onClick={e=>open(e,row.session)} title={row.note.text}>{row.note.text}</a><p>{row.session.group} · {stamp(row.note.t)}</p>
      </article> : <article className="md-thread" key={row.id} data-entry={row.id} {...brushProps(row.session)}>
        <span className={`md-state-dot md-state-${row.state.id}`} title={row.state.label} aria-label={row.state.label}/>
        <div className="md-thread-body"><a className="md-thread-title" title={row.session.title} href={hrefForSession(row.session,route)} onClick={e=>open(e,row.session)}>{row.session.title}</a><div className="md-meta"><span>{row.session.provider || 'Agent unrecorded'} · {row.session.group}</span><time dateTime={new Date(row.state.last).toISOString()}>{ago(row.state.last,at)}</time></div></div>
        {row.files.find(f=>/\.md(?:own)?$/i.test(f.path)) && <button className="md-row-read" aria-label={`Read artifact from ${row.session.title}`} onClick={()=>onReview(row.session,row.files.find(f=>/\.md(?:own)?$/i.test(f.path)),'file')}>MD</button>}
        <a className="md-row-open" aria-label={`Open ${row.session.title}`} href={hrefForSession(row.session,route)} onClick={e=>open(e,row.session)}>↗</a>
      </article>)}
      {!ordered.length && <p className="md-empty">No {kind === 'sessions' ? 'threads' : kind} match this view. Clear find or selection, or try All threads.</p>}
    </div>
    <nav className="md-pagination" aria-label="Result pages"><button aria-label="Previous page" disabled={!start} onClick={()=>setOffset(Math.max(0,start-capacity))}>← Previous</button><span aria-live="polite">{ordered.length ? `${start+1}–${Math.min(ordered.length,start+capacity)} of ${ordered.length}` : '0 results'}</span><button aria-label="Next page" disabled={start+capacity>=ordered.length} onClick={()=>setOffset(start+capacity)}>Next →</button></nav>
  </section>;
}
