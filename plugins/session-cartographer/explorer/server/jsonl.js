import { readFileSync, statSync, watch, openSync, readSync, closeSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { createHash } from 'node:crypto';

const DEV_DIR = process.env.CARTOGRAPHER_DEV_DIR || join(homedir(), 'Documents', 'dev');
// The warm service indexes exactly one corpus, fixed at spawn time. Consumers
// need to be able to ask which one before trusting its answers.
export const CORPUS_ROOT = DEV_DIR;

// The searched logs. Every entry must live under DEV_DIR: the warm service
// indexes exactly one corpus (CORPUS_ROOT), and a source outside it cannot be
// swapped out by CARTOGRAPHER_DEV_DIR, so tests and alternate corpora silently
// inherit the real machine's history.
//
// `prompts` supersedes the former `claude-history` entry, which read
// ~/.claude/history.jsonl directly. Those 18,103 rows carried no event_id, so
// they could never be fetched, touched, or threaded, and recall.js had to drop
// every one of them at the contract boundary. build-prompt-history.js now
// projects the same content into prompt-history.jsonl with stable ids. Do not
// re-add the raw history file: the same prompts would be indexed twice under
// two different identities, and the id-less copy would win nothing.
export const LOG_FILES = {
  changelog: join(DEV_DIR, 'changelog.jsonl'),
  research: join(DEV_DIR, 'research-log.jsonl'),
  milestones: join(DEV_DIR, 'session-milestones.jsonl'),
  'tool-use': join(DEV_DIR, 'tool-use-log.jsonl'),
  prompts: join(DEV_DIR, 'prompt-history.jsonl'),
};

/**
 * Read all events from a JSONL file. Skips malformed lines (mid-flush writes).
 */
export function readJsonlFile(filePath) {
  let content;
  try {
    content = readFileSync(filePath, 'utf-8');
  } catch {
    return [];
  }

  const events = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      // Incomplete write — Claude is mid-flush. Skip.
    }
  }
  return events;
}

// Low-signal event types to hide from timeline (still searchable via BM25)
const NOISE_TYPES = new Set([
  'bridge_ping_received',
  'bridge_ping_sent',
]);

// Low-signal milestone types
const NOISE_MILESTONES = new Set([
  'agent_Explore',
  'agent_Plan',
  'agent_general-purpose',
]);

/**
 * Check if an event is high enough signal for the timeline.
 */
export function isHighSignal(event) {
  const type = event.type || '';
  const milestone = event.milestone || '';
  if (NOISE_TYPES.has(type) || NOISE_TYPES.has(milestone)) return false;
  if (NOISE_MILESTONES.has(milestone)) return false;
  if (type.startsWith('milestone_agent_')) return false;
  if (type.startsWith('bridge_ping')) return false;
  if (milestone.startsWith('bridge_ping')) return false;
  return true;
}

/**
 * Fold a repeated event into the copy already stored. The corpus intentionally
 * overlaps across changelog and the domain logs, so one event_id arrives from
 * more than one source: keep whichever value is non-empty and longer, and let a
 * domain log claim the source label away from changelog.
 *
 * Startup and the live watcher both need this rule. Startup applied it inline
 * while the watcher appended blind, so any event written to two logs was pushed
 * onto the feed twice while the process ran.
 */
export function mergeDuplicateEvent(existing, event, source) {
  for (const [k, v] of Object.entries(event)) {
    if (k === '_source') continue;
    if (v && (!existing[k] || (typeof v === 'string' && v.length > (existing[k]?.length || 0)))) {
      existing[k] = v;
    }
  }
  // Prefer domain source label
  if (source !== 'changelog') existing._source = source;
  return existing;
}

/**
 * Read all events from all known log files, tagged with source.
 * Deduplicates by event_id (same event in changelog + domain log).
 */
