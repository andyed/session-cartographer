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

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'fs';
import { join, basename, dirname } from 'path';
import { homedir } from 'os';
import { execSync } from 'child_process';

const DEV = process.env.CARTOGRAPHER_DEV_DIR || join(homedir(), 'Documents/dev');
const TRANSCRIPTS = process.env.CARTOGRAPHER_TRANSCRIPTS_DIR || join(homedir(), '.claude/projects');
const CHANGELOG = join(DEV, 'changelog.jsonl');
const MILESTONES = join(DEV, 'session-milestones.jsonl');

const doWrite = process.argv.includes('--write');
const doReindex = process.argv.includes('--reindex');

// ─── Step 1: Build session windows from existing events ───

function readJsonl(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf-8')
    .split('\n')
    .filter(l => l.trim())
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

const sessions = new Map(); // session_id → { start, end, projects, transcriptPath }

function updateSession(sid, ts, project, transcriptPath) {
  if (!sid || !ts) return;
  let s = sessions.get(sid);
  if (!s) {
    s = { start: ts, end: ts, projects: new Set(), transcriptPath: '' };
    sessions.set(sid, s);
  }
  if (ts < s.start) s.start = ts;
  if (ts > s.end) s.end = ts;
  if (project) s.projects.add(project);
  if (transcriptPath && !s.transcriptPath) s.transcriptPath = transcriptPath;
}

// From changelog + milestones
for (const file of [CHANGELOG, MILESTONES]) {
  for (const e of readJsonl(file)) {
    const sid = e.session_id || e.session;
    updateSession(sid, e.timestamp, e.project, e.transcript_path);
  }
}

// ─── Step 2: Extend session windows from transcript files ───

function scanTranscripts() {
  let extended = 0;
  try {
    for (const projectDir of readdirSync(TRANSCRIPTS)) {
      const projectPath = join(TRANSCRIPTS, projectDir);
      if (!statSync(projectPath).isDirectory()) continue;

      for (const file of readdirSync(projectPath)) {
        if (!file.endsWith('.jsonl')) continue;
        const sid = file.replace('.jsonl', '');
        const transcriptPath = join(projectPath, file);

        try {
          const content = readFileSync(transcriptPath, 'utf-8');
          const lines = content.split('\n').filter(l => l.trim());
          if (lines.length === 0) continue;

          const first = JSON.parse(lines[0]);
          const last = JSON.parse(lines[lines.length - 1]);
          const tsStart = first.timestamp;
          const tsEnd = last.timestamp;
          if (!tsStart || !tsEnd) continue;

          // Normalize numeric timestamps
          const normTs = (ts) => typeof ts === 'number' ? new Date(ts).toISOString() : ts;

          const s = sessions.get(sid);
          if (!s) {
            sessions.set(sid, {
              start: normTs(tsStart),
              end: normTs(tsEnd),
              projects: new Set([projectDir]),
              transcriptPath,
            });
            extended++;
          } else {
            const ns = normTs(tsStart);
            const ne = normTs(tsEnd);
            if (ns < s.start) s.start = ns;
            if (ne > s.end) s.end = ne;
            if (!s.transcriptPath) s.transcriptPath = transcriptPath;
          }
        } catch { /* skip unreadable transcripts */ }
      }
    }
  } catch { /* transcripts dir missing */ }
  return extended;
}

const transcriptExtended = scanTranscripts();

console.log(`Session windows: ${sessions.size} (${transcriptExtended} extended from transcripts)`);

// ─── Step 3: Match orphan events to sessions ───

// Build sorted session list for efficient matching
const sessionList = [...sessions.entries()]
  .map(([sid, s]) => ({ sid, ...s }))
  .sort((a, b) => a.start.localeCompare(b.start));

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
