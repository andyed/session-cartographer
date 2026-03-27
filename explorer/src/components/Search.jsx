import { useState, useEffect, useRef } from 'react';
import { useSearch } from '../hooks/useSearch';
import { fetchProjects } from '../api';
import EventCard from './EventCard';

// Read initial state from URL
function parseSearchURL() {
  const params = new URLSearchParams(window.location.search);
  return {
    query: params.get('q') || '',
    project: params.get('project') || '',
  };
}

export default function Search({ initialQuery = '', onOpenTranscript }) {
  const urlState = parseSearchURL();
  const [query, setQuery] = useState(urlState.query || initialQuery);
  const [project, setProject] = useState(urlState.project);
  const [projects, setProjects] = useState([]);
  const [limit, setLimit] = useState(15);
  const { results, loading, search } = useSearch();
  const bottomRef = useRef(null);

  useEffect(() => {
    fetchProjects().then(setProjects);
  }, []);

  useEffect(() => {
    search(query, { project, limit });
  }, [query, project, limit, search]);

  // Sync URL as permalink when query/project changes
  useEffect(() => {
    const params = new URLSearchParams();
    if (query) params.set('q', query);
    if (project) params.set('project', project);
    const qs = params.toString();
    const url = qs ? `/?${qs}` : '/';
    window.history.replaceState({ tab: 'search' }, '', url);
  }, [query, project]);

  // Reset limit when query/project changes
  useEffect(() => {
    setLimit(15);
  }, [query, project]);

  const loadMore = () => setLimit(prev => prev + 10);

  const hasMore = results && results.meta.fused_count >= limit;

  return (
    <div className="flex flex-col h-full">
      {/* Top search bar */}
      <div className="flex gap-2 p-4 pb-2 flex-shrink-0">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search session history..."
          className="flex-1 bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 placeholder-gray-500 focus:outline-none focus:border-gray-500"
          autoFocus
        />
        <select
          value={project}
          onChange={(e) => setProject(e.target.value)}
          className="bg-gray-900 border border-gray-700 rounded-lg px-2 py-2 text-sm text-gray-400 focus:outline-none focus:border-gray-500"
        >
          <option value="">all projects</option>
          {projects.map(p => (
            <option key={p} value={p}>{p}</option>
          ))}
        </select>
      </div>

      {/* Results */}
      <div className="flex-1 overflow-y-auto px-4">
        {loading && <div className="text-gray-500 text-sm py-2">Searching...</div>}

        {results && !loading && (
          <>
            <div className="text-xs text-gray-500 mb-3 font-mono">
              {results.meta.fused_count} results
              {results.meta.semantic_count > 0 && (
                <> (keyword: {results.meta.keyword_count}, semantic: {results.meta.semantic_count})</>
              )}
              {' '}in {results.meta.duration_ms}ms
            </div>

            {results.results.length === 0 ? (
              <div className="text-gray-500 text-center py-8">No results found.</div>
            ) : (
              <>
                {results.results.map((event, i) => (
                  <EventCard
                    key={event.event_id || i}
                    event={event}
                    showScore
                    showSource
                    onOpenTranscript={onOpenTranscript}
                  />
                ))}

                {hasMore && (
                  <button
                    onClick={loadMore}
                    className="w-full py-2 mb-4 text-xs text-gray-400 hover:text-gray-200 border border-gray-700 hover:border-gray-500 rounded-lg transition-colors"
                  >
                    next 10
                  </button>
                )}
              </>
            )}
          </>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Bottom refinement bar — sticky at bottom */}
      {results && results.results.length > 0 && (
        <div className="flex gap-2 p-3 border-t border-gray-800 flex-shrink-0">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Refine search..."
            className="flex-1 bg-gray-900 border border-gray-700 rounded px-3 py-1.5 text-xs text-gray-200 placeholder-gray-500 focus:outline-none focus:border-gray-500"
          />
          <span className="text-xs text-gray-600 self-center font-mono whitespace-nowrap">
            {results.meta.fused_count} results
          </span>
        </div>
      )}
    </div>
  );
}
