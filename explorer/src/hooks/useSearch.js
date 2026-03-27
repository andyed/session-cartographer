import { useState, useRef, useCallback } from 'react';
import { searchEvents } from '../api';

export function useSearch() {
  const [results, setResults] = useState(null);
  const [loading, setLoading] = useState(false);
  const timerRef = useRef(null);
  const firstCall = useRef(true);

  const search = useCallback((query, { project = '', limit = 15 } = {}) => {
    if (timerRef.current) clearTimeout(timerRef.current);

    if (!query.trim()) {
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

    // Fire immediately on first call (e.g. initialQuery from URL), debounce after
    if (firstCall.current) {
      firstCall.current = false;
      doSearch();
    } else {
      timerRef.current = setTimeout(doSearch, 300);
    }
  }, []);

  return { results, loading, search };
}
