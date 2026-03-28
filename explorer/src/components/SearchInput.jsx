import { useState, useRef, useEffect, useCallback } from 'react';
import { autocomplete, coterms } from '../api';

export default function SearchInput({ value, onChange }) {
  const [suggestions, setSuggestions] = useState([]);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [related, setRelated] = useState([]); // second-level co-occurring terms
  const [relatedFor, setRelatedFor] = useState(null); // which term the related list is for
  const [relatedIndex, setRelatedIndex] = useState(-1); // focus index in flyout
  const [inFlyout, setInFlyout] = useState(false); // keyboard focus is in flyout
  const inputRef = useRef(null);
  const listRef = useRef(null);
  const subRef = useRef(null);
  const timerRef = useRef(null);
  const hoverTimerRef = useRef(null);

  // Fetch suggestions for the last word being typed
  const fetchSuggestions = useCallback((text) => {
    if (timerRef.current) clearTimeout(timerRef.current);

    const words = text.split(/\s+/);
    const lastWord = words[words.length - 1] || '';

    if (lastWord.length < 2) {
      setSuggestions([]);
      setOpen(false);
      return;
    }

    timerRef.current = setTimeout(async () => {
      try {
        const data = await autocomplete(lastWord);
        if (data.suggestions.length > 0) {
          setSuggestions(data.suggestions);
          setOpen(true);
          setActiveIndex(-1);
        } else {
          setSuggestions([]);
          setOpen(false);
        }
      } catch {
        setSuggestions([]);
        setOpen(false);
      }
    }, 150);
  }, []);

  // Append a term to the search (for second-level picks)
  const appendTerm = useCallback((term) => {
    const newValue = value.trimEnd() + ' ' + term + ' ';
    onChange(newValue);
    setRelated([]);
    setRelatedFor(null);
    setInFlyout(false);
    setRelatedIndex(-1);
    inputRef.current?.focus();
  }, [value, onChange]);

  const applySuggestion = useCallback((term) => {
    const words = value.split(/\s+/);
    words[words.length - 1] = term;
    const newValue = words.join(' ') + ' ';
    onChange(newValue);
    setSuggestions([]);
    setOpen(false);
    setActiveIndex(-1);
    setRelated([]);
    setRelatedFor(null);
    setInFlyout(false);
    setRelatedIndex(-1);
    inputRef.current?.focus();
  }, [value, onChange]);

  const handleChange = useCallback((e) => {
    const text = e.target.value;
    onChange(text);
    fetchSuggestions(text);
    setRelated([]);
    setRelatedFor(null);
  }, [onChange, fetchSuggestions]);

  // Fetch co-occurring terms for a suggestion
  const fetchRelated = useCallback(async (term) => {
    try {
      const data = await coterms(term);
      if (data.terms.length > 0) {
        setRelated(data.terms);
        setRelatedFor(term);
      } else {
        setRelated([]);
        setRelatedFor(null);
      }
    } catch {
      setRelated([]);
      setRelatedFor(null);
    }
  }, []);

  // Hover on a suggestion → fetch co-occurring terms after 500ms
  const handleItemEnter = useCallback((i, term) => {
    setActiveIndex(i);
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = setTimeout(() => fetchRelated(term), 500);
  }, [fetchRelated]);

  const handleItemLeave = useCallback(() => {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
  }, []);

  const handleKeyDown = useCallback((e) => {
    if (!open || suggestions.length === 0) return;

    // Flyout navigation
    if (inFlyout && related.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setRelatedIndex(i => (i + 1) % related.length);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setRelatedIndex(i => (i <= 0 ? related.length - 1 : i - 1));
      } else if (e.key === 'ArrowLeft' || e.key === 'Escape') {
        e.preventDefault();
        setInFlyout(false);
        setRelatedIndex(-1);
      } else if ((e.key === 'Enter' || e.key === 'Tab') && relatedIndex >= 0) {
        e.preventDefault();
        appendTerm(related[relatedIndex]);
        setInFlyout(false);
        setRelatedIndex(-1);
      }
      return;
    }

    // Main list navigation
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex(i => (i + 1) % suggestions.length);
      setRelated([]);
      setRelatedFor(null);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex(i => (i <= 0 ? suggestions.length - 1 : i - 1));
      setRelated([]);
      setRelatedFor(null);
    } else if (e.key === 'ArrowRight' && activeIndex >= 0) {
      e.preventDefault();
      if (related.length > 0 && relatedFor === suggestions[activeIndex]) {
        // Already fetched — move focus into flyout
        setInFlyout(true);
        setRelatedIndex(0);
      } else {
        // Fetch then move focus
        fetchRelated(suggestions[activeIndex]).then(() => {
          setInFlyout(true);
          setRelatedIndex(0);
        });
      }
    } else if (e.key === 'ArrowLeft') {
      setRelated([]);
      setRelatedFor(null);
    } else if (e.key === 'Tab' || e.key === 'Enter') {
      if (activeIndex >= 0) {
        e.preventDefault();
        applySuggestion(suggestions[activeIndex]);
      } else if (e.key === 'Tab' && suggestions.length > 0) {
        e.preventDefault();
        applySuggestion(suggestions[0]);
      }
    } else if (e.key === 'Escape') {
      setOpen(false);
      setActiveIndex(-1);
      setRelated([]);
      setRelatedFor(null);
      setInFlyout(false);
      setRelatedIndex(-1);
    }
  }, [open, suggestions, activeIndex, applySuggestion, appendTerm, inFlyout, related, relatedIndex, relatedFor, fetchRelated]);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClick = (e) => {
      if (!inputRef.current?.contains(e.target) &&
          !listRef.current?.contains(e.target) &&
          !subRef.current?.contains(e.target)) {
        setOpen(false);
        setRelated([]);
        setRelatedFor(null);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  // Highlight the matching prefix in each suggestion
  const lastWord = (value.split(/\s+/).pop() || '').toLowerCase();

  // Compute flyout position when related terms are showing
  const [flyoutPos, setFlyoutPos] = useState(null);
  useEffect(() => {
    if (related.length > 0 && relatedFor && listRef.current && activeIndex >= 0) {
      const el = listRef.current.children[activeIndex];
      const listRect = listRef.current.getBoundingClientRect();
      if (el) {
        const rect = el.getBoundingClientRect();
        setFlyoutPos({ left: listRect.right + 4, top: rect.top });
      }
    } else {
      setFlyoutPos(null);
    }
  }, [related, relatedFor, activeIndex]);

  return (
    <div className="relative flex-1">
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        onFocus={() => { if (suggestions.length > 0) setOpen(true); }}
        placeholder="Search session history..."
        className="w-full bg-gray-900 border border-gray-700 rounded px-3 py-1.5 text-base text-gray-200 placeholder-gray-500 focus:outline-none focus:border-gray-500"
        autoFocus
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
        aria-controls="search-suggestions"
        aria-activedescendant={activeIndex >= 0 ? `suggestion-${activeIndex}` : undefined}
      />
      {open && suggestions.length > 0 && (
        <ul
          ref={listRef}
          id="search-suggestions"
          role="listbox"
          className="absolute z-50 top-full left-0 mt-1 bg-gray-800 border border-gray-700 rounded shadow-lg max-h-60 overflow-y-auto w-fit min-w-48"
        >
          {suggestions.map((term, i) => {
            // Fisheye: scale font size by distance from active item
            const focus = activeIndex >= 0 ? activeIndex : 0;
            const dist = Math.abs(i - focus);
            const scale = Math.max(0.75, 1 - dist * 0.08); // 1.0 at focus, tapering to 0.75
            const fontSize = Math.round(35 * scale);
            const py = scale > 0.9 ? 6 : scale > 0.8 ? 4 : 2;

            return (
              <li
                key={term}
                id={`suggestion-${i}`}
                role="option"
                aria-selected={i === activeIndex}
                className={`px-3 cursor-pointer font-mono transition-all duration-100 ${
                  i === activeIndex
                    ? 'bg-gray-700 text-gray-100'
                    : 'text-gray-300 hover:bg-gray-750 hover:text-gray-100'
                }`}
                style={{ fontSize: `${fontSize}px`, padding: `${py}px 12px` }}
                onMouseDown={(e) => { e.preventDefault(); applySuggestion(term); }}
                onMouseEnter={() => handleItemEnter(i, term)}
                onMouseLeave={handleItemLeave}
              >
                <span className="text-gray-200">{term.slice(0, lastWord.length)}</span>
                <span className="text-gray-500">{term.slice(lastWord.length)}</span>
                {relatedFor === term && related.length > 0 && (
                  <span className="text-gray-600 ml-2 text-xs">{'›'}</span>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {/* Second-level: co-occurring terms panel */}
      {related.length > 0 && relatedFor && flyoutPos && (
        <div
          ref={subRef}
          className="fixed z-50 bg-gray-800 border border-gray-700 rounded shadow-lg w-fit min-w-32"
          style={{
            left: `${flyoutPos.left}px`,
            top: `${flyoutPos.top}px`,
          }}
        >
          <div className="text-[10px] text-gray-500 px-2 pt-1.5 pb-0.5 font-mono">
            with "{relatedFor}"
          </div>
          {related.map((term, i) => {
            const focus = inFlyout && relatedIndex >= 0 ? relatedIndex : 0;
            const dist = Math.abs(i - focus);
            const scale = Math.max(0.75, 1 - dist * 0.1);
            const fontSize = Math.round(32 * scale);
            const py = scale > 0.9 ? 5 : scale > 0.8 ? 3 : 2;

            return (
              <div
                key={term}
                className={`font-mono cursor-pointer transition-all duration-100 ${
                  inFlyout && i === relatedIndex
                    ? 'bg-gray-700 text-gray-200'
                    : 'text-gray-400 hover:bg-gray-700 hover:text-gray-200'
                }`}
                style={{ fontSize: `${fontSize}px`, padding: `${py}px 8px` }}
                onMouseDown={(e) => { e.preventDefault(); appendTerm(term); }}
                onMouseEnter={() => { setInFlyout(true); setRelatedIndex(i); }}
              >
                + {term}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
