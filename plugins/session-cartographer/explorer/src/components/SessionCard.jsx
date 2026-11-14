import { useState, useEffect } from 'react';
import EventGroup, { groupEvents } from './EventGroup';
import SessionSparkline from './SessionSparkline';
import ProjectBadge from './ProjectBadge';
import AgentBadge from './AgentBadge';
import SessionArtifacts from './SessionArtifacts.jsx';
import SessionIdentity from './SessionIdentity.jsx';

function formatTokens(n) {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(0)}k`;
  return String(n);
}

const CONTEXT_WINDOW = 1_000_000;

function ContextGauge({ summary, compactionEvents }) {
  if (!summary) return null;
  const { totalTokens, compactionCount } = summary;
  if (!totalTokens) return null;

  // Cumulative: sum of preTokens from each compaction + current phase tokens
  const compactedTokens = (compactionEvents || []).reduce((sum, e) => sum + (e.preTokens || 0), 0);
  const cumulativeTokens = compactedTokens + totalTokens;

  // Bar shows cumulative as multiple windows
  const windows = cumulativeTokens / CONTEXT_WINDOW;
  const barW = 56; // px
  const barH = 10;

  // Segments: one per window consumed (compaction phases + current)
  const phases = [];
  for (const e of (compactionEvents || [])) {
    if (e.preTokens > 0) phases.push(e.preTokens);
  }
  phases.push(totalTokens); // current phase

  // Normalize each phase to its share of cumulative
  const totalPhaseTokens = phases.reduce((a, b) => a + b, 0);

  // Color ramp by cumulative windows: <0.15 gray, <0.5 emerald, <1.5 amber, >1.5 red
  const fill = windows < 0.15 ? '#6b7280' : windows < 0.5 ? '#34d399' : windows < 1.5 ? '#fbbf24' : '#f87171';

  // Compaction divider positions (cumulative fraction)
  const dividers = [];
  let runningTokens = 0;
  for (let i = 0; i < phases.length - 1; i++) {
    runningTokens += phases[i];
    dividers.push(runningTokens / totalPhaseTokens);
  }

  return (
    <span className="inline-flex items-center gap-1.5 text-xs" title={`${formatTokens(cumulativeTokens)} cumulative (${compactionCount} compaction${compactionCount !== 1 ? 's' : ''}) • ${formatTokens(totalTokens)} current phase • ${windows.toFixed(1)}x context window`}>
      <svg width={barW} height={barH} className="rounded-sm overflow-hidden">
        <rect width={barW} height={barH} fill="#1f2937" />
        <rect width={Math.max(1, barW * Math.min(windows, 1))} height={barH} fill={fill} rx={0} />
        {windows > 1 && (
          <rect x={0} y={0} width={barW} height={barH} fill="none" stroke={fill} strokeWidth={1.5} rx={1} />
        )}
        {dividers.map((frac, i) => (
          <line key={i} x1={barW * Math.min(frac, 1)} y1={0} x2={barW * Math.min(frac, 1)} y2={barH} stroke="#a78bfa" strokeWidth={1.5} />
        ))}
      </svg>
      <span className="text-gray-300">{windows < 1 ? `${(windows * 100).toFixed(0)}%` : `${windows.toFixed(1)}x`}</span>
    </span>
  );
}

export default function SessionCard({ session, onOpenTranscript, onProjectClick, onProviderClick, onInspect }) {
  const [expanded, setExpanded] = useState(false);
  const [summary, setSummary] = useState(null);

  const [compactionEvents, setCompactionEvents] = useState([]);

  useEffect(() => {
    if (!session.transcript_path) return;
    fetch(`/api/transcript/analysis?path=${encodeURIComponent(session.transcript_path)}`)
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (data?.summary) setSummary(data.summary);
        if (data?.compactionEvents) setCompactionEvents(data.compactionEvents);
      })
      .catch(() => {});
  }, [session.transcript_path]);

  const events = session.events;
  if (!events || events.length === 0) return null;

  const sortedTs = events
    .map(e => new Date(e.timestamp || 0).getTime())
    .filter(ts => !isNaN(ts) && ts > 0)
    .sort((a,b) => a - b);

  let startTime = '?';
  let endTime = '?';
  let durationMins = 0;
  let dateObj = new Date();

  if (sortedTs.length > 0) {
    const startTimeMs = sortedTs[0];
    const endTimeMs = sortedTs[sortedTs.length - 1];
    dateObj = new Date(startTimeMs);
    startTime = dateObj.toLocaleTimeString();
    endTime = new Date(endTimeMs).toLocaleTimeString();
    durationMins = Math.max(1, Math.round((endTimeMs - startTimeMs) / 60000));
  }

  // Find unique projects
  const projects = Array.from(new Set(events.map(e => e.project).filter(Boolean)));

  // First meaningful summary for collapsed preview
  const previewSummary = events.find(e => e.summary && e.summary.length > 5 && !e.summary.startsWith('/'))?.summary || '';

  // Group events chronologically within the session just like the normal timeline
  const groups = groupEvents(events);

  return (
    <div className="session-card border border-gray-700 bg-gray-900/40 rounded-lg mb-4 overflow-hidden shadow-md">
      <div className="p-3">
        <div className="session-card-header">
          <SessionIdentity title={session.title} sessionId={session.session_id} cwd={session.cwd} />
          <div className="session-card-badges">
            <AgentBadge
              provider={session.provider}
              onClick={onProviderClick}
              title={session.providers?.length > 1
                ? `Mixed session: ${session.providers.join(', ')}`
                : undefined}
            />
            {projects.map(p => <ProjectBadge key={p} project={p} onClick={onProjectClick} />)}
          </div>
        </div>

        <div className="session-card-metadata">
          <span>{events.length} {events.length === 1 ? 'record' : 'records'} in focus{events.length > 1 ? ` • ${durationMins}m observed` : ''}</span>
          <ContextGauge summary={summary} compactionEvents={compactionEvents} />
        </div>
        <div className="session-card-metadata">
          {dateObj.toLocaleDateString()} • {startTime} - {endTime}
        </div>
        {previewSummary && !expanded && (
          <div className="session-card-preview text-xs text-gray-300 mb-2 truncate max-w-xl">{previewSummary}</div>
        )}

        <SessionArtifacts transcriptPath={session.transcript_path} sessionId={session.session_id} compact onOpenTranscript={onOpenTranscript} />
        <SessionSparkline events={events} />

        <div className="session-card-actions">
          {onInspect && <button className="timeline-inspect" aria-label="Inspect evidence" title="Inspect evidence" onClick={event => onInspect(event.currentTarget)}><svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M8 13h8M8 17h5"/></svg></button>}
          <button
            onClick={() => setExpanded(!expanded)}
            aria-label={expanded ? '▲ Hide Events' : '▼ View Session Events'}
            aria-expanded={expanded}
            className="text-xs text-link hover:text-blue-200 transition-colors font-medium"
          >
            <span aria-hidden="true">{expanded ? '▴' : '▾'}</span> Events
          </button>
        </div>
      </div>

      {expanded && (
        <div className="border-t border-gray-800 bg-gray-950 p-3 pt-4">
          {groups.map((g, i) => (
             <EventGroup key={g.events[0]?.event_id || i} group={g} onOpenTranscript={onOpenTranscript} onProjectClick={onProjectClick} />
          ))}
        </div>
      )}
    </div>
  );
}
