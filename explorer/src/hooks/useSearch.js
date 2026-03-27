import { useState, useRef, useCallback } from 'react';
import { searchEvents } from '../api';

export function useSearch() {
  const [results, setResults] = useState(null);
  const [loading, setLoading] = useState(false);
  const timerRef = useRef(null);

  const search = useCallback((query, { project = '', limit = 15 } = {}) => {
    if (timerRef.current) clearTimeout(timerRef.current);

    // Need at least a query or a project filter
    if (!query.trim() && !project) {
      setResults(null);
      setLoading(false);
      return;
    }

    setLoading(true);

    const doSearch = async () => {
      try {
        const data = await searchEvents(query, { project, limit });
        setResults(data);
      } catch {
        setResults(null);
      }
      setLoading(false);
    };

    // Debounce typing, but fire immediately for project-only changes
    if (!query.trim()) {
      doSearch(); // project filter change — no debounce
    } else {
      timerRef.current = setTimeout(doSearch, 300);
    }
  }, []);

  return { results, loading, search };
}
