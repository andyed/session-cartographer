import { useState, useEffect, useRef, useMemo } from 'react';
import { fetchEvents } from '../api';
import { useEventStream } from '../hooks/useEventStream';
import EventGroup, { groupEvents } from './EventGroup';

export default function Timeline({ onOpenTranscript }) {
  const [events, setEvents] = useState([]);
  const [newCount, setNewCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const scrollRef = useRef(null);
  const isAtTop = useRef(true);

  useEffect(() => {
    fetchEvents({ limit: 200 }).then(data => {
      setEvents(data.events);
      setLoading(false);
    });
  }, []);

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

  const groups = useMemo(() => groupEvents(events), [events]);

  if (loading) {
    return <div className="p-8 text-gray-500">Loading events...</div>;
  }

  return (
    <div className="relative h-full">
      {newCount > 0 && (
        <button
          onClick={scrollToTop}
          className="absolute top-2 left-1/2 -translate-x-1/2 z-10 bg-blue-600 text-white text-xs px-3 py-1 rounded-full shadow-lg hover:bg-blue-500"
        >
          {newCount} new event{newCount > 1 ? 's' : ''}
        </button>
      )}

      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="overflow-y-auto h-full p-4"
      >
        {events.length === 0 ? (
          <div className="text-gray-500 text-center py-12">
            No events yet. Events will appear as Claude Code hooks fire.
          </div>
        ) : (
          groups.map((group, i) => (
            <EventGroup
              key={group.events[0].event_id || group.events[0].timestamp + i}
              group={group}
              onOpenTranscript={onOpenTranscript}
            />
          ))
        )}
      </div>
    </div>
  );
}
