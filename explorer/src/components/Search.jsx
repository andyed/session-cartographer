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
  const [limit] = useState(15);
  const [offset, setOffset] = useState(0);
  const { results, loading, search } = useSearch();
  const bottomRef = useRef(null);

  useEffect(() => {
    fetchProjects().then(setProjects);
  }, []);

  useEffect(() => {
    // Only fire standard first-page load here. (Load more passes explicitly true flags)
    search(query, { project, limit, offset: 0, isLoadMore: false });
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

  // Reset offset when query/project changes
  useEffect(() => {
    setOffset(0);
  }, [query, project]);

  const loadMore = () => {
    const nextOffset = offset + limit;
    setOffset(nextOffset);
    search(query, { project, limit, offset: nextOffset, isLoadMore: true });
  };

  const hasMore = results && (offset + limit < (results.meta.fused_count || 0));

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
              {results.meta.total_matches} absolute matches
              {results.meta.semantic_count > 0 && (
                <> (keyword: {results.meta.keyword_count}, semantic pool: {results.meta.semantic_count})</>
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

    </div>
  );
}
