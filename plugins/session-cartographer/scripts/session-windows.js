#!/usr/bin/env node
/**
 * Shared session-window construction.
 *
 * Builds, for every session id the corpus knows about, the time window it was
 * active in, the projects and working directories it touched, and its
 * transcript path. Two consumers with deliberately different matching policies
 * share this:
 *
 *   enrich-sessions.js        — loose: fills orphan changelog events, accepts a
 *                               time-only match when no project matches.
 *   repair-orphan-sessions.js — strict: requires a project match, refuses
 *                               ambiguity, verifies the transcript on disk.
 *
 * The window build is identical for both; only the policy on top differs.
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { isResolved } from './sentinels.js';

export function readJsonl(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf-8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

export function defaultPaths() {
  const dev = process.env.CARTOGRAPHER_DEV_DIR || join(homedir(), 'Documents/dev');
  return {
    dev,
    changelog: join(dev, 'changelog.jsonl'),
    milestones: join(dev, 'session-milestones.jsonl'),
    transcripts: process.env.CARTOGRAPHER_TRANSCRIPTS_DIR || join(homedir(), '.claude/projects'),
  };
}

// Note on Codex: the directory scan below is Claude-only, because
// ~/.codex/sessions nests by date and the filename is not the session id.
// Codex sessions still get windows — the event logs carry their session_id and
// transcript_path directly, so they arrive via `sources`, not the scan.

const normTs = (ts) => (typeof ts === 'number' ? new Date(ts).toISOString() : ts);

/**
 * @returns {Map<string, {start,end,projects:Set,cwds:Set,transcriptPath:string,
 *                        transcriptStart:string,transcriptEnd:string}>}
 */
export function buildSessionWindows({ sources, transcriptDirs, collectStamps = false }) {
  const sessions = new Map();

  const touch = (sid, ts, project, cwd, transcriptPath) => {
    // Sentinels are not sessions. Admitting one builds a phantom window that
    // spans the whole corpus and shows up as a false candidate against every
    // real session. See sentinels.js for what this cost the first time.
    if (!isResolved(sid) || !ts) return;
    let s = sessions.get(sid);
    if (!s) {
      s = {
        start: ts,
        end: ts,
        projects: new Set(),
        cwds: new Set(),
        transcriptPath: '',
        transcriptStart: '',
        transcriptEnd: '',
        // project → sorted epoch-ms of that session's events in that project.
        // A session window spans everything between first and last event, which
        // for a session resumed over days is uselessly wide. The stamps say
        // where the session was actually *doing* something.
        stampsByProject: collectStamps ? new Map() : null,
      };
      sessions.set(sid, s);
    }
    if (ts < s.start) s.start = ts;
    if (ts > s.end) s.end = ts;
    if (project) s.projects.add(project);
    if (cwd) s.cwds.add(cwd);
    if (transcriptPath && !s.transcriptPath) s.transcriptPath = transcriptPath;
    if (s.stampsByProject && project) {
      const ms = Date.parse(ts);
      if (Number.isFinite(ms)) {
        let arr = s.stampsByProject.get(project);
        if (!arr) { arr = []; s.stampsByProject.set(project, arr); }
        arr.push(ms);
      }
    }
  };

  for (const file of sources) {
    for (const e of readJsonl(file)) {
      touch(e.session_id || e.session, e.timestamp, e.project, e.cwd, e.transcript_path);
    }
  }

  if (collectStamps) {
    for (const s of sessions.values()) {
      for (const arr of s.stampsByProject.values()) arr.sort((a, b) => a - b);
    }
  }

  let extended = 0;
  for (const root of transcriptDirs) {
    extended += scanTranscriptRoot(root, sessions, touch);
  }

  return { sessions, extended };
}

// Transcript first/last timestamps are kept separately from the event-derived
// window: verifying a repair against the transcript's own range is stricter
// than verifying against a window the events already widened.
function scanTranscriptRoot(root, sessions, touch) {
  let extended = 0;
  let dirs;
  try {
    dirs = readdirSync(root);
  } catch {
    return 0; // transcript root absent — fine, this is best-effort
  }

  for (const entry of dirs) {
    const entryPath = join(root, entry);
    let isDir;
    try { isDir = statSync(entryPath).isDirectory(); } catch { continue; }
    if (!isDir) continue;

    let files;
    try { files = readdirSync(entryPath); } catch { continue; }

    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue;
      const sid = file.replace('.jsonl', '');
      const transcriptPath = join(entryPath, file);

      let tsStart;
      let tsEnd;
      try {
        const lines = readFileSync(transcriptPath, 'utf-8').split('\n').filter((l) => l.trim());
        if (lines.length === 0) continue;
        tsStart = normTs(JSON.parse(lines[0]).timestamp);
        tsEnd = normTs(JSON.parse(lines[lines.length - 1]).timestamp);
      } catch {
        continue; // unreadable or non-JSONL — skip
      }
      if (!tsStart || !tsEnd) continue;

      const existing = sessions.get(sid);
      if (!existing) {
        touch(sid, tsStart, entry, '', transcriptPath);
        extended += 1;
      }
      const s = sessions.get(sid);
      if (tsStart < s.start) s.start = tsStart;
      if (tsEnd > s.end) s.end = tsEnd;
      if (!s.transcriptPath) s.transcriptPath = transcriptPath;
      s.transcriptStart = tsStart;
      s.transcriptEnd = tsEnd;
    }
  }
  return extended;
}

export function toSortedList(sessions) {
  return [...sessions.entries()]
    .map(([sid, s]) => ({ sid, ...s }))
    .sort((a, b) => a.start.localeCompare(b.start));
}