export function readAllEvents(logFiles = LOG_FILES) {
  const all = [];
  // Keep a direct reference to the first stored event for each id. The event
  // corpus intentionally overlaps across changelog and domain logs; looking
  // up every repeated id with all.findIndex() made startup quadratic once the
  // corpus reached six figures.
  const byEventId = new Map();

  for (const [source, filePath] of Object.entries(logFiles)) {
    for (const event of readJsonlFile(filePath)) {
      const id = event.event_id;
      // Deduplicate: merge fields from both sources, prefer richer values
      if (id && byEventId.has(id)) {
        mergeDuplicateEvent(byEventId.get(id), event, source);
        continue;
      }
      const stored = { ...event, _source: source };
      if (id) byEventId.set(id, stored);
      all.push(stored);
    }
  }

  // Robustly parse timestamps (ISO strings or numeric epochs) for chronological sorting
  function parseTs(ts) {
    if (!ts) return 0;
    if (!isNaN(ts)) {
      const n = parseFloat(ts);
      // Auto-detect seconds vs milliseconds (seconds < year 2033)
      return n < 2000000000 ? n * 1000 : n;
    }
    return new Date(ts).getTime() || 0;
  }

  // Normalize field variants so downstream code can use canonical names
  for (const e of all) {
    // sessionId → session_id
    if (!e.session_id && e.sessionId) e.session_id = e.sessionId;
    if (!e.session_id && e.session) e.session_id = e.session;
    // display → summary fallback
    if (!e.summary && e.display) e.summary = e.display;
    // type fallback to source
    if (!e.type && e._source) e.type = e._source;
    // NOTE: a transcript_path derivation used to live here, guessing
    // ~/.claude/projects/<project-with-slashes-dashed>/<session_id>.jsonl. It
    // only ever resolved for claude-history rows, whose `project` is a full cwd
    // path; measured against the live corpus it produced 15,456 paths, all of
    // them from that one source, and 0 from the other four logs (2,291 rows
    // there met the guard and every candidate stat missed, because their
    // `project` is a bare project name, not a path). With claude-history gone it
    // is dead code that costs a statSync per event at startup. The prompts
    // projector stamps transcript_path at write time; a resolver for stale
    // recorded paths already exists at scripts/resolve-transcript.sh.
  }

  // Sort by timestamp descending (newest first)
  all.sort((a, b) => parseTs(b.timestamp) - parseTs(a.timestamp));
  return all;
}

/**
 * Watch all JSONL files for new events. Calls onNewEvents(events) when new
 * lines appear. Uses byte offsets to avoid re-reading entire files.
 * Returns a cleanup function.
 */
// Bytes of the pre-offset boundary region fingerprinted to detect a rewrite.
// The offset alone cannot: repairing history in place changes bytes BEFORE the
// offset, and if the file also grows (e.g. rewriting a path to a longer one)
// the size check reads the shifted tail as if it were fresh appends while every
// already-indexed record silently keeps its stale value.
const BOUNDARY_BYTES = 4096;

function boundaryHash(filePath, offset) {
  if (!offset) return '';
  const start = Math.max(0, offset - BOUNDARY_BYTES);
  const length = offset - start;
  if (length <= 0) return '';
  const buffer = Buffer.alloc(length);
  let fd;
  try {
    fd = openSync(filePath, 'r');
    readSync(fd, buffer, 0, length, start);
    closeSync(fd);
  } catch {
    if (fd !== undefined) { try { closeSync(fd); } catch {} }
    return '';
  }
  return createHash('sha1').update(buffer).digest('hex');
}

/**
 * @param onNewEvents  called with newly appended events
 * @param onRewrite    optional; called with the source name when history was
 *                     rewritten in place. Appending cannot repair that, so the
 *                     consumer must reload from disk. Without a handler the
 *                     watcher re-baselines and keeps going, which is the old
 *                     behaviour: stale in memory, no signal.
 */
