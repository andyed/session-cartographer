import { useEffect, useMemo, useRef, useState } from 'react';
import { apiRequest, isDemoMode } from '../api.js';
import { workspaceHref } from '../hooks/useFocusWorkspace.js';
import { MAX_FOCUS_DURATION_MS } from '../../shared/focus.js';
import { plainLinkClick } from './memory-route.js';
import AgentBadge from './AgentBadge.jsx';
import '../styles/memory-recall.css';

// Recall telemetry is fetched when one of these views opens, never with the
// polled memory state. Labels say "marked used": a --touch proves the agent
// marked a result, not that the result improved anything.

const stamp = t => new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const clock = t => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const shortId = id => String(id).slice(0, 8);
const STATUS_LABELS = {
  explicit: 'explicit call id',
  unique_serve: 'only call that served it',
  prior_access: 'earlier access in this session',
  invalid_call: 'named a call that never served it',
  no_session: 'no session recorded',
  ambiguous_serve: 'several calls served it',
  ambiguous_prior_access: 'several earlier accesses',
  no_compatible_serve: 'no matching call',
};
const statusLabel = status => status ? STATUS_LABELS[status] || status : 'status not recorded';
const isCallList = body => Array.isArray(body?.calls) && Boolean(body.totals) && Boolean(body.unplaced);
const isCallDetail = body => Array.isArray(body?.rows) && Boolean(body.resolution);

// A backend started before these endpoints existed answers with the SPA's
// HTML, which apiRequest reads as {}. Say so instead of rendering nothing.
const STALE_BACKEND = 'The running Explorer backend does not serve recall telemetry yet. Restart Turbo and the Explorer UI to load it.';

function useRecall(url, key, isShape) {
  const [state, setState] = useState({ loading: true });
  useEffect(() => {
    if (!url) return undefined;
    const controller = new AbortController();
    setState(current => ({ ...current, loading: true, error: null }));
    apiRequest(url, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]) })
      .then(body => { if (!isShape(body)) throw new Error(STALE_BACKEND); return body; })
      .then(body => { if (!controller.signal.aborted) setState({ loading: false, body }); })
      .catch(error => { if (!controller.signal.aborted) setState({ loading: false, error: error.message }); });
    return () => controller.abort();
  }, [key]);
  return state;
}

/**
 * A fixed window that holds the result's own session. A rolling link breaks
 * once the session leaves the window, so episode links are always fixed:
 * bounded by the session's recorded life, or a day around the one timestamp known.
 */
export function episodeRange(row, fallbackTime = null, now = Date.now()) {
  const pad = 60000;
  let from, through;
  if (row.session_range) { from = row.session_range.from - pad; through = row.session_range.through + pad; }
  else {
    const t = row.event_timestamp ?? fallbackTime;
    if (!Number.isFinite(t)) return null;
    from = t - 12 * 3600000; through = t + 12 * 3600000;
  }
  through = Math.min(through, now);
  from = Math.max(Math.min(from, through - pad), through - MAX_FOCUS_DURATION_MS);
  return { from, through, lower: 'closed' };
}

function episodeDestination(workspace, sessionId, range) {
  if (!sessionId || !range) return null;
  return { href: workspaceHref({ ...range, mode: 'fixed', session: sessionId }, 'memory'), onClick: event => {
    if (!plainLinkClick(event)) return;
    event.preventDefault();
    workspace.activate(range, { session: sessionId, surface: 'results', result: 'tasks', call: null, contributor: null, file: null, review: null, q: '', project: null, providers: [], evidence: [], brush: null }, 'fixed');
  } };
}

function EpisodeLink({ workspace, sessionId, range, label = 'Open episode' }) {
  const destination = episodeDestination(workspace, sessionId, range);
  if (!destination) return null;
  return <a className="rc-episode" aria-label={`${label} ↗`} title={label} {...destination}><svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M14 3h7v7M21 3L10 14M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5"/></svg></a>;
}

function UsedMarker({ row }) {
  if (!row.used.length) return null;
  const statuses = [...new Set(row.used.map(mark => mark.attribution_status))];
  return <span className="rc-marker rc-used" title={`Marked used by --touch · ${statuses.map(statusLabel).join(', ')}`}>
    <span aria-hidden="true">✓ </span>marked used{row.rank !== null ? ` · rank ${row.rank}` : ''}
    {statuses.some(status => status !== 'explicit') && <span className="rc-marker-note"> · {statuses.map(statusLabel).join(', ')}</span>}
  </span>;
}

