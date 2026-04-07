import { useState, useEffect } from 'react';
import EventGroup, { groupEvents } from './EventGroup';
import SessionSparkline from './SessionSparkline';
import ProjectBadge from './ProjectBadge';

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

export default function SessionCard({ session, onOpenTranscript, onProjectClick }) {
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
    <div className="border border-gray-700 bg-gray-900/40 rounded-lg mb-4 overflow-hidden shadow-md">
      <div className="p-3">
        <div className="flex justify-between items-center mb-1">
          <div className="flex items-center gap-3 text-sm">
            <span className="font-medium text-gray-200" title={session.session_id}>
              {session.session_id.startsWith('Legacy') 
                ? session.session_id 
                : `Session ${session.session_id.substring(0, 8)}`}
            </span>
            <span className="text-gray-500 text-xs">{events.length} events • {durationMins}m</span>
            <ContextGauge summary={summary} compactionEvents={compactionEvents} />
          </div>
          <div className="flex gap-2">
            {projects.map(p => <ProjectBadge key={p} project={p} onClick={onProjectClick} />)}
          </div>
        </div>
        
        <div className="text-xs text-gray-600 mb-2">
          {dateObj.toLocaleDateString()} • {startTime} - {endTime}
        </div>
        {previewSummary && !expanded && (
          <div className="text-xs text-gray-300 mb-2 truncate max-w-xl">{previewSummary}</div>
        )}

        <SessionSparkline events={events} />

        <button 
          onClick={() => setExpanded(!expanded)}
          className="text-xs text-blue-400 hover:text-blue-300 transition-colors mt-2 font-medium"
        >
          {expanded ? '▲ Hide Events' : '▼ View Session Events'}
        </button>
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
