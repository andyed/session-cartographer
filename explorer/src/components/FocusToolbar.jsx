import { useEffect, useRef, useState } from 'react';
import { isDemoMode } from '../api.js';
import { MAX_FOCUS_DURATION_MS } from '../../shared/focus.js';
import { workspaceHref } from '../hooks/useFocusWorkspace.js';
import { toLocalDateTime, fromLocalDateTime } from './focus-gesture.js';

const EVIDENCE = [['edit', 'File edits'], ['commit', 'Commits recorded'], ['wrapup', 'Wrapups recorded'], ['research', 'Research'], ['activity', 'Other activity']];
const stamp = time => new Date(time).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const rangeLabel = interval => `${stamp(interval.from)} – ${stamp(interval.through)}`;

export function FocusExactFields({ workspace, focus, onClose }) {
  const initial = useRef(workspace.interval);
  const [from, setFrom] = useState(() => toLocalDateTime(initial.current.from));
  const [through, setThrough] = useState(() => toLocalDateTime(initial.current.through));
  const [error, setError] = useState('');
  const dirty = useRef({ from: false, through: false });
  return <form className="fw-exact" onSubmit={event => {
    event.preventDefault();
    const a = dirty.current.from ? fromLocalDateTime(from) : initial.current.from;
    const b = dirty.current.through ? fromLocalDateTime(through) : initial.current.through;
    if (a === null || b === null || a > b || toLocalDateTime(a) !== (from.length === 16 ? `${from}:00` : from) || toLocalDateTime(b) !== (through.length === 16 ? `${through}:00` : through)) { setError('Choose valid local times, with From no later than Through.'); return; }
    if (b - a > MAX_FOCUS_DURATION_MS) { setError('Choose a window of 90 days or less.'); return; }
    if (!isDemoMode && b > Date.now() + 60000) { setError('Through cannot be later than the current time.'); return; }
    const changed = dirty.current.from || dirty.current.through;
    const range = { from: a, through: b, lower: changed ? 'closed' : initial.current.lower || 'closed' };
    if (changed) workspace.activate(range);
    if (event.nativeEvent.submitter?.dataset.intent === 'remember') focus.save(range);
    onClose();
  }}>
    <label>From<input aria-label="Exact focus from" type="datetime-local" step="1" value={from} onChange={e => { dirty.current.from = true; setFrom(e.target.value); }} /></label>
    <label>Through<input aria-label="Exact focus through" type="datetime-local" step="1" value={through} onChange={e => { dirty.current.through = true; setThrough(e.target.value); }} /></label>
    <div className="fw-exact-actions"><button type="submit">Done</button><button type="button" onClick={() => onClose()}>Cancel</button></div>
    <button className="fw-remember-range" type="submit" data-intent="remember">{focus.saved ? 'Replace return point with this window' : 'Use this window as return point'}</button>
    <p>Local time · {Intl.DateTimeFormat().resolvedOptions().timeZone}</p>
    {error && <p role="alert">{error}</p>}
  </form>;
}

