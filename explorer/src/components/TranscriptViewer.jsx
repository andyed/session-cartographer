import { useState, useEffect, useMemo, useRef } from 'react';

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
  const pattern = searchTerms.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
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

      <pre className="text-sm text-gray-300 whitespace-pre-wrap break-words font-sans leading-relaxed">
        {searchTerms.length > 0
          ? highlightMatches(displayContent, searchTerms)
          : displayContent}
        {!expanded && isLong && (
          <span className="text-gray-500">...</span>
        )}
      </pre>

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

export default function TranscriptViewer({ transcriptPath, targetUuid, initialHighlight = '', onClose }) {
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState(initialHighlight);
  const [showAllTypes, setShowAllTypes] = useState(false);
  const containerRef = useRef(null);

  useEffect(() => {
    if (!transcriptPath) return;
    setLoading(true);
    setError(null);

    fetch(`/api/transcript?path=${encodeURIComponent(transcriptPath)}`)
      .then(r => {
        if (!r.ok) throw new Error(`${r.status}`);
        return r.json();
      })
      .then(data => {
        setMessages(data.messages);
        setLoading(false);

        // Scroll to target: by UUID, or by first highlight match
        setTimeout(() => {
          if (targetUuid) {
            const el = document.getElementById(targetUuid);
            if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
          } else if (initialHighlight) {
            // Find first message containing the highlight text and scroll to it
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

  const searchTerms = useMemo(() =>
    search.trim() ? search.trim().split(/\s+/) : [],
    [search]
  );

  const filtered = useMemo(() => {
    let msgs = messages;
    if (!showAllTypes) {
      msgs = msgs.filter(m => m.role === 'user' || m.role === 'assistant');
    }
    if (searchTerms.length > 0) {
      // Show all messages but highlight matches — don't filter out non-matches
      // so the conversation stays coherent
    }
    return msgs;
  }, [messages, showAllTypes, searchTerms]);

  const matchCount = useMemo(() => {
    if (searchTerms.length === 0) return 0;
    return filtered.filter(m =>
      searchTerms.some(t => m.content.toLowerCase().includes(t.toLowerCase()))
    ).length;
  }, [filtered, searchTerms]);

  if (loading) {
    return <div className="p-8 text-gray-500">Loading transcript...</div>;
  }

  if (error) {
    return (
      <div className="p-8">
        <div className="text-red-400 text-sm mb-2">Failed to load transcript: {error}</div>
        <button onClick={onClose} className="text-xs text-gray-500 hover:text-gray-300">back</button>
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

      {/* Messages */}
      <div ref={containerRef} className="flex-1 overflow-y-auto px-4 py-2">
        {filtered.map((msg, i) => (
          <MessageBlock
            key={msg.uuid || i}
            msg={msg}
            searchTerms={searchTerms}
            defaultExpanded={msg.uuid === targetUuid}
          />
        ))}
      </div>
    </div>
  );
}
