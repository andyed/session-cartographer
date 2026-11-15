// Paging and search over one decoded text file. Pure functions: the worker in
// memory-file-worker.js owns the descriptor and the cache, and the tests drive
// these directly.

export const FILE_READ_LIMIT = 32 * 1024 * 1024;
export const PAGE_LINES = 500;
// Characters per page, so one long line cannot make a page megabytes wide.
export const PAGE_CHARS = 64 * 1024;
// A single minified line is cut for display; `clipped` names how many were.
export const LINE_CHARS = 4096;
export const SEARCH_LIMIT = 200;
export const QUERY_MAX = 256;
const EXCERPT_BEFORE = 60;
const EXCERPT_AFTER = 120;

export class FileReadError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

/** dev:ino:size:mtime, so an edit or a replaced file reads as a different version. */
export const fileVersion = stat => [stat.dev, stat.ino, stat.size, Math.trunc(stat.mtimeMs)].join(':');

/** UTF-8 bytes → text, refusing binary and invalid encodings the way the preview does. */
export function decodeText(bytes) {
  if (bytes.includes(0)) throw new FileReadError(415, 'Binary files are not available in text review.');
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw new FileReadError(415, 'File is not UTF-8 text.'); }
}

/** Offsets of every line start. A trailing newline does not open another line. */
export function indexLines(text) {
  const starts = [0];
  for (let i = text.indexOf('\n'); i !== -1 && i < text.length - 1; i = text.indexOf('\n', i + 1)) starts.push(i + 1);
  return { text, starts: Uint32Array.from(starts), total: text.length ? starts.length : 0 };
}

function lineAt(doc, number) {
  const start = doc.starts[number - 1];
  const end = number < doc.total ? doc.starts[number] - 1 : doc.text.length - (doc.text.endsWith('\n') ? 1 : 0);
  return doc.text.slice(start, end).replace(/\r$/, '');
}

/** The line holding a character offset (1-based). */
function lineOf(doc, offset) {
  let lo = 0, hi = doc.total - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (doc.starts[mid] <= offset) lo = mid; else hi = mid - 1;
  }
  return lo + 1;
}

/** Where the page before `startLine` begins, under the same line and character caps. */
function previousStart(doc, startLine) {
  if (startLine <= 1) return null;
  let line = startLine, chars = 0;
  while (line > 1 && startLine - line < PAGE_LINES) {
    const length = Math.min(lineAt(doc, line - 1).length, LINE_CHARS) + 1;
    if (chars && chars + length > PAGE_CHARS) break;
    chars += length;
    line -= 1;
  }
  return line;
}

export function readPage(doc, requested) {
  if (!doc.total) return { totalLines: 0, startLine: 1, endLine: 0, lines: [], clipped: 0, prevLine: null, nextLine: null };
  if (!Number.isSafeInteger(requested) || requested < 1) throw new FileReadError(400, 'Line numbers start at 1.');
  if (requested > doc.total) throw new FileReadError(416, `This file has ${doc.total.toLocaleString('en-US')} lines.`);
  const lines = [];
  let chars = 0, clipped = 0, line = requested;
  while (line <= doc.total && lines.length < PAGE_LINES) {
    const full = lineAt(doc, line);
    const value = full.length > LINE_CHARS ? full.slice(0, LINE_CHARS) : full;
    if (lines.length && chars + value.length + 1 > PAGE_CHARS) break;
    if (value !== full) clipped += 1;
    lines.push(value);
    chars += value.length + 1;
    line += 1;
  }
  return {
    totalLines: doc.total, startLine: requested, endLine: line - 1, lines, clipped,
    prevLine: previousStart(doc, requested), nextLine: line <= doc.total ? line : null,
  };
}

export function searchText(doc, query) {
  if (typeof query !== 'string' || !query.trim() || query.length > QUERY_MAX) throw new FileReadError(400, `Search for 1 to ${QUERY_MAX} characters.`);
  // Literal, case-insensitive. A regex with the u flag keeps offsets in the
  // original text, which lowercasing both sides would not (İ lowercases to two).
  const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu');
  const matches = [];
  let match, limited = false;
  while ((match = pattern.exec(doc.text))) {
    if (matches.length === SEARCH_LIMIT) { limited = true; break; }
    const line = lineOf(doc, match.index);
    const lineStart = doc.starts[line - 1];
    const full = lineAt(doc, line);
    const column = match.index - lineStart;
    const from = Math.max(0, column - EXCERPT_BEFORE);
    const to = Math.min(full.length, column + match[0].length + EXCERPT_AFTER);
    matches.push({ line, column: column + 1, excerpt: full.slice(from, to), start: column - from, end: column - from + match[0].length, leading: from > 0, trailing: to < full.length });
    if (!match[0].length) pattern.lastIndex += 1;
  }
  return { query, matches, limited, limit: SEARCH_LIMIT };
}
