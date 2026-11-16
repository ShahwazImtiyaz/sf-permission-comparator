import { useState, useEffect, useRef } from 'react';
import { searchUsers } from '../lib/salesforce';

function Highlighted({ text, query }) {
  if (!query) return text;
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return text;
  return (
    <>
      {text.slice(0, idx)}
      <mark className="highlight-match">{text.slice(idx, idx + query.length)}</mark>
      {text.slice(idx + query.length)}
    </>
  );
}

export default function UserPicker({ selected, onSelect, placeholder, slot = 0 }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [searchError, setSearchError] = useState(null);
  const [activeIndex, setActiveIndex] = useState(-1);
  const timerRef = useRef(null);
  const abortRef = useRef(null);
  const wrapRef = useRef(null);
  const inputRef = useRef(null);
  const listRef = useRef(null);

  useEffect(() => {
    function handleClick(e) {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  useEffect(() => {
    if (query.trim().length < 2) {
      abortRef.current?.abort();
      setResults([]);
      setOpen(false);
      setSearchError(null);
      setActiveIndex(-1);
      setLoading(false);
      return;
    }
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(async () => {
      // Cancel any previous in-flight search immediately
      abortRef.current?.abort();
      abortRef.current = new AbortController();
      const { signal } = abortRef.current;

      setLoading(true);
      setSearchError(null);
      setActiveIndex(-1);
      try {
        const data = await searchUsers(query, signal);
        setResults(data);
        setOpen(true);
      } catch (e) {
        if (e.name === 'AbortError') return;
        setSearchError(e.message);
        setResults([]);
        setOpen(true);
      } finally {
        if (!signal.aborted) setLoading(false);
      }
    }, 400);
    return () => clearTimeout(timerRef.current);
  }, [query]);

  // scroll active item into view
  useEffect(() => {
    if (activeIndex >= 0 && listRef.current) {
      const items = listRef.current.querySelectorAll('li');
      items[activeIndex]?.scrollIntoView({ block: 'nearest' });
    }
  }, [activeIndex]);

  function select(user) {
    onSelect(user);
    setQuery('');
    setResults([]);
    setOpen(false);
    setSearchError(null);
    setActiveIndex(-1);
  }

  function clear() {
    onSelect(null);
    setQuery('');
    setResults([]);
    setSearchError(null);
    setActiveIndex(-1);
    setTimeout(() => inputRef.current?.focus(), 0);
  }

  function handleKeyDown(e) {
    if (!open) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex(i => Math.min(i + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex(i => Math.max(i - 1, -1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (activeIndex >= 0 && results[activeIndex]) select(results[activeIndex]);
      else if (results.length === 1) select(results[0]);
    } else if (e.key === 'Escape') {
      setOpen(false);
      setActiveIndex(-1);
    }
  }

  return (
    <div className={`user-picker slot-${slot}`} ref={wrapRef} style={{ position: 'relative' }}>
      {selected ? (
        <div className={`selected-user slot-${slot}`}>
          <div className={`user-avatar slot-${slot}`}>{selected.Name.charAt(0)}</div>
          <div className="user-info">
            <div className="user-name">{selected.Name}</div>
            <div className="user-username">{selected.Username}</div>
          </div>
          <button className="clear-btn" onClick={clear} title="Clear">×</button>
        </div>
      ) : (
        <div className="search-wrap">
          <input
            ref={inputRef}
            type="text"
            className="search-input"
            placeholder={placeholder}
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            autoComplete="off"
          />
          {loading && <span className="search-spinner" />}
        </div>
      )}

      {open && (
        <div className="dropdown">
          {searchError ? (
            <div className="dropdown-error">
              <strong>Search failed:</strong> {searchError}
            </div>
          ) : results.length > 0 ? (
            <>
              <div className="dropdown-header">{results.length} result{results.length !== 1 ? 's' : ''}</div>
              <ul ref={listRef}>
                {results.map((user, i) => (
                  <li
                    key={user.Id}
                    className={activeIndex === i ? 'active' : ''}
                    onMouseDown={() => select(user)}
                    onMouseEnter={() => setActiveIndex(i)}
                  >
                    <div className={`user-avatar sm slot-${slot}`}>{user.Name.charAt(0)}</div>
                    <div className="user-info">
                      <div className="user-name">
                        <Highlighted text={user.Name} query={query} />
                      </div>
                      <div className="user-username">
                        <Highlighted text={user.Username} query={query} />
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <div className="dropdown-empty">No users found for "{query}"</div>
          )}
        </div>
      )}
    </div>
  );
}
