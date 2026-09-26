import { readFileSync, statSync, watch, openSync, readSync, closeSync } from 'fs';
import { basename, dirname, join } from 'path';
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
export const LOG_FILE_NAMES = {
  changelog: 'changelog.jsonl',
  research: 'research-log.jsonl',
  milestones: 'session-milestones.jsonl',
  'tool-use': 'tool-use-log.jsonl',
  prompts: 'prompt-history.jsonl',
};
export const LOG_FILES = Object.fromEntries(
  Object.entries(LOG_FILE_NAMES).map(([source, name]) => [source, join(DEV_DIR, name)]),
);

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

// The canonical fields downstream code reads, each derived from the fields a
// writer may have used instead.
//
// `type` comes from `milestone`, then `event`, then the log's name. The
// milestone hook writes each event twice and types the changelog copy
// `milestone_<milestone>`; a row only in the milestones log (/wrapup,
// hermes-source.js) gets the same name, so census counts it with its kind.
// Typed by the log name, 1,921 such rows shared one `milestones` bucket, and
// the Memory Desk's /wrapup/ test on `type` never matched a wrapup. `milestone`
// outranks `event` because it is the finer name: a milestone row's `event` is
// the hook that fired (`Stop`, `SubagentStop`), and `SubagentStop` does not
// say which agent.
const CANONICAL_FIELDS = [
  ['session_id', (event) => event.sessionId || event.session],
  ['summary', (event) => event.display],
  ['type', (event) => {
    if (typeof event.milestone === 'string' && event.milestone) return `milestone_${event.milestone}`;
    if (typeof event.event === 'string' && event.event) return event.event;
    return event._source;
  }],
];

// Per event, the canonical values normalizeEvent filled in rather than read.
// On the live corpus about 3,500 loaded events carry an entry: milestone-only
// rows with no `type` and research-only rows with no `session_id`. Most rows
// get the field from their changelog copy.
const derivedValues = new WeakMap();

// Remove the values normalizeEvent filled in, returning the event to the fields
// its copies supplied. A value something else has since replaced is kept.
function underive(event) {
  const derived = derivedValues.get(event);
  if (!derived) return false;
  for (const [field, value] of Object.entries(derived)) {
    if (event[field] === value) delete event[field];
  }
  derivedValues.delete(event);
  return true;
}

/**
 * Fill the canonical fields from their variants, in place: `session_id` from
 * `sessionId` or `session`, `summary` from `display`, `type` from `milestone`
 * (as `milestone_<milestone>`), `event`, or else `_source`.
 *
 * The load, the watcher, and the facts `delta` verb all apply this, so one
 * event reads the same whether it came from the resident corpus or off a log
 * tail. The watcher once delivered raw rows, so a row with no changelog copy to
 * fill it in lacked `session_id` or `type` until the next restart, and recall
 * and census disagreed with a freshly loaded service. Re-running it re-derives
 * from the current fields, which a fold may have changed.
 */
