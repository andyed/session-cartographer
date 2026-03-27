import { useState, useCallback, useEffect, useRef } from 'react';
import Timeline from './components/Timeline';
import Search from './components/Search';
import TranscriptViewer from './components/TranscriptViewer';

function parseURL() {
  const url = new URL(window.location.href);
  const urlQuery = url.searchParams.get('q') || '';
  const urlTranscript = url.searchParams.get('transcript') || '';
  const urlUuid = url.searchParams.get('uuid') || '';

  const sessionMatch = url.pathname.match(/^\/session\/(.+)/);
  const deepLinkTranscript = sessionMatch
    ? decodeURIComponent(sessionMatch[1])
    : urlTranscript;

  const tab = deepLinkTranscript ? 'transcript'
    : urlQuery ? 'search'
    : 'timeline';

  const urlHighlight = url.searchParams.get('highlight') || '';
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

  // Browser back/forward
  useEffect(() => {
    const onPopState = () => {
      const state = parseURL();
      setTab(state.tab);
      setTranscript({ path: state.transcript, uuid: state.uuid });
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  const prevTab = useRef(tab);

  const openTranscript = useCallback((path, uuid, highlight = '') => {
    prevTab.current = tab;
    setTranscript({ path, uuid, highlight });
    setTab('transcript');
    const params = new URLSearchParams();
    if (uuid) params.set('uuid', uuid);
    if (highlight) params.set('highlight', highlight);
    const qs = params.toString();
    window.history.pushState({}, '', `/session/${encodeURIComponent(path)}${qs ? '?' + qs : ''}`);
  }, [tab]);

  const closeTranscript = useCallback(() => {
    setTab(prevTab.current === 'transcript' ? 'timeline' : prevTab.current);
    setTranscript({ path: '', uuid: '' });
    window.history.pushState({}, '', '/');
  }, []);

  return (
    <div className="h-screen flex flex-col">
      <header className="flex items-center gap-4 px-4 py-3 border-b border-gray-800">
        <h1 className="text-sm font-medium text-gray-300">Session Cartographer</h1>
        <div className="flex gap-1">
          {['timeline', 'search'].map(t => (
            <button
              key={t}
              onClick={() => setTab(t)}
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
        {/* Keep Search mounted but hidden so scroll position is preserved */}
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
