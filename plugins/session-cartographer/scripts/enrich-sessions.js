#!/usr/bin/env node
// enrich-sessions.js — Infer session_id for orphan events in changelog.jsonl.
//
// Builds session time windows from events that already have session_id,
// extends them with transcript first/last timestamps, then matches orphan
// events (backfilled git commits, etc.) by project + time overlap.
//
// Usage:
//   node scripts/enrich-sessions.js                  # Preview (dry run)
//   node scripts/enrich-sessions.js --write          # Update changelog.jsonl in place
//   node scripts/enrich-sessions.js --write --reindex # Also re-index updated events in Qdrant

import { readFileSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import { execSync } from 'child_process';
import { buildSessionWindows, defaultPaths, readJsonl, toSortedList } from './session-windows.js';

const { changelog: CHANGELOG, milestones: MILESTONES, transcripts: TRANSCRIPTS } = defaultPaths();

const doWrite = process.argv.includes('--write');
const doReindex = process.argv.includes('--reindex');

// ─── Steps 1-2: Build session windows (shared with repair-orphan-sessions.js) ───

const { sessions, extended: transcriptExtended } = buildSessionWindows({
  sources: [CHANGELOG, MILESTONES],
  transcriptDirs: [TRANSCRIPTS],
});

console.log(`Session windows: ${sessions.size} (${transcriptExtended} extended from transcripts)`);

// ─── Step 3: Match orphan events to sessions ───

const sessionList = toSortedList(sessions);

function findSession(timestamp, project) {
  // Prefer project+time match, fall back to time-only
  let timeOnlyMatch = null;

  for (const s of sessionList) {
    if (s.start > timestamp) break; // past the window
    if (timestamp >= s.start && timestamp <= s.end) {
      if (s.projects.has(project)) {
        return s; // project+time match — best
      }
      if (!timeOnlyMatch) timeOnlyMatch = s;
    }
  }

  return timeOnlyMatch;
}

// ─── Step 4: Enrich changelog events ───

const events = readJsonl(CHANGELOG);
let enriched = 0;
let alreadyHad = 0;
let unmatched = 0;

const updatedEvents = events.map(e => {
  if (e.session_id) {
    alreadyHad++;
    // Even events with session_id might be missing transcript_path
    if (!e.transcript_path) {
      const s = sessions.get(e.session_id);
      if (s?.transcriptPath) {
        e.transcript_path = s.transcriptPath;
        enriched++;
      }
    }
    return e;
  }

  // Skip memory events — they're not session-scoped
  if (e.type?.startsWith('memory_')) return e;

  const match = findSession(e.timestamp, e.project);
  if (match) {
    e.session_id = match.sid;
    if (match.transcriptPath) e.transcript_path = match.transcriptPath;
    enriched++;
  } else {
    unmatched++;
  }
  return e;
});

console.log(`Already had session_id: ${alreadyHad}`);
console.log(`Enriched: ${enriched}`);
console.log(`Unmatched: ${unmatched}`);

if (doWrite) {
  // Backup
  const backup = CHANGELOG + '.bak';
  writeFileSync(backup, readFileSync(CHANGELOG));
  console.log(`Backup: ${backup}`);

  // Write enriched changelog
  const output = updatedEvents.map(e => JSON.stringify(e)).join('\n') + '\n';
  writeFileSync(CHANGELOG, output);
  console.log(`Updated: ${CHANGELOG}`);

  if (doReindex) {
    console.log('Re-indexing into Qdrant...');
    try {
      execSync('node scripts/embed-events.js --reindex', { cwd: dirname(CHANGELOG), stdio: 'inherit' });
    } catch (err) {
      console.error('Reindex failed — run manually: node scripts/embed-events.js --reindex');
    }
  }
} else {
  console.log('\nDry run — pass --write to update changelog.jsonl');
}
