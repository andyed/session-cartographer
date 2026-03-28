import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useSearch } from '../hooks/useSearch';
import EventCard from './EventCard';
import FacetBar from './FacetBar';

// Parse facet params from URL: fp=a,b&ft=c&fs=d → { projects: Set, types: Set, sources: Set }
function parseFacetsFromURL() {
  const params = new URLSearchParams(window.location.search);
  const parse = (key) => {
    const val = params.get(key);
    return val ? new Set(val.split(',').filter(Boolean)) : new Set();
  };
  return { projects: parse('fp'), types: parse('ft'), sources: parse('fs') };
}

export default function Search({ query = '', onOpenTranscript }) {
  const project = new URLSearchParams(window.location.search).get('project') || '';
  const [initialFacets] = useState(parseFacetsFromURL);
  const {
    results, loading, search,
    filteredResults, displayLimit, loadMore,
    facets, activeFacets, hasAnyFacet, toggleFacet, clearFacets,
  } = useSearch(initialFacets);
  const scrollRef = useRef(null);
  const [visibleIds, setVisibleIds] = useState(new Set());
  const cardRefs = useRef(new Map()); // event_id → DOM element
  const isFirstSearch = useRef(true);

  useEffect(() => {
    // Don't clear URL-restored facets on initial mount
    if (isFirstSearch.current) {
      isFirstSearch.current = false;
    } else {
      clearFacets();
    }
    search(query, { project });
  }, [query, project, search, clearFacets]);

  // Sync facets + query to URL
  useEffect(() => {
    const params = new URLSearchParams();
    if (query) params.set('q', query);
    if (project) params.set('project', project);
    if (activeFacets.projects.size > 0) params.set('fp', [...activeFacets.projects].join(','));
    if (activeFacets.types.size > 0) params.set('ft', [...activeFacets.types].join(','));
    if (activeFacets.sources.size > 0) params.set('fs', [...activeFacets.sources].join(','));
    const qs = params.toString();
    const url = qs ? `/?${qs}` : '/';
    window.history.replaceState({ tab: 'search' }, '', url);
  }, [query, project, activeFacets]);

  // Track visible cards via IntersectionObserver
  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;

    const observer = new IntersectionObserver(
      (entries) => {
        setVisibleIds(prev => {
          const next = new Set(prev);
          for (const entry of entries) {
            const id = entry.target.dataset.eventId;
            if (!id) continue;
            if (entry.isIntersecting) next.add(id);
            else next.delete(id);
          }
          return next;
        });
      },
      { root: container, threshold: 0.1 }
    );

    // Observe all card elements
    for (const el of cardRefs.current.values()) {
      if (el) observer.observe(el);
    }

    return () => observer.disconnect();
  }, [filteredResults, displayLimit]);

  const registerCard = useCallback((id, el) => {
    if (el) cardRefs.current.set(id, el);
    else cardRefs.current.delete(id);
  }, []);

  // Click a dot on the timeline → scroll to that card
  const scrollToEvent = useCallback((eventId) => {
    const el = cardRefs.current.get(eventId);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, []);

  const displayItems = filteredResults.slice(0, displayLimit);
  const hasMore = displayLimit < filteredResults.length;

  return (
    <div className="flex flex-col h-full">
      {/* Sticky facet bar + timeline */}
      {facets && (
        <FacetBar
          facets={facets}
          activeFacets={activeFacets}
          onToggle={toggleFacet}
          onClear={clearFacets}
          results={filteredResults}
          visibleIds={visibleIds}
          onDotClick={scrollToEvent}
        />
      )}

      {/* Scrollable results */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4">
        {loading && <div className="text-gray-500 text-sm py-2">Searching...</div>}

        {results && !loading && (
          <>
            <div className="text-xs text-gray-300 mb-3 mt-2 font-mono">
              {hasAnyFacet ? (
                <>{filteredResults.length} of {results.results.length} results</>
              ) : (
                <>{results.results.length} results</>
              )}
              {results.meta.semantic_count > 0 && (
                <> (keyword: {results.meta.keyword_count}, semantic: {results.meta.semantic_count})</>
              )}
              {' '}in {results.meta.duration_ms}ms
            </div>

            {displayItems.length === 0 ? (
              <div className="text-gray-500 text-center py-8">No results found.</div>
            ) : (
              <>
                <GroupedResults
                  results={displayItems}
                  onOpenTranscript={onOpenTranscript}
                  registerCard={registerCard}
                />

                {hasMore && (
                  <button
                    onClick={loadMore}
                    className="w-full py-2 mb-4 text-xs text-gray-400 hover:text-gray-200 border border-gray-700 hover:border-gray-500 rounded-lg transition-colors"
                  >
                    show more ({filteredResults.length - displayLimit} remaining)
                  </button>
                )}
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function GroupedResults({ results, onOpenTranscript, registerCard }) {
  const groups = useMemo(() => {
    const out = [];
    const seen = new Map();

    for (const event of results) {
      const text = (event.prompt || event.query || event.summary || event.display || event.url || '').slice(0, 120);
      if (!text) {
        out.push({ event, dupes: [] });
        continue;
      }

      if (seen.has(text)) {
        out[seen.get(text)].dupes.push(event);
      } else {
        seen.set(text, out.length);
        out.push({ event, dupes: [] });
      }
    }
    return out;
  }, [results]);

  return groups.map(({ event, dupes }, i) => (
    <div
      key={event.event_id || i}
      ref={(el) => registerCard(event.event_id, el)}
      data-event-id={event.event_id}
    >
      <EventCard
        event={event}
        showScore
        showSource
        onOpenTranscript={onOpenTranscript}
      />
      {dupes.length > 0 && (
        <DupeIndicator count={dupes.length} />
      )}
    </div>
  ));
}

function DupeIndicator({ count }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="ml-4 mb-2">
      <button
        onClick={() => setExpanded(!expanded)}
        className="text-xs text-gray-500 hover:text-gray-300"
      >
        +{count} similar {expanded ? '▾' : '▸'}
      </button>
    </div>
  );
}
