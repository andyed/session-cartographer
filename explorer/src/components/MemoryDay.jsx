import { useEffect, useMemo, useState } from 'react';
import { apiRequest, isDemoMode } from '../api.js';
import { workspaceHref } from '../hooks/useFocusWorkspace.js';
import { plainLinkClick } from './memory-route.js';
import AgentBadge from './AgentBadge.jsx';
import '../styles/memory-day.css';

// One local calendar day across every session, from /api/memory/day. The
// endpoint runs the same script as `session-digest.js --day` and the scheduled
// pulse, so every count here is the count the command line prints. This view
// adds no arithmetic of its own beyond the per-project claim rule the panel
// applies: a commit counts when git confirms it.

const pad2 = n => String(n).padStart(2, '0');
export const localDay = t => { const d = new Date(t); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; };
const shiftDay = (day, delta) => { const [y, m, d] = day.split('-').map(Number); return localDay(new Date(y, m - 1, d + delta).getTime()); };

/** The focus window for a day: local midnight to local midnight, or to now for today. */
export function dayRange(day, now = Date.now()) {
  const [y, m, d] = day.split('-').map(Number);
  const from = new Date(y, m - 1, d).getTime();
  const end = new Date(y, m - 1, d + 1).getTime();
  return { from, through: Math.min(end, Math.max(from + 60000, now)), lower: 'closed' };
}

