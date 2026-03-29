/**
 * ConcurrentTimeline — swim-lane view showing temporal overlap between sessions.
 * Columns = sessions, Y axis = time (downward). Overlap bands highlight concurrency.
 */
import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { fetchSessions } from '../api';
import FacetBar from './FacetBar';

const COLORS = [
  '#e06c75', '#c678dd', '#e5c07b', '#56b6c2', '#61afef',
  '#d19a66', '#98c379', '#ff6b9d', '#c3a6ff', '#5c6370',
];

function hashColor(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash |= 0;
  }
  return COLORS[Math.abs(hash) % COLORS.length];
}

function eventTypeColor(type) {
  if (!type) return '#6b7280';
  if (type === 'git_commit') return '#98c379';
  if (type === 'fetch' || type === 'research_fetch') return '#61afef';
  if (type === 'search' || type === 'research_search') return '#e5c07b';
  if (type.includes('bash')) return '#e06c75';
  if (type.includes('edit')) return '#d19a66';
  if (type.includes('milestone') || type.includes('agent')) return '#c678dd';
  if (type.startsWith('memory_')) return '#56b6c2';
  return '#6b7280';
}

function formatTime(iso) {
  return new Date(iso).toLocaleTimeString('en', { hour: 'numeric', minute: '2-digit', hour12: true });
}

function formatDate(iso) {
  return new Date(iso).toLocaleDateString('en', { month: 'short', day: 'numeric' });
}

function durationLabel(start, end) {
  const mins = Math.round((new Date(end) - new Date(start)) / 60000);
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

const PIXELS_PER_HOUR = { overview: 20, detail: 100 };
const LANE_MIN_WIDTH = 48;
const LANE_MAX_WIDTH = 120;
const TIME_GUTTER = 64;
const GAP_THRESHOLD_MS = 15 * 60 * 1000; // 15 min — split sessions at gaps longer than this

// Sky palette — hour of day → background color (dark mode friendly)
// Night: deep navy. Dawn: indigo-amber. Day: dark blue-gray. Dusk: purple-orange. Night: deep navy.
const SKY_STOPS = [
  // hour, [r, g, b]
  [0,  [8, 8, 18]],      // midnight — deep navy
  [5,  [8, 8, 18]],      // pre-dawn — still dark
  [6,  [18, 12, 28]],    // first light — deep indigo
  [7,  [35, 18, 32]],    // dawn — indigo-plum
  [8,  [28, 20, 15]],    // sunrise — warm dark amber
  [9,  [15, 18, 28]],    // morning — settling blue-gray
  [12, [12, 16, 25]],    // noon — neutral dark blue
  [15, [12, 16, 25]],    // afternoon — same
  [17, [20, 16, 18]],    // late afternoon — warming
  [18, [32, 16, 20]],    // sunset — warm plum
  [19, [25, 12, 28]],    // dusk — purple
  [20, [14, 10, 22]],    // twilight — deep purple
  [21, [8, 8, 18]],      // night — back to navy
  [24, [8, 8, 18]],      // midnight
];

function skyColorAtHour(hour) {
  const h = hour % 24;
  let lo = SKY_STOPS[0], hi = SKY_STOPS[SKY_STOPS.length - 1];
  for (let i = 0; i < SKY_STOPS.length - 1; i++) {
    if (h >= SKY_STOPS[i][0] && h < SKY_STOPS[i + 1][0]) {
      lo = SKY_STOPS[i];
      hi = SKY_STOPS[i + 1];
      break;
    }
  }
  const t = (h - lo[0]) / Math.max(hi[0] - lo[0], 1);
  const r = Math.round(lo[1][0] + (hi[1][0] - lo[1][0]) * t);
  const g = Math.round(lo[1][1] + (hi[1][1] - lo[1][1]) * t);
  const b = Math.round(lo[1][2] + (hi[1][2] - lo[1][2]) * t);
  return `rgb(${r},${g},${b})`;
}

// Split a session into work segments based on event timestamps
function splitIntoSegments(session) {
  const evts = session.events;
  if (!evts || evts.length === 0) return [{ start: session.start, end: session.end, events: [] }];

  const sorted = [...evts].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const segments = [];
  let segStart = session.start;
  let segEvents = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    const prev = new Date(sorted[i - 1].timestamp).getTime();
    const curr = new Date(sorted[i].timestamp).getTime();

    if (curr - prev > GAP_THRESHOLD_MS) {
      // Close current segment at previous event, start new one
      segments.push({ start: segStart, end: sorted[i - 1].timestamp, events: segEvents });
      segStart = sorted[i].timestamp;
      segEvents = [sorted[i]];
    } else {
      segEvents.push(sorted[i]);
    }
  }

  segments.push({ start: segStart, end: session.end, events: segEvents });
  return segments;
}

