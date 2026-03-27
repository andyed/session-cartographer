import { useState } from 'react';
import Timeline from './components/Timeline';
import Search from './components/Search';

// Check URL for ?q= parameter (handoff from /explore command)
const urlQuery = new URLSearchParams(window.location.search).get('q') || '';
const initialTab = urlQuery ? 'search' : 'timeline';

export default function App() {
  const [tab, setTab] = useState(initialTab);

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
        </div>
      </header>

      <main className="flex-1 overflow-hidden">
        {tab === 'timeline' && <Timeline />}
        {tab === 'search' && <Search initialQuery={urlQuery} />}
      </main>
    </div>
  );
}
