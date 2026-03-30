import { useState, useEffect, useMemo, useRef, Fragment } from 'react';

/**
 * Lightweight markdown renderer — no dependencies.
 * Handles: headings, bold, italic, code blocks, inline code, hr, lists.
 */
function RenderMarkdown({ text, highlights = [] }) {
  const lines = text.split('\n');
  const elements = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Code block: ```
    if (line.trimStart().startsWith('```')) {
      const lang = line.trim().slice(3);
      const codeLines = [];
      i++;
      while (i < lines.length && !lines[i].trimStart().startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // skip closing ```
      elements.push(
        <pre key={elements.length} className="bg-gray-800 border border-gray-700 rounded px-3 py-2 my-2 text-xs font-mono overflow-x-auto text-gray-300">
          {codeLines.join('\n')}
        </pre>
      );
      continue;
    }

    // Heading
    const headingMatch = line.match(/^(#{1,4})\s+(.+)/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const sizes = { 1: 'text-lg font-bold text-gray-100', 2: 'text-base font-semibold text-gray-200', 3: 'text-sm font-semibold text-gray-200', 4: 'text-sm font-medium text-gray-300' };
      elements.push(<div key={elements.length} className={`${sizes[level]} mt-3 mb-1`}>{inlineMarkdown(headingMatch[2], highlights)}</div>);
      i++;
      continue;
    }

    // Horizontal rule
    if (/^---+$/.test(line.trim())) {
      elements.push(<hr key={elements.length} className="border-gray-700 my-2" />);
      i++;
      continue;
    }

    // List item
    if (/^\s*[-*]\s+/.test(line)) {
      elements.push(
        <div key={elements.length} className="flex gap-2 ml-2">
          <span className="text-gray-500">·</span>
          <span>{inlineMarkdown(line.replace(/^\s*[-*]\s+/, ''), highlights)}</span>
        </div>
      );
      i++;
      continue;
    }

    // Numbered list
    if (/^\s*\d+\.\s+/.test(line)) {
      const num = line.match(/^\s*(\d+)\./)[1];
      elements.push(
        <div key={elements.length} className="flex gap-2 ml-2">
          <span className="text-gray-500 font-mono text-xs w-4 text-right">{num}.</span>
          <span>{inlineMarkdown(line.replace(/^\s*\d+\.\s+/, ''), highlights)}</span>
        </div>
      );
      i++;
      continue;
    }

    // Empty line → spacer
    if (line.trim() === '') {
      elements.push(<div key={elements.length} className="h-2" />);
      i++;
      continue;
    }

    // Regular paragraph
    elements.push(<div key={elements.length}>{inlineMarkdown(line, highlights)}</div>);
    i++;
  }

  return <>{elements}</>;
}

