/**
 * FacetBar — space-filling facet pills with proportional font sizing.
 * Pills scale font size by count, constrained to fill exactly ~2 lines.
 * Time range on separate line as sparkline.
 */
import { useRef, useState, useEffect, useMemo } from 'react';

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

const TYPE_COLORS = {
  fetch: '#61afef', research_fetch: '#61afef',
  search: '#e5c07b', research_search: '#e5c07b',
  git_commit: '#ff9e64', git_push: '#ff6b6b',
  tool_file_edit: '#98c379', tool_bash: '#56b6c2',
};

function typeColor(name) {
  if (TYPE_COLORS[name]) return TYPE_COLORS[name];
  if (name.includes('compaction') || name.includes('session_end')) return '#e06c75';
  if (name.includes('bridge')) return '#c678dd';
  if (name.startsWith('memory_')) return '#d19a66';
  if (name.startsWith('agent_') || name.startsWith('milestone_agent_')) return '#c3a6ff';
  return '#5c6370';
}

const SOURCE_COLORS = {
  keyword: '#98c379', semantic: '#61afef', browse: '#5c6370',
  changelog: '#e5c07b', research: '#61afef', milestones: '#e06c75',
  'tool-use': '#56b6c2', transcript: '#c678dd',
};

// Font size range
const MIN_FONT = 10;
const MAX_FONT = 16;
const TARGET_LINES = 2;
const GAP = 4; // gap between pills in px
const H_PAD = 10; // horizontal padding inside pill
const DOT_WIDTH = 16; // width of · separator

/**
 * Given all pill items + container width, compute a global scale factor
 * so that total pill width fills TARGET_LINES lines.
 * Each pill's font size = MIN_FONT + (MAX_FONT - MIN_FONT) * (count / maxCount) * scale
 */
function computeSizes(items, containerWidth) {
  if (!items.length || !containerWidth) return items.map(() => MIN_FONT);

  const maxCount = Math.max(...items.map(i => i.count), 1);
  const targetWidth = containerWidth * TARGET_LINES;

  // Estimate pill width: chars * fontSize * charWidthRatio + padding + gap
  // 0.65 accounts for mono font average glyph width + inter-character spacing
  function totalWidth(scale) {
    let w = 0;
    for (const item of items) {
      const ratio = item.count / maxCount;
      const fontSize = MIN_FONT + (MAX_FONT - MIN_FONT) * ratio * scale;
      const charCount = item.label.length + String(item.count).length + 1;
      const pad = fontSize > 13 ? fontSize * 0.5 : fontSize * 0.4;
      w += charCount * fontSize * 0.65 + pad * 2 + GAP + 2; // +2 for border
      if (item.separator) w += DOT_WIDTH;
    }
    return w;
  }

  // Binary search for scale that fills target width
  let lo = 0.1, hi = 3.0;
  for (let i = 0; i < 20; i++) {
    const mid = (lo + hi) / 2;
    if (totalWidth(mid) < targetWidth) lo = mid;
    else hi = mid;
  }
  const scale = (lo + hi) / 2;

  return items.map(item => {
    const ratio = item.count / maxCount;
    return Math.round(Math.max(MIN_FONT, Math.min(MAX_FONT, MIN_FONT + (MAX_FONT - MIN_FONT) * ratio * scale)));
  });
}

