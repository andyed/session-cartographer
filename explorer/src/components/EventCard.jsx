import { useState } from 'react';
import ProjectBadge from './ProjectBadge';
import SourceBadge from './SourceBadge';

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

// Event type → visual category
function eventCategory(event) {
  const type = event.type || event.milestone || '';
  if (type === 'fetch' || type === 'research_fetch') return { label: 'fetch', color: '#61afef' };
  if (type === 'search' || type === 'research_search') return { label: 'search', color: '#e5c07b' };
  if (type === 'search_result') return { label: 'result', color: '#d19a66' };
  if (type.includes('compaction')) return { label: 'compaction', color: '#e06c75' };
  if (type.includes('session_end')) return { label: 'session end', color: '#e06c75' };
  if (type.includes('bridge_query')) return { label: 'bridge query', color: '#c678dd' };
  if (type === 'tool_file_edit') return { label: 'edit', color: '#98c379' };
  if (type === 'tool_bash') return { label: 'bash', color: '#56b6c2' };
  return { label: event._source || type || '?', color: '#5c6370' };
}

export default function EventCard({ event, showScore, showSource, onOpenTranscript }) {
  const [expanded, setExpanded] = useState(false);
  const cat = eventCategory(event);

  // Build display text — prefer human-readable summaries over raw URLs
  let summary = event.summary || event.description || event.prompt || '';

  // For search events, show query
  if (!summary && event.query) {
    summary = event.query;
  }

  // If all we have is a URL, show it compactly
  if (!summary && event.url) {
    try {
      const u = new URL(event.url);
      summary = `${u.hostname}${u.pathname.length > 50 ? u.pathname.slice(0, 50) + '...' : u.pathname}`;
    } catch {
      summary = event.url;
    }
  }

  if (!summary) summary = event.event_id || '';

  return (
    <div className="border border-gray-800 rounded-lg p-3 mb-2 hover:border-gray-600 transition-colors">
      <div className="flex items-center gap-2 flex-wrap mb-1">
        <span
          className="text-xs text-gray-500 font-mono cursor-help"
          title={event.timestamp}
        >
          {relativeTime(event.timestamp)}
        </span>

        {/* Event type badge */}
        <span
          className="inline-block text-xs px-1.5 py-0.5 rounded font-mono"
          style={{ backgroundColor: cat.color + '22', color: cat.color, border: `1px solid ${cat.color}44` }}
        >
          {cat.label}
        </span>

        <ProjectBadge project={event.project} />

        {/* URL indicator — link icon with hover tooltip */}
        {event.url && (
          <a
            href={event.url}
            target="_blank"
            rel="noopener"
            title={event.url}
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

        {showSource && <SourceBadge source={event._sources} />}
        {showScore && event._score != null && (
          <span className="text-xs text-gray-500 font-mono">
            {event._score.toFixed(3)}
          </span>
        )}
      </div>

      <p className="text-sm text-gray-300 leading-relaxed">
        {summary.length > 300 ? summary.slice(0, 300) + '...' : summary}
      </p>

      {(event.event_id || event.deeplink || event.session_id) && (
        <button
          onClick={() => setExpanded(!expanded)}
          className="text-xs text-gray-500 hover:text-gray-300 mt-1"
        >
          {expanded ? 'less' : 'more'}
        </button>
      )}

      {expanded && (
        <div className="mt-2 text-xs text-gray-500 font-mono space-y-0.5">
          {event.event_id && <div>id: {event.event_id}</div>}
          {event.url && (
            <div>
              url: <a href={event.url} target="_blank" rel="noopener" className="text-blue-400 hover:underline">{event.url}</a>
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
