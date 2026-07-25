#!/usr/bin/env node
/**
 * backfill-app-sessions.js — Import Claude desktop-app and Cowork session
 * metadata into the cartographer event log.
 *
 * The desktop app keeps a per-session metadata file (title, cwd, timestamps,
 * cliSessionId) that the transcript store never sees. Two things in there are
 * worth recovering:
 *
 *   1. TITLES — human-readable session names ("SPF trilogy") keyed to CLI
 *      session ids. Transcripts and hook events have no titles at all.
 *   2. COWORK SESSIONS — they run in VMs (cwd: /sessions/<name>), so their
 *      transcripts never land in ~/.claude/projects. The metadata file's
 *      title + initialMessage is the ONLY locally recoverable record.
 *
 * Stores walked (macOS paths; see mindmap-mcp-server's import.ts for the
 * cross-tool catalog that pointed at these):
 *   ~/Library/Application Support/Claude/claude-code-sessions/        (desktop)
 *   ~/Library/Application Support/Claude/local-agent-mode-sessions/   (cowork)
 *
 * Events are appended to changelog.jsonl with deterministic event_ids
 * (app-<local-session-uuid>), so re-runs are no-ops. Run
 * `node scripts/embed-events.js` afterwards to index into Qdrant.
 *
 * Usage:
 *   node scripts/backfill-app-sessions.js [--dry-run] [--limit N]
 *
 * Environment:
 *   CARTOGRAPHER_DEV_DIR — log directory (default: ~/Documents/dev)
 */

import { appendFileSync, existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const DEV_DIR = process.env.CARTOGRAPHER_DEV_DIR || join(homedir(), 'Documents', 'dev');
const CHANGELOG = join(DEV_DIR, 'changelog.jsonl');
const TRANSCRIPTS_DIR = process.env.CARTOGRAPHER_TRANSCRIPTS_DIR || join(homedir(), '.claude', 'projects');
const APP_SUPPORT = join(homedir(), 'Library', 'Application Support', 'Claude');

const STORES = [
  { dir: join(APP_SUPPORT, 'claude-code-sessions'), store: 'desktop' },
  { dir: join(APP_SUPPORT, 'local-agent-mode-sessions'), store: 'cowork' },
];

const DRY_RUN = process.argv.includes('--dry-run');
const limitIdx = process.argv.indexOf('--limit');
const LIMIT = limitIdx > -1 ? parseInt(process.argv[limitIdx + 1], 10) : Infinity;

/** Recursively collect local_*.json files (stores nest by org/project dirs). */
function collectSessionFiles(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) collectSessionFiles(p, out);
    else if (e.name.startsWith('local_') && e.name.endsWith('.json')) out.push(p);
  }
  return out;
}

/** Map cliSessionId → transcript path, built once from one walk of the tree. */
function buildTranscriptMap() {
  const map = new Map();
  let projects;
  try {
    projects = readdirSync(TRANSCRIPTS_DIR, { withFileTypes: true });
  } catch {
    return map;
  }
  for (const proj of projects) {
    if (!proj.isDirectory()) continue;
    const projPath = join(TRANSCRIPTS_DIR, proj.name);
    let files;
    try {
      files = readdirSync(projPath);
    } catch {
      continue;
    }
    for (const f of files) {
      if (f.endsWith('.jsonl')) map.set(f.slice(0, -6), join(projPath, f));
    }
  }
  return map;
}

/** Existing app-session event_ids in the changelog (dedup for re-runs). */
function existingEventIds() {
  const ids = new Set();
  if (!existsSync(CHANGELOG)) return ids;
  for (const line of readFileSync(CHANGELOG, 'utf-8').split('\n')) {
    const m = line.match(/"event_id":"(app-[^"]+)"/);
    if (m) ids.add(m[1]);
  }
  return ids;
}

function isoFromMs(ms) {
  const n = Number(ms);
  if (!isFinite(n) || n <= 0) return null;
  return new Date(n).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

const transcriptMap = buildTranscriptMap();
const existing = existingEventIds();

let written = 0;
let skippedDup = 0;
let skippedBad = 0;
const counts = { desktop: 0, cowork: 0, orphaned: 0 };

for (const { dir, store } of STORES) {
  for (const file of collectSessionFiles(dir)) {
    if (written >= LIMIT) break;

    let meta;
    try {
      meta = JSON.parse(readFileSync(file, 'utf-8'));
    } catch {
      skippedBad++;
      continue;
    }

    const localId = String(meta.sessionId || '').replace(/^local_(ditto_)?/, '');
    const title = (meta.title || '').trim();
    if (!localId || !title) {
      skippedBad++;
      continue;
    }

    const eventId = `app-${localId}`;
    if (existing.has(eventId)) {
      skippedDup++;
      continue;
    }

    const cliId = meta.cliSessionId || '';
    const transcriptPath = cliId ? transcriptMap.get(cliId) || '' : '';
    const cwd = meta.originCwd || meta.cwd || '';
    // Cowork cwds are VM paths (/sessions/<name>) — no real project to name.
    const isCowork = store === 'cowork' || cwd.startsWith('/sessions/');
    const project = isCowork ? 'cowork' : (cwd.split('/').filter(Boolean).pop() || 'unknown');

    // Summary feeds the BM25 fallback chain and the embedding text. Title
    // leads; Cowork sessions also carry their initialMessage — for them it
    // is the only recoverable content, so include a generous slice.
    let summary = `[${store}] Session: ${title}`;
    if (isCowork && typeof meta.initialMessage === 'string' && meta.initialMessage.trim()) {
      summary += ` — ${meta.initialMessage.trim().replace(/\s+/g, ' ').slice(0, 500)}`;
    }

    // Salience by how unique this record is: Cowork sessions (0.7) and
    // orphaned desktop sessions (0.6) are the only surviving record;
    // transcript-backed desktop sessions (0.5) mainly contribute the title.
    const orphaned = !transcriptPath;
    const salience = isCowork ? 0.7 : orphaned ? 0.6 : 0.5;
    if (isCowork) counts.cowork++;
    else counts.desktop++;
    if (orphaned) counts.orphaned++;

    const event = {
      event_id: eventId,
      timestamp: isoFromMs(meta.createdAt) || isoFromMs(meta.lastActivityAt) || new Date().toISOString(),
      type: 'app_session',
      session_id: cliId,
      project,
      cwd,
      summary,
      title,
      source_store: store,
      salience,
    };
    if (transcriptPath) event.transcript_path = transcriptPath;

    if (DRY_RUN) {
      console.log(JSON.stringify(event).slice(0, 200));
    } else {
      appendFileSync(CHANGELOG, JSON.stringify(event) + '\n');
    }
    written++;
    existing.add(eventId);
  }
}

const verb = DRY_RUN ? 'would write' : 'wrote';
console.log(
  `\n${verb} ${written} app_session events ` +
  `(${counts.desktop} desktop, ${counts.cowork} cowork; ${counts.orphaned} with no surviving transcript)\n` +
  `skipped: ${skippedDup} already imported, ${skippedBad} unparseable`
);
if (!DRY_RUN && written > 0) {
  console.log('next: node scripts/embed-events.js   # index the new events into Qdrant');
}
