import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useSearch } from '../hooks/useSearch';
import EventCard from './EventCard';
import FacetBar from './FacetBar';
import { groupSearchResults, visibleSearchMembers } from './search-results.js';
import { eventTranscriptHighlight } from './event-navigation.js';
import '../styles/search-review.css';

// Parse facet params from URL: fp=a,b&ft=c&fs=d → { projects: Set, types: Set, sources: Set }
function parseFacetsFromURL() {
  const params = new URLSearchParams(window.location.search);
  const parse = (key) => {
    const val = params.get(key);
    return val ? new Set(val.split(',').filter(Boolean)) : new Set();
  };
  return { projects: parse('fp'), types: parse('ft'), quadrants: parse('fq'), sources: parse('fs'), providers: parse('fa') };
}

export default function Search({ query = '', onOpenTranscript, isActive = true }) {
  const project = new URLSearchParams(window.location.search).get('project') || '';
  const [initialFacets] = useState(parseFacetsFromURL);
  const {
    results, loading, search,
    filteredResults, displayLimit, loadMore,
    facets, activeFacets, hasAnyFacet, toggleFacet, clearFacets,
  } = useSearch(initialFacets);
  const scrollRef = useRef(null);
  const [visibleIds, setVisibleIds] = useState(new Set());
  const [activeIdx, setActiveIdx] = useState(-1); // keyboard-selected result
  const cardRefs = useRef(new Map()); // event_id → DOM element
  const isFirstSearch = useRef(true);
  const [expandedGroups, setExpandedGroups] = useState(new Set());
  const [pendingScroll, setPendingScroll] = useState(null);
  const displayItems = useMemo(() => filteredResults.slice(0, displayLimit), [filteredResults, displayLimit]);
  const ranks = useMemo(() => new Map((results?.results || []).map((event, index) => [event, index + 1])), [results]);
  const grouped = useMemo(() => groupSearchResults(displayItems, ranks), [displayItems, ranks]);
  const members = useMemo(() => visibleSearchMembers(grouped, expandedGroups), [grouped, expandedGroups]);
  const hasMore = displayLimit < filteredResults.length;

  useEffect(() => {
    if (!isActive) return;
    // Don't clear URL-restored facets on initial mount
    if (isFirstSearch.current) {
      isFirstSearch.current = false;
    } else {
      clearFacets();
    }
    search(query, { project });
  }, [query, project, search, clearFacets, isActive]);

  // Sync facets + query to URL
  useEffect(() => {
    if (!isActive) return;
    const params = new URLSearchParams();
    if (query) params.set('q', query);
    if (project) params.set('project', project);
    if (activeFacets.projects.size > 0) params.set('fp', [...activeFacets.projects].join(','));
    if (activeFacets.types.size > 0) params.set('ft', [...activeFacets.types].join(','));
    if (activeFacets.quadrants.size > 0) params.set('fq', [...activeFacets.quadrants].join(','));
    if (activeFacets.providers.size > 0) params.set('fa', [...activeFacets.providers].join(','));
    if (activeFacets.sources.size > 0) params.set('fs', [...activeFacets.sources].join(','));
    const qs = params.toString();
    const base = import.meta.env.BASE_URL || '/';
    const url = qs ? `${base}?${qs}` : base;
    window.history.replaceState({ tab: 'search' }, '', url);
  }, [query, project, activeFacets, isActive]);

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
  }, [filteredResults, displayLimit, expandedGroups]);

  const registerCard = useCallback((id, el) => {
    if (el) cardRefs.current.set(id, el);
    else cardRefs.current.delete(id);
  }, []);

  // A timeline dot may address a member folded under an occurrence header.
  const scrollToEvent = useCallback(eventId => {
    const targetIndex = filteredResults.findIndex(event => event.event_id === eventId);
    if (targetIndex < 0) return;
    if (targetIndex >= displayLimit) loadMore();
    const group = grouped.find(group => group.members.some(member => member.event.event_id === eventId));
    if (group?.members.length > 1) setExpandedGroups(current => new Set([...current, group.key]));
    setPendingScroll(eventId);
  }, [filteredResults, grouped, displayLimit, loadMore]);
  useEffect(() => {
    if (!pendingScroll) return;
    const member = members.find(member => member.event.event_id === pendingScroll);
    if (!member) { scrollToEvent(pendingScroll); return; }
    const frame = requestAnimationFrame(() => { cardRefs.current.get(member.key)?.scrollIntoView({ behavior: 'smooth', block: 'center' }); setPendingScroll(null); });
    return () => cancelAnimationFrame(frame);
  }, [pendingScroll, members, scrollToEvent]);
  useEffect(() => { setActiveIdx(-1); setExpandedGroups(new Set()); }, [filteredResults]);
  const toggleGroup = key => {
    setExpandedGroups(current => { const next = new Set(current); next.has(key) ? next.delete(key) : next.add(key); return next; });
    setActiveIdx(-1);
  };

  // Keyboard navigation: ↓↑ to move, Enter to open, Escape to deselect
  useEffect(() => {
    if (!isActive) return;
    const handleKey = (e) => {
      // Don't capture if focus is in the search input or autocomplete
      const tag = document.activeElement?.tagName;
      const inInput = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || document.activeElement?.isContentEditable;
      const nativeAction = document.activeElement?.closest('a,button,summary');

      if (e.key === 'ArrowDown' && (!inInput || e.altKey)) {
        e.preventDefault();
        setActiveIdx(prev => {
          const next = Math.min(prev + 1, members.length - 1);
          // Scroll into view
          const eid = members[next]?.key;
          if (eid) {
            const el = cardRefs.current.get(eid);
            el?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
          }
          // Load more if near bottom
          if (next >= members.length - 3 && hasMore) loadMore();
          return next;
        });
      } else if (e.key === 'ArrowUp' && (!inInput || e.altKey)) {
        e.preventDefault();
        setActiveIdx(prev => {
          const next = Math.max(prev - 1, -1);
          if (next >= 0) {
            const eid = members[next]?.key;
            if (eid) {
              const el = cardRefs.current.get(eid);
              el?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            }
          }
          return next;
        });
      } else if (e.key === 'Enter' && activeIdx >= 0 && !inInput && !nativeAction) {
        e.preventDefault();
        const event = members[activeIdx]?.event;
        if (event?.transcript_path && onOpenTranscript) {
          onOpenTranscript(event.transcript_path, event.uuid, eventTranscriptHighlight(event), event.block_id || event.blockId);
        }
      } else if (e.key === 'Escape') {
        setActiveIdx(-1);
      }
    };

    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [members, activeIdx, hasMore, loadMore, onOpenTranscript, isActive]);

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
        {loading && <div className="text-muted text-sm py-2">Searching...</div>}

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
              {grouped.some(group => group.members.length > 1) && <span> · {grouped.length} text groups shown</span>}
            </div>

            {displayItems.length === 0 ? (
              <div className="text-muted text-center py-8">
                {results.meta?.demo_miss
                  ? 'This query isn\'t cached in the demo. Try one of the queries in the banner above.'
                  : 'No results found.'}
              </div>
            ) : (
              <>
                <GroupedResults
                  groups={grouped}
                  expanded={expandedGroups}
                  onToggle={toggleGroup}
                  onOpenTranscript={onOpenTranscript}
                  onProviderClick={(provider) => toggleFacet('providers', provider)}
                  registerCard={registerCard}
                  activeKey={activeIdx >= 0 ? members[activeIdx]?.key : null}
                />

                {hasMore && (
                  <button
                    onClick={loadMore}
                    className="w-full py-2 mb-4 text-xs text-muted hover:text-gray-200 border border-gray-700 hover:border-gray-500 rounded-lg transition-colors"
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

function GroupedResults({ groups, expanded, onToggle, onOpenTranscript, onProviderClick, registerCard, activeKey }) {
  const renderMember = (member, grouped = false) => <div key={member.key}
    ref={element => registerCard(member.key, element)} data-event-id={member.event.event_id} data-result-rank={member.rank}>
    {grouped && <p className="search-occurrence-context" data-copy-content>
      <span>Rank {member.rank}</span>
      <span title={member.event.session_id}>{member.event.session_title ? `${member.event.session_title}${member.event.session_id ? ' · ' + member.event.session_id.slice(0,8) : ''}` : member.event.session_id || 'Session not recorded'}</span>
      {member.event.timestamp && <time dateTime={member.event.timestamp}>{new Date(member.event.timestamp).toLocaleString()}</time>}
    </p>}
    <EventCard event={member.event} showScore showSource onOpenTranscript={onOpenTranscript}
      onProviderClick={onProviderClick} active={member.key === activeKey} />
  </div>;
  return <div className="result-list">{groups.map(group => <section key={group.key} className="search-result-group">
    {renderMember(group.members[0], group.members.length > 1)}
    {group.members.length > 1 && <>
      <button className="search-occurrences-toggle" aria-expanded={expanded.has(group.key)} onClick={() => onToggle(group.key)}>
        {expanded.has(group.key) ? 'Hide' : 'Show'} {group.members.length - 1} other {group.members.length === 2 ? 'occurrence' : 'occurrences'}
      </button>
      {expanded.has(group.key) && <div className="search-occurrences">{group.members.slice(1).map(member => renderMember(member, true))}</div>}
    </>}
  </section>)}</div>;
}
