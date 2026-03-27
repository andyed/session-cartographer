import { useState } from 'react';
import EventGroup, { groupEvents } from './EventGroup';
import SessionSparkline from './SessionSparkline';
import ProjectBadge from './ProjectBadge';

export default function SessionCard({ session, onOpenTranscript, onProjectClick }) {
  const [expanded, setExpanded] = useState(false);
  
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
          </div>
          <div className="flex gap-2">
            {projects.map(p => <ProjectBadge key={p} project={p} onClick={onProjectClick} />)}
          </div>
        </div>
        
        <div className="text-xs text-gray-600 mb-2">
          {dateObj.toLocaleDateString()} • {startTime} - {endTime}
        </div>

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
