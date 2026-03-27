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

export default function EventCard({ event, showScore, showSource }) {
  const [expanded, setExpanded] = useState(false);

  const summary = event.summary || event.description || event.prompt || event.url || event.query || event.event_id || '';
  const sourceBadge = event._source || event.type || '';

  return (
    <div className="border border-gray-800 rounded-lg p-3 mb-2 hover:border-gray-600 transition-colors">
      <div className="flex items-center gap-2 flex-wrap mb-1">
        <span
          className="text-xs text-gray-500 font-mono cursor-help"
          title={event.timestamp}
        >
          {relativeTime(event.timestamp)}
        </span>
        <span className="text-xs text-gray-600 font-mono">{sourceBadge}</span>
        <ProjectBadge project={event.project} />
        {showSource && <SourceBadge source={event._sources} />}
        {showScore && event._score != null && (
          <span className="text-xs text-gray-500 font-mono">
            score: {event._score.toFixed(3)}
          </span>
        )}
      </div>

      <p className="text-sm text-gray-300 leading-relaxed">
        {summary.length > 300 ? summary.slice(0, 300) + '...' : summary}
      </p>

      {(event.url || event.deeplink || event.transcript_path || event.event_id) && (
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
          {event.transcript_path && <div>transcript: {event.transcript_path}</div>}
          {event.session_id && <div>session: {event.session_id}</div>}
        </div>
      )}
    </div>
  );
}
