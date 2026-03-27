import React from 'react';

export default function SessionSparkline({ events }) {
  if (!events || events.length === 0) return null;

  // Find min and max timestamp
  const timestamps = events
    .map(e => new Date(e.timestamp || 0).getTime())
    .filter(ts => !isNaN(ts) && ts > 0);

  if (timestamps.length === 0) return null;

  const min = Math.min(...timestamps);
  const max = Math.max(...timestamps);
  const range = Math.max(max - min, 1); // Avoid div by 0 for instantaneous sessions

  function getColor(type) {
    if (!type) return 'bg-gray-500';
    const t = type.toLowerCase();
    
    // Explicit matches
    if (t.includes('git') || t.includes('commit')) return 'bg-green-500';
    if (t.includes('fetch') || t.includes('search')) return 'bg-blue-500';
    if (t.includes('bash')) return 'bg-red-500'; 
    if (t.includes('tool') || t.includes('edit')) return 'bg-yellow-500';
    if (t.includes('milestone')) return 'bg-purple-500';
    if (t.includes('transcript')) return 'bg-indigo-400';
    
    return 'bg-gray-400';
  }

  return (
    <div className="relative h-6 w-full bg-gray-900 rounded border border-gray-700 mt-2 mb-2 overflow-hidden px-1">
      {/* Central track line */}
      <div className="absolute top-1/2 left-0 right-0 h-px bg-gray-700 -translate-y-1/2" />
      
      {/* Event dots */}
      {events.map((ev, i) => {
        const ts = new Date(ev.timestamp || 0).getTime();
        if (!ts) return null;
        const percent = ((ts - min) / range) * 100;
        
        return (
          <div
            key={ev.event_id || i}
            className={`absolute top-1/2 w-2 h-2 rounded-full -translate-y-1/2 -ml-1 opacity-80 mix-blend-screen shadow-sm ${getColor(ev.type || ev.milestone)}`}
            style={{ left: `${Math.max(1, Math.min(99, percent))}%` }}
            title={`${ev.type || ev.milestone} at ${new Date(ts).toLocaleTimeString()}`}
          />
        );
      })}
    </div>
  );
}
