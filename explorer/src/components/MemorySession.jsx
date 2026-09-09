import { useEffect, useMemo, useRef, useState } from 'react';
import { sessionMetricsAt, formatDuration, formatCount } from './memory-metrics';
import { plainLinkClick } from './memory-route';
import '../styles/memory-session.css';

const KINDS = [
  { id: 'activity', label: 'actions', color: '#81aaff' },
  { id: 'edit', label: 'edits', color: '#55d9e6' },
  { id: 'research', label: 'research', color: '#c678dd' },
  { id: 'commit', label: 'commits', color: '#98c379' },
  { id: 'lifecycle', label: 'session events', color: '#e5c07b' },
];
const clock = (t) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const stamp = (t) => new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

function noteLabel(type = '') {
  if (/prompt|user_message/.test(type)) return 'You';
  if (/wrapup/.test(type)) return 'Wrapup';
  if (/decision/.test(type)) return 'Decision';
  if (/commit/.test(type)) return 'Commit';
  if (/edit|write/.test(type)) return 'Edit';
  if (/search|fetch|research/.test(type)) return 'Research';
  if (/assistant|response/.test(type)) return 'Response';
  return 'Activity';
}

function directory(file) {
  const pieces = file.path.split('/').filter(Boolean);
  const parent = pieces.slice(0, -1);
  const project = parent.indexOf(file.project);
  return (project >= 0 ? parent.slice(project) : parent.slice(-3)).join('/');
}

function makeTrace(events, tokenSeries) {
  const times = [...events.map((event) => event[0]), ...tokenSeries.map((sample) => sample.t)].filter(Number.isFinite);
  if (!times.length) return null;
  const first = times.reduce((earliest, t) => Math.min(earliest, t), Infinity);
  const last = times.reduce((latest, t) => Math.max(latest, t), -Infinity);
  const duration = Math.max(last - first, 60000);
  const bins = Array.from({ length: 96 }, () => ({ counts: {}, output: 0, total: 0 }));
  const indexAt = (t) => Math.min(bins.length - 1, Math.max(0, Math.floor((t - first) / duration * bins.length)));
  for (const [t, category] of events) {
    const bin = bins[indexAt(t)];
    bin.counts[category] = (bin.counts[category] || 0) + 1;
    bin.total += 1;
  }
  for (const sample of tokenSeries) bins[indexAt(sample.t)].output += Number(sample.output) || 0;
  return { first, last, bins, maxEvents: Math.max(1, ...bins.map((bin) => bin.total)), maxOutput: Math.max(1, ...bins.map((bin) => bin.output)) };
}

function ActivityTrace({ metrics, tokens, tokenSeries }) {
  const trace = useMemo(() => makeTrace(metrics.events, tokenSeries), [metrics.events, tokenSeries]);
  const available = Number.isFinite(tokens.output);
  return (
    <div className="ms-trace">
      <div className="ms-trace-caption"><h2>Logged activity</h2><span>{formatCount(metrics.eventCount)} observations</span></div>
      {trace && <>
        <svg className="ms-activity-plot" viewBox="0 0 960 128" preserveAspectRatio="none" role="img" aria-label={`Activity over time, ${formatCount(metrics.eventCount)} observations from ${stamp(trace.first)} to ${stamp(trace.last)}`}>
          <line x1="0" x2="960" y1="118" y2="118" className="ms-axis" />
          {trace.bins.flatMap((bin, i) => {
            let y = 118;
            return KINDS.flatMap(({ id, color }) => {
              const count = bin.counts[id] || 0;
              if (!count) return [];
              const height = Math.max(3, count / trace.maxEvents * 108);
              y -= height;
              return <rect key={`${i}-${id}`} x={i * 10 + 1} y={y} width="8" height={height} rx="1" fill={color}><title>{count} {KINDS.find((kind) => kind.id === id).label}</title></rect>;
            });
          })}
        </svg>
        <div className="ms-mix" aria-label="Activity mix">
          {KINDS.filter(({ id }) => metrics.counts[id] > 0).map(({ id, label, color }) => (
            <span key={id}><i style={{ background: color }} />{formatCount(metrics.counts[id])} {label}</span>
          ))}
        </div>
      </>}
      {!trace && <p className="ms-muted">No observations before this point in the replay.</p>}
      <div className="ms-token-caption">
        <h2>Generated tokens</h2>
        <span>{available ? <><strong>{formatCount(tokens.output)}</strong> output tokens{tokens.status === 'partial' && <span className="ms-coverage-label"> · partial</span>}</> : 'Not recorded'}</span>
      </div>
      {available && trace && tokenSeries.length > 0 ? (
        <svg className="ms-token-plot" viewBox="0 0 960 58" preserveAspectRatio="none" role="img" aria-label={`${formatCount(tokens.output)} generated tokens recorded over the same time interval`}>
          <line x1="0" x2="960" y1="52" y2="52" className="ms-axis" />
          {trace.bins.map((bin, i) => bin.output > 0 && <rect key={i} x={i * 10 + 1} y={52 - Math.max(2, bin.output / trace.maxOutput * 48)} width="8" height={Math.max(2, bin.output / trace.maxOutput * 48)} rx="1" fill="#e5e7eb"><title>{formatCount(bin.output)} output tokens</title></rect>)}
        </svg>
      ) : <p className="ms-token-missing">{tokens.reason || 'No token usage samples at this point. Activity above comes from recorded events.'}</p>}
      {trace && <div className="ms-time-axis"><time dateTime={new Date(trace.first).toISOString()}>{clock(trace.first)}</time><time dateTime={new Date(trace.last).toISOString()}>{clock(trace.last)}</time></div>}
      {available && <details className="ms-coverage"><summary>Token coverage{tokens.status === 'partial' ? ' · partial' : ''}</summary><div>
        <p>{formatCount(tokens.input)} input tokens, including {formatCount(tokens.cacheRead)} read from cache; {formatCount(tokens.total)} total input + output tokens.</p>
        <p>{tokens.reason || 'Recorded usage within this time window.'}{tokens.capturedUntil ? ` Last sample ${stamp(tokens.capturedUntil)}.` : ''}</p>
      </div></details>}
    </div>
  );
}