export default function ConcurrentTimeline({ onOpenTranscript }) {
  const urlParams = useMemo(() => {
    const p = new URLSearchParams(window.location.search);
    return { days: parseInt(p.get('days') || '7', 10), zoom: p.get('zoom') || 'overview' };
  }, []);

  const [days, setDays] = useState(urlParams.days);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [zoom, setZoom] = useState(urlParams.zoom);
  const [activeFacets, setActiveFacets] = useState({ projects: new Set(), types: new Set(), sources: new Set() });
  const [hoveredSession, setHoveredSession] = useState(null);
  const scrollRef = useRef(null);

  useEffect(() => {
    const params = new URLSearchParams();
    params.set('view', 'concurrent');
    if (days !== 7) params.set('days', days);
    if (zoom !== 'overview') params.set('zoom', zoom);
    if (activeFacets.projects.size > 0) params.set('fp', [...activeFacets.projects].join(','));
    if (activeFacets.types.size > 0) params.set('ft', [...activeFacets.types].join(','));
    const qs = params.toString();
    window.history.replaceState({ tab: 'timeline' }, '', qs ? `/?${qs}` : '/');
  }, [days, zoom, activeFacets]);

  useEffect(() => {
    setLoading(true);
    fetchSessions({ days }).then(d => {
      setData(d);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, [days]);

  const toggleFacet = useCallback((dimension, value) => {
    setActiveFacets(prev => {
      const next = { ...prev, [dimension]: new Set(prev[dimension]) };
      if (next[dimension].has(value)) next[dimension].delete(value);
      else next[dimension].add(value);
      return next;
    });
  }, []);

  const clearFacets = useCallback(() => {
    setActiveFacets({ projects: new Set(), types: new Set(), sources: new Set() });
  }, []);

  const filteredSessions = useMemo(() => {
    if (!data?.sessions) return [];
    let sessions = data.sessions;
    if (activeFacets.projects.size > 0)
      sessions = sessions.filter(s => s.projects.some(p => activeFacets.projects.has(p)));
    if (activeFacets.types.size > 0)
      sessions = sessions.filter(s => Object.keys(s.types).some(t => activeFacets.types.has(t)));
    return sessions;
  }, [data, activeFacets]);

  const filteredOverlaps = useMemo(() => {
    if (!data?.overlaps) return [];
    const visibleIds = new Set(filteredSessions.map(s => s.session_id));
    return data.overlaps.filter(o => o.sessions.every(sid => visibleIds.has(sid)));
  }, [data, filteredSessions]);

  const facets = useMemo(() => {
    if (!data?.sessions) return null;
    const projMap = new Map(), typeMap = new Map();
    for (const s of data.sessions) {
      for (const p of s.projects) projMap.set(p, (projMap.get(p) || 0) + 1);
      for (const [t, c] of Object.entries(s.types)) typeMap.set(t, (typeMap.get(t) || 0) + c);
    }
    const sortDesc = (map, n) => [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([name, count]) => ({ name, count }));
    return { projects: sortDesc(projMap, 6), types: sortDesc(typeMap, 6), sources: [], time: null };
  }, [data]);

  const { windowStart, windowEnd, containerHeight, timeToY } = useMemo(() => {
    if (!filteredSessions.length) return { windowStart: 0, windowEnd: 1, containerHeight: 400, timeToY: () => 0 };
    const starts = filteredSessions.map(s => new Date(s.start).getTime());
    const ends = filteredSessions.map(s => new Date(s.end).getTime());
    const ws = Math.min(...starts), we = Math.max(...ends);
    const range = Math.max(we - ws, 3600000);
    const pph = PIXELS_PER_HOUR[zoom];
    const ch = Math.max(400, (range / 3600000) * pph);
    return { windowStart: ws, windowEnd: we, containerHeight: ch, timeToY: (ts) => {
      const t = typeof ts === 'string' ? new Date(ts).getTime() : ts;
      return ch - ((t - ws) / range) * ch;  // inverted: newest at top
    }};
  }, [filteredSessions, zoom]);

  // Group sessions into lanes by project — sessions sharing a project stack in the same column
  const { lanes, laneMap } = useMemo(() => {
    const projectToLane = new Map();
    const lanes = []; // each lane: { project, sessions: [] }
    const laneMap = new Map(); // session_id → lane index

    for (const s of filteredSessions) {
      if (!projectToLane.has(s.project)) {
        projectToLane.set(s.project, lanes.length);
        lanes.push({ project: s.project, sessions: [] });
      }
      const laneIdx = projectToLane.get(s.project);
      lanes[laneIdx].sessions.push(s);
      laneMap.set(s.session_id, laneIdx);
    }

    return { lanes, laneMap };
  }, [filteredSessions]);

  const timeLabels = useMemo(() => {
    const labels = [];
    const step = zoom === 'overview' ? 6 : 1;
    const cursor = new Date(windowStart);
    cursor.setMinutes(0, 0, 0);
    cursor.setHours(Math.floor(cursor.getHours() / step) * step);
    while (cursor.getTime() <= windowEnd) {
      const ts = cursor.getTime();
      if (ts >= windowStart) {
        const isNewDay = cursor.getHours() === 0 || labels.length === 0;
        labels.push({
          y: timeToY(ts),
          label: isNewDay ? `${formatDate(cursor)} ${formatTime(cursor)}` : formatTime(cursor),
          isMajor: isNewDay,
        });
      }
      cursor.setHours(cursor.getHours() + step);
    }
    return labels;
  }, [windowStart, windowEnd, timeToY, zoom]);

  const laneWidth = Math.max(LANE_MIN_WIDTH, Math.min(LANE_MAX_WIDTH, 600 / Math.max(lanes.length, 1)));
  const hasAnyFacet = activeFacets.projects.size > 0 || activeFacets.types.size > 0;

  // Sky gradient bands — one per hour in the visible window
  const skyBands = useMemo(() => {
    const bands = [];
    const cursor = new Date(windowStart);
    cursor.setMinutes(0, 0, 0);
    while (cursor.getTime() <= windowEnd) {
      const ts = cursor.getTime();
      const nextHour = new Date(ts);
      nextHour.setHours(nextHour.getHours() + 1);
      const y1 = timeToY(Math.max(ts, windowStart));
      const y2 = timeToY(Math.min(nextHour.getTime(), windowEnd));
      const top = Math.min(y1, y2);
      const height = Math.abs(y2 - y1);
      if (height > 0) {
        bands.push({ top, height, color: skyColorAtHour(cursor.getHours()) });
      }
      cursor.setHours(cursor.getHours() + 1);
    }
    return bands;
  }, [windowStart, windowEnd, timeToY]);

  if (loading) return <div className="text-gray-500 text-sm p-4">Loading sessions...</div>;
  if (!data?.sessions.length) return <div className="text-gray-500 text-sm p-4">No sessions found.</div>;

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 px-4 py-2 border-b border-gray-800 flex-shrink-0">
        <div className="flex gap-1">
          {[1, 3, 7, 30].map(d => (
            <button key={d} onClick={() => setDays(d)}
              className={`px-2 py-0.5 text-xs rounded ${days === d ? 'bg-gray-700 text-gray-200' : 'text-gray-500 hover:text-gray-300'}`}>
              {d}d
            </button>
          ))}
        </div>
        <span className="text-gray-700">·</span>
        <div className="flex gap-1">
          {['overview', 'detail'].map(z => (
            <button key={z} onClick={() => setZoom(z)}
              className={`px-2 py-0.5 text-xs rounded ${zoom === z ? 'bg-gray-700 text-gray-200' : 'text-gray-500 hover:text-gray-300'}`}>
              {z}
            </button>
          ))}
        </div>
        <span className="text-gray-700">·</span>
        <span className="text-xs text-gray-300 font-mono">
          {filteredSessions.length} sessions · {filteredOverlaps.length} overlaps
        </span>
      </div>

      {facets && (
        <FacetBar facets={facets} activeFacets={activeFacets} onToggle={toggleFacet} onClear={clearFacets} />
      )}

      <div ref={scrollRef} className="flex-1 overflow-auto">
        <div className="relative" style={{ minWidth: TIME_GUTTER + lanes.length * laneWidth, height: containerHeight }}>

          {/* Sky gradient — day/night ambient backdrop */}
          {skyBands.map((band, i) => (
            <div key={`sky-${i}`} className="absolute left-0 right-0" style={{ top: band.top, height: band.height, backgroundColor: band.color, zIndex: 0 }} />
          ))}

          {/* Time axis */}
          <div className="absolute top-0 left-0 bottom-0" style={{ width: TIME_GUTTER }}>
            {timeLabels.map((t, i) => (
              <div key={i} className="absolute left-0 right-0" style={{ top: t.y }}>
                <div className="text-[10px] text-gray-300 font-mono px-1 leading-tight whitespace-nowrap">{t.label}</div>
                <div className="absolute right-0 h-px" style={{ width: '100vw', backgroundColor: t.isMajor ? 'rgba(255,255,255,0.06)' : 'rgba(255,255,255,0.02)' }} />
              </div>
            ))}
          </div>

          {/* Overlap bands — only cross-project overlaps */}
          {filteredOverlaps.map((o, i) => {
            const idxA = laneMap.get(o.sessions[0]), idxB = laneMap.get(o.sessions[1]);
            if (idxA === undefined || idxB === undefined || idxA === idxB) return null;
            const left = TIME_GUTTER + Math.min(idxA, idxB) * laneWidth;
            const right = TIME_GUTTER + (Math.max(idxA, idxB) + 1) * laneWidth;
            const top = timeToY(o.start);
            const height = Math.max(2, timeToY(o.end) - top);
            return <div key={i} className="absolute rounded-sm" style={{ left, top, width: right - left, height, backgroundColor: 'rgba(255,255,255,0.03)', zIndex: 0 }} />;
          })}

          {/* Project lanes — sessions grouped by project */}
          {lanes.map((lane, laneIdx) => {
            const color = hashColor(lane.project);
            const left = TIME_GUTTER + laneIdx * laneWidth;

            return (
              <div key={lane.project}>
                {/* Lane header — project name at top of column */}
                <div className="absolute text-[9px] font-mono truncate"
                  style={{ left: left + 2, top: 2, width: laneWidth - 4, color, zIndex: 3 }}>
                  {lane.project}
                </div>

                {/* Session bars — split into segments at gaps >15 min */}
                {lane.sessions.map(session => {
                  const segments = splitIntoSegments(session);
                  const isHovered = hoveredSession === session.session_id;

                  return segments.map((seg, si) => {
                    const segTop = timeToY(seg.end);  // inverted: end is higher (smaller y)
                    const segBottom = timeToY(seg.start);
                    const barTop = Math.min(segTop, segBottom);
                    const barHeight = Math.max(4, Math.abs(segBottom - segTop));

                    return (
                      <div key={`${session.session_id}-${si}`}
                        className="absolute rounded-sm cursor-pointer transition-opacity duration-100 session-bar"
                        style={{
                          left: left + 2, top: barTop, width: laneWidth - 4, height: barHeight,
                          backgroundColor: color + (isHovered ? '66' : '33'),
                          borderLeft: `3px solid ${color}`,
                          opacity: isHovered ? 1 : 0.85, zIndex: 1,
                        }}
                        onClick={() => session.transcript_path && onOpenTranscript?.(session.transcript_path)}
                        onMouseEnter={() => setHoveredSession(session.session_id)}
                        onMouseLeave={() => setHoveredSession(null)}
                        title={`${session.project}\n${durationLabel(seg.start, seg.end)} · ${seg.events.length} events\n${formatDate(seg.start)} ${formatTime(seg.start)} – ${formatTime(seg.end)}`}>
                        {zoom === 'detail' && seg.events.map((ev, ei) => {
                          const evY = timeToY(ev.timestamp) - barTop;
                          if (evY < 0 || evY > barHeight) return null;
                          return <div key={ev.event_id || ei} className="absolute left-0 right-0 h-[2px]"
                            style={{ top: evY, backgroundColor: eventTypeColor(ev.type), opacity: 0.8 }}
                            title={`${ev.type}: ${ev.summary}`} />;
                        })}
                      </div>
                    );
                  });
                })}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