export function watchFiles(onNewEvents, onRewrite, logFiles = LOG_FILES) {
  const offsets = {};
  const boundaries = {};
  const watchers = [];

  // Initialize offsets to current file sizes (don't replay history)
  for (const [source, filePath] of Object.entries(logFiles)) {
    try {
      offsets[source] = statSync(filePath).size;
    } catch {
      offsets[source] = 0;
    }
    boundaries[source] = boundaryHash(filePath, offsets[source]);
  }

  for (const [source, filePath] of Object.entries(logFiles)) {
    let debounceTimer = null;

    const handleChange = () => {
      // Debounce — fs.watch can fire multiple times per write
      if (debounceTimer) return;
      debounceTimer = setTimeout(() => {
        debounceTimer = null;

        let size;
        try {
          size = statSync(filePath).size;
        } catch {
          return;
        }

        // Truncation/rotation, or history rewritten underneath us.
        const truncated = size < offsets[source];
        const rewritten = !truncated
          && offsets[source] > 0
          && boundaryHash(filePath, offsets[source]) !== boundaries[source];

        if (truncated || rewritten) {
          offsets[source] = size;
          boundaries[source] = boundaryHash(filePath, size);
          if (onRewrite) onRewrite(source);
          return;
        }

        if (size <= offsets[source]) return;

        // Read new bytes
        const bytesToRead = size - offsets[source];
        const buffer = Buffer.alloc(bytesToRead);
        let fd;
        try {
          fd = openSync(filePath, 'r');
          readSync(fd, buffer, 0, bytesToRead, offsets[source]);
          closeSync(fd);
        } catch {
          if (fd) try { closeSync(fd); } catch {}
          return;
        }

        offsets[source] = size;
        boundaries[source] = boundaryHash(filePath, size);

        // Parse new lines
        const newEvents = [];
        for (const line of buffer.toString('utf-8').split('\n')) {
          if (!line.trim()) continue;
          try {
            newEvents.push({ ...JSON.parse(line), _source: source });
          } catch {
            // Mid-flush write — skip
          }
        }

        if (newEvents.length > 0) {
          onNewEvents(newEvents);
        }
      }, 100);
    };

    try {
      const w = watch(filePath, handleChange);
      // A long-lived recall service must not crash if the host temporarily
      // exhausts watcher handles. The current index remains usable; a restart
      // re-reads the complete append-only logs.
      w.on('error', () => {});
      watchers.push(w);
    } catch {
      // File doesn't exist yet — that's fine
    }
  }

  return () => {
    for (const w of watchers) {
      try { w.close(); } catch {}
    }
  };
}

/**
 * ---------------------------------------------------------------------------
 * Positions: "what has been appended since I last looked."
 * ---------------------------------------------------------------------------
 *
 * `watchFiles` already answers this for a live process, but it answers it
 * privately and only forward from the moment it started. A caller that wants a
 * durable answer across restarts — a scheduled agent asking "what changed since
 * my last run twelve hours ago" — needs the same question answered from a token
 * it can hold on disk.
 *
 * These export the primitive `watchFiles` uses internally rather than letting a
 * second consumer re-derive it. The rewrite-detection rule in particular is not
 * obvious and not optional: a byte offset alone cannot tell an append from an
 * in-place history repair, and the failure is silent in the direction that
 * matters — a repair that also grows the file makes the shifted tail read as
 * fresh appends. `boundaryHash` is the guard, and there must be exactly one
 * copy of it.
 *
 * Why this reads disk instead of the resident event array: the in-memory corpus
 * has no stable arrival order. It is loaded file-by-file at spawn and only
 * newly-appended events are unshifted to the front, so "the first N entries"
 * means different things before and after a restart. The append-only logs *are*
 * the arrival order. That distinction is the whole reason a delta cursor can be
 * trusted, and it is also why a `since`-timestamp filter is not a substitute:
 * backfills (`backfill-git-history.sh`, `retro-index.sh`,
 * `catch-up-transcripts.sh`) append events dated months in the past, and a
 * timestamp window silently omits every one of them.
 */

/** Current append position of every searched log. */
export function logPositions(logFiles = LOG_FILES) {
  const positions = {};
  for (const [source, filePath] of Object.entries(logFiles)) {
    let offset = 0;
    try {
      offset = statSync(filePath).size;
    } catch {
      offset = 0;
    }
    positions[source] = { offset, boundary: boundaryHash(filePath, offset) };
  }
  return positions;
}

/**
 * Read events appended to each log since `positions`.
 *
 * `budget` caps how many events are returned. When it binds, each source's new
 * offset advances only past the lines this call consumed, so the remainder is
 * still pending on the next call. Advancing past an event that was never handed
 * to the caller would lose it permanently and silently, which is the one
 * outcome a durable cursor exists to prevent.
 *
 * "Consumed" is wider than "returned", deliberately, in two places: blank and
 * unparseable lines are consumed while emitting nothing, because a line that is
 * never consumed wedges the cursor at that byte forever; and a caller applying
 * its own filter downstream still advances past what it discarded, or an agent
 * watching one project would re-read every unrelated event on every call.
 *
 * A source whose history was rewritten or truncated under the cursor is
 * reported in `stale` and contributes no events. The honest response to "your
 * cursor no longer describes this file" is to say so, not to emit a diff
 * computed against bytes that no longer mean what they meant — the same
 * refuse-rather-than-guess rule `session-match.js` applies to ambiguous
 * matches.
 *
 * @returns {{events: object[], positions: object, stale: object, pending: object}}
 */
