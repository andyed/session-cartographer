import { useState, useCallback, useEffect } from 'react';
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

  return { tab, query: urlQuery, transcript: deepLinkTranscript, uuid: urlUuid };
}

const initial = parseURL();

export default function App() {
  const [tab, setTab] = useState(initial.tab);
  const [transcript, setTranscript] = useState({
    path: initial.transcript,
    uuid: initial.uuid,
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

  const openTranscript = useCallback((path, uuid) => {
    setTranscript({ path, uuid });
    setTab('transcript');
    window.history.pushState({}, '', `/session/${encodeURIComponent(path)}${uuid ? `?uuid=${uuid}` : ''}`);
  }, []);

  const closeTranscript = useCallback(() => {
    setTab('timeline');
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

      <main className="flex-1 overflow-hidden">
        {tab === 'timeline' && <Timeline onOpenTranscript={openTranscript} />}
        {tab === 'search' && <Search initialQuery={initial.query} onOpenTranscript={openTranscript} />}
        {tab === 'transcript' && (
          <TranscriptViewer
            transcriptPath={transcript.path}
            targetUuid={transcript.uuid}
            onClose={closeTranscript}
          />
        )}
      </main>
    </div>
  );
}