export function normalizeEvent(event) {
  underive(event);
  let derived = null;
  for (const [field, derive] of CANONICAL_FIELDS) {
    if (event[field]) continue;
    const value = derive(event);
    if (!value) continue;
    event[field] = value;
    (derived ||= {})[field] = value;
  }
  if (derived) derivedValues.set(event, derived);
  return event;
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
 *
 * A derived value is a placeholder until a copy supplies the real one, so it
 * takes no part in the longer-wins comparison. The load normalizes after every
 * fold and never meets one. The watcher delivers normalized rows, so it would:
 * a derived `type: "milestone_session_wrapup"` outlasts a twin's shorter real
 * type, and a `type` taken from changelog outlives a domain log claiming the
 * source. Both sides fold without their derived values, and the result is
 * re-derived.
 */
export function mergeDuplicateEvent(existing, event, source) {
  const wasDerived = underive(existing);
  const incomingDerived = derivedValues.get(event);
  for (const [k, v] of Object.entries(event)) {
    if (k === '_source' || (incomingDerived && Object.hasOwn(incomingDerived, k))) continue;
    if (v && (!existing[k] || (typeof v === 'string' && v.length > (existing[k]?.length || 0)))) {
      existing[k] = v;
    }
  }
  // Prefer domain source label
  if (source !== 'changelog') existing._source = source;
  if (wasDerived) normalizeEvent(existing);
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

  // Normalize field variants so downstream code can use canonical names. After
  // the folds, so a derived value never competes with a copy's real one.
  for (const e of all) {
    normalizeEvent(e);
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

// Where the last complete line ends: the byte after the final newline at or
// before `size`, or 0 if there is none. A write still in progress leaves a
// fragment past it. A position inside that fragment makes the rest of the line
// read as a second fragment that never parses, so the event is lost.
const TAIL_CHUNK = 64 * 1024;

function lastLineEnd(filePath, size) {
  if (!size) return 0;
  let fd;
  try {
    fd = openSync(filePath, 'r');
    let end = size;
    while (end > 0) {
      const start = Math.max(0, end - TAIL_CHUNK);
      const buffer = Buffer.alloc(end - start);
      const read = readSync(fd, buffer, 0, buffer.length, start);
      const newline = buffer.subarray(0, read).lastIndexOf(0x0a);
      if (newline >= 0) return start + newline + 1;
      end = start;
    }
    return 0;
  } catch {
    // Unreadable now; the next change event reads it again.
    return size;
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch {} }
  }
}

/**
 * Arm this before reading the corpus, not after. Each log is baselined at its
 * last complete line when armed ("don't replay history"), so a watcher armed
 * after the load never sees what was appended while the load ran: the read had
 * already passed it. Armed first, with the load run synchronously after it,
 * nothing is delivered until the load finishes; the first pass then reads
 * everything appended since the arm. A row both loaded and delivered is the
 * same event arriving twice, which the consumer folds by event_id.
 *
 * @param onNewEvents  called with newly appended events
 * @param onRewrite    optional; called with the source name when history was
 *                     rewritten in place, or when the file at the path is no
 *                     longer the one being watched (replaced by rename,
 *                     deleted and recreated, or absent at startup and since
 *                     created). Appending cannot repair any of those, so the
 *                     consumer must reload from disk. Without a handler the
 *                     watcher re-baselines and keeps going, which is the old
 *                     behaviour: stale in memory, no signal.
 */
export function watchFiles(onNewEvents, onRewrite, logFiles = LOG_FILES) {
  const offsets = {};
  const boundaries = {};
  const handlers = {};
  // fs.watch on a file is bound to its inode, not its path. The repair
  // scripts replace a log by writing a temp file beside it and renaming it
  // over the original; the watcher fires once, for the unlink, and then sits
  // on a file nothing will write again. Nothing errors, and the service keeps
  // answering from a corpus that has stopped growing. So each source records
  // the inode its watcher is bound to, and a mismatch re-arms it.
  const inodes = {};
  const fileWatchers = {};
  const dirWatchers = [];
  // A handler that runs after the cleanup function would re-arm a watcher
  // nothing closes, which holds the process open.
  let closed = false;

  function armFile(source) {
    const filePath = logFiles[source];
    try { fileWatchers[source]?.close(); } catch {}
    fileWatchers[source] = null;
    let stat;
    try {
      stat = statSync(filePath);
    } catch {
      // Doesn't exist yet. The directory watch arms it when it appears.
      inodes[source] = undefined;
      return null;
    }
    // Stat before watching. If the file is swapped again in between, the
    // recorded inode is the older one, so the next event reads as another
    // replacement and reloads, rather than trusting a watcher on the wrong file.
    inodes[source] = stat.ino;
    try {
      const w = watch(filePath, handlers[source]);
      // A long-lived recall service must not crash if the host temporarily
      // exhausts watcher handles. The current index remains usable; a restart
      // re-reads the complete append-only logs.
      w.on('error', () => {});
      fileWatchers[source] = w;
    } catch {
      // Gone between stat and watch; the directory watch sees it come back.
    }
    return stat;
  }

  for (const [source, filePath] of Object.entries(logFiles)) {
    let debounceTimer = null;

    handlers[source] = () => {
      // Debounce — fs.watch can fire multiple times per write, and the file
      // and directory watches both report the same append.
      if (debounceTimer || closed) return;
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        if (closed) return;

        let stat;
        try {
          stat = statSync(filePath);
        } catch {
          return;
        }
        const size = stat.size;

        // A different file now sits at the path. Its history need not extend
        // the old one's, so this is a rewrite, not an append — even when the
        // replacement happens to share the old bytes as a prefix. A log that
        // was absent at startup lands here too; a reload reads it whole.
        if (stat.ino !== inodes[source]) {
          const armed = armFile(source);
          if (!armed) return;
          offsets[source] = lastLineEnd(filePath, armed.size);
          boundaries[source] = boundaryHash(filePath, offsets[source]);
          if (onRewrite) onRewrite(source);
          return;
        }

        // Truncation/rotation, or history rewritten underneath us.
        const truncated = size < offsets[source];
        const rewritten = !truncated
          && offsets[source] > 0
          && boundaryHash(filePath, offsets[source]) !== boundaries[source];

        if (truncated || rewritten) {
          offsets[source] = lastLineEnd(filePath, size);
          boundaries[source] = boundaryHash(filePath, offsets[source]);
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

        // Consume through the last newline only. A trailing fragment is a write
        // still in progress: parsing it fails, and counting its bytes as read
        // anyway loses the event, since the rest of the line then arrives as a
        // second fragment. Leave it for the next pass, as readAppended does.
        const complete = buffer.lastIndexOf(0x0a) + 1;
        if (complete === 0) return;
        offsets[source] += complete;
        boundaries[source] = boundaryHash(filePath, offsets[source]);

        // Parse new lines, normalized as readAllEvents normalizes a load. A
        // consumer folding a copy into its stored event does so with
        // mergeDuplicateEvent, which re-derives.
        const newEvents = [];
        for (const line of buffer.toString('utf-8', 0, complete).split('\n')) {
          if (!line.trim()) continue;
          try {
            newEvents.push(normalizeEvent({ ...JSON.parse(line), _source: source }));
          } catch {
            // Mid-flush write — skip
          }
        }

        if (newEvents.length > 0) {
          onNewEvents(newEvents);
        }
      }, 100);
    };
  }

  // Start at each log's last complete line: history is not replayed, and a line
  // still being written is read whole once it is finished.
  for (const [source, filePath] of Object.entries(logFiles)) {
    const stat = armFile(source);
    offsets[source] = stat ? lastLineEnd(filePath, stat.size) : 0;
    boundaries[source] = boundaryHash(filePath, offsets[source]);
  }

  // A file watch cannot report a replacement after its first event, or a log
  // that did not exist when it was armed. The containing directory can: route
  // any event naming a log's basename to that log's handler, which stats the
  // path and decides. Measured on macOS, where this is FSEvents over the whole
  // corpus root: 5 ms CPU in 30 s against 1 ms idle.
  const byDir = new Map();
  for (const [source, filePath] of Object.entries(logFiles)) {
    const names = byDir.get(dirname(filePath)) || new Map();
    const name = basename(filePath);
    names.set(name, [...(names.get(name) || []), source]);
    byDir.set(dirname(filePath), names);
  }
  for (const [dir, names] of byDir) {
    try {
      const w = watch(dir, (_event, filename) => {
        // Some platforms omit the name; then any log in the directory may
        // have changed, and a stat per log is cheap.
        const sources = filename ? names.get(String(filename)) : [...names.values()].flat();
        for (const source of sources || []) handlers[source]();
      });
      w.on('error', () => {});
      dirWatchers.push(w);
    } catch {
      // Directory missing; nothing under it can be watched either.
    }
  }

  // Check every log once the caller's synchronous work has finished. A file
  // watch reaches the kernel only when the event loop next polls (kqueue on
  // macOS), so an append in the same tick as the arm raises no event: 0 of 5
  // trials reported one. The directory watch caught them in isolation, from
  // its own thread, but missed under load. The caller loads the corpus in that
  // tick, so without this pass whatever landed during the load waited for the
  // log's next append. The debounce the pass starts cannot fire before a poll,
  // so every append is either read by it or raises an event after it.
  const firstPass = setImmediate(() => {
    for (const source of Object.keys(logFiles)) handlers[source]();
  });

  const stop = () => {
    closed = true;
    clearImmediate(firstPass);
    for (const w of [...Object.values(fileWatchers), ...dirWatchers]) {
      try { w?.close(); } catch {}
    }
  };
  // Where each source's watcher has read to, and which file it is bound to.
  // Only a comparison with the disk can show a stalled watcher: on 2026-09-25 a
  // log replaced by rename left this bound to the unlinked inode, and every
  // health signal stayed green while Turbo served 2 of 69 hermes milestones. A
  // stopped watcher keeps reporting where it stopped, as a stalled one would.
  stop.positions = () => Object.fromEntries(Object.keys(logFiles).map((source) => [source, {
    path: logFiles[source],
    offset: offsets[source],
    inode: inodes[source] ?? null,
  }]));
  return stop;
}

/**
 * One look at a watcher from outside: the positions it reports, then the logs
 * on disk as read after them. Read the disk second, so an append that lands in
 * between shows as lag and earns a second look rather than hiding.
 */
export function watchSample(positions) {
  const disk = {};
  for (const [source, position] of Object.entries(positions || {})) {
    try {
      const stat = statSync(position.path);
      disk[source] = { bytes: stat.size, inode: stat.ino };
    } catch {
      disk[source] = null;
    }
  }
  return { positions: positions || {}, disk };
}

/**
 * Judge whether a watcher is keeping up with its logs.
 *
 * One sample cannot separate a stall from an append the watcher has not reached
 * yet: the logs grow continuously and the watcher waits out a 100 ms debounce.
 * So with one sample `stale` is provisional, true for anything not caught up
 * (bound to a file no longer at the path, or a byte count that differs from the
 * file's). Pass a second sample taken a grace period later and each source is
 * judged on whether the watcher reached what was on disk at the FIRST look.
 * Bytes appended during the grace do not count against it.
 *
 * @returns { source: { consumed_bytes, disk_bytes, bytes_behind, inode_mismatch, stale } }
 */
export function watchLag(first, later = first) {
  const lag = {};
  for (const [source, position] of Object.entries(later.positions)) {
    const then = first.disk[source] ?? null;
    const disk = later.disk[source] ?? null;
    const bound = position.inode ?? null;
    const sameFile = disk !== null && bound === disk.inode;
    let stale = false;
    // A log absent at the first look has nothing to fall behind.
    if (then !== null) {
      if (bound !== then.inode && bound !== (disk?.inode ?? null)) {
        // Bound to neither the file at the path then nor the file there now:
        // the pre-fix rename stall, or a log that appeared and was never armed.
        stale = true;
      } else if (disk !== null && bound === then.inode && then.inode === disk.inode) {
        // The same file throughout: short of the bytes it held at the first
        // look, or claiming bytes neither look saw (a truncation it missed).
        stale = position.offset < then.bytes
          || position.offset > Math.max(then.bytes, disk.bytes);
      }
      // Otherwise the file was replaced between the looks and the watcher is
      // on the newer one or has yet to move; the next status call can judge.
    }
    lag[source] = {
      consumed_bytes: position.offset ?? null,
      disk_bytes: disk?.bytes ?? null,
      // Across a replacement the two counts describe different files.
      bytes_behind: sameFile ? disk.bytes - position.offset : null,
      inode_mismatch: disk !== null && !sameFile,
      stale,
    };
  }
  return lag;
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
