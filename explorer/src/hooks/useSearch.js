import { useState, useRef, useCallback } from 'react';
import { searchEvents } from '../api';

export function useSearch() {
  const [results, setResults] = useState(null);
  const [loading, setLoading] = useState(false);
  const timerRef = useRef(null);

  const search = useCallback((query, { project = '', limit = 15 } = {}) => {
    if (timerRef.current) clearTimeout(timerRef.current);

    if (!query.trim()) {
      setResults(null);
      setLoading(false);
      return;
    }

    setLoading(true);
    timerRef.current = setTimeout(async () => {
      try {
        const data = await searchEvents(query, { project, limit });
        setResults(data);
      } catch {
        setResults(null);
      }
      setLoading(false);
    }, 300);
  }, []);

  return { results, loading, search };
}
