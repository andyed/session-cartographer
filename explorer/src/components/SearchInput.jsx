import { useState, useRef, useEffect, useCallback } from 'react';
import { autocomplete } from '../api';

export default function SearchInput({ value, onChange }) {
  const [suggestions, setSuggestions] = useState([]);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const inputRef = useRef(null);
  const listRef = useRef(null);
  const timerRef = useRef(null);

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

  const applySuggestion = useCallback((term) => {
    const words = value.split(/\s+/);
    words[words.length - 1] = term;
    const newValue = words.join(' ') + ' ';
    onChange(newValue);
    setSuggestions([]);
    setOpen(false);
    setActiveIndex(-1);
    inputRef.current?.focus();
  }, [value, onChange]);

  const handleChange = useCallback((e) => {
    const text = e.target.value;
    onChange(text);
    fetchSuggestions(text);
  }, [onChange, fetchSuggestions]);

  const handleKeyDown = useCallback((e) => {
    if (!open || suggestions.length === 0) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex(i => (i + 1) % suggestions.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex(i => (i <= 0 ? suggestions.length - 1 : i - 1));
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
    }
  }, [open, suggestions, activeIndex, applySuggestion]);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClick = (e) => {
      if (!inputRef.current?.contains(e.target) && !listRef.current?.contains(e.target)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  // Highlight the matching prefix in each suggestion
  const lastWord = (value.split(/\s+/).pop() || '').toLowerCase();

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
          className="absolute z-50 top-full left-0 right-0 mt-1 bg-gray-800 border border-gray-700 rounded shadow-lg max-h-60 overflow-y-auto"
        >
          {suggestions.map((term, i) => (
            <li
              key={term}
              id={`suggestion-${i}`}
              role="option"
              aria-selected={i === activeIndex}
              className={`px-3 py-1.5 cursor-pointer text-sm font-mono ${
                i === activeIndex
                  ? 'bg-gray-700 text-gray-100'
                  : 'text-gray-300 hover:bg-gray-750 hover:text-gray-100'
              }`}
              onMouseDown={(e) => { e.preventDefault(); applySuggestion(term); }}
              onMouseEnter={() => setActiveIndex(i)}
            >
              <span className="text-gray-500">{term.slice(0, lastWord.length)}</span>
              <span>{term.slice(lastWord.length)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
