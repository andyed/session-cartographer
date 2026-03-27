import { useState, useEffect } from 'react';
import { useSearch } from '../hooks/useSearch';
import { fetchProjects } from '../api';
import EventCard from './EventCard';

export default function Search({ initialQuery = '' }) {
  const [query, setQuery] = useState(initialQuery);
  const [project, setProject] = useState('');
  const [projects, setProjects] = useState([]);
  const { results, loading, search } = useSearch();

  // Load project list
  useEffect(() => {
    fetchProjects().then(setProjects);
  }, []);

  // Trigger search on query/project change
  useEffect(() => {
    search(query, { project });
  }, [query, project, search]);

  return (
    <div className="p-4">
      <div className="flex gap-2 mb-4">
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

      {loading && <div className="text-gray-500 text-sm">Searching...</div>}

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
            results.results.map((event, i) => (
              <EventCard
                key={event.event_id || i}
                event={event}
                showScore
                showSource
              />
            ))
          )}
        </>
      )}
    </div>
  );
}
