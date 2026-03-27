import { useState } from 'react';
import EventCard from './EventCard';
import ProjectBadge from './ProjectBadge';

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

function getDomain(url) {
  try { return new URL(url).hostname; } catch { return ''; }
}

/**
 * Group consecutive events by (project, type, domain).
 * Events within 5 minutes of each other with same signature collapse.
 */
export function groupEvents(events) {
  const groups = [];
  let current = null;

  for (const event of events) {
    const type = event.type || event.milestone || '';
    const domain = getDomain(event.url || '');
    const key = `${event.project}|${type}|${domain}`;
    const ts = new Date(event.timestamp || 0).getTime();

    if (current && current.key === key) {
      const lastTs = new Date(current.events[current.events.length - 1].timestamp || 0).getTime();
      // Within 5 minutes
      if (Math.abs(ts - lastTs) < 5 * 60 * 1000) {
        current.events.push(event);
        continue;
      }
    }

    // Start new group
    current = { key, events: [event] };
    groups.push(current);
  }

  return groups;
}

export default function EventGroup({ group, onOpenTranscript }) {
  const [expanded, setExpanded] = useState(false);
  const events = group.events;

  // Single event — no grouping needed
  if (events.length === 1) {
    return <EventCard event={events[0]} onOpenTranscript={onOpenTranscript} />;
  }

  const first = events[0];
  const type = first.type || first.milestone || '';
  const domain = getDomain(first.url || '');
  const typeLabel = type === 'fetch' ? 'fetches' : type === 'search' ? 'searches' : `${type} events`;

  return (
    <div className="border border-gray-800 rounded-lg mb-2 overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-2 hover:bg-gray-800/50 transition-colors text-left"
      >
        <span className="text-xs text-gray-500 font-mono" title={first.timestamp}>
          {relativeTime(first.timestamp)}
        </span>
        <span className="text-xs text-gray-400">
          {events.length} {typeLabel}
        </span>
        {domain && (
          <span className="text-xs text-blue-400/60 font-mono">{domain}</span>
        )}
        <ProjectBadge project={first.project} />
        <span className="text-xs text-gray-600 ml-auto">
          {expanded ? '▾' : '▸'}
        </span>
      </button>

      {expanded && (
        <div className="border-t border-gray-800/50 px-1 py-1">
          {events.map((event, i) => (
            <EventCard
              key={event.event_id || event.timestamp + i}
              event={event}
              onOpenTranscript={onOpenTranscript}
            />
          ))}
        </div>
      )}
    </div>
  );
}
