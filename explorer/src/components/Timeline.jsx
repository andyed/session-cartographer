import { useState, useEffect, useRef, useMemo } from 'react';
import { fetchEvents } from '../api';
import { useEventStream } from '../hooks/useEventStream';
import EventGroup, { groupEvents } from './EventGroup';
import SessionCard from './SessionCard';

function groupEventsBySession(events) {
  const sessions = {};
  for (const e of events) {
    let sid = e.session_id;
    if (!sid || sid === 'unknown') {
      const dateStr = new Date(e.timestamp || 0).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
      const proj = e.project || 'Orphaned';
      sid = `Legacy: ${proj} (${dateStr})`;
    }
    if (!sessions[sid]) {
      sessions[sid] = {
        session_id: sid,
        events: [],
        timestamp: e.timestamp // Most recent timestamp
      };
    }
    sessions[sid].events.push(e);
  }
  
  return Object.values(sessions).sort((a, b) => {
    return new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();
  });
}

export default function Timeline({ onOpenTranscript }) {
  const [events, setEvents] = useState([]);
  const [newCount, setNewCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [viewMode, setViewMode] = useState('chronological'); // 'sessions' or 'chronological'
  const [projectFilter, setProjectFilter] = useState('');
  const scrollRef = useRef(null);
  const isAtTop = useRef(true);

  useEffect(() => {
    setLoading(true);
    fetchEvents({ limit: 400, project: projectFilter }).then(data => {
      setEvents(data.events);
      setLoading(false);
    });
  }, [projectFilter]);

  useEventStream((event) => {
    setEvents(prev => [event, ...prev]);
    if (!isAtTop.current) {
      setNewCount(prev => prev + 1);
    }
  });

  const handleScroll = () => {
    if (scrollRef.current) {
      isAtTop.current = scrollRef.current.scrollTop < 50;
      if (isAtTop.current && newCount > 0) {
        setNewCount(0);
      }
    }
  };

  const scrollToTop = () => {
    scrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
    setNewCount(0);
  };

  const timeGroups = useMemo(() => groupEvents(events), [events]);
  const sessionGroups = useMemo(() => groupEventsBySession(events), [events]);

  if (loading) {
    return <div className="p-8 text-gray-500">Loading timeline...</div>;
  }

  return (
    <div className="relative h-full flex flex-col">
      {/* View Toggle Bar */}
      <div className="px-4 py-2 border-b border-gray-800 bg-gray-900/50 flex justify-between items-center">
        <div className="flex-1">
          {projectFilter && (
            <span className="inline-flex items-center gap-2 bg-blue-900/30 border border-blue-500/50 text-blue-200 text-xs px-2 py-0.5 rounded-full">
              Project: <span className="font-mono font-medium">{projectFilter}</span>
              <button onClick={() => setProjectFilter('')} className="hover:text-white font-bold text-blue-400 ml-1 rounded-full p-0.5 leading-none px-1.5 focus:outline-none focus:ring-1">
                ✕
              </button>
            </span>
          )}
        </div>

        <div className="bg-gray-800 p-1 rounded-md inline-flex text-xs shrink-0">
          <button
            onClick={() => setViewMode('sessions')}
            className={`px-3 py-1 rounded transition-colors ${viewMode === 'sessions' ? 'bg-gray-700 text-white shadow-sm' : 'text-gray-400 hover:text-gray-200'}`}
          >
            Sessions
          </button>
          <button
            onClick={() => setViewMode('chronological')}
            className={`px-3 py-1 rounded transition-colors ${viewMode === 'chronological' ? 'bg-gray-700 text-white shadow-sm' : 'text-gray-400 hover:text-gray-200'}`}
          >
            Event Feed
          </button>
        </div>
      </div>

      {newCount > 0 && (
        <button
          onClick={scrollToTop}
          className="absolute top-12 left-1/2 -translate-x-1/2 z-10 bg-blue-600 text-white text-xs px-3 py-1 rounded-full shadow-lg hover:bg-blue-500"
        >
          {newCount} new event{newCount > 1 ? 's' : ''}
        </button>
      )}

      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="overflow-y-auto flex-1 p-4"
      >
        {events.length === 0 ? (
          <div className="text-gray-500 text-center py-12">
            No events yet. Events will appear as Claude Code hooks fire.
          </div>
        ) : viewMode === 'sessions' ? (
          sessionGroups.map((group, i) => (
            <SessionCard
              key={group.session_id || i}
              session={group}
              onOpenTranscript={onOpenTranscript}
              onProjectClick={setProjectFilter}
            />
          ))
        ) : (
          timeGroups.map((group, i) => (
            <EventGroup
              key={group.events[0]?.event_id || group.events[0]?.timestamp || i}
              group={group}
              onOpenTranscript={onOpenTranscript}
              onProjectClick={setProjectFilter}
            />
          ))
        )}
      </div>
    </div>
  );
}
