/**
 * Session summarisation — the fold behind /api/sessions.
 *
 * Extracted from app.js so the attribution rules below are testable without
 * booting a server. Behaviour is a pure function of the events handed in; the
 * only I/O is the transcript derivation, which the caller injects.
 *
 * Two rules here are load-bearing and were both wrong before the Codex port:
 *
 *   provider. Roughly half this corpus is Codex (54,826 of 110,752 changelog
 *   events; 30 of the 130 sessions in a 7-day window), and the fold dropped the
 *   field entirely — so every downstream view rendered a mixed corpus as if it
 *   were one agent. Resolve it through isResolved() rather than truthiness:
 *   writers spell absence as "", "unknown" and null, and "unknown" is truthy,
 *   so a naive count would mint a third agent.
 *
 *   transcript derivation. The old fallback built
 *   ~/.claude/projects/<encoded>/<sid>.jsonl for ANY session missing a recorded
 *   path — a shape that can never be right for Codex, whose transcripts live in
 *   ~/.codex/sessions and move to ~/.codex/archived_sessions on completion.
 *   Derivation is now per-provider, and a session whose provider is unresolved
 *   gets both candidates tried rather than one guessed.
 */

import { isResolved } from '../../scripts/sentinels.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function normalizeTs(ts) {
  return typeof ts === 'number' ? new Date(ts).toISOString() : ts;
}

/** The session id a record claims, or null when it claims none. */
export function sessionIdOf(event) {
  const sid = event.session_id ?? event.session ?? event.sessionId;
  return isResolved(sid) ? sid : null;
}

/**
 * The agent that produced a session: the most-attested resolved provider across
 * its events. Ties break toward the first seen, which is the earliest event.
 * Returns { provider, providers } — `providers` lists every resolved value, so
 * a genuinely mixed session (a relay, a misattributed hook) stays visible
 * instead of being silently flattened to its majority.
 */
export function attributeProvider(events) {
  const counts = new Map();
  for (const event of events) {
    const value = event.provider;
    if (!isResolved(value)) continue;
    const key = String(value).trim().toLowerCase();
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  if (counts.size === 0) return { provider: '', providers: [] };
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  return { provider: ranked[0][0], providers: ranked.map(([name]) => name) };
}

/**
 * Summarise events into session records for the given window.
 *
 * @param {object[]} events        the warm corpus
 * @param {object}   options
 * @param {number}   options.days  window size, already clamped by the caller
 * @param {function} options.isHighSignal   event → keep in the card preview
 * @param {function} options.deriveTranscript  ({session_id, provider, project})
 *        → a path that exists, or ''. Injected because resolution is I/O and
 *        differs per provider; see transcripts.js for the two shapes.
 * @param {number}   options.now   epoch ms, for deterministic tests
 */
export function summarizeSessions(events, { days = 7, isHighSignal = () => true, deriveTranscript = () => '', now = Date.now() } = {}) {
  const cutoff = new Date(now - days * DAY_MS).toISOString();

  const bySession = new Map();
  for (const event of events) {
    const sid = sessionIdOf(event);
    if (!sid) continue;
    if (!bySession.has(sid)) bySession.set(sid, []);
    bySession.get(sid).push({ ...event, timestamp: normalizeTs(event.timestamp) });
  }

  const sessions = [];
  for (const [sid, evts] of bySession) {
    if (evts.length < 2) continue;
    let start = evts[0].timestamp, end = evts[0].timestamp;
    const projectCounts = {}, typeCounts = {}, quadrantCounts = {}, commitTypeCounts = {};
    let recordedPath = '';

    for (const e of evts) {
      if (e.timestamp < start) start = e.timestamp;
      if (e.timestamp > end) end = e.timestamp;
      const p = e.project || '';
      if (p) projectCounts[p] = (projectCounts[p] || 0) + 1;
      const t = e.type || '';
      if (t) typeCounts[t] = (typeCounts[t] || 0) + 1;
      if (e.diff_shape?.quadrant) quadrantCounts[e.diff_shape.quadrant] = (quadrantCounts[e.diff_shape.quadrant] || 0) + 1;
      if (e.diff_shape?.commit_type) commitTypeCounts[e.diff_shape.commit_type] = (commitTypeCounts[e.diff_shape.commit_type] || 0) + 1;
      if (!recordedPath && e.transcript_path) recordedPath = e.transcript_path;
    }

    if (end < cutoff) continue;

    const { provider, providers } = attributeProvider(evts);
    const project = Object.entries(projectCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || '';
    const transcriptPath = deriveTranscript({ session_id: sid, provider, project, recorded_path: recordedPath }) || '';
    const highSignal = evts.filter(isHighSignal).slice(0, 200);

    sessions.push({
      session_id: sid, start, end, event_count: evts.length, project, provider, providers,
      projects: Object.keys(projectCounts), types: typeCounts, quadrants: quadrantCounts, commit_types: commitTypeCounts,
      transcript_path: transcriptPath,
      // A recorded path that no longer resolves is worth saying out loud: it is
      // the difference between "this session has no transcript" and "Codex
      // archived it and we could not find where."
      transcript_path_status: transcriptPath
        ? (recordedPath && transcriptPath !== recordedPath ? 'resolved' : recordedPath ? 'recorded' : 'derived')
        : (recordedPath ? 'unresolved' : 'absent'),
      events: highSignal.map(e => ({
        event_id: e.event_id, timestamp: e.timestamp, type: e.type || e._source || '',
        project: e.project, provider: isResolved(e.provider) ? e.provider : '',
        summary: (e.summary || e.display || e.description || '').slice(0, 120),
        ...(e.transcript_path ? { transcript_path: e.transcript_path } : {}),
      })),
    });
  }

  // Associate orphan commits (backfilled, no session_id) with sessions by
  // project + time overlap.
  const orphanCommits = events.filter(e => e.type === 'git_commit' && !sessionIdOf(e) && e.diff_shape);
  for (const commit of orphanCommits) {
    for (const s of sessions) {
      if (commit.timestamp >= s.start && commit.timestamp <= s.end && s.projects.includes(commit.project)) {
        if (commit.diff_shape.quadrant) s.quadrants[commit.diff_shape.quadrant] = (s.quadrants[commit.diff_shape.quadrant] || 0) + 1;
        if (commit.diff_shape.commit_type) s.commit_types[commit.diff_shape.commit_type] = (s.commit_types[commit.diff_shape.commit_type] || 0) + 1;
        break; // assign to first matching session
      }
    }
  }

  sessions.sort((a, b) => b.start.localeCompare(a.start));

  const overlaps = [];
  for (let i = 0; i < sessions.length; i++) {
    for (let j = i + 1; j < sessions.length; j++) {
      const a = sessions[i], b = sessions[j];
      if (a.start < b.end && b.start < a.end) {
        overlaps.push({
          sessions: [a.session_id, b.session_id],
          start: a.start > b.start ? a.start : b.start,
          end: a.end < b.end ? a.end : b.end,
        });
      }
    }
  }

  return { sessions, overlaps };
}