export default function FocusToolbar({ workspace, focus }) {
  const { route, data, scoped, interval, navigate, query, endQuery, activate, refreshing } = workspace;
  const [copied, setCopied] = useState('');
  const [editing, setEditing] = useState(false);
  const find = useRef(null), rangeButton = useRef(null), editor = useRef(null), facets = useRef(null);
  const closeEditor = (restore = true) => { setEditing(false); if (restore) requestAnimationFrame(() => rangeButton.current?.focus({ preventScroll: true })); };
  useEffect(() => {
    const shortcut = event => {
      if (event.key === 'Escape' && editing) { event.preventDefault(); event.stopPropagation(); closeEditor(); return; }
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey || event.target.closest('input, textarea, select, [contenteditable=true]') || !find.current?.getClientRects().length) return;
      event.preventDefault(); find.current.focus();
    };
    const dismiss = event => {
      if (editing && !editor.current?.contains(event.target) && !rangeButton.current?.contains(event.target)) closeEditor(false);
      if (facets.current?.open && !facets.current.contains(event.target)) facets.current.open = false;
    };
    window.addEventListener('keydown', shortcut, true); window.addEventListener('pointerdown', dismiss, true);
    return () => { window.removeEventListener('keydown', shortcut, true); window.removeEventListener('pointerdown', dismiss, true); };
  }, [editing]);
  const toggle = (key, value) => { const values = route[key] || []; navigate({ [key]: values.includes(value) ? values.filter(v => v !== value) : [...values, value], offset: 0 }); };
  const projects = [...new Set([...(data?.groups || []), ...(data?.sessions || []).flatMap(s => Object.keys(s.projects || {}))])].sort();
  const fixed = route.mode === 'fixed' || isDemoMode;
  const label = !interval ? 'Time range' : !fixed && route.mode === 'rolling' ? `Last ${Math.round((interval.through - interval.from) / 3600000)} hours` : route.mode === 'since-saved' ? 'Since return point' : rangeLabel(interval);
  const preset = hours => { const through = isDemoMode ? data.end : Date.now(); activate({ from: through - hours * 3600000, through, lower: 'closed' }, {}, isDemoMode ? 'fixed' : 'rolling'); closeEditor(); };
  return <header className="fw-toolbar">
    <div className="fw-scope-row">
      <label className="fw-find"><span className="md-sr">Find in this window</span><input ref={find} type="search" aria-label="Find in this window" placeholder="Find tasks, files, or recorded notes…" value={route.q} onChange={e => query(e.target.value)} onBlur={endQuery} onKeyDown={e => { if (e.key === 'Enter') endQuery(); }} />{route.q && <button aria-label="Clear find" onClick={() => { endQuery(); query(''); endQuery(); }}>×</button>}</label>
      <label className="fw-project"><span className="md-sr">Project</span><select aria-label="Project" value={route.project || ''} onChange={e => navigate({ project: e.target.value || null, offset: 0 })}><option value="">All projects</option>{route.project && !projects.includes(route.project) && <option>{route.project}</option>}{projects.map(p => <option key={p}>{p}</option>)}</select></label>
      <details ref={facets} className="fw-facets" onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); e.currentTarget.open = false; e.currentTarget.querySelector('summary').focus(); } }}><summary>Filters{(route.providers?.length || 0) + (route.evidence?.length || 0) ? ` · ${(route.providers?.length || 0) + (route.evidence?.length || 0)}` : ''}</summary><div className="fw-facet-panel"><fieldset><legend>Provider</legend>{['codex', 'claude'].map(value => <label key={value}><input type="checkbox" checked={route.providers?.includes(value) || false} onChange={() => toggle('providers', value)} />{value}</label>)}</fieldset><fieldset><legend>Recorded evidence</legend>{EVIDENCE.map(([value, label]) => <label key={value}><input type="checkbox" checked={route.evidence?.includes(value) || false} onChange={() => toggle('evidence', value)} />{label}</label>)}</fieldset><button onClick={() => { facets.current.open = false; facets.current.querySelector('summary').focus(); }}>Done</button></div></details>
    </div>
    <div className="fw-chips" aria-label="Active filters">
      {route.project && <button onClick={() => navigate({ project: null })}>Project: {route.project} ×</button>}
      {(route.providers || []).map(p => <button key={p} onClick={() => toggle('providers', p)}>{p} ×</button>)}
      {(route.evidence || []).map(p => <button key={p} onClick={() => toggle('evidence', p)}>{EVIDENCE.find(([key]) => key === p)?.[1] || p} ×</button>)}
      {route.brush?.length > 0 && <button onClick={() => navigate({ brush: null })}>{route.brush.length} selected tasks ×</button>}
    </div>
    <div className="fw-rangebar">
      <button ref={rangeButton} className="fw-range-trigger" aria-label="Edit time range" aria-expanded={editing} disabled={!interval || Boolean(route.routeError)} onClick={() => setEditing(value => !value)} title={interval ? rangeLabel(interval) : undefined}>{label} <span aria-hidden="true">▾</span></button>
      {focus.saved && <button className="fw-return-marker" aria-label="Go to return point" title={`Return point: ${rangeLabel(focus.saved)}`} onClick={() => { focus.restore(); closeEditor(false); }}><span aria-hidden="true">↶</span> Return point <time dateTime={new Date(focus.saved.through).toISOString()}>{stamp(focus.saved.through)}</time></button>}
      <span className="fw-range-state">{isDemoMode ? 'Recorded example' : fixed ? 'Fixed' : 'Following latest'}</span>
    </div>
    {editing && interval && <section ref={editor} className="fw-range-editor" aria-label="Edit time range">
      <div className="fw-range-presets" aria-label="Time presets">{[[1,'Last hour'],[24,'Last 24 hours'],[168,'Last 7 days']].map(([hours,text]) => <button key={hours} disabled={!data} onClick={() => preset(hours)}>{text}</button>)}{focus.saved && <button onClick={() => { focus.since(); closeEditor(); }}>Since return point</button>}</div>
      <FocusExactFields workspace={workspace} focus={focus} onClose={closeEditor} />
      <div className="fw-range-secondary">
        {!fixed && <button onClick={() => { activate(interval); closeEditor(); }}>Pause following</button>}
        <button onClick={async () => {
          const tab = window.location.pathname.includes('/memory') ? 'memory' : 'timeline';
          const link = new URL(workspaceHref({ ...route, ...interval, mode: 'fixed', durationMs: null }, tab), window.location.origin).href;
          try { await navigator.clipboard.writeText(link); setCopied('Link copied'); } catch { setCopied(`Copy this link: ${link}`); }
          closeEditor();
        }}>Copy link to this window</button>
      </div>
    </section>}
    {data && <details className="fw-coverage"><summary>{refreshing ? 'Updating records…' : `Updated ${new Date(data.source?.snapshotAt || data.end).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`}{data.evidenceComplete === false ? ' · incomplete source' : ''}</summary><p>{isDemoMode ? 'This is a fixed recorded example. Outside its recorded dates, history is unavailable.' : 'These are recorded observations. Gaps in logging may exist; no activity is not proof that no work happened.'}</p><p>Loaded {new Date(data.start).toLocaleString()} – {new Date(data.end).toLocaleString()}.</p>{scoped?.coverage?.status === 'outside-observed-extent' && <p>The focus is outside the dates with observed records.</p>}{data.evidenceComplete === false && <p role="status">The source is incomplete. Counts describe only the records currently available.</p>}<button onClick={workspace.retry} disabled={refreshing}>Refresh</button></details>}
    {(focus.notice || copied) && <p className="fw-notice" role="status">{focus.notice || copied}</p>}
    {focus.legacy && <p className="fw-notice">A previous return point is available. <button onClick={focus.useLegacy}>Use previous return point</button></p>}
  </header>;
}
