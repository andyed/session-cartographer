import { useState, useRef, useCallback, useMemo } from 'react';
import { searchEvents } from '../api';

export function useSearch(initialFacets) {
  const [results, setResults] = useState(null);
  const [loading, setLoading] = useState(false);
  const [activeFacets, setActiveFacets] = useState(() => initialFacets || { projects: new Set(), types: new Set(), quadrants: new Set(), sources: new Set() });
  const [displayLimit, setDisplayLimit] = useState(15);
  const timerRef = useRef(null);

  const search = useCallback((query, { project = '' } = {}) => {
    if (timerRef.current) clearTimeout(timerRef.current);

    // Need at least a query or a project filter
    if (!query.trim() && !project) {
      setResults(null);
      setLoading(false);
      return;
    }

    setLoading(true);
    setDisplayLimit(15);

    const doSearch = async () => {
      try {
        const data = await searchEvents(query, { project, limit: 500, offset: 0 });
        setResults(data);
      } catch {
        setResults(null);
      }
      setLoading(false);
    };

    // Debounce typing, but fire immediately for project-only browse
    if (!query.trim()) {
      doSearch();
    } else {
      timerRef.current = setTimeout(doSearch, 300);
    }
  }, []);

  const toggleFacet = useCallback((dimension, value) => {
    setActiveFacets(prev => {
      const next = { ...prev, [dimension]: new Set(prev[dimension]) };
      if (next[dimension].has(value)) {
        next[dimension].delete(value);
      } else {
        next[dimension].add(value);
      }
      return next;
    });
    setDisplayLimit(15);
  }, []);

  const clearFacets = useCallback(() => {
    setActiveFacets({ projects: new Set(), types: new Set(), quadrants: new Set(), sources: new Set() });
    setDisplayLimit(15);
  }, []);

  // Client-side filtering over full result set
  const filteredResults = useMemo(() => {
    if (!results?.results) return [];
    let items = results.results;

    if (activeFacets.projects.size > 0) {
      items = items.filter(e => activeFacets.projects.has(e.project));
    }
    if (activeFacets.types.size > 0) {
      items = items.filter(e => activeFacets.types.has(e.type || e.milestone || ''));
    }
    if (activeFacets.quadrants.size > 0) {
      items = items.filter(e => activeFacets.quadrants.has(e.diff_shape?.quadrant || ''));
    }
    if (activeFacets.sources.size > 0) {
      items = items.filter(e => {
        const srcs = (e._sources || '').split('+');
        return srcs.some(s => activeFacets.sources.has(s));
      });
    }

    return items;
  }, [results, activeFacets]);

  const hasAnyFacet = activeFacets.projects.size > 0 || activeFacets.types.size > 0 || activeFacets.quadrants.size > 0 || activeFacets.sources.size > 0;

  // Recompute facet counts over filtered results when filters are active
  const liveFacets = useMemo(() => {
    const serverFacets = results?.facets;
    if (!serverFacets || !hasAnyFacet) return serverFacets || null;

    // Recount over filteredResults
    const projMap = new Map();
    const typeMap = new Map();
    const quadMap = new Map();
    const srcMap = new Map();
    for (const item of filteredResults) {
      if (item.project) projMap.set(item.project, (projMap.get(item.project) || 0) + 1);
      const type = item.type || item.milestone || '';
      if (type) typeMap.set(type, (typeMap.get(type) || 0) + 1);
      const quad = item.diff_shape?.quadrant;
      if (quad) quadMap.set(quad, (quadMap.get(quad) || 0) + 1);
      for (const s of (item._sources || '').split('+')) {
        if (s) srcMap.set(s, (srcMap.get(s) || 0) + 1);
      }
    }

    const recount = (serverList, liveMap) =>
      (serverList || []).map(({ name }) => ({ name, count: liveMap.get(name) || 0 }));

    return {
      ...serverFacets,
      projects: recount(serverFacets.projects, projMap),
      types: recount(serverFacets.types, typeMap),
      quadrants: recount(serverFacets.quadrants, quadMap),
      sources: recount(serverFacets.sources, srcMap),
    };
  }, [results, filteredResults, hasAnyFacet]);

  const loadMore = useCallback(() => {
    setDisplayLimit(prev => prev + 15);
  }, []);

  return {
    results,
    loading,
    search,
    filteredResults,
    displayLimit,
    loadMore,
    facets: liveFacets,
    activeFacets,
    hasAnyFacet,
    toggleFacet,
    clearFacets,
  };
}