export function readAppended(positions = {}, { budget = 500, logFiles = LOG_FILES } = {}) {
  const nextPositions = {};
  const stale = {};
  const pending = {};
  // Parsed but not yet emitted, per source, each entry carrying the byte cost
  // of its own line so the offset can advance exactly as far as we emit.
  const queues = {};

  for (const [source, filePath] of Object.entries(logFiles)) {
    const prior = positions[source];
    let size;
    try {
      size = statSync(filePath).size;
    } catch {
      // A log that does not exist yet is at position zero, not stale.
      nextPositions[source] = { offset: 0, boundary: '' };
      queues[source] = [];
      continue;
    }

    if (!prior || typeof prior.offset !== 'number') {
      // No cursor for this source: baseline at the current end rather than
      // replaying the entire log. A first call establishes a position; it does
      // not claim the whole corpus is "new".
      nextPositions[source] = { offset: size, boundary: boundaryHash(filePath, size) };
      queues[source] = [];
      continue;
    }

    if (size < prior.offset) {
      stale[source] = 'truncated';
      nextPositions[source] = { offset: size, boundary: boundaryHash(filePath, size) };
      queues[source] = [];
      continue;
    }
    if (prior.offset > 0 && boundaryHash(filePath, prior.offset) !== prior.boundary) {
      stale[source] = 'rewritten';
      nextPositions[source] = { offset: size, boundary: boundaryHash(filePath, size) };
      queues[source] = [];
      continue;
    }
    if (size === prior.offset) {
      nextPositions[source] = { offset: size, boundary: prior.boundary };
      queues[source] = [];
      continue;
    }

    const buffer = Buffer.alloc(size - prior.offset);
    let fd;
    try {
      fd = openSync(filePath, 'r');
      readSync(fd, buffer, 0, buffer.length, prior.offset);
      closeSync(fd);
    } catch {
      if (fd !== undefined) { try { closeSync(fd); } catch {} }
      nextPositions[source] = { ...prior };
      queues[source] = [];
      continue;
    }

    // Hold the start offset; it advances per emitted line below.
    nextPositions[source] = { offset: prior.offset, boundary: prior.boundary };
    const queue = [];
    const text = buffer.toString('utf-8');
    const lines = text.split('\n');
    // `split` leaves a final element that is either the empty string after a
    // closing newline or a mid-flush fragment with no newline yet. Either way it
    // is not a complete line: stop one short and leave its bytes unconsumed so
    // the next call reads the whole record.
    const complete = lines.length - 1;
    for (let i = 0; i < complete; i += 1) {
      const line = lines[i];
      const bytes = Buffer.byteLength(line, 'utf-8') + 1;
      if (!line.trim()) {
        // Blank line: consume its bytes, emit nothing.
        queue.push({ event: null, bytes });
        continue;
      }
      try {
        queue.push({ event: { ...JSON.parse(line), _source: source }, bytes });
      } catch {
        // Unparseable line. Consume it — a malformed row that is never consumed
        // would wedge the cursor at this byte forever.
        queue.push({ event: null, bytes });
      }
    }
    queues[source] = queue;
  }

  // Round-robin across sources so one busy log cannot starve the others out of
  // every delta. Draining in a fixed source order would mean a saturated
  // changelog permanently hides new prompt history.
  const events = [];
  const heads = Object.fromEntries(Object.keys(queues).map((source) => [source, 0]));
  let progressed = true;
  while (events.length < budget && progressed) {
    progressed = false;
    for (const source of Object.keys(queues)) {
      if (events.length >= budget) break;
      const queue = queues[source];
      let index = heads[source];
      // Skip consumed-but-unemitted lines (blank/malformed) without spending
      // budget on them.
      while (index < queue.length && queue[index].event === null) {
        nextPositions[source].offset += queue[index].bytes;
        index += 1;
      }
      if (index >= queue.length) { heads[source] = index; continue; }
      events.push(queue[index].event);
      nextPositions[source].offset += queue[index].bytes;
      heads[source] = index + 1;
      progressed = true;
    }
  }

  for (const [source, queue] of Object.entries(queues)) {
    const remaining = queue.slice(heads[source]).filter((entry) => entry.event !== null).length;
    if (remaining > 0) pending[source] = remaining;
    // Recompute the boundary at whatever offset we actually reached.
    const filePath = logFiles[source];
    if (filePath && nextPositions[source]) {
      nextPositions[source].boundary = boundaryHash(filePath, nextPositions[source].offset);
    }
  }

  return { events, positions: nextPositions, stale, pending };
}