const fmtDuration = minutes => minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h${pad2(minutes % 60)}m`;
const clock = t => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const plural = (n, one, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
const claimed = project => project.commits.filter(c => c.status === 'landed').length + project.git_only_commits.length;
const isMinor = p => !p.commits.length && !p.git_only_commits.length && !p.investigations.length
  && !p.investigation_outcomes.length && !Object.keys(p.files).length && !p.repo;
// Worded for both cases: an installed plugin older than 0.8.1, and a Turbo
// still running from before an update, which keeps serving the old API until
// it restarts.
const STALE_BACKEND = 'The running Turbo backend is older than this view and does not serve the day digest yet. Update Cartographer to 0.8.1 or later, stop Turbo with node scripts/cartographer-turbo.js stop, and reopen the desk to start the new one. The same digest runs from the command line now:';
const COMMITS_SHOWN = 10;

function useDay(url, refresh) {
  const [state, setState] = useState({ loading: true });
  useEffect(() => {
    if (!url) return undefined;
    const controller = new AbortController();
    setState(current => ({ loading: true, body: current.url === url ? current.body : null, url }));
    apiRequest(url, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(45000)]) })
      .then(body => { if (body?.schema !== 'carto.day-digest/1') throw new Error(STALE_BACKEND); return body; })
      .then(body => { if (!controller.signal.aborted) setState({ loading: false, body, url }); })
      .catch(error => {
        if (controller.signal.aborted) return;
        setState({ loading: false, url, error: error.status === 404 ? STALE_BACKEND : error.message });
      });
    return () => controller.abort();
  }, [url, refresh]);
  return state;
}

function niceCeiling(n) {
  if (n <= 5) return 5;
  const step = 10 ** Math.floor(Math.log10(n));
  return [1, 2, 5, 10].map(k => k * step).find(v => v >= n);
}

/** Events per local hour: one series, so no legend; the caption names it and a table carries the values. */
function HoursChart({ hours }) {
  const top = niceCeiling(Math.max(...hours));
  // Room at the left for a four-digit tick with a thousands separator, at the
  // larger tick size narrow screens use (the SVG scales its text with it).
  const slot = 20, plot = 96, base = 104, left = 64;
  const barPath = (x, h) => {
    const w = 14, r = Math.min(4, h);
    return `M${x},${base} V${base - h + r} Q${x},${base - h} ${x + r},${base - h} H${x + w - r} Q${x + w},${base - h} ${x + w},${base - h + r} V${base} Z`;
  };
  return <figure className="dd-hours">
    <figcaption>Events per local hour</figcaption>
    <svg viewBox={`0 0 ${left + 24 * slot} 130`} role="img" aria-label="Events per local hour; the table below lists each hour" preserveAspectRatio="xMinYMin meet">
      <line x1={left} x2={left + 24 * slot} y1={base + 0.5} y2={base + 0.5} className="dd-axis" />
      <line x1={left} x2={left + 24 * slot} y1={base - plot + 0.5} y2={base - plot + 0.5} className="dd-grid" />
      {/* Bars grow from the baseline rule, which is zero; a "0" label there
          collides with the first hour label at phone width. */}
      <text x={left - 6} y={base - plot + 4} textAnchor="end" className="dd-tick">{top.toLocaleString()}</text>
      {hours.map((n, hour) => {
        const x = left + hour * slot + 3;
        const h = n ? Math.max(2, (n / top) * plot) : 0;
        return <g key={hour} className="dd-bar">
          <title>{`${pad2(hour)}:00–${pad2(hour)}:59 · ${plural(n, 'event')}`}</title>
          <rect x={x - 3} y={base - plot} width={slot} height={plot} className="dd-hit" />
          {h > 0 && <path d={barPath(x, h)} />}
        </g>;
      })}
      {[0, 6, 12, 18, 23].map(hour => <text key={hour} x={left + hour * slot + 10} y={base + 18} textAnchor="middle" className="dd-tick">{pad2(hour)}</text>)}
    </svg>
    <table className="md-sr"><caption>Events per local hour</caption><thead><tr><th scope="col">Hour</th><th scope="col">Events</th></tr></thead>
      <tbody>{hours.map((n, hour) => <tr key={hour}><td>{pad2(hour)}:00</td><td>{n}</td></tr>)}</tbody></table>
  </figure>;
}

const MARKS = {
  moved: c => `moved · logged as ${c.hash}`,
  git_only: () => 'git only',
  missing: () => 'not in git',
  unverified: () => 'unchecked',
};

function CommitRow({ commit, sessionLink }) {
  const kind = commit.gitOnly ? 'git_only' : commit.landed_as ? 'moved' : commit.status === 'landed' ? null : commit.status;
  const hash = (commit.landed_as || commit.sha || '').slice(0, 7);
  const churn = commit.added === null || commit.added === undefined ? null : `+${commit.added.toLocaleString()} −${commit.removed.toLocaleString()}`;
  const link = !commit.gitOnly && commit.session_id ? sessionLink(commit.session_id) : null;
  return <li className="dd-commit" data-status={kind || 'landed'}>
    <time dateTime={commit.at}>{clock(commit.at)}</time>
    <code>{hash}</code>
    <span className="dd-subject">{link ? <a href={link.href} onClick={link.onClick}>{commit.subject || '(no subject)'}</a> : commit.subject || '(no subject)'}</span>
    <span className="dd-commit-tail">
      {kind && <span className={`rc-marker ${kind === 'missing' || kind === 'unverified' ? 'rc-warn' : 'rc-fetched'}`}>{MARKS[kind](commit)}</span>}
      {churn && <span className="dd-churn">{churn}</span>}
    </span>
  </li>;
}

function ProjectDay({ project, sessionLink, titles }) {
  const [all, setAll] = useState(false);
  const rows = useMemo(() => [
    ...project.commits.filter(c => c.status !== 'rewritten').map(c => ({ ...c, gitOnly: false })),
    ...project.git_only_commits.map(c => ({ ...c, gitOnly: true })),
  ].sort((a, b) => Date.parse(b.at) - Date.parse(a.at)), [project]);
  const rewritten = project.commits.filter(c => c.status === 'rewritten').length;
  const files = Object.entries(project.files);
  const n = claimed(project);
  const repo = project.repo;
  const repoFlags = repo ? [repo.dirty > 0 && `${repo.dirty} uncommitted`, repo.unpushed && repo.unpushed !== '0' && `${repo.unpushed} unpushed`].filter(Boolean) : [];
  const name = project.kind === 'repo' ? project.name : 'Outside any repository';
  return <section className="dd-project" aria-label={name}>
    <header className="dd-project-head">
      <h3>{name}</h3>
      <span className="rc-quiet">{project.kind === 'repo' && `${plural(n, 'commit')} · `}{plural(project.sessions.length, 'session')} · {fmtDuration(project.active_minutes)} active</span>
    </header>
    {project.kind === 'non_repo' && <p className="rc-quiet">Recorded under {project.members.join(', ')}. Commits here cannot be checked against a repository.</p>}
    {rows.length > 0 && <ol className="dd-commits" aria-label={`Commits in ${name}, newest first`}>
      {(all ? rows : rows.slice(0, COMMITS_SHOWN)).map(c => <CommitRow key={`${c.sha}-${c.gitOnly}`} commit={c} sessionLink={sessionLink} />)}
    </ol>}
    {rows.length > COMMITS_SHOWN && <button className="dd-more" aria-expanded={all} onClick={() => setAll(v => !v)}>{all ? `Show the latest ${COMMITS_SHOWN}` : `Show all ${rows.length} commits`}</button>}
    {rewritten > 0 && <p className="rc-quiet">{plural(rewritten, 'logged commit')} no longer on any branch (amended or rebased away) {rewritten === 1 ? 'is' : 'are'} not listed.</p>}
    {project.investigations.map(inv => <p key={inv.event_id} className="dd-line"><span className={`rc-marker ${inv.outcome === 'open' ? 'rc-warn' : 'rc-fetched'}`}>diagnosed · {inv.outcome}</span> <span>{inv.symptom}</span></p>)}
    {files.length > 0 && <div className="dd-files">
      <p className="rc-quiet">{plural(files.length, 'file')} edited{project.files_unresolved ? ` · ${project.files_unresolved} edit ${project.files_unresolved === 1 ? 'path' : 'paths'} not found on disk` : ''}</p>
      <ul>{files.slice(0, 5).map(([file, count]) => <li key={file}><span className="dd-path">{file}</span><span className="rc-quiet">×{count}</span></li>)}</ul>
    </div>}
    {project.sessions.length > 0 && <ul className="dd-sessions" aria-label={`Sessions in ${name}`}>
      {project.sessions.map(s => {
        const link = sessionLink(s.id);
        const title = titles.get(s.id)?.title || `Session ${s.id.slice(0, 8)}`;
        return <li key={s.id}>{s.provider ? <AgentBadge provider={s.provider} /> : <span className="rc-quiet">agent unrecorded</span>}<a href={link.href} onClick={link.onClick}>{title}</a><span className="rc-quiet">{clock(s.first)}–{clock(s.last)}</span></li>;
      })}
    </ul>}
    {repo && <p className="dd-line"><span className="rc-quiet">Now, read at load:</span> {repo.branch} · {repoFlags.length ? repoFlags.join(' · ') : 'clean'}</p>}
  </section>;
}

export default function MemoryDay({ workspace, viewNavigation }) {
  const { route, interval, data } = workspace;
  const today = localDay(Date.now());
  const day = route.day || localDay(Math.min(interval?.through ?? Date.now(), Date.now()) - 1);
  const [refresh, setRefresh] = useState(0);
  const [receipt, setReceipt] = useState({ message: '', text: '' });
  const params = new URLSearchParams({ day });
  if (route.project) params.set('projects', route.project);
  const state = useDay(isDemoMode ? null : `/api/memory/day?${params}`, refresh);
  const body = state.body;
  const titles = useMemo(() => new Map((data?.sessions || []).map(session => [session.id, session])), [data]);
  // Picking a day also moves the desk's window onto it, so the timeline above
  // and the inspector a session link opens describe the same day as this view.
  const choose = next => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(next)) return;
    setReceipt({ message: '', text: '' });
    workspace.activate(dayRange(next), { surface: 'day', day: next, session: null, contributor: null, file: null, review: null, call: null }, 'fixed');
  };
  const sessionLink = id => {
    const range = dayRange(day);
    const scope = { surface: 'day', day, session: id, contributor: null, file: null, review: null, call: null };
    return {
      href: workspaceHref({ ...scope, ...range, mode: 'fixed' }, 'memory'),
      onClick: event => { if (plainLinkClick(event)) { event.preventDefault(); workspace.activate(range, scope, 'fixed'); } },
    };
  };
  const copyReceipt = async () => {
    setReceipt({ message: 'Reading receipt…', text: '' });
    try {
      const md = new URLSearchParams(params); md.set('format', 'md');
      const result = await apiRequest(`/api/memory/day?${md}`, { signal: AbortSignal.timeout(45000) });
      if (typeof result?.text !== 'string') throw new Error(STALE_BACKEND);
      try { await navigator.clipboard.writeText(result.text); setReceipt({ message: 'Receipt copied as Markdown', text: '' }); }
      catch { setReceipt({ message: 'The clipboard is unavailable; select the receipt below.', text: result.text }); }
    } catch (error) {
      setReceipt({ message: error.status === 404 ? STALE_BACKEND : error.message, text: '' });
    }
  };
  const projects = body?.projects || [];
  const shown = projects.filter(p => !isMinor(p));
  const minor = projects.filter(isMinor);
  const totals = body?.totals;
  // Moved commits are a subset of landed ones, so they are said inside it,
  // never beside it where the two would read as a sum.
  const git = totals ? [
    [totals.commits_landed, totals.commits_moved ? `landed (${totals.commits_moved} of them under a new sha)` : 'landed'], [totals.commits_rewritten, 'rewritten away'],
    [totals.commits_missing, 'not in git'], [totals.commits_unverified, 'unchecked'], [totals.commits_git_only, 'in git, logged by no session'],
  ].filter(([n]) => n > 0) : [];
  const title = new Date(dayRange(day).from).toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });

  return <section className="fw-day" aria-label="Day digest">
    <div className="fw-results-head">{viewNavigation}
      <div className="dd-picker">
        <button aria-label="Previous day" onClick={() => choose(shiftDay(day, -1))}>‹</button>
        <label><span className="md-sr">Day</span><input type="date" aria-label="Day" value={day} max={today} onChange={event => choose(event.target.value)} /></label>
        <button aria-label="Next day" disabled={day >= today} onClick={() => choose(shiftDay(day, 1))}>›</button>
        <button aria-pressed={day === shiftDay(today, -1)} onClick={() => choose(shiftDay(today, -1))}>Yesterday</button>
        <button aria-pressed={day === today} onClick={() => choose(today)}>Today</button>
      </div>
      {!isDemoMode && <div className="dd-actions">
        <button onClick={copyReceipt} disabled={!body}>Copy receipt</button>
        <button onClick={() => setRefresh(n => n + 1)} disabled={state.loading}>{state.loading ? 'Reading…' : 'Refresh'}</button>
      </div>}
    </div>
    {receipt.message && <p className="fw-notice" role="status">{receipt.message}</p>}
    {receipt.text && <textarea className="dd-receipt" readOnly value={receipt.text} aria-label="Receipt as Markdown" onFocus={event => event.target.select()} />}
    {isDemoMode && <div className="fw-empty"><h2>The day digest is not part of the recorded example</h2><p>The live Explorer folds one calendar day across every session and checks each commit against git.</p></div>}
    {state.error && <div className="fw-error" role="alert"><span>{state.error}</span>{state.error === STALE_BACKEND
      ? <code>node scripts/session-digest.js --day {day}</code>
      : <button onClick={() => setRefresh(n => n + 1)}>Retry</button>}</div>}
    {!isDemoMode && state.loading && !body && <p className="rc-quiet" role="status">Reading {title}. The digest checks every commit against git, which takes a second or two.</p>}
    {body && <>
      <header className="dd-head">
        <h2>{title}</h2>
        <span className="rc-quiet">{body.tz_abbrev} · {body.complete ? 'complete day' : 'so far'}{body.tz !== Intl.DateTimeFormat().resolvedOptions().timeZone ? ` · computed in ${body.tz}` : ''}</span>
      </header>
      {totals.events === 0 ? <div className="fw-empty"><h2>No logged events on this day</h2><p>The event log's newest entry is {body.log_newest ? new Date(body.log_newest).toLocaleString() : 'unknown'}, so the hooks {body.log_newest && Date.parse(body.log_newest) >= Date.parse(body.start) ? 'are writing' : 'may not be writing'}.</p></div> : <>
        <dl className="dd-stats">
          <div><dt>Commits</dt><dd>{(totals.commits_landed + totals.commits_git_only).toLocaleString()}</dd></div>
          <div><dt>Active, wall clock</dt><dd>{fmtDuration(totals.active_minutes)}</dd></div>
          <div><dt>Sessions</dt><dd>{totals.sessions.toLocaleString()}</dd></div>
          <div><dt>Projects</dt><dd>{totals.projects.toLocaleString()}</dd></div>
          <div><dt>Events</dt><dd>{totals.events.toLocaleString()}</dd></div>
          {totals.pushes > 0 && <div><dt>Pushes</dt><dd>{totals.pushes.toLocaleString()}</dd></div>}
        </dl>
        <p className="dd-agents">{Object.entries(body.agents).sort((a, b) => b[1] - a[1]).map(([provider, n]) => <span key={provider}>{provider === 'unknown' ? <span className="rc-quiet">agent unrecorded</span> : <AgentBadge provider={provider} />} {plural(n, 'session')}</span>)}</p>
        <HoursChart hours={body.hours} />
        {git.length > 0 && <p className="dd-git"><span className="rc-quiet">Checked against git:</span> {git.map(([n, label]) => `${n.toLocaleString()} ${label}`).join(' · ')}</p>}
        {(body.scope.projects || body.scope.denied || body.unattributed.project) ? <p className="rc-quiet">
          {body.scope.projects && `${plural(body.scope.out_of_scope.events, 'event')} in ${plural(body.scope.out_of_scope.projects, 'project')} outside “${route.project}” are not shown. `}
          {body.unattributed.project > 0 && `${plural(body.unattributed.project, 'event')} carry no project and are not shown.`}
        </p> : null}
        {shown.map(project => <ProjectDay key={project.name} project={project} sessionLink={sessionLink} titles={titles} />)}
        {minor.length > 0 && <p className="rc-quiet dd-minor">Also active: {minor.map(p => `${p.name} (${fmtDuration(p.active_minutes)})`).join(', ')}.</p>}
        <p className="rc-quiet dd-foot">Active time counts five-minute bins with any logged event, with every session merged, so three sessions in one hour count as one hour. A commit counts when git has it on a branch, remote, or tag; “moved” commits landed under a new sha after an amend, rebase, or cherry-pick.</p>
      </>}
    </>}
  </section>;
}
