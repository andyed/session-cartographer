import { useState } from 'react';
import ProjectBadge from './ProjectBadge';
import AgentBadge from './AgentBadge';
import SourceBadge from './SourceBadge';
import { HUE, NEUTRAL, QUADRANT_HUES } from '../lib/palette.js';

// 2×2 grid icon: active quadrant highlighted, others dim.
// Layout:  [bootstrap | construct ]
//          [surgical  | rework    ]
const QUAD_POS = {
  bootstrap: { x: 0, y: 0 },
  construct: { x: 7, y: 0 },
  surgical:  { x: 0, y: 7 },
  rework:    { x: 7, y: 7 },
};

function QuadrantIcon({ quadrant, shape }) {
  const color = QUADRANT_HUES[quadrant] || NEUTRAL;
  const title = `${quadrant} · +${shape.lines_added} −${shape.lines_removed} · ${shape.files_new} new, ${shape.files_modified} mod, ${shape.files_deleted} del${shape.commit_type ? ` · ${shape.commit_type}` : ''}`;

  return (
    <svg width="14" height="14" viewBox="0 0 14 14" className="inline-block cursor-help flex-shrink-0">
      <title>{title}</title>
      {Object.entries(QUAD_POS).map(([name, pos]) => (
        <rect
          key={name}
          x={pos.x} y={pos.y}
          width="6" height="6"
          rx="1"
          fill={name === quadrant ? color : '#333'}
          opacity={name === quadrant ? 0.9 : 0.2}
        />
      ))}
    </svg>
  );
}

function relativeTime(ts) {
  if (!ts) return '?';
  const diff = Date.now() - new Date(ts).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(ts).toLocaleDateString();
}

// Event type → visual category. Hues and their measured ratios: lib/palette.js.
function eventCategory(event) {
  const type = event.type || event.milestone || '';
  if (type === 'fetch' || type === 'research_fetch') return { label: 'fetch', color: HUE.blue };
  if (type === 'search' || type === 'research_search') return { label: 'search', color: HUE.yellow };
  if (type === 'search_result') return { label: 'result', color: HUE.orange };
  if (type.includes('compaction')) return { label: 'compaction', color: HUE.red };
  if (type.includes('session_end')) return { label: 'session end', color: HUE.red };
  if (type.includes('bridge_query')) return { label: 'bridge query', color: HUE.purple };
  if (type === 'tool_file_edit') return { label: 'edit', color: HUE.green };
  if (type === 'tool_bash') return { label: 'bash', color: HUE.cyan };
  if (type === 'git_commit') return { label: 'commit', color: HUE.commit };
  if (type === 'git_push') return { label: 'push', color: HUE.push };
  if (type === 'memory_feedback') return { label: 'memory', color: HUE.yellow };
  if (type === 'memory_project') return { label: 'memory', color: HUE.purple };
  if (type === 'memory_user') return { label: 'memory', color: HUE.cyan };
  if (type === 'memory_reference') return { label: 'memory', color: HUE.blue };
  if (type.startsWith('memory_')) return { label: 'memory', color: HUE.orange };
  return { label: event._source || type || '?', color: NEUTRAL };
}

