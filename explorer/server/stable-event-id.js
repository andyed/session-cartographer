// stable-event-id.js — the one definition of "an event's id, derived from its
// own content."
//
// Two things need this and must agree exactly:
//   scripts/backfill-event-ids.js   — mints ids for rows that never got one
//   scripts/build-prompt-history.js — mints ids for projected prompt records
//
// If they disagree, the projector re-mints a different id for a record the
// backfill already identified, and the same prompt lands in the corpus twice.
// Duplication is the visible failure; the invisible one is worse — an id that
// two writers spell differently cannot be fetched, touched, or threaded.
//
// The rule the digest enforces: the id may depend only on the record's own
// content, never on where the record sits or when it was read. No line numbers,
// no byte offsets, no file names, no wall clock. Both search engines otherwise
// fall back to a POSITIONAL synthetic key (bm25-search.awk to `src "-" fnr`,
// bm25.js to `${_source}-${docs.size}`), which changes on every append and on
// every engine, and the recall response contract rejects a result carrying no
// real id.
//
// A field that can change while the record does not — a transcript_path that
// expires, a mutable status — must be stripped by the caller before hashing.
// It is not on this module to know which of its caller's fields are volatile.
import crypto from 'node:crypto';

// Content fields in priority order. The fallback chain is deliberately wide:
// the searched logs carry several schemas and no single field is universal.
export const CONTENT_KEYS = [
  'summary', 'description', 'prompt', 'url', 'query', 'topic', 'note',
  'milestone', 'event', 'type', 'session_id', 'session', 'project',
  'transcript_path', 'cwd', 'deeplink', 'title', 'category',
  // /investigate records carry their content in these instead of summary.
  'symptom', 'hypothesis', 'layer', 'status',
];

/**
 * Derive a stable `evt-<12 hex>` id from a record's content.
 *
 * Absent, null, and empty-string fields are skipped identically, so a writer
 * that omits a key and one that spells it `""` produce the same id.
 *
 * @param {Record<string, unknown>} record
 * @returns {string} e.g. "evt-9f2c1a04bb7e"
 */
export function stableEventId(record) {
  const parts = [record.timestamp || ''];
  for (const key of CONTENT_KEYS) {
    const value = record[key];
    if (value === undefined || value === null || value === '') continue;
    parts.push(`${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`);
  }
  const digest = crypto.createHash('sha256').update(parts.join(' ')).digest('hex');
  return `evt-${digest.slice(0, 12)}`;
}

export default stableEventId;