function ResultText({ row }) {
  if (row.summary) return <span className="rc-summary">{row.summary}</span>;
  if (row.resolution === 'turn-id') return <span className="rc-summary rc-quiet">Transcript turn {row.turn ?? ''} · text is held only in the semantic index</span>;
  return <span className="rc-summary rc-quiet">Unresolved: <code>{row.event_id}</code> is not in the corpus or the index</span>;
}

function sharedResultContext(rows) {
  if (rows.length < 2) return {};
  const same = read => {
    const value = read(rows[0]);
    return value && rows.every(row => read(row) === value) ? value : null;
  };
  const sessionId = same(row => row.session_id);
  return {
    provider: same(row => row.provider), source: same(row => row.source),
    project: same(row => row.event_project || row.project), sessionId,
    sessionTitle: sessionId ? rows.find(row => row.session_title)?.session_title || `Session ${shortId(sessionId)}` : null,
  };
}

function ResultTime({ timestamp, callTime, rank }) {
  if (!Number.isFinite(timestamp)) return null;
  const exact = new Date(timestamp).toLocaleString([], { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit', timeZoneName: 'short' });
  const delta = Number.isFinite(callTime) ? timestamp - callTime : null;
  const distance = Math.abs(delta || 0);
  const age = distance < 60000 ? '<1m' : distance < 3600000 ? `${Math.floor(distance / 60000)}m` : distance < 86400000 ? `${Math.floor(distance / 3600000)}h` : `${Math.floor(distance / 86400000)}d`;
  const label = delta === null ? stamp(timestamp) : delta === 0 ? 'At call time' : `${age} ${delta < 0 ? 'before' : 'after'} call`;
  const offset = delta === null ? stamp(timestamp) : delta === 0 ? '0m' : `${delta < 0 ? '−' : '+'}${age}`;
  return <details className="rc-result-time"><summary aria-label={`Show exact time for rank ${rank ?? 'unknown'}: ${label}`} title={`${label} · ${exact}`}>{offset}</summary><time dateTime={new Date(timestamp).toISOString()} data-copy-content>{exact}</time></details>;
}

function ResultRow({ row, workspace, callTime, shared = {} }) {
  const range = episodeRange(row, callTime);
  const destination = episodeDestination(workspace, row.session_id, range);
  const Body = destination ? 'a' : 'div';
  return <li className="rc-result" data-used={row.used.length > 0 || undefined} data-event-id={row.event_id} data-session-id={row.session_id || undefined} data-source={row.source || undefined}>
    <span className="rc-rank" aria-label={`Rank ${row.rank ?? 'unknown'}`}>{row.rank ?? '–'}</span>
    <div className="rc-result-body">
      <Body className="rc-result-destination" {...(destination || {})} title={destination ? `Open episode${row.session_title ? `: ${row.session_title}` : ''}` : undefined}>
      <ResultText row={row} />
      <span className="rc-meta">
        {row.provider && !shared.provider && <AgentBadge provider={row.provider} />}
        {row.session_id && !shared.sessionId && <span title={row.session_id}>{row.session_title || `Session ${shortId(row.session_id)}`}</span>}
        {row.source && !shared.source && <span>{row.source}</span>}
        {(row.event_project || row.project) && !shared.project && <span>{row.event_project || row.project}</span>}
        {row.resolution === null && <span>unresolved</span>}
      </span>
      </Body>
      <div className="rc-markers">
        <ResultTime timestamp={row.event_timestamp} callTime={callTime} rank={row.rank} />
        <UsedMarker row={row} />
        {row.fetched.length > 0 && <span className="rc-marker rc-fetched" title="Redeemed with --get. Fetching is inspection, not a use mark.">fetched</span>}
        {row.session_id && !range && <span className="rc-meta">session {shortId(row.session_id)}</span>}
      </div>
    </div>
  </li>;
}

function StrayMarks({ marks, workspace }) {
  if (!marks?.length) return null;
  return <div className="rc-stray" role="note">
    <h4>{plural(marks.length, 'mark')} named this call for results it never served</h4>
    <ul>{marks.map((mark, i) => <li key={`${mark.event_id}-${i}`}>
      <span className="rc-marker rc-warn">{statusLabel(mark.attribution_status)}</span>
      <span className="rc-summary">{mark.summary || <code>{mark.event_id}</code>}</span>
      {mark.marked_at && <span className="rc-meta">marked {stamp(mark.marked_at)}</span>}
      <EpisodeLink workspace={workspace} sessionId={mark.session_id} range={episodeRange(mark, mark.marked_at)} />
    </li>)}</ul>
  </div>;
}

function CallResults({ call, workspace }) {
  const [retry, setRetry] = useState(0);
  const panel = useRef(null);
  const detail = useRecall(`/api/memory/recall/call?${new URLSearchParams({ call: call.call_id })}`, `${call.call_id}:${retry}`, isCallDetail);
  const { rows = [], stray_marks: stray, resolution } = detail.body || {};
  const shared = useMemo(() => sharedResultContext(rows), [rows]);
  return <section ref={panel} tabIndex={-1} className="rc-results" aria-label={`Results for ${call.query || call.call_id}`}>
    {detail.loading && !detail.body && <p className="rc-quiet" role="status">Reading ranked results…</p>}
    {detail.error && <div className="rc-detail-error" role="alert"><span>{detail.error}</span><button onClick={() => { panel.current?.focus({ preventScroll: true }); setRetry(value => value + 1); }}>Retry results</button></div>}
    {detail.body && <>
    {(shared.provider || shared.sessionId || shared.source || shared.project) && <div className="rc-result-context" role="group" aria-label="Shared result context">
      <span>All results</span>
      {shared.provider && <AgentBadge provider={shared.provider} />}
      {shared.sessionId && <span data-shared-session={shared.sessionId} title={shared.sessionId}>{shared.sessionTitle}</span>}
      {shared.project && <span data-shared-project={shared.project}>{shared.project}</span>}
      {shared.source && <span data-shared-source={shared.source}>{shared.source}</span>}
    </div>}
    {Number.isFinite(call.timestamp) && rows.some(row => Number.isFinite(row.event_timestamp)) && <p className="rc-time-baseline rc-quiet">Time from search</p>}
    {rows.length ? <ol aria-label={`Ranked results for “${call.query || call.call_id}”`}>{rows.map(row => <ResultRow key={row.event_id} row={row} workspace={workspace} callTime={call.timestamp} shared={shared} />)}</ol>
      : <p className="rc-quiet">This call returned no results.</p>}
    {resolution.unresolved > 0 && <p className="rc-quiet">{plural(resolution.unresolved, 'result')} no longer resolve{resolution.unresolved === 1 ? 's' : ''} to a recorded event{resolution.index_status === 'unavailable' ? '; the semantic index did not answer' : resolution.index_status === 'disabled' ? '; the semantic index is off' : ''}. They stay listed at their served rank.</p>}
    <StrayMarks marks={stray} workspace={workspace} />
    </>}
  </section>;
}

function CallRow({ call, workspace, expanded, onToggle, showAgent = true }) {
  const id = `recall-${call.call_id}`;
  const deep = call.deepest_used_rank;
  return <li className="rc-call" data-call={call.call_id} data-expanded={expanded || undefined}>
    <button className="rc-call-toggle" aria-expanded={expanded} aria-controls={id} onClick={onToggle}>
      <span className="rc-call-query">{call.query || <span className="rc-quiet">Query not recorded</span>}</span>
      <span className="rc-meta">
        <time dateTime={call.timestamp ? new Date(call.timestamp).toISOString() : undefined}>{call.timestamp ? stamp(call.timestamp) : 'time not recorded'}</time>
        <span>{call.purpose || 'purpose not recorded'}</span>
        {call.backend && <span>{call.backend}</span>}
      </span>
      <span className="rc-call-counts">
        <span>{plural(call.served, 'result')}</span>
        <span className={call.used ? 'rc-used-count' : undefined}>{call.used} marked used{deep ? ` · deepest rank ${deep}` : ''}</span>
        {call.fetched > 0 && <span>{call.fetched} fetched</span>}
        {call.stray_marks > 0 && <span className="rc-warn-text">{plural(call.stray_marks, 'stray mark')}</span>}
      </span>
    </button>
    {showAgent && call.provider && <span className="rc-call-agent"><AgentBadge provider={call.provider} /></span>}
    {expanded && <div id={id}><CallResults call={call} workspace={workspace} /></div>}
  </li>;
}

function UnplacedMarks({ unplaced, workspace, scope }) {
  if (!unplaced?.total) return null;
  const statuses = Object.entries(unplaced.by_status).sort((a, b) => b[1] - a[1]);
  return <details className="rc-unplaced">
    <summary>{plural(unplaced.total, 'used mark')} {scope} name{unplaced.total === 1 ? 's' : ''} no call · {statuses.map(([status, n]) => `${n} ${statusLabel(status)}`).join(' · ')}</summary>
    <p className="rc-quiet">The writer could not tie these marks to a served call, so no result above carries them. They are listed rather than guessed onto a call.</p>
    <ul>{unplaced.marks.map((mark, i) => <li key={`${mark.event_id}-${i}`}>
      <span className="rc-marker rc-warn">{statusLabel(mark.attribution_status)}</span>
      <span className="rc-summary">{mark.summary || <code>{mark.event_id}</code>}</span>
      {mark.marked_at && <span className="rc-meta">marked {stamp(mark.marked_at)}{mark.requested_call_id ? ` · requested ${mark.requested_call_id}` : ''}</span>}
      <EpisodeLink workspace={workspace} sessionId={mark.session_id} range={episodeRange(mark, mark.marked_at)} />
    </li>)}</ul>
    {unplaced.marks.length < unplaced.total && <p className="rc-quiet">Showing the latest {unplaced.marks.length}.</p>}
  </details>;
}

function useExpanded(workspace) {
  const { route, navigate } = workspace;
  return [route.call, id => navigate({ call: route.call === id ? null : id }, { replace: true })];
}

/** The task inspector's Recall section: every search this session ran, over its whole life. */
export function SessionRecall({ workspace, session }) {
  const [refresh, setRefresh] = useState(0);
  const [expanded, toggle] = useExpanded(workspace);
  const recall = useRecall(isDemoMode ? null : `/api/memory/recall?${new URLSearchParams({ session: session.id })}`, `${session.id}:${refresh}`, isCallList);
  if (isDemoMode) return null;
  const body = recall.body;
  if (!recall.error && (!body || (!body.calls.length && !body.unplaced.total))) return null;
  return <section className="rc-session" aria-label="Recall">
    <div className="rc-session-head"><h2>Recall</h2>{body?.totals.calls > 0 && <span>{plural(body.totals.calls, 'search', 'searches')}</span>}</div>
    {recall.loading && !body && <p className="rc-quiet" role="status">Reading recall telemetry…</p>}
    {recall.error && <p role="alert">{recall.error} <button className="fw-link" onClick={() => setRefresh(n => n + 1)}>Retry</button></p>}
    {body && <>
      {body.totals.calls > 0 && <p className="rc-quiet">{body.totals.served} results served · {body.totals.used} marked used{body.totals.fetched ? ` · ${body.totals.fetched} fetched` : ''}</p>}
      {body.totals.calls > 0 && <ul className="rc-calls">{body.calls.map(call => <CallRow key={call.call_id} call={call} workspace={workspace} expanded={expanded === call.call_id} onToggle={() => toggle(call.call_id)} />)}</ul>}
      <UnplacedMarks unplaced={body.unplaced} workspace={workspace} scope="made in this session" />
    </>}
  </section>;
}

/** The window-level Recall view: every call in the focus interval, grouped by session. */
export default function MemoryRecall({ workspace, onSession, hrefForSession, viewNavigation }) {
  const { route, interval, data } = workspace;
  const [purpose, setPurpose] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [expanded, toggle] = useExpanded(workspace);
  const intervalRef = useRef(interval); intervalRef.current = interval;
  // A rolling window advances on every poll; refetching on each tick would
  // turn an on-demand view into a second poller. Refetch when the window's
  // definition changes or the reader asks.
  const windowKey = route.mode === 'rolling' ? `rolling:${route.durationMs}` : `${interval?.from}:${interval?.through}`;
  const url = useMemo(() => {
    if (isDemoMode || !intervalRef.current) return null;
    const params = new URLSearchParams({ from: new Date(intervalRef.current.from).toISOString(), through: new Date(Math.min(intervalRef.current.through, Date.now())).toISOString() });
    if (purpose) params.set('purpose', purpose);
    return `/api/memory/recall?${params}`;
  }, [windowKey, purpose, refresh]);
  // Keyed on the counter too: in a fixed window, Refresh leaves the URL unchanged.
  const recall = useRecall(url, `${url}|${refresh}`, isCallList);
  const titles = useMemo(() => new Map((data?.sessions || []).map(session => [session.id, session])), [data]);
  const body = recall.body;
  const groups = useMemo(() => {
    if (!body) return [];
    const bySession = new Map();
    for (const call of body.calls) {
      const key = call.session_id || '';
      if (!bySession.has(key)) bySession.set(key, []);
      bySession.get(key).push(call);
    }
    return [...bySession.entries()].map(([sessionId, calls]) => ({ sessionId: sessionId || null, calls, latest: calls[0].timestamp ?? null }))
      .sort((a, b) => (a.sessionId === null) - (b.sessionId === null) || (b.latest ?? 0) - (a.latest ?? 0));
  }, [body]);

  return <section className="fw-recall" aria-label="Recall searches">
    <div className="fw-results-head">{viewNavigation}
      {body && <label><span className="md-sr">Purpose</span><select aria-label="Recall purpose" value={purpose} onChange={event => setPurpose(event.target.value)}>
        <option value="">All purposes</option>
        {Object.entries(body.purposes).sort((a, b) => b[1] - a[1]).map(([name, count]) => <option key={name} value={name}>{name} ({count})</option>)}
        {purpose && !(purpose in body.purposes) && <option value={purpose}>{purpose}</option>}
      </select></label>}
      {!isDemoMode && <button className="rc-refresh" onClick={() => setRefresh(n => n + 1)} disabled={recall.loading}>{recall.loading ? 'Reading…' : 'Refresh'}</button>}
    </div>
    {isDemoMode && <div className="fw-empty"><h2>Recall telemetry is not part of the recorded example</h2><p>The live Explorer lists every /remember search in the window with its ranked results.</p></div>}
    {recall.error && <div className="fw-error" role="alert"><span>{recall.error}</span><button onClick={() => setRefresh(n => n + 1)}>Retry</button></div>}
    {!isDemoMode && recall.loading && !body && <p className="rc-quiet" role="status">Reading recall telemetry…</p>}
    {body && <>
      <p className="rc-totals" role="status">
        {plural(body.totals.calls, 'call')} · {body.totals.attributed} attributed to {plural(body.totals.sessions, 'session')} · <strong>{body.totals.unattributed} unattributed</strong> · {body.totals.served} results served · {body.totals.used} marked used
        {body.unplaced.total > 0 && ` · ${plural(body.unplaced.total, 'mark')} with no call`}
      </p>
      <UnplacedMarks unplaced={body.unplaced} workspace={workspace} scope="in this window" />
      {body.truncated > 0 && <p className="fw-notice" role="status">Showing the newest {body.calls.length} of {body.totals.calls} calls. Narrow the window to see the rest.</p>}
      {groups.map(group => {
        const session = group.sessionId && titles.get(group.sessionId);
        return <section key={group.sessionId || 'unattributed'} className="rc-group" aria-label={group.sessionId ? `Session ${session?.title || shortId(group.sessionId)}` : 'Unattributed calls'} data-unattributed={group.sessionId ? undefined : true}>
          <header className="rc-group-head">
            {group.sessionId ? <>
              <h3>{session ? <a href={hrefForSession(session)} onClick={event => { if (plainLinkClick(event)) { event.preventDefault(); onSession(session); } }}>{session.title}</a> : `Session ${shortId(group.sessionId)}`}</h3>
              {session?.provider ? <AgentBadge provider={session.provider} /> : group.calls[0].provider ? <AgentBadge provider={group.calls[0].provider} /> : null}
              {!session && <EpisodeLink workspace={workspace} sessionId={group.sessionId} range={episodeRange({}, group.latest)} label="Open session" />}
            </> : <h3>Unattributed</h3>}
            <span className="rc-quiet">{plural(group.calls.length, 'call')}</span>
          </header>
          {!group.sessionId && <p className="rc-quiet">These calls were recorded without a session id, so no task can claim them. They are listed so the window's recall stays complete.</p>}
          {/* A session group names its agent in the header; unattributed calls name their own. */}
          <ul className="rc-calls">{group.calls.map(call => <CallRow key={call.call_id} call={call} workspace={workspace} expanded={expanded === call.call_id} onToggle={() => toggle(call.call_id)} showAgent={!group.sessionId} />)}</ul>
        </section>;
      })}
      {!body.calls.length && <div className="fw-empty"><h2>No recall calls in this window</h2><p>No /remember search was recorded between these times. Try a wider interval.</p></div>}
    </>}
  </section>;
}