export default function EventCard({ event, showScore, showSource, onOpenTranscript, onProjectClick, onProviderClick, active }) {
  const [expanded, setExpanded] = useState(false);
  const cat = eventCategory(event);

  // Build display text — prefer the most useful human-readable field
  let extractedUrl = event.url || '';
  let summary = '';

  // For fetch events, the prompt is the most informative field
  if (event.prompt) {
    summary = event.prompt;
  } else if (event.query) {
    summary = event.query;
  } else if (event.title || event.description) {
    summary = event.title || event.description;
  } else if (event.display) {
    summary = event.display;
  } else if (event.summary) {
    // "Fetched: https://..." summaries — extract the URL and show domain
    const fetchMatch = event.summary.match(/^(?:Fetched|Search):\s*(https?:\/\/\S+)/);
    if (fetchMatch) {
      extractedUrl = extractedUrl || fetchMatch[1];
      try {
        const u = new URL(fetchMatch[1]);
        summary = `${u.hostname}${u.pathname.length > 50 ? u.pathname.slice(0, 50) + '...' : u.pathname}`;
      } catch {
        summary = event.summary;
      }
    } else {
      summary = event.summary;
    }
  }

  if (!summary && extractedUrl) {
    try {
      const u = new URL(extractedUrl);
      summary = `${u.hostname}${u.pathname.length > 50 ? u.pathname.slice(0, 50) + '...' : u.pathname}`;
    } catch {
      summary = extractedUrl;
    }
  }

  if (!summary) summary = event.event_id || '';

  // Click handler: open transcript if available, using summary text as highlight
  const handleCardClick = (e) => {
    // Don't intercept clicks on links, buttons, or interactive elements
    if (e.target.closest('a, button, details')) return;
    if (!onOpenTranscript || !event.transcript_path) return;

    // Use a short search-friendly excerpt from summary for highlight
    const highlightText = (event.summary || event.query || event.prompt || '').slice(0, 80);
    onOpenTranscript(event.transcript_path, event.uuid, highlightText);
  };

  const isClickable = onOpenTranscript && event.transcript_path;

  return (
    <div
      onClick={handleCardClick}
      className={`border rounded-lg p-3 mb-2 transition-colors ${
        active ? 'border-gray-500 bg-gray-800/50 ring-1 ring-gray-600' : 'border-gray-800 hover:border-gray-600'
      } ${isClickable ? 'cursor-pointer' : ''}`}
    >
      <div className="flex items-center gap-2 flex-wrap mb-1">
        <span
          className="text-xs text-muted font-mono cursor-help"
          title={event.timestamp}
        >
          {relativeTime(event.timestamp)}
        </span>

        {/* Event type badge: outlined, never tinted (lib/palette.js) */}
        <span
          className="inline-block text-xs px-1.5 py-0.5 rounded font-mono"
          style={{ color: cat.color, border: `1px solid ${cat.color}44` }}
        >
          {cat.label}
        </span>

        <ProjectBadge project={event.project} onClick={onProjectClick} />

        <AgentBadge provider={event.provider} onClick={onProviderClick} />

        {/* Diff shape quadrant indicator (Tier 3) */}
        {event.diff_shape?.quadrant && <QuadrantIcon quadrant={event.diff_shape.quadrant} shape={event.diff_shape} />}

        {/* URL indicator — link icon with hover tooltip */}
        {extractedUrl && (
          <a
            href={extractedUrl}
            target="_blank"
            rel="noopener"
            title={extractedUrl}
            className="text-blue-400/60 hover:text-blue-400 transition-colors"
          >
            <svg className="w-3.5 h-3.5 inline" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
            </svg>
          </a>
        )}

        {/* Transcript indicator */}
        {event.transcript_path && onOpenTranscript && (
          <button
            onClick={() => onOpenTranscript(event.transcript_path, event.uuid)}
            title="Open transcript"
            className="text-green-400/60 hover:text-green-400 transition-colors"
          >
            <svg className="w-3.5 h-3.5 inline" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
          </button>
        )}

        {showSource && <SourceBadge source={event._sources} score={event._score} />}
      </div>

      <p className="text-sm text-gray-300 leading-relaxed">
        {summary.length > 300 ? summary.slice(0, 300) + '...' : summary}
      </p>

      {/* Fetch context — show the prompt that triggered this fetch */}
      {event.prompt && event.prompt !== summary && (
        <p className="text-xs text-muted mt-0.5 leading-relaxed italic">
          {event.prompt.length > 150 ? event.prompt.slice(0, 150) + '...' : event.prompt}
        </p>
      )}

      {/* Search query context */}
      {event.query && event.query !== summary && (
        <p className="text-xs text-muted mt-0.5 leading-relaxed italic">
          query: {event.query.length > 150 ? event.query.slice(0, 150) + '...' : event.query}
        </p>
      )}

      {/* Files changed for commits — show inline without expanding */}
      {event.files_changed && (
        <div className="mt-1 text-xs text-muted font-mono">
          {event.files_changed.split(',').map((f, i) => (
            <span key={i} className="inline-block mr-2">{f.trim()}</span>
          ))}
        </div>
      )}

      {(event.event_id || event.deeplink || event.session_id || event.commit_hash) && (
        <button
          onClick={(e) => { e.stopPropagation(); setExpanded(!expanded); }}
          className="text-xs text-muted hover:text-gray-300 mt-1"
        >
          {expanded ? 'less' : 'more'}
        </button>
      )}

      {expanded && (
        <div className="mt-2 text-xs text-muted font-mono space-y-0.5">
          {event.event_id && <div>id: {event.event_id}</div>}
          {event.commit_hash && (
            <div>
              commit: <span style={{ color: HUE.commit }}>{event.commit_hash.slice(0, 7)}</span>
              {event.url && (
                <> — <a href={event.url} target="_blank" rel="noopener" className="text-link hover:underline">view on GitHub</a></>
              )}
            </div>
          )}
          {event.author && <div>author: {event.author}</div>}
          {!event.commit_hash && event.url && (
            <div>
              url: <a href={event.url} target="_blank" rel="noopener" className="text-link hover:underline">{event.url}</a>
            </div>
          )}
          {event.deeplink && <div>deeplink: {event.deeplink}</div>}
          {event.transcript_path && (
            <div>transcript: {event.transcript_path}</div>
          )}
          {event.session_id && <div>session: {event.session_id}</div>}
        </div>
      )}
    </div>
  );
}
