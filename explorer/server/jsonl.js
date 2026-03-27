import { readFileSync, statSync, watch, openSync, readSync, closeSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const DEV_DIR = process.env.CARTOGRAPHER_DEV_DIR || join(homedir(), 'Documents', 'dev');

export const LOG_FILES = {
  changelog: join(DEV_DIR, 'changelog.jsonl'),
  research: join(DEV_DIR, 'research-log.jsonl'),
  milestones: join(DEV_DIR, 'session-milestones.jsonl'),
  'tool-use': join(DEV_DIR, 'tool-use-log.jsonl'),
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
 * Read all events from all known log files, tagged with source.
 * Deduplicates by event_id (same event in changelog + domain log).
 */
export function readAllEvents() {
  const all = [];
  const seen = new Set();

  for (const [source, filePath] of Object.entries(LOG_FILES)) {
    for (const event of readJsonlFile(filePath)) {
      const id = event.event_id;
      // Deduplicate: prefer domain log (research/milestones) over changelog
      if (id && seen.has(id)) {
        // If we already have this from changelog, replace with domain source
        if (source !== 'changelog') {
          const idx = all.findIndex(e => e.event_id === id);
          if (idx !== -1) all[idx] = { ...event, _source: source };
        }
        continue;
      }
      if (id) seen.add(id);
      all.push({ ...event, _source: source });
    }
  }

  // Sort by timestamp descending (newest first)
  all.sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''));
  return all;
}

/**
 * Watch all JSONL files for new events. Calls onNewEvents(events) when new
 * lines appear. Uses byte offsets to avoid re-reading entire files.
 * Returns a cleanup function.
 */
export function watchFiles(onNewEvents) {
  const offsets = {};
  const watchers = [];

  // Initialize offsets to current file sizes (don't replay history)
  for (const [source, filePath] of Object.entries(LOG_FILES)) {
    try {
      offsets[source] = statSync(filePath).size;
    } catch {
      offsets[source] = 0;
    }
  }

  for (const [source, filePath] of Object.entries(LOG_FILES)) {
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

        // Detect truncation/rotation
        if (size < offsets[source]) {
          offsets[source] = 0;
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