function Pill({ label, count, color, active, onClick, fontSize }) {
  const py = fontSize > 13 ? '2px' : '1px';

  if (active) {
    return (
      <button
        onClick={onClick}
        className="inline-flex items-center gap-1 rounded font-mono transition-all outline-none ring-1 ring-offset-1 ring-offset-gray-900"
        style={{
          fontSize: `${fontSize}px`,
          lineHeight: 1.3,
          padding: `${py} ${Math.round(fontSize * 0.5)}px`,
          backgroundColor: color + '55',
          color: '#fff',
          border: `1px solid ${color}`,
          ringColor: color,
        }}
      >
        {label}<span style={{ opacity: 0.7 }}>{count}</span>
        <span className="opacity-60 hover:opacity-100" style={{ fontSize: `${fontSize - 2}px` }}>×</span>
      </button>
    );
  }

  return (
    <button
      onClick={onClick}
      className="inline-flex items-center gap-0.5 rounded font-mono transition-all outline-none hover:brightness-125"
      style={{
        fontSize: `${fontSize}px`,
        lineHeight: 1.3,
        padding: `${py} ${Math.round(fontSize * 0.4)}px`,
        backgroundColor: count > 0 ? color + '15' : 'transparent',
        color: count > 0 ? color : '#4b5563',
        border: `1px solid ${count > 0 ? color + '30' : '#374151'}`,
      }}
    >
      {label}<span style={{ opacity: 0.5 }}>{count}</span>
    </button>
  );
}

/**
 * Timeline sparkline — two-row reflection layout.
 * Top row: viewport matches (bright, glowing) — reflects what's on screen.
 * Bottom row: full distribution (dim) — the complete result set.
 * Shared time axis with month ticks between them.
 */