export default function MemorySession({ session, files = [], at, onBack, onReview, selectedPath, onSelectFile, hrefForFile }) {
  const heading = useRef(null);
  const [fileLimit, setFileLimit] = useState(8);
  const [noteLimit, setNoteLimit] = useState(8);
  const metrics = useMemo(() => sessionMetricsAt(session, at, files), [session, at, files]);
  const tokenSeries = useMemo(() => (session.tokenSeries || []).filter((sample) => sample.t <= at), [session.tokenSeries, at]);
  const visibleFiles = useMemo(() => files.map((file) => ({ ...file, edits: (file.edits || []).filter((edit) => edit.t <= at) }))
    .filter((file) => file.edits.length).sort((a, b) => b.edits.at(-1).t - a.edits.at(-1).t), [files, at]);
  const notes = useMemo(() => {
    const distinct = new Map();
    for (const note of (session.notes || []).filter((item) => item.t <= at && typeof item.text === 'string' && item.text.trim()).slice().sort((a, b) => b.t - a.t)) {
      const clean = note.text.replace(/\s+/g, ' ').trim();
      if (/^(?:session (?:started|ended)|agent stopped|working on (?:the )?project|tool executed|command completed|success|done)[.!]?$/i.test(clean)) continue;
      const found = distinct.get(clean);
      if (found) found.repeated.push(note);
      else distinct.set(clean, { ...note, text: clean, repeated: [] });
    }
    return [...distinct.values()];
  }, [session.notes, at]);
  const selected = visibleFiles.find((file) => file.path === selectedPath);
  const resolvedEdits = new Set(visibleFiles.flatMap((file) => file.edits.filter((edit) => edit.source !== 'transcript').map((edit) => edit.id)).filter(Boolean)).size;
  const unresolvedEdits = Math.max(0, (metrics.counts.edit || 0) - resolvedEdits);
  const projects = Object.keys(session.projects || {}).filter((project) => project !== 'dev' && project !== 'Unattributed');
  const title = session.title || session.group || 'Session';
  const fullTitle = session.fullTitle?.trim();

  useEffect(() => {
    setFileLimit(8);
    setNoteLimit(8);
    heading.current?.focus({ preventScroll: true });
  }, [session.id]);

  useEffect(() => {
    const index = visibleFiles.findIndex(file => file.path === selectedPath);
    if (index >= 0) setFileLimit(limit => Math.max(limit, index + 1));
  }, [selectedPath, visibleFiles]);

  return (
    <section className="memory-session" aria-label="Session detail">
      <header className="ms-heading">
        <div className="ms-topline"><button type="button" className="ms-back" aria-label="Back to all sessions" onClick={onBack}>← <span>All sessions</span></button><span className="ms-project">{projects.join(' · ') || session.group || 'Unattributed project'}</span></div>
        <h1 ref={heading} tabIndex={-1}>{title}</h1>
        <div className="ms-duration"><span title="First to last event in the selected 24-hour window"><strong>{formatDuration(metrics.spanMs)}</strong> session span</span><span>{formatDuration(metrics.activeMs)} observed active <abbr title="Sum of gaps of 15 minutes or less between non-lifecycle events; this is observed activity, not measured effort.">ⓘ</abbr></span></div>
        {fullTitle && fullTitle !== title && <details className="ms-prompt"><summary>Session prompt</summary><p>{fullTitle}</p></details>}
      </header>

      <ActivityTrace metrics={metrics} tokens={metrics.tokens} tokenSeries={tokenSeries} />

      <div className={`ms-evidence-columns${visibleFiles.length ? '' : ' ms-no-files'}`}>
        <section className="ms-files" aria-label="Recently edited files">
          <div className="ms-section-heading"><h2>Edited files</h2><span>{visibleFiles.length ? formatCount(visibleFiles.length) : 'None resolved'}</span></div>
          {visibleFiles.length > 0 ? <>
            <div className="ms-file-branches">
              {visibleFiles.slice(0, fileLimit).map((file) => (
                <a key={file.path} className="ms-file" href={hrefForFile(file)} aria-label={`Inspect ${file.path}`} aria-current={selectedPath === file.path ? 'true' : undefined} onClick={event => { if (plainLinkClick(event)) { event.preventDefault(); onSelectFile(file); } }}>
                  <span className="ms-branch" aria-hidden="true"><i /></span>
                  <span className="ms-file-label"><strong>{file.name || file.path.split('/').at(-1)}</strong><span>{directory(file)}</span></span>
                  <span className="ms-file-edits">{file.edits.length} {file.edits.length === 1 ? 'record' : 'records'}</span>
                </a>
              ))}
            </div>
            {visibleFiles.length > fileLimit && <button type="button" className="ms-more" onClick={() => setFileLimit((n) => n + 8)}>More files ({visibleFiles.length - fileLimit}) ↓</button>}
            {selected && <div className="ms-selected-file" aria-live="polite"><p>{selected.path}</p><a href={hrefForFile(selected, 'changes')} onClick={event => { if (plainLinkClick(event)) { event.preventDefault(); onReview(session, selected); } }}>Review</a></div>}
          </> : <p className="ms-empty-files">{metrics.counts.edit ? `${formatCount(metrics.counts.edit)} edit observations, but their files could not be resolved in the current workspace.` : 'No file edits were recorded in this session at this point.'}</p>}
          {unresolvedEdits > 0 && visibleFiles.length > 0 && <p className="ms-file-coverage">{formatCount(unresolvedEdits)} further edit observations have no resolved file.</p>}
          {selectedPath && !selected && <p className="ms-file-coverage" role="status">The linked file has no resolved edit evidence at this point in the session.</p>}
        </section>

        <section className="ms-notes" aria-label="Recent session observations">
          <div className="ms-section-heading"><h2>Recent observations</h2><span>{formatCount(notes.length)}</span></div>
          {notes.length ? <>
            <div className="ms-note-thread">{notes.slice(0, noteLimit).map((note, i) => {
              const clean = note.text.replace(/\s+/g, ' ').trim();
              const excerpt = clean.length > 220 ? `${clean.slice(0, 217).trimEnd()}…` : clean;
              return <details className="ms-observation" key={note.id || `${note.t}-${i}`}>
                <summary><span className="ms-observation-meta"><time dateTime={new Date(note.t).toISOString()}>{clock(note.t)}</time><span>{noteLabel(note.type)}</span><span className="ms-note-expand" aria-hidden="true">+</span></span><span className="ms-observation-text">{excerpt}</span></summary>
                <div className="ms-observation-evidence">{clean.length > 220 && <p>{clean}</p>}<p>{stamp(note.t)}{note.id && <><br /><code>{note.id}</code></>}</p>{note.repeated.length > 0 && <><p>Repeated in {note.repeated.length} earlier observations:</p><ul>{note.repeated.map((earlier, j) => <li key={earlier.id || j}>{stamp(earlier.t)}{earlier.id && <> · <code>{earlier.id}</code></>}</li>)}</ul></>}</div>
              </details>;
            })}</div>
            {notes.length > noteLimit && <button type="button" className="ms-more" onClick={() => setNoteLimit((n) => n + 8)}>Earlier observations ({notes.length - noteLimit}) ↓</button>}
          </> : <p className="ms-empty-notes">{metrics.eventCount ? 'These events contain no descriptive notes. Their timing and activity types are shown above.' : 'No descriptive observations before this point in the replay.'}</p>}
        </section>
      </div>
    </section>
  );
}
