import { useState, useCallback, useEffect, useRef } from 'react';
import Timeline from './components/Timeline';
import Search from './components/Search';
import TranscriptViewer from './components/TranscriptViewer';

function parseURL() {
  const url = new URL(window.location.href);
  const urlQuery = url.searchParams.get('q') || '';
  const urlTranscript = url.searchParams.get('transcript') || '';
  const urlUuid = url.searchParams.get('uuid') || '';
  const urlHighlight = url.searchParams.get('highlight') || '';

  const sessionMatch = url.pathname.match(/^\/session\/(.+)/);
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
    window.history.pushState({ tab: t }, '', t === 'timeline' ? '/' : window.location.href);
  }, []);

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
      `/session/${encodeURIComponent(path)}${qs ? '?' + qs : ''}`
    );
  }, [tab]);

  const closeTranscript = useCallback(() => {
    window.history.back();
  }, []);

  return (
    <div className="h-screen flex flex-col">
      <header className="flex items-center gap-4 px-4 py-3 border-b border-gray-800">
        <h1 className="text-sm font-medium text-gray-300">Session Cartographer</h1>
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
      </header>

      <main className="flex-1 overflow-hidden relative">
        <div className={`absolute inset-0 ${tab === 'timeline' ? '' : 'hidden'}`}>
          <Timeline onOpenTranscript={openTranscript} />
        </div>
        <div className={`absolute inset-0 ${tab === 'search' ? '' : 'hidden'}`}>
          <Search initialQuery={initial.query} onOpenTranscript={openTranscript} />
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