function TimeSparkline({ results, oldest, newest, visibleIds, onDotClick }) {
  if (!results || results.length === 0 || !oldest || !newest) return null;

  const minTs = new Date(oldest).getTime();
  const maxTs = new Date(newest).getTime();
  const range = Math.max(maxTs - minTs, 1);

  const ticks = [];
  const cursor = new Date(new Date(oldest).getFullYear(), new Date(oldest).getMonth(), 1);
  const endDate = new Date(newest);
  while (cursor <= endDate) {
    const ts = cursor.getTime();
    if (ts >= minTs && ts <= maxTs) {
      const pct = ((ts - minTs) / range) * 100;
      const label = cursor.toLocaleDateString('en', { month: 'short', year: '2-digit' });
      ticks.push({ pct, label });
    }
    cursor.setMonth(cursor.getMonth() + 1);
  }

  const parsedResults = useMemo(() => {
    return results.map(ev => {
      const rawTs = ev.timestamp;
      const ts = typeof rawTs === 'string' ? new Date(rawTs).getTime()
        : typeof rawTs === 'number' ? (rawTs > 1e12 ? rawTs : rawTs * 1000)
        : 0;
      return { ...ev, _ts: ts || 0, _type: ev.type || ev.milestone || '' };
    }).filter(ev => ev._ts > 0);
  }, [results]);

  function dotColor(type) {
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

  const visSet = visibleIds || new Set();

  // Shared tick marks renderer
  const TickMarks = () => ticks.map(({ pct }, i) => (
    <div key={i} className="absolute top-0 h-full" style={{ left: `${Math.max(1, Math.min(99, pct))}%` }}>
      <div className="w-px h-full bg-gray-700/30" />
    </div>
  ));

  return (
    <div className="relative w-full">
      {/* Top row: viewport reflection — only visible cards */}
      <div className="relative h-4 w-full bg-gray-900/30 rounded-t border-x border-t border-gray-800/50 overflow-hidden px-1">
        <div className="absolute bottom-0 left-0 right-0 h-px bg-gray-700/30" />
        <TickMarks />
        {parsedResults.map((ev, i) => {
          if (!visSet.has(ev.event_id)) return null;
          const pct = ((ev._ts - minTs) / range) * 100;
          const color = dotColor(ev._type);
          return (
            <div
              key={ev.event_id || i}
              className="absolute bottom-[3px] rounded-full cursor-pointer transition-all duration-200"
              style={{
                left: `${Math.max(0.5, Math.min(99.5, pct))}%`,
                width: '6px',
                height: '6px',
                marginLeft: '-3px',
                backgroundColor: color,
                boxShadow: `0 0 5px ${color}, 0 0 2px ${color}`,
              }}
              onClick={() => onDotClick?.(ev.event_id)}
              title={`${ev._type} · ${new Date(ev._ts).toLocaleDateString()}`}
            />
          );
        })}
      </div>

      {/* Bottom row: full distribution — all results, dim */}
      <div className="relative h-4 w-full bg-gray-900/50 rounded-b border-x border-b border-gray-800/50 overflow-hidden px-1">
        <div className="absolute top-0 left-0 right-0 h-px bg-gray-700/30" />
        <TickMarks />
        {parsedResults.map((ev, i) => {
          const pct = ((ev._ts - minTs) / range) * 100;
          const color = dotColor(ev._type);
          return (
            <div
              key={ev.event_id || i}
              className="absolute top-[5px] rounded-full cursor-pointer"
              style={{
                left: `${Math.max(0.5, Math.min(99.5, pct))}%`,
                width: '3px',
                height: '3px',
                marginLeft: '-1.5px',
                backgroundColor: color,
                opacity: 0.5,
              }}
              onClick={() => onDotClick?.(ev.event_id)}
              title={`${ev._type} · ${new Date(ev._ts).toLocaleDateString()}`}
            />
          );
        })}
      </div>

      {/* Month labels */}
      <div className="relative h-3 w-full px-1">
        {ticks.map(({ pct, label }, i) => (
          <span
            key={i}
            className="absolute text-[10px] text-gray-400 font-mono -translate-x-1/2"
            style={{ left: `${Math.max(3, Math.min(97, pct))}%`, top: 0 }}
          >
            {label}
          </span>
        ))}
      </div>
    </div>
  );
}

export default function FacetBar({ facets, activeFacets, onToggle, onClear, results, visibleIds, onDotClick }) {
  if (!facets) return null;

  const containerRef = useRef(null);
  const [containerWidth, setContainerWidth] = useState(0);

  useEffect(() => {
    if (!containerRef.current) return;
    const observer = new ResizeObserver(([entry]) => {
      setContainerWidth(entry.contentRect.width);
    });
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  const hasActive = activeFacets.projects.size > 0 || activeFacets.types.size > 0 || activeFacets.sources.size > 0;

  // Build flat list of all pill items with metadata for sizing
  const allItems = useMemo(() => {
    const items = [];
    const addGroup = (list, dimension, colorFn) => {
      if (!list?.length) return;
      if (items.length > 0) items[items.length - 1].separator = true;
      for (const { name, count } of list) {
        items.push({ label: name, count, dimension, color: colorFn(name), separator: false });
      }
    };
    addGroup(facets.projects, 'projects', hashColor);
    addGroup(facets.types, 'types', typeColor);
    addGroup(facets.sources, 'sources', (n) => SOURCE_COLORS[n] || '#5c6370');
    return items;
  }, [facets]);

  const fontSizes = useMemo(
    () => computeSizes(allItems, containerWidth),
    [allItems, containerWidth]
  );

  return (
    <div className="flex flex-col gap-1 px-4 py-2 border-b border-gray-800/50 flex-shrink-0">
      {/* Facet pills — space-filling proportional layout */}
      <div ref={containerRef} className="flex flex-wrap items-center gap-1">
        {allItems.map((item, i) => (
          <span key={`${item.dimension}-${item.label}`} className="inline-flex items-center gap-1">
            <Pill
              label={item.label}
              count={item.count}
              color={item.color}
              active={activeFacets[item.dimension]?.has(item.label)}
              onClick={() => onToggle(item.dimension, item.label)}
              fontSize={fontSizes[i]}
            />
            {item.separator && <span className="text-gray-700 mx-0.5">·</span>}
          </span>
        ))}
        {hasActive && (
          <button onClick={onClear} className="text-xs text-gray-500 hover:text-gray-300 underline ml-1">clear</button>
        )}
      </div>

      {/* Time range — dot sparkline with month labels + legend */}
      {facets.time?.oldest && (
        <TimeSparkline
          results={results || []}
          oldest={facets.time.oldest}
          newest={facets.time.newest}
          visibleIds={visibleIds}
          onDotClick={onDotClick}
        />
      )}
    </div>
  );
}
