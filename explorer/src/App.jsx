import { useState, useCallback, useEffect, useRef } from 'react';
import Timeline from './components/Timeline';
import Search from './components/Search';
import SearchInput from './components/SearchInput';
import TranscriptViewer from './components/TranscriptViewer';
import { isDemoMode, getDemoQueries } from './api';

const BASE = import.meta.env.BASE_URL || '/';

function parseURL() {
  const url = new URL(window.location.href);
  const urlQuery = url.searchParams.get('q') || '';
  const urlTranscript = url.searchParams.get('transcript') || '';
  const urlUuid = url.searchParams.get('uuid') || '';
  const urlHighlight = url.searchParams.get('highlight') || '';

  const base = (import.meta.env.BASE_URL || '/').replace(/\/$/, '');
  const sessionMatch = url.pathname.match(new RegExp(`^${base}/session/(.+)`));
  const deepLinkTranscript = sessionMatch
    ? decodeURIComponent(sessionMatch[1])
    : urlTranscript;

  const urlProject = url.searchParams.get('project') || '';

  const tab = deepLinkTranscript ? 'transcript'
    : (urlQuery || urlProject) ? 'search'
    : 'timeline';

  return { tab, query: urlQuery, transcript: deepLinkTranscript, uuid: urlUuid, highlight: urlHighlight };
}

const initial = parseURL();

export default function App() {
  const [tab, setTab] = useState(initial.tab);
  const [searchQuery, setSearchQuery] = useState(initial.query);
  const [demoQueries, setDemoQueries] = useState([]);

  useEffect(() => {
    if (isDemoMode) getDemoQueries().then(q => setDemoQueries(q || []));
  }, []);
  const [transcript, setTranscript] = useState({
    path: initial.transcript,
    uuid: initial.uuid,
    highlight: initial.highlight,
  });

  // Browser back/forward — use state object to know which tab to restore
  useEffect(() => {
    // Replace initial entry with state
    window.history.replaceState({ tab: initial.tab }, '');

    const onPopState = (e) => {
      if (e.state?.tab) {
        setTab(e.state.tab);
        if (e.state.tab === 'transcript' && e.state.transcript) {
          setTranscript(e.state.transcript);
        } else {
          setTranscript({ path: '', uuid: '', highlight: '' });
        }
      } else {
        // Fallback: parse URL
        const state = parseURL();
        setTab(state.tab);
        setTranscript({ path: state.transcript, uuid: state.uuid, highlight: state.highlight });
      }
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  const handleTabClick = useCallback((t) => {
    setTab(t);
    window.history.pushState({ tab: t }, '', t === 'timeline' ? BASE : window.location.href);
  }, []);

  // When typing in search, auto-switch to search tab
  const handleSearchInput = useCallback((value) => {
    setSearchQuery(value);
    if (value.trim() && tab !== 'search') {
      setTab('search');
    }
  }, [tab]);

  const openTranscript = useCallback((path, uuid, highlight = '') => {
    // Push current tab state first so back returns here
    window.history.pushState({ tab }, '', window.location.href);
    // Then push transcript
    const transcriptState = { path, uuid, highlight };
    setTranscript(transcriptState);
    setTab('transcript');
    const params = new URLSearchParams();
    if (uuid) params.set('uuid', uuid);
    if (highlight) params.set('highlight', highlight);
    const qs = params.toString();
    window.history.pushState(
      { tab: 'transcript', transcript: transcriptState },
      '',
      `${BASE}session/${encodeURIComponent(path)}${qs ? '?' + qs : ''}`
    );
  }, [tab]);

  const closeTranscript = useCallback(() => {
    window.history.back();
  }, []);

  return (
    <div className="h-screen flex flex-col">
      {isDemoMode && (
        <div className="bg-indigo-900/50 border-b border-indigo-700 px-4 py-1.5 text-xs text-indigo-200 flex items-center gap-3">
          <span>Live demo — test set from building Session Cartographer with Claude Code.</span>
          <a href="https://github.com/andyed/session-cartographer" className="underline hover:text-white" target="_blank" rel="noopener">GitHub</a>
          {demoQueries.length > 0 && (
            <>
              <span className="text-indigo-500 ml-2">Try:</span>
              {demoQueries.map(q => (
                <button
                  key={q.id}
                  onClick={() => { handleSearchInput(q.query); }}
                  className="px-2 py-0.5 rounded bg-indigo-800/60 hover:bg-indigo-700 text-indigo-100"
                >
                  {q.query}
                </button>
              ))}
            </>
          )}
        </div>
      )}
      <header className="flex flex-col border-b border-gray-800 flex-shrink-0">
        <div className="flex items-center gap-3 px-4 py-2">
          {/* Search input with autocomplete — flush left */}
          <SearchInput value={searchQuery} onChange={handleSearchInput} />

          {/* Nav — flush right */}
          <div className="flex items-center gap-3 flex-shrink-0">
            <div className="flex gap-1">
              {['timeline', 'search'].map(t => (
                <button
                  key={t}
                  onClick={() => handleTabClick(t)}
                  className={`px-3 py-1 text-xs rounded ${
                    tab === t
                      ? 'bg-gray-700 text-gray-200'
                      : 'text-gray-500 hover:text-gray-300'
                  }`}
                >
                  {t}
                </button>
              ))}
              {tab === 'transcript' && (
                <span className="px-3 py-1 text-xs rounded bg-gray-700 text-gray-200">
                  transcript
                </span>
              )}
            </div>
            <span className="text-xs text-gray-600 font-mono">SC</span>
          </div>
        </div>
        {isDemoMode && !searchQuery && tab !== 'transcript' && (
          <div className="flex items-center gap-2 px-4 pb-2 flex-wrap">
            <span className="text-[10px] text-gray-600 uppercase tracking-wider">Try:</span>
            {[
              'diff shape',
              'facets',
              'concurrent timeline',
              'fisheye autocomplete',
            ].map(q => (
              <button
                key={q}
                onClick={() => handleSearchInput(q)}
                className="px-2 py-0.5 text-[11px] rounded bg-gray-800/80 border border-gray-700/50 text-gray-400 hover:text-gray-200 hover:bg-gray-700 transition-colors"
              >
                {q}
              </button>
            ))}
          </div>
        )}
      </header>

      <main className="flex-1 overflow-hidden relative">
        <div className={`absolute inset-0 ${tab === 'timeline' ? '' : 'hidden'}`}>
          <Timeline onOpenTranscript={openTranscript} isActive={tab === 'timeline'} />
        </div>
        <div className={`absolute inset-0 ${tab === 'search' ? '' : 'hidden'}`}>
          <Search query={searchQuery} onOpenTranscript={openTranscript} />
        </div>
        {tab === 'transcript' && (
          <TranscriptViewer
            transcriptPath={transcript.path}
            targetUuid={transcript.uuid}
            initialHighlight={transcript.highlight}
            onClose={closeTranscript}
          />
        )}
      </main>
    </div>
  );
}