// Inline markdown: **bold**, *italic*, `code`
// Optionally highlights search terms in plain text segments
function inlineMarkdown(text, highlights = []) {
  const parts = [];
  let remaining = text;
  let key = 0;

  while (remaining.length > 0) {
    // Inline code
    let match = remaining.match(/^(.*?)`([^`]+)`/);
    if (match) {
      if (match[1]) parts.push(...applyHighlights(match[1], highlights, key)); key++;
      parts.push(<code key={key++} className="bg-gray-800 px-1 rounded text-xs font-mono text-amber-300">{match[2]}</code>);
      remaining = remaining.slice(match[0].length);
      continue;
    }

    // Bold
    match = remaining.match(/^(.*?)\*\*(.+?)\*\*/);
    if (match) {
      if (match[1]) parts.push(...applyHighlights(match[1], highlights, key)); key++;
      parts.push(<strong key={key++} className="text-gray-100 font-semibold">{match[2]}</strong>);
      remaining = remaining.slice(match[0].length);
      continue;
    }

    // Italic
    match = remaining.match(/^(.*?)\*(.+?)\*/);
    if (match) {
      if (match[1]) parts.push(...applyHighlights(match[1], highlights, key)); key++;
      parts.push(<em key={key++} className="text-gray-400">{match[2]}</em>);
      remaining = remaining.slice(match[0].length);
      continue;
    }

    // No more matches — emit the rest with highlights
    parts.push(...applyHighlights(remaining, highlights, key));
    break;
  }

  return parts;
}

// Apply search term highlights to a plain text string
function applyHighlights(text, highlights, baseKey) {
  if (!text || highlights.length === 0) return [text];

  const pattern = highlights.map(h => h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const regex = new RegExp(`(${pattern})`, 'gi');
  const parts = text.split(regex);

  return parts.map((part, i) => {
    if (regex.test(part)) {
      regex.lastIndex = 0; // reset after test
      return <mark key={`hl-${baseKey}-${i}`} className="bg-yellow-500/30 text-yellow-200 rounded px-0.5">{part}</mark>;
    }
    return part;
  });
}

function relativeTime(ts) {
  if (!ts) return '';
  const diff = Date.now() - new Date(ts).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function highlightMatches(text, searchTerms) {
  if (!searchTerms.length || !text) return text;

  // Filter out trivially short terms (< 3 chars) that cause noise highlights
  const meaningful = searchTerms.filter(t => t.length >= 3);
  if (!meaningful.length) return text;

  // Escape regex special chars, join as alternation, require word-ish boundaries
  // Use \b for terms that start/end with word chars, raw for others
  const pattern = meaningful
    .map(t => {
      const escaped = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return `\\b${escaped}\\b`;
    })
    .join('|');

  const regex = new RegExp(`(${pattern})`, 'gi');
  const parts = text.split(regex);
  return parts.map((part, i) =>
    regex.test(part)
      ? <mark key={i} className="bg-yellow-500/30 text-yellow-200 rounded px-0.5">{part}</mark>
      : part
  );
}

function MessageBlock({ msg, searchTerms, defaultExpanded }) {
  const isLong = msg.content.length > 500;
  const [expanded, setExpanded] = useState(defaultExpanded || !isLong);

  const roleColors = {
    user: 'border-blue-500/40',
    assistant: 'border-green-500/40',
    progress: 'border-gray-600/40',
  };

  const roleLabels = {
    user: 'user',
    assistant: msg.model || 'assistant',
    progress: 'system',
  };

  const borderColor = roleColors[msg.role] || 'border-gray-700';
  const displayContent = expanded ? msg.content : msg.content.slice(0, 500);

  // Check if this message matches search
  const hasMatch = searchTerms.length > 0 &&
    searchTerms.some(t => msg.content.toLowerCase().includes(t.toLowerCase()));

  return (
    <div
      id={msg.uuid}
      className={`border-l-2 ${borderColor} pl-3 py-2 mb-1 ${
        hasMatch ? 'bg-yellow-500/5' : ''
      }`}
    >
      <div className="flex items-center gap-2 mb-1">
        <span className={`text-xs font-mono ${
          msg.role === 'user' ? 'text-blue-400' :
          msg.role === 'assistant' ? 'text-green-400' :
          'text-gray-500'
        }`}>
          {roleLabels[msg.role]}
        </span>
        <span className="text-xs text-gray-600 font-mono" title={msg.timestamp}>
          {relativeTime(msg.timestamp)}
        </span>
      </div>

      <div className="text-sm text-gray-300 break-words font-sans leading-relaxed prose-transcript">
        <RenderMarkdown text={displayContent} highlights={searchTerms} />
        {!expanded && isLong && (
          <span className="text-gray-500">...</span>
        )}
      </div>

      {isLong && (
        <button
          onClick={() => setExpanded(!expanded)}
          className="text-xs text-gray-500 hover:text-gray-300 mt-1"
        >
          {expanded ? 'collapse' : `expand (${msg.content.length} chars)`}
        </button>
      )}
    </div>
  );
}

// ─── Duration formatter ───────────────────────────────────────────────────────

function formatDuration(ms) {
  if (ms < 60000) return `${Math.round(ms / 1000)}s`;
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  return remMins > 0 ? `${hours}h ${remMins}m` : `${hours}h`;
}

function fmtTokens(n) {
  if (!n || n === 0) return '0';
  if (n < 1000) return String(n);
  return `${(n / 1000).toFixed(0)}k`;
}

// ─── 1c. Session Summary Header ──────────────────────────────────────────────

function SessionSummaryCard({ summary }) {
  const CATEGORY_LABELS = {
    claudeMd: 'CLAUDE.md',
    mentionedFiles: 'files',
    toolOutputs: 'tool outputs',
    thinkingText: 'thinking',
    taskCoordination: 'coordination',
    userMessages: 'user',
  };

  const stats = [
    { label: 'turns', value: summary.totalTurns },
    summary.totalTokens > 0 && { label: 'tokens', value: fmtTokens(summary.totalTokens) },
    summary.toolCallCount > 0 && { label: 'tool calls', value: summary.toolCallCount },
    summary.compactionCount > 0 && { label: 'compactions', value: summary.compactionCount, accent: true },
    summary.duration > 0 && { label: 'duration', value: formatDuration(summary.duration) },
    summary.dominantCategory && { label: 'dominated by', value: CATEGORY_LABELS[summary.dominantCategory] || summary.dominantCategory },
  ].filter(Boolean);

  return (
    <div className="mx-4 mt-2 mb-1 bg-gray-900/60 border border-gray-800 rounded px-4 py-2.5 flex flex-wrap gap-x-5 gap-y-1 flex-shrink-0">
      {stats.map(({ label, value, accent }) => (
        <div key={label} className="flex flex-col">
          <span className={`text-xs font-mono font-medium ${accent ? 'text-orange-400' : 'text-gray-200'}`}>
            {value}
          </span>
          <span className="text-xs text-gray-600">{label}</span>
        </div>
      ))}
    </div>
  );
}

// ─── 1b. Compaction Event Banner ─────────────────────────────────────────────

function CompactionBanner({ preTokens, postTokens }) {
  const compressionPct = postTokens > 0 ? Math.round((1 - postTokens / preTokens) * 100) : null;

  return (
    <div className="relative my-3 flex items-center gap-3 select-none" title="Context compaction — prior conversation was compressed">
      <div className="flex-1 h-px bg-gradient-to-r from-transparent to-orange-500/50" />
      <div className="flex-shrink-0 flex items-center gap-2 bg-gray-950 border border-orange-500/25 rounded px-2.5 py-1 text-xs font-mono">
        <span className="text-orange-400/80">⚡ compaction</span>
        {preTokens > 0 && (
          <span className="text-gray-600">
            {fmtTokens(preTokens)}
            <span className="mx-1 text-gray-700">→</span>
            {postTokens > 0 ? fmtTokens(postTokens) : '?'}
            {compressionPct !== null && (
              <span className="text-orange-400/60 ml-1.5">−{compressionPct}%</span>
            )}
          </span>
        )}
      </div>
      <div className="flex-1 h-px bg-gradient-to-l from-transparent to-orange-500/50" />
    </div>
  );
}

// ─── 1a. Token Attribution Sidebar ───────────────────────────────────────────

const ATTRIBUTION_CATEGORIES = [
  { key: 'claudeMd',        label: 'CLAUDE.md',     color: 'bg-blue-500',   dot: 'bg-blue-500' },
  { key: 'mentionedFiles',  label: 'Files',          color: 'bg-green-500',  dot: 'bg-green-500' },
  { key: 'toolOutputs',     label: 'Tool outputs',   color: 'bg-amber-500',  dot: 'bg-amber-500' },
  { key: 'thinkingText',    label: 'Thinking / text',color: 'bg-purple-500', dot: 'bg-purple-500' },
  { key: 'taskCoordination',label: 'Coordination',   color: 'bg-cyan-500',   dot: 'bg-cyan-500' },
  { key: 'userMessages',    label: 'User',           color: 'bg-gray-500',   dot: 'bg-gray-500' },
];

function TokenAttributionSidebar({ attribution, activeCategory, onCategoryClick, collapsed, onToggle }) {
  const total = Object.values(attribution).reduce((a, b) => a + b, 0);

  return (
    <div className={`border-l border-gray-800 bg-gray-950 flex-shrink-0 flex flex-col transition-[width] duration-200 ${collapsed ? 'w-8' : 'w-52'}`}>
      {/* Toggle button */}
      <button
        onClick={onToggle}
        className="flex-shrink-0 w-full h-8 flex items-center justify-center text-gray-600 hover:text-gray-400 border-b border-gray-800/60 text-xs"
        title={collapsed ? 'Expand token attribution' : 'Collapse'}
      >
        {collapsed ? '◂' : '▸'}
      </button>

      {!collapsed && (
        <div className="flex-1 overflow-y-auto p-3">
          <div className="text-xs text-gray-600 mb-3 font-medium uppercase tracking-wide">
            Token attribution
          </div>

          {/* Stacked horizontal bar */}
          <div className="flex h-4 rounded overflow-hidden mb-3 gap-px">
            {ATTRIBUTION_CATEGORIES.map(cat => {
              const pct = total > 0 ? (attribution[cat.key] / total) * 100 : 0;
              if (pct < 1) return null;
              return (
                <div
                  key={cat.key}
                  className={`${cat.color} cursor-pointer opacity-80 hover:opacity-100 transition-opacity ${activeCategory === cat.key ? 'ring-1 ring-white ring-inset' : ''}`}
                  style={{ width: `${pct}%` }}
                  onClick={() => onCategoryClick(cat.key)}
                  title={`${cat.label}: ${pct.toFixed(1)}% (${fmtTokens(attribution[cat.key])} tokens)`}
                />
              );
            })}
          </div>

          {/* Legend rows */}
          {ATTRIBUTION_CATEGORIES.map(cat => {
            const pct = total > 0 ? (attribution[cat.key] / total) * 100 : 0;
            if (pct < 0.5) return null;
            const isActive = activeCategory === cat.key;
            return (
              <button
                key={cat.key}
                onClick={() => onCategoryClick(cat.key)}
                className={`w-full flex items-center gap-2 py-1 px-1.5 rounded text-left transition-colors ${
                  isActive
                    ? 'bg-gray-800 text-gray-200'
                    : 'text-gray-500 hover:bg-gray-900 hover:text-gray-300'
                }`}
              >
                <div className={`w-2 h-2 rounded-sm flex-shrink-0 ${cat.dot} ${isActive ? 'opacity-100' : 'opacity-60'}`} />
                <span className="text-xs flex-1 leading-tight">{cat.label}</span>
                <span className="text-xs font-mono text-gray-600">{pct.toFixed(0)}%</span>
              </button>
            );
          })}

          {activeCategory && (
            <button
              onClick={() => onCategoryClick(null)}
              className="w-full mt-2 text-xs text-gray-600 hover:text-gray-400 text-center py-1"
            >
              clear filter
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Main TranscriptViewer ────────────────────────────────────────────────────

export default function TranscriptViewer({ transcriptPath, targetUuid, initialHighlight = '', onClose }) {
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState(initialHighlight);
  const [showAllTypes, setShowAllTypes] = useState(false);
  // Enrichment state (null = no devtools data / not yet loaded)
  const [enriched, setEnriched] = useState(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [activeCategory, setActiveCategory] = useState(null);
  const containerRef = useRef(null);

  useEffect(() => {
    if (!transcriptPath) return;
    setLoading(true);
    setError(null);
    setEnriched(null);
    setActiveCategory(null);

    // Fetch transcript and enrichment data in parallel.
    // Enrichment failures are silent — TranscriptViewer works without it.
    const transcriptReq = fetch(`/api/transcript?path=${encodeURIComponent(transcriptPath)}`)
      .then(r => {
        if (!r.ok) throw new Error(`${r.status}`);
        return r.json();
      });

    const analysisReq = fetch(`/api/transcript/analysis?path=${encodeURIComponent(transcriptPath)}`)
      .then(r => r.ok ? r.json() : null)
      .catch(() => null);

    Promise.all([transcriptReq, analysisReq])
      .then(([data, analysis]) => {
        setMessages(data.messages);
        if (analysis?.summary) setEnriched(analysis);
        setLoading(false);

        // Scroll to target: by UUID, or by first highlight match
        setTimeout(() => {
          if (targetUuid) {
            const el = document.getElementById(targetUuid);
            if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
          } else if (initialHighlight) {
            const match = data.messages.find(m =>
              m.content.toLowerCase().includes(initialHighlight.toLowerCase())
            );
            if (match) {
              const el = document.getElementById(match.uuid);
              if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
          }
        }, 100);
      })
      .catch(e => {
        setError(e.message);
        setLoading(false);
      });
  }, [transcriptPath, targetUuid]);

  // Split search into terms, filter out noise (< 3 chars)
  const searchTerms = useMemo(() =>
    search.trim()
      ? search.trim().split(/\s+/).filter(t => t.length >= 3)
      : [],
    [search]
  );

  // Map compaction UUID → event data for banner rendering
  const compactionMap = useMemo(() => {
    if (!enriched?.compactionEvents?.length) return {};
    return Object.fromEntries(enriched.compactionEvents.map(e => [e.uuid, e]));
  }, [enriched]);

  const filtered = useMemo(() => {
    let msgs = messages;
    if (!showAllTypes) {
      msgs = msgs.filter(m => m.role === 'user' || m.role === 'assistant');
    }
    // Sidebar category filter: show only turns dominated by the selected category
    if (activeCategory && enriched?.perMessageCategory) {
      msgs = msgs.filter(m => enriched.perMessageCategory[m.uuid] === activeCategory);
    }
    return msgs;
  }, [messages, showAllTypes, activeCategory, enriched]);

  const matchCount = useMemo(() => {
    if (searchTerms.length === 0) return 0;
    return filtered.filter(m =>
      searchTerms.some(t => m.content.toLowerCase().includes(t.toLowerCase()))
    ).length;
  }, [filtered, searchTerms]);

  function handleCategoryClick(cat) {
    setActiveCategory(prev => prev === cat ? null : cat);
  }

  if (loading) {
    return <div className="p-8 text-gray-500">Loading transcript...</div>;
  }

  if (error) {
    const friendly = error.includes('404') ? 'Transcript not found — the file may have been deleted or the path is stale.'
      : error.includes('403') ? 'Access denied — transcript is outside the allowed directory.'
      : `Could not load transcript (${error})`;
    return (
      <div className="p-8">
        <div className="text-red-400 text-sm mb-2">{friendly}</div>
        <div className="text-xs text-gray-600 font-mono mb-3">{transcriptPath}</div>
        <button onClick={onClose} className="text-xs text-gray-400 hover:text-gray-200 underline">back to results</button>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-2 border-b border-gray-800 flex-shrink-0">
        <button
          onClick={onClose}
          className="text-xs text-gray-500 hover:text-gray-300 mr-2"
        >
          back
        </button>

        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search in transcript..."
          className="flex-1 bg-gray-900 border border-gray-700 rounded px-2 py-1 text-xs text-gray-200 placeholder-gray-500 focus:outline-none focus:border-gray-500"
        />

        {searchTerms.length > 0 && (
          <span className="text-xs text-gray-500 font-mono">
            {matchCount} match{matchCount !== 1 ? 'es' : ''}
          </span>
        )}

        <label className="flex items-center gap-1 text-xs text-gray-500 cursor-pointer">
          <input
            type="checkbox"
            checked={showAllTypes}
            onChange={(e) => setShowAllTypes(e.target.checked)}
            className="rounded bg-gray-800 border-gray-600"
          />
          system
        </label>

        <span className="text-xs text-gray-600 font-mono">
          {filtered.length} messages
        </span>
      </div>

      {/* Transcript path */}
      <div className="px-4 py-1 text-xs text-gray-600 font-mono border-b border-gray-800/50 flex-shrink-0">
        {transcriptPath}
      </div>

      {/* Body: main content + optional attribution sidebar */}
      <div className="flex flex-1 min-h-0">
        {/* Main column */}
        <div className="flex flex-col flex-1 min-h-0">
          {/* 1c. Session summary header */}
          {enriched?.summary && (
            <SessionSummaryCard summary={enriched.summary} />
          )}

          {/* Messages */}
          <div ref={containerRef} className="flex-1 overflow-y-auto px-4 py-2">
            {filtered.map((msg, i) => (
              <Fragment key={msg.uuid || i}>
                {/* 1b. Compaction banner — rendered before the compaction summary message */}
                {compactionMap[msg.uuid] && (
                  <CompactionBanner
                    preTokens={compactionMap[msg.uuid].preTokens}
                    postTokens={compactionMap[msg.uuid].postTokens}
                  />
                )}
                <MessageBlock
                  msg={msg}
                  searchTerms={searchTerms}
                  defaultExpanded={msg.uuid === targetUuid}
                />
              </Fragment>
            ))}
          </div>
        </div>

        {/* 1a. Token attribution sidebar (only when enriched data is available) */}
        {enriched?.attribution && (
          <TokenAttributionSidebar
            attribution={enriched.attribution}
            activeCategory={activeCategory}
            onCategoryClick={handleCategoryClick}
            collapsed={sidebarCollapsed}
            onToggle={() => setSidebarCollapsed(s => !s)}
          />
        )}
      </div>
    </div>
  );
}
