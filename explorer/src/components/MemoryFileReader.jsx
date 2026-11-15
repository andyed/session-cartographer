import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { apiRequest } from '../api.js';

// Lines of context kept above a line someone jumps to.
const LEAD_LINES = 20;
const count = value => value.toLocaleString();

function readerHref(review, params) {
  const url = new URL(review.readerUrl, window.location.origin);
  url.searchParams.set('version', review.version);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  return url.pathname + url.search;
}

function Excerpt({ match }) {
  return <code>
    {match.leading && '…'}{match.excerpt.slice(0, match.start)}
    <mark>{match.excerpt.slice(match.start, match.end)}</mark>
    {match.excerpt.slice(match.end)}{match.trailing && '…'}
  </code>;
}

/**
 * The whole file, a page at a time, for files the preview cut short. Every
 * request names the version the review read, so a file edited meanwhile
 * answers 409 instead of mixing two versions' line numbers.
 */
export default function MemoryFileReader({ review, onReload }) {
  const [view, setView] = useState({ line: 1, target: null, seq: 0 });
  const [page, setPage] = useState(null);
  const [failure, setFailure] = useState(null);
  const [lineInput, setLineInput] = useState('');
  const [query, setQuery] = useState('');
  const [found, setFound] = useState(null);
  const top = useRef(null), source = useRef(null);
  // Find results belong to the version they searched.
  useEffect(() => setFound(null), [review.version]);

  useEffect(() => {
    const controller = new AbortController();
    setFailure(null);
    apiRequest(readerHref(review, { action: 'page', line: view.line }), { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]) })
      .then(result => { if (!controller.signal.aborted) setPage(result); })
      .catch(error => { if (!controller.signal.aborted) setFailure({ message: error.message, changed: error.status === 409 }); });
    return () => controller.abort();
  }, [review.readerUrl, review.version, view.line, view.seq]);

  // A jump shows its line; a page turn starting below the fold returns to the top.
  useLayoutEffect(() => {
    if (!page || page.startLine !== view.line) return;
    const row = view.target && source.current?.querySelector(`[data-line="${view.target}"]`);
    if (row) row.scrollIntoView({ block: 'center' });
    else if (view.seq && top.current && top.current.getBoundingClientRect().top < 0) top.current.scrollIntoView({ block: 'start' });
  }, [page, view]);

  const go = (line, target = null) => setView(current => ({ line, target, seq: current.seq + 1 }));
  const jump = line => go(Math.max(1, line - LEAD_LINES), line);
  const total = page?.totalLines;

  function submitLine(event) {
    event.preventDefault();
    const line = Number(lineInput);
    if (!Number.isInteger(line) || line < 1) return;
    jump(total ? Math.min(line, total) : line);
  }

  function submitFind(event) {
    event.preventDefault();
    const text = query.trim() ? query : '';
    if (!text) { setFound(null); return; }
    setFound({ query: text, loading: true });
    apiRequest(readerHref(review, { action: 'search', find: text }), { signal: AbortSignal.timeout(15000) })
      .then(result => setFound(current => current?.query === text ? result : current))
      .catch(error => setFound(current => current?.query === text ? { query: text, error: error.message, changed: error.status === 409 } : current));
  }

  const pager = <div className="memory-artifact-view-options" role="group" aria-label="Pages">
    <button type="button" disabled={!page?.prevLine} onClick={() => go(page.prevLine)}>Previous</button>
    <button type="button" disabled={!page?.nextLine} onClick={() => go(page.nextLine)}>Next</button>
  </div>;

  return <div className="memory-reader">
    <div ref={top} className="memory-artifact-toolbar memory-reader-bar">
      {pager}
      <span className="memory-reader-position" aria-live="polite">{page ? total ? `Lines ${count(page.startLine)}–${count(page.endLine)} of ${count(total)}` : 'Empty file' : 'Reading…'}</span>
      <form className="memory-reader-form" onSubmit={submitLine}>
        <label>Line <input type="number" inputMode="numeric" min="1" max={total || undefined} value={lineInput} onChange={event => setLineInput(event.target.value)} /></label>
        <button type="submit">Go</button>
      </form>
      <form className="memory-reader-form" role="search" onSubmit={submitFind}>
        <label>Find <input type="search" maxLength={256} value={query} onChange={event => setQuery(event.target.value)} /></label>
        <button type="submit">Find</button>
      </form>
    </div>
    {found && <div className="memory-reader-results" aria-live="polite">
      {found.loading ? <p>Searching…</p>
        : found.error ? <p role="alert">{found.error}</p>
        : <>
          <p>{found.matches.length ? `${found.limited ? `First ${count(found.limit)}` : count(found.matches.length)} ${found.matches.length === 1 ? 'match' : 'matches'} for “${found.query}”` : `No matches for “${found.query}”`}</p>
          {found.matches.length > 0 && <ol>{found.matches.map((match, index) => <li key={index}>
            <button type="button" aria-current={view.target === match.line ? 'true' : undefined} onClick={() => jump(match.line)}>Line {count(match.line)}</button>
            <Excerpt match={match} />
          </li>)}</ol>}
        </>}
    </div>}
    {failure ? <div className="memory-reader-failure">
      <p role="alert">{failure.message}</p>
      {failure.changed && onReload ? <button type="button" onClick={onReload}>Reload file</button> : <button type="button" onClick={() => go(view.line, view.target)}>Retry</button>}
    </div> : page && <>
      {page.clipped > 0 && <p className="memory-artifact-notice">{page.clipped === 1 ? 'One line on this page is' : `${count(page.clipped)} lines on this page are`} cut at 4,096 characters.</p>}
      <div ref={source} className="memory-reader-source" tabIndex={0} role="region" aria-label="File source">
        {page.lines.map((text, index) => {
          const line = page.startLine + index;
          return <div key={line} data-line={line} className={line === view.target ? 'is-target' : undefined}>
            <span className="memory-reader-number" aria-hidden="true">{line}</span><code>{text || ' '}</code>
          </div>;
        })}
      </div>
      <div className="memory-reader-foot">{pager}</div>
    </>}
  </div>;
}
