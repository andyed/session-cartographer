import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pipeline } from 'node:stream/promises';
import { firstResolved, isResolved } from '../../scripts/sentinels.js';
import { editSummaryPaths } from '../../scripts/edit-paths.js';
import { eventEpochMs } from './event-time.js';
import { CORPUS_ROOT } from './jsonl.js';
import { createTranscriptEnricher, missingTokens } from './memory-transcript.js';
import { activityFromMemory, normalizeActivityScope, projectMemoryScope } from '../shared/activity-scope.js';
import { createDayDigestSource, readDayParams } from './memory-day.js';
import { createRecallSource, fetchIndexedEvents, listRecallCalls, recallCallDetail, resolveUnplacedMarks, RECALL_CALL_LIMIT, RECALL_DEFAULT_WINDOW_MS, RECALL_MAX_WINDOW_MS } from './memory-recall.js';

const execFileAsync = promisify(execFile);
const HOUR_MS = 60 * 60 * 1000;
const DEFAULT_WINDOW_HOURS = 24;
const MAX_WINDOW_HOURS = 90 * 24;
const PREVIEW_LIMIT = 256 * 1024;
const PREVIEW_LINES = 2000;
const DIFF_LIMIT = 256 * 1024;
const DIFF_LINES = 4000;
export const MEMORY_CONTRACT_VERSION = 1;
export const MEMORY_REFRESH_MS = 5000;

function text(value) {
  return typeof value === 'string' && isResolved(value) ? value.trim() : '';
}

function eventType(event) {
  return String(firstResolved([event.type, event.event, event.milestone, event._source], '')).toLowerCase();
}

function category(event) {
  const type = eventType(event);
  if (type === 'tool_file_edit' || type === 'file_edit') return 'edit';
  if (type === 'git_commit') return 'commit';
  if (/search|fetch|research/.test(type)) return 'research';
  if (event._source === 'milestones' || /^(milestone|session_|sessionend|sessionstart|agent_|stop$|compaction|wrapup)/.test(type)) return 'lifecycle';
  return 'activity';
}

function projectLabel(event) {
  const project = text(firstResolved([event.project, event.repo]));
  return project ? (path.isAbsolute(project) ? path.basename(project) : project) : 'Unattributed';
}

function within(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** Only existing files inside the indexed workspace become review targets. */
export function resolveMemoryFile(candidate, cwd, corpusRoot) {
  if (typeof candidate !== 'string' || !candidate.trim() || candidate.includes('\0')) return null;
  let value = candidate.trim();
  if (/^(["'`]).*\1$/.test(value)) value = value.slice(1, -1);
  if (!path.isAbsolute(value) && (!text(cwd) || !path.isAbsolute(cwd))) return null;
  try {
    const root = fs.realpathSync(corpusRoot);
    const absolute = fs.realpathSync(path.isAbsolute(value) ? value : path.resolve(cwd, value));
    return within(root, absolute) && fs.statSync(absolute).isFile() ? absolute : null;
  } catch {
    return null;
  }
}

function editPaths(event, corpusRoot) {
  const candidates = [];
  const add = (value) => {
    if (typeof value === 'string') candidates.push(value);
    else if (value && typeof value === 'object') {
      const candidate = firstResolved([value.file_path, value.path, value.file]);
      if (typeof candidate === 'string') candidates.push(candidate);
    }
  };
  add(event.file_path);
  add(event.filePath);
  add(event.tool_input?.file_path);
  for (const field of [event.files, event.files_changed]) {
    if (Array.isArray(field)) field.forEach(add);
    else add(field);
  }
  // These are the edit hook's explicit output forms. Do not infer paths from
  // arbitrary shell commands, prompts, or prose that happens to name a file.
  const summary = text(firstResolved([event.summary, event.description]));
  candidates.push(...editSummaryPaths(summary, (value) => resolveMemoryFile(value, event.cwd, corpusRoot)));
  return [...new Set(candidates.map((candidate) => resolveMemoryFile(candidate, event.cwd, corpusRoot)).filter(Boolean))];
}

function compactTitle(value) {
  const clean = text(value).replace(/\s+/g, ' ');
  if (!clean || clean.startsWith('<') || clean.startsWith('{') || clean.length < 3) return '';
  return clean.length > 80 ? `${clean.slice(0, 77).trimEnd()}…` : clean;
}

function noteText(event) {
  return text(firstResolved([event.summary, event.display, event.description, event.prompt, event.url, event.query, event.event_id, event.milestone])).replace(/\s+/g, ' ').slice(0, 500);
}

function stableHash(values) {
  let hash = 0x811c9dc5;
  for (const value of values) for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function sessionId(event) {
  const value = firstResolved([event.session_id, event.session, event.sessionId]);
  return typeof value === 'string' || typeof value === 'number' ? String(value).trim() || null : null;
}

function providerLabel(event) {
  const value = text(event.provider).toLowerCase();
  return value || null;
}

/** A fold over the owning service's warm corpus, with no ranking or log reads. */
export function projectMemory(events, { now = Date.now(), hours = DEFAULT_WINDOW_HOURS, corpusRoot = CORPUS_ROOT } = {}) {
  if (!Number.isInteger(hours) || hours < 1 || hours > MAX_WINDOW_HOURS) throw new RangeError('Memory window hours must be an integer between 1 and 2160.');
  const start = now - hours * HOUR_MS;
  let availableStart = null;
  let availableEnd = null;
  const deduped = new Map();
  const anonymous = [];
  const fullRanges = new Map();
  const revisionParts = [];
  for (const event of events) {
    const t = eventEpochMs(event);
    if (!Number.isFinite(t)) continue;
    const sid = sessionId(event);
    if (sid) {
      const range = fullRanges.get(sid) || { from: t, through: t };
      range.from = Math.min(range.from, t);
      range.through = Math.max(range.through, t);
      fullRanges.set(sid, range);
    }
    revisionParts.push(`${t}:${text(event.event_id)}:${projectLabel(event)}:${providerLabel(event) || ''}:${eventType(event)}`);
    availableStart = availableStart === null ? t : Math.min(availableStart, t);
    availableEnd = availableEnd === null ? t : Math.max(availableEnd, t);
    if (t < start || t > now) continue;
    const id = text(event.event_id);
    if (!id) { anonymous.push(event); continue; }
    if (!deduped.has(id)) deduped.set(id, { ...event });
    else {
      const existing = deduped.get(id);
      for (const [key, value] of Object.entries(event)) {
        if (isResolved(value) && (!isResolved(existing[key]) || (typeof value === 'string' && value.length > (existing[key]?.length || 0)))) existing[key] = value;
      }
    }
  }
  const rows = [...deduped.values(), ...anonymous].sort((a, b) => eventEpochMs(a) - eventEpochMs(b) || text(a.event_id).localeCompare(text(b.event_id)));
  const sessions = new Map();
  const fileMaps = new Map();
  const evidenceIndex = [];
  let unattributed = 0;
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
    const event = rows[rowIndex];
    const id = sessionId(event);
    const t = eventEpochMs(event);
    const cat = category(event);
    const project = projectLabel(event);
    const eventId = text(event.event_id) || null;
    const provider = providerLabel(event);
    const resolvedPaths = cat === 'edit' ? editPaths(event, corpusRoot) : [];
    evidenceIndex.push({
      key: eventId || `anonymous:${t}:${rowIndex}`,
      id: eventId,
      event_id: eventId,
      t,
      timestamp: new Date(t).toISOString(),
      sessionId: id,
      session_id: id,
      project,
      provider,
      type: eventType(event),
      category: cat,
      text: noteText(event),
      summary: noteText(event),
      transcript_path: text(event.transcript_path) || null,
      files: resolvedPaths,
      source: text(event._source) || null,
      quadrant: text(event.diff_shape?.quadrant) || null,
      commit_type: text(event.diff_shape?.commit_type) || null,
      evidence: [cat, ...(cat === 'commit' || /wrapup/.test(eventType(event)) ? ['outcome'] : [])],
    });
    if (!id) { unattributed += 1; continue; }
    if (!sessions.has(id)) {
      sessions.set(id, { id, title: '', fullTitle: '', group: '', projects: Object.create(null), events: [], wraps: [], notes: [], outcomes: [], provider: null, providers: [], cwd: null, count: 0, lifecycleOnly: true, transcript: null, transcriptPaths: [], promptTitle: '', _editEvidence: [], fullRange: fullRanges.get(id) || null });
      fileMaps.set(id, new Map());
    }
    const session = sessions.get(id);
    if (provider) {
      session.provider ||= provider;
      if (!session.providers.includes(provider)) session.providers.push(provider);
    }
    if (path.isAbsolute(text(event.cwd))) session.cwd ||= text(event.cwd);
    session.events.push([t, cat, eventId, project]);
    session.projects[project] = (session.projects[project] || 0) + 1;
    session.count += 1;
    session.lifecycleOnly &&= cat === 'lifecycle';
    if (/wrapup/.test(eventType(event)) || /wrapup/i.test(text(event.milestone))) session.wraps.push({ t, id: eventId });
    session.title ||= compactTitle(firstResolved([event.session_title, event.title]));
    session.fullTitle ||= text(firstResolved([event.session_title, event.title])).replace(/\s+/g, ' ').slice(0, 600);
    session.transcript ||= text(event.transcript_path) || null;
    if (text(event.transcript_path) && !session.transcriptPaths.includes(event.transcript_path)) session.transcriptPaths.push(event.transcript_path);
    session.promptTitle ||= compactTitle(firstResolved([event.prompt, event.user_prompt, /prompt|user_message/.test(eventType(event)) ? firstResolved([event.summary, event.description, event.display]) : null]));
    const note = noteText(event);
    if (note) {
      const observation = { t, id: eventId, type: eventType(event), text: note };
      session.notes.push(observation);
      if (cat === 'commit' || /wrapup/.test(eventType(event))) session.outcomes.push(observation);
    }
    if (cat === 'edit') session._editEvidence.push({ ...event, t });
    if (cat !== 'edit' || !eventId) continue;
    const files = fileMaps.get(id);
    for (const filePath of resolvedPaths) {
      if (!files.has(filePath)) files.set(filePath, { path: filePath, name: path.basename(filePath), project, edits: [] });
      files.get(filePath).edits.push({ t, id: eventId });
    }
  }
  const files = Object.create(null);
  const result = [...sessions.values()].sort((a, b) => a.id.localeCompare(b.id));
  for (const session of result) {
    const projects = Object.entries(session.projects).sort(([a, ac], [b, bc]) => bc - ac || a.localeCompare(b));
    const nongeneric = projects.filter(([name]) => name.toLowerCase() !== 'dev' && name !== 'Unattributed');
    session.group = (nongeneric.length ? nongeneric : projects)[0][0];
    session.title ||= session.promptTitle || session.group;
    session.fullTitle ||= session.title;
    delete session.promptTitle;
    files[session.id] = [...fileMaps.get(session.id).values()].sort((a, b) => b.edits.at(-1).t - a.edits.at(-1).t || a.path.localeCompare(b.path));
    const counts = { activity: 0, edit: 0, research: 0, commit: 0, lifecycle: 0 };
    let activeMs = 0;
    let previous = null;
    for (const [t, cat] of session.events) {
      counts[cat]++;
      if (cat !== 'lifecycle') {
        if (previous !== null && t - previous <= 15 * 60 * 1000) activeMs += t - previous;
        previous = t;
      }
    }
    session.metrics = { spanMs: session.events.at(-1)[0] - session.events[0][0], activeMs, counts, tokens: missingTokens() };
    session.tokenSeries = [];
    session.noteCount = session.notes.length;
    session.notes = session.notes.slice(-60);
    session.notePreview = { total: session.noteCount, shown: session.notes.length, truncated: session.noteCount > session.notes.length };
    const resolved = new Set(files[session.id].flatMap((file) => file.edits.map((edit) => edit.id)));
    session.fileEvidenceStats = { recordedEdits: counts.edit, resolvedFiles: files[session.id].length, unresolvedEdits: session._editEvidence.filter((event) => !resolved.has(event.event_id)).length };
  }
  const requestedRange = { from: start, through: now, lower: 'closed' };
  const observedExtent = { from: availableStart, through: availableEnd };
  const sourceRevision = `memory-${stableHash(revisionParts.sort())}`;
  const corpusId = `corpus-${stableHash([path.resolve(corpusRoot)])}`;
  const truncatedSessions = result.filter((session) => session.notePreview.truncated).length;
  const coverage = {
    status: 'unknown-history',
    requestedRange,
    loadedRange: { from: start, through: now },
    observedExtent,
    evidenceComplete: true,
    indexedRecords: evidenceIndex.length,
    notePreview: { limitPerSession: 60, truncatedSessions, omitted: result.reduce((sum, session) => sum + session.noteCount - session.notes.length, 0) },
  };
  const source = { mode: 'warm-corpus', corpusId, revision: sourceRevision, snapshotAt: now };
  return {
    start, end: now, windowHours: hours, availableStart, availableEnd,
    total: rows.length, unattributed, groups: [...new Set(result.map((session) => session.group))].sort(), sessions: result, files,
    evidenceIndex, evidenceComplete: true, indexedRecordCount: evidenceIndex.length,
    requestedRange, loadedRange: coverage.loadedRange, observedExtent, snapshotAt: now, sourceRevision, coverageStatus: coverage.status,
    source, coverage,
  };
}

export async function enrichMemory(snapshot, enricher, corpusRoot = CORPUS_ROOT) {
  // Wide windows can contain thousands of sessions. Keep transcript discovery
  // and worker requests bounded while retaining every session and its evidence.
  async function enrichSession(session) {
    let transcript;
    try { transcript = await enricher.read(session, snapshot); }
    catch { transcript = { valid: false, reason: 'Transcript analysis is unavailable.' }; }
    if (transcript.valid) {
      session.transcript = transcript.path;
      session.provider = transcript.provider;
      if (transcript.provider && !session.providers.includes(transcript.provider)) session.providers.push(transcript.provider);
      if (transcript.title) {
        session.fullTitle = transcript.title;
        session.title = compactTitle(transcript.title);
      }
      session.metrics.tokens = transcript.tokens;
      session.tokenSeries = transcript.tokenSeries;
      const files = new Map(snapshot.files[session.id].map((file) => [file.path, file]));
      function addFile(filePath, evidence, project = session.group) {
        if (!files.has(filePath)) files.set(filePath, { path: filePath, name: path.basename(filePath), project, edits: [] });
        const file = files.get(filePath);
        if (!file.edits.some((edit) => edit.id === evidence.id)) file.edits.push(evidence);
      }
      for (const tool of transcript.tools) {
        for (const candidate of tool.paths) {
          const filePath = resolveMemoryFile(candidate, tool.cwd, corpusRoot);
          if (filePath) addFile(filePath, { t: tool.end || tool.t, id: `transcript:${tool.callId}`, source: 'transcript', callId: tool.callId, transcript: transcript.path });
        }
      }
      // The hook sometimes records the session cwd instead of an individual
      // tool's explicit workdir. Recover only a unique path under a recorded
      // tool interval, retaining both the event and supporting call identities.
      for (const event of session._editEvidence) {
        const candidates = new Map();
        for (const tool of transcript.tools) {
          if (!tool.commandPrefix || !path.isAbsolute(tool.cwd || '') || event.t < Math.floor(tool.t / 1000) * 1000 || event.t > tool.end + 1000) continue;
          for (const filePath of editPaths({ ...event, cwd: tool.cwd }, corpusRoot)) {
            if (!candidates.has(filePath)) candidates.set(filePath, []);
            candidates.get(filePath).push(tool.callId);
          }
        }
        // Multiple different files with the same basename under simultaneous
        // workdirs are ambiguous; preserve the unresolved edit in that case.
        const byName = new Map();
        for (const filePath of candidates.keys()) {
          const name = path.basename(filePath);
          if (!byName.has(name)) byName.set(name, []);
          byName.get(name).push(filePath);
        }
        for (const [filePath, callIds] of candidates) if (byName.get(path.basename(filePath)).length === 1 && text(event.event_id)) addFile(filePath, { t: event.t, id: event.event_id, source: 'event', workdirCallIds: callIds }, projectLabel(event));
      }
      for (const file of files.values()) file.edits.sort((a, b) => a.t - b.t || a.id.localeCompare(b.id));
      snapshot.files[session.id] = [...files.values()].sort((a, b) => b.edits.at(-1).t - a.edits.at(-1).t || a.path.localeCompare(b.path));
      const resolved = new Set([...files.values()].flatMap((file) => file.edits.filter((edit) => edit.source !== 'transcript').map((edit) => edit.id)));
      session.fileEvidenceStats = { recordedEdits: session.metrics.counts.edit, resolvedFiles: files.size, unresolvedEdits: session._editEvidence.filter((event) => !resolved.has(event.event_id)).length };
    } else session.metrics.tokens = missingTokens(transcript.reason);
    for (const record of snapshot.evidenceIndex || []) if (record.sessionId === session.id && !record.provider && session.provider) {
      record.provider = session.provider;
      record.providerSource = 'session-transcript';
    }
    delete session._editEvidence;
    delete session.transcriptPaths;
  }
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, snapshot.sessions.length) }, async () => {
    while (next < snapshot.sessions.length) await enrichSession(snapshot.sessions[next++]);
  }));
  return snapshot;
}

class MemoryError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const lineCount = content => content ? content.split('\n').length - (content.endsWith('\n') ? 1 : 0) : 0;

function openReviewFile(snapshot, sessionId, filePath, corpusRoot) {
  const session = snapshot.sessions.find((item) => item.id === sessionId);
  const evidence = snapshot.files[sessionId]?.find((item) => item.path === filePath);
  if (!session || !evidence) throw new MemoryError(404, 'File is not recorded as edited by this session in the current window.');
  // Revalidate at read time: a file can disappear or become a symlink after the
  // two-second projection cache was populated.
  if (resolveMemoryFile(filePath, null, corpusRoot) !== filePath) throw new MemoryError(403, 'File is no longer available inside this workspace.');
  let fd;
  try {
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new MemoryError(403, 'Only regular files can be reviewed.');
    // Bound allocation and rendering independently of the full file size.
    const buffer = Buffer.alloc(PREVIEW_LIMIT + 1);
    let bytes = 0;
    while (bytes < buffer.length) {
      const read = fs.readSync(fd, buffer, bytes, buffer.length - bytes, bytes);
      if (!read) break;
      bytes += read;
    }
    let end = Math.min(bytes, PREVIEW_LIMIT), lines = 0;
    for (let i = 0; i < end; i++) {
      if (buffer[i] === 10 && ++lines === PREVIEW_LINES) { end = i + 1; break; }
    }
    const data = buffer.subarray(0, end);
    if (data.includes(0)) throw new MemoryError(415, 'Binary files are not available in text review.');
    const truncated = end < bytes || end < stat.size;
    let content;
    // A cut through a UTF-8 character is withheld, not replaced or rejected.
    try { content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data, { stream: truncated }); }
    catch { throw new MemoryError(415, 'File is not UTF-8 text.'); }
    return { fd, stat, session, evidence, content, preview: {
      truncated, bytes: Buffer.byteLength(content), totalBytes: Math.max(stat.size, bytes),
      lineCount: lineCount(content), limitBytes: PREVIEW_LIMIT, limitLines: PREVIEW_LINES,
    } };
  } catch (error) {
    if (fd !== undefined) fs.closeSync(fd);
    throw error;
  }
}

async function downloadFile(snapshot, sessionId, filePath, corpusRoot, res) {
  const { fd, stat } = openReviewFile(snapshot, sessionId, filePath, corpusRoot);
  let stream;
  try {
    // A download is an attachment, never executable HTML or an unbounded JSON
    // string. The descriptor is the same one validated with O_NOFOLLOW above.
    const name = encodeURIComponent(path.basename(filePath)).replace(/['()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream', 'Content-Length': stat.size,
      'Content-Disposition': `attachment; filename*=UTF-8''${name}`,
      'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "sandbox; default-src 'none'",
    });
    if (!stat.size) { res.end(); return; }
    stream = fs.createReadStream(filePath, { fd, autoClose: true, start: 0, end: stat.size - 1 });
    await pipeline(stream, res);
  } finally {
    if (!stream) fs.closeSync(fd);
  }
}

async function reviewFile(snapshot, sessionId, filePath, corpusRoot, { bounds, now }) {
  const { fd, content, preview, evidence, session } = openReviewFile(snapshot, sessionId, filePath, corpusRoot);
  fs.closeSync(fd);
  const { diff, diffAvailable, diffReason, range, note } = await reviewRange(filePath, content, bounds, now, preview.truncated);
  const diffBase = range?.base ? range.base.short : 'none';
  return { path: filePath, name: evidence.name, content, preview, diff, diffAvailable, diffReason, range, evidence: evidence.edits, session: sessionId, title: session.title, state: 'current', diffBase, note };
}

const IN_FLIGHT_MS = 15 * 60 * 1000;
// Hooks stamp a commit event after git has already written it, and git keeps
// committer time at one-second resolution, so the session's closing commit can
// sit a little past its last recorded event.
const COMMIT_GRACE_MS = 2 * 60 * 1000;

/** When a session began and ended, folded over every event it left in the whole
 *  corpus rather than the selected window, so a long session's review is bounded
 *  by the session and not by the desk's zoom level. */
export function sessionBounds(events, sessionId) {
  let start = null;
  let end = null;
  for (const event of events) {
    if (String(firstResolved([event.session_id, event.session, event.sessionId], '')) !== sessionId) continue;
    const t = eventEpochMs(event);
    if (!Number.isFinite(t)) continue;
    start = start === null ? t : Math.min(start, t);
    end = end === null ? t : Math.max(end, t);
  }
  return start === null ? null : { start, end };
}

const gitSecond = (ms) => new Date(Math.floor(ms / 1000) * 1000).toISOString();

/**
 * The file's change across one session, bounded by commit time on both ends.
 *
 * Base is the last commit at or before the session's first event. Head is the
 * last commit within a grace period of its final event when that commit changed
 * the file and the session has left the field; otherwise the working tree,
 * which is the only place uncommitted work exists. Boundaries are commit
 * times, not authorship: a session whose first act is committing a previous
 * session's leftovers inherits them, and the note says so rather than hiding it.
 */
async function reviewRange(filePath, content, bounds, nowMs, contentTruncated = false) {
  const unavailable = (diffReason, range = null) => ({ diff: '', diffAvailable: false, diffReason, range, note: diffReason });
  const tooLarge = () => unavailable('These changes are too large for inline review. The current file preview and full-file download are still available.');
  if (!bounds) return unavailable('This session has no dated activity to bound a diff.');
  const options = { timeout: 2500, maxBuffer: DIFF_LIMIT + 4096, encoding: 'utf8', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' } };
  let root;
  try { root = (await execFileAsync('git', ['rev-parse', '--show-toplevel'], { ...options, cwd: path.dirname(filePath) })).stdout.trim(); }
  catch { return unavailable('This file is not inside a Git repository, so no session diff can be bounded.'); }
  const relative = path.relative(root, filePath);
  // Resolve, never throw, on a non-zero exit: "no such path at that commit" and
  // "these differ" are answers here, and only a missing git or a timeout is a failure.
  async function git(args) {
    try {
      const { stdout } = await execFileAsync('git', ['--literal-pathspecs', '-C', root, ...args], options);
      return { stdout, code: 0 };
    } catch (error) {
      if (typeof error.code === 'number') return { stdout: error.stdout || '', code: error.code };
      throw error;
    }
  }
  const inFlight = nowMs - bounds.end <= IN_FLIGHT_MS;
  try {
    const emptyTree = (await git(['hash-object', '-t', 'tree', '/dev/null'])).stdout.trim();
    const commitAt = async (ms) => (await git(['rev-list', '-1', `--before=${gitSecond(ms)}`, 'HEAD'])).stdout.trim() || null;
    const describe = async (sha) => {
      if (!sha) return null;
      const [full, seconds, subject] = (await git(['show', '-s', '--format=%H%x00%ct%x00%s', sha])).stdout.trim().split('\0');
      return { sha: full, short: full.slice(0, 7), time: Number(seconds) * 1000, subject: (subject || '').slice(0, 120) };
    };
    const blobAt = async (sha) => sha ? (await git(['rev-parse', '--verify', '-q', `${sha}:${relative}`])).stdout.trim() || null : null;
    const contentAt = async (sha) => {
      const blob = await blobAt(sha);
      if (!blob) return { content: null, omitted: false };
      const size = Number((await git(['cat-file', '-s', blob])).stdout.trim());
      if (!Number.isFinite(size) || size > PREVIEW_LIMIT) return { content: null, omitted: true };
      const shown = await git(['show', `${sha}:${relative}`]);
      if (shown.code !== 0) return { content: null, omitted: true };
      if (shown.stdout.includes('\0')) throw new MemoryError(415, 'An earlier version of this file is binary.');
      if (Buffer.byteLength(shown.stdout) > PREVIEW_LIMIT || lineCount(shown.stdout) > PREVIEW_LINES) return { content: null, omitted: true };
      return { content: shown.stdout, omitted: false };
    };
    const baseSha = await commitAt(bounds.start);
    const endSha = await commitAt(bounds.end + COMMIT_GRACE_MS);
    const tracked = (await git(['ls-files', '--error-unmatch', '--', relative])).code === 0;
    const [baseBlob, endBlob] = await Promise.all([blobAt(baseSha), blobAt(endSha)]);
    const committedInSession = Boolean(endSha) && endSha !== baseSha && endBlob !== baseBlob;
    const useCommit = committedInSession && !inFlight;
    const diffArgs = ['diff', '--no-ext-diff', '--no-textconv', '--no-color'];
    let diff;
    if (useCommit) diff = (await git([...diffArgs, baseSha || emptyTree, endSha, '--', relative])).stdout;
    else if (tracked) diff = (await git([...diffArgs, baseSha || emptyTree, '--', relative])).stdout;
    else diff = (await git([...diffArgs, '--no-index', '--', '/dev/null', filePath])).stdout;
    if (Buffer.byteLength(diff) > DIFF_LIMIT || lineCount(diff) > DIFF_LINES) return tooLarge();
    // Work that landed after the bounded head is real but out of scope; say so
    // instead of folding it in, which is what the old HEAD-relative diff did.
    const committedAfter = useCommit ? (await blobAt('HEAD')) !== endBlob : false;
    const uncommittedAfter = useCommit ? (await git(['diff', '--quiet', 'HEAD', '--', relative])).code !== 0 : false;
    const [base, headCommit] = await Promise.all([describe(baseSha), useCommit ? describe(endSha) : null]);
    const old = await contentAt(baseSha);
    const next = useCommit ? await contentAt(endSha) : { content: contentTruncated ? null : content, omitted: contentTruncated };
    const range = { start: bounds.start, end: bounds.end, inFlight, tracked, base, baseFileExists: Boolean(baseBlob), head: useCommit ? { kind: 'commit', ...headCommit } : { kind: 'working-tree' }, committedAfter, uncommittedAfter, oldContent: old.content, newContent: next.content, contentsOmitted: old.omitted || next.omitted };
    const from = base ? `commit ${base.short}` : 'before any commit';
    const to = useCommit ? `commit ${headCommit.short}` : 'the working tree';
    const note = `Changes from ${from} to ${to}, bounded by this session's first and last recorded activity. Boundaries are commit times, not authorship.`;
    return { diff, diffAvailable: true, diffReason: null, range, note };
  } catch (error) {
    if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return tooLarge();
    if (error instanceof MemoryError) return unavailable(error.message);
    return unavailable('A session-bounded diff is unavailable for this file.');
  }
}

/** Shared by Express and the zero-dependency Turbo HTTP server. */
export function createMemoryHandler({ getEvents, corpusRoot = CORPUS_ROOT, now = Date.now, cacheMs = 2000, transcriptEnricher = createTranscriptEnricher(), recallSource = createRecallSource(), lookupIndexed = fetchIndexedEvents, dayDigest = createDayDigestSource({ corpusRoot }) }) {
  // Keep historical windows and session links isolated from the live cache.
  const cache = new Map();
  function readEnd(value) {
    if (!value) return null;
    const end = /^\d{13}$/.test(value) ? Number(value) : /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value) ? Date.parse(value) : NaN;
    if (!Number.isSafeInteger(end) || end <= 0 || end > now() + 60000) throw new MemoryError(400, 'Invalid memory window end.');
    return end;
  }
  function readHours(value) {
    if (value === null) return DEFAULT_WINDOW_HOURS;
    const hours = /^\d+$/.test(value) ? Number(value) : NaN;
    if (!Number.isInteger(hours) || hours < 1 || hours > MAX_WINDOW_HOURS) throw new MemoryError(400, 'Memory window hours must be an integer between 1 and 2160.');
    return hours;
  }
  async function snapshot(end = null, sessionId = null, hours = DEFAULT_WINDOW_HOURS) {
    const key = `${end ?? 'live'}:${hours}:${sessionId || ''}`;
    const time = now();
    const existing = cache.get(key);
    if (existing && (existing.pending || (time >= existing.at && time - existing.at < cacheMs))) return existing.promise;
    let events = getEvents();
    let windowEnd = end ?? time;
    let corpusBounds = null;
    if (sessionId) {
      if (!/^[\w-]{1,256}$/.test(sessionId)) throw new MemoryError(400, 'Invalid session id.');
      corpusBounds = { availableStart: null, availableEnd: null };
      events = events.filter(event => {
        const t = eventEpochMs(event);
        if (Number.isFinite(t)) {
          corpusBounds.availableStart = corpusBounds.availableStart === null ? t : Math.min(corpusBounds.availableStart, t);
          corpusBounds.availableEnd = corpusBounds.availableEnd === null ? t : Math.max(corpusBounds.availableEnd, t);
        }
        return String(firstResolved([event.session_id, event.session, event.sessionId], '')) === sessionId;
      });
      // A live permalink follows the session while active. Once it has left
      // the field, reopen its last recorded window at the selected duration.
      const latest = events.reduce((last, event) => {
        const t = eventEpochMs(event);
        return Number.isFinite(t) && t <= time ? Math.max(last, t) : last;
      }, 0);
      if (end === null && latest && latest < time - hours * HOUR_MS) windowEnd = latest;
    }
    const projected = projectMemory(events, { now: windowEnd, hours, corpusRoot });
    projected.snapshotAt = time;
    projected.source.snapshotAt = time;
    if (corpusBounds) Object.assign(projected, corpusBounds);
    const promise = enrichMemory(projected, transcriptEnricher, corpusRoot);
    cache.delete(key);
    const entry = { at: time, promise, pending: true };
    cache.set(key, entry);
    while (cache.size > 12) cache.delete(cache.keys().next().value);
    try {
      const result = await promise;
      entry.pending = false;
      entry.at = now();
      return result;
    }
    catch (error) { if (cache.get(key)?.promise === promise) cache.delete(key); throw error; }
  }
  function readActivityTime(value, label, fallback) {
    if (value === null) return fallback;
    const parsed = /^\d{13}$/.test(value) ? Number(value) : /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value) ? Date.parse(value) : NaN;
    if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > now() + 60000) throw new MemoryError(400, `Invalid activity ${label}.`);
    return parsed;
  }
  function readList(params, name) {
    return params.getAll(name).flatMap((value) => value.split(',')).map((value) => value.trim()).filter(Boolean);
  }
  function readLimit(value) {
    if (value === null) return 200;
    const limit = /^\d+$/.test(value) ? Number(value) : NaN;
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new MemoryError(400, 'Activity limit must be an integer between 1 and 500.');
    return limit;
  }
  function cursorOffset(value, revision, scopeKey) {
    if (!value) return 0;
    try {
      const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
      if (parsed.revision !== revision || parsed.scope !== scopeKey || !Number.isInteger(parsed.offset) || parsed.offset < 0) throw new Error('stale');
      return parsed.offset;
    } catch { throw new MemoryError(409, 'Activity cursor does not belong to this source revision.'); }
  }
  const activityScope = (params, from, through) => normalizeActivityScope({
    from, through, lower: params.get('lower'), project: params.get('project') || '',
    providers: readList(params, 'provider'), evidence: readList(params, 'evidence'), brush: readList(params, 'brush'), q: params.get('q') || '',
    result: params.get('result') || 'tasks', kind: params.get('kind') || 'all',
  }, { start: from, end: through });

  function hasExactScope(params) {
    return ['from', 'through', 'project', 'provider', 'evidence', 'brush', 'q', 'result', 'kind', 'lower'].some((name) => params.has(name));
  }

  async function scopedSnapshot(params, sessionId = null) {
    const legacyEnd = readEnd(params.get('end'));
    const through = readActivityTime(params.get('through'), 'through timestamp', legacyEnd ?? now());
    const legacyHours = readHours(params.get('hours'));
    const from = readActivityTime(params.get('from'), 'from timestamp', through - legacyHours * HOUR_MS);
    if (from > through) throw new MemoryError(400, 'Activity from must not be later than through.');
    const hours = Math.max(1, Math.ceil((through - from) / HOUR_MS));
    if (hours > MAX_WINDOW_HOURS) throw new MemoryError(422, 'Activity ranges wider than 90 days are not supported.');
    return projectMemoryScope(await snapshot(through, sessionId, hours), activityScope(params, from, through));
  }

  async function activity(params) {
    const requestNow = now();
    const legacyEnd = readEnd(params.get('end'));
    const through = readActivityTime(params.get('through'), 'through timestamp', legacyEnd ?? requestNow);
    const legacyHours = readHours(params.get('hours'));
    const from = readActivityTime(params.get('from'), 'from timestamp', through - legacyHours * HOUR_MS);
    const contextFrom = readActivityTime(params.get('contextFrom'), 'context start timestamp', from);
    const contextThrough = readActivityTime(params.get('contextThrough'), 'context end timestamp', through);
    if (from > through || contextFrom > from || contextThrough < through || contextFrom > contextThrough) throw new MemoryError(400, 'Activity ranges must be ordered, and context must contain the focus interval.');
    const contextHours = Math.max(1, Math.ceil((contextThrough - contextFrom) / HOUR_MS));
    if (contextHours > MAX_WINDOW_HOURS) throw new MemoryError(422, 'Activity ranges wider than 90 days are not supported.');
    const base = await snapshot(contextThrough, null, contextHours);
    const context = projectMemoryScope(base, activityScope(params, contextFrom, contextThrough));
    if (params.get('shape') === 'context') return {
      source: context.source,
      coverage: context.coverage,
      context,
    };
    const focused = projectMemoryScope(base, activityScope(params, from, through));
    const aggregates = activityFromMemory(focused);
    const limit = readLimit(params.get('limit'));
    const scopeKey = JSON.stringify(focused.scope);
    const offset = cursorOffset(params.get('cursor'), focused.sourceRevision, scopeKey);
    const page = focused.evidenceIndex.slice(offset, offset + limit);
    const nextOffset = offset + page.length;
    const nextCursor = nextOffset < focused.evidenceIndex.length
      ? Buffer.from(JSON.stringify({ revision: focused.sourceRevision, scope: scopeKey, offset: nextOffset })).toString('base64url')
      : null;
    return {
      scope: focused.scope,
      source: focused.source,
      coverage: focused.coverage,
      context,
      focused,
      activity: {
        ...aggregates,
        events: page,
        totalEvents: focused.counts.events,
        totalSessions: focused.counts.sessions,
        totalFiles: focused.counts.files,
        cursor: params.get('cursor') || null,
        nextCursor,
      },
    };
  }
  // Recall is fetched when a view asks for it, never with the polled state.
  // A session's calls span its whole life, so a session request needs no window.
  async function recallCalls(params) {
    const session = params.get('session');
    if (session !== null && !/^[\w-]{1,256}$/.test(session)) throw new MemoryError(400, 'Invalid session id.');
    const purpose = params.get('purpose') || null;
    if (purpose !== null && !/^(?:[\w-]{1,64}|\(none\))$/.test(purpose)) throw new MemoryError(400, 'Invalid recall purpose.');
    const windowed = session === null || params.has('from') || params.has('through');
    let from = null, through = null;
    if (windowed) {
      through = readActivityTime(params.get('through'), 'through timestamp', now());
      from = readActivityTime(params.get('from'), 'from timestamp', through - RECALL_DEFAULT_WINDOW_MS);
      if (from > through) throw new MemoryError(400, 'Recall from must not be later than through.');
      if (through - from > RECALL_MAX_WINDOW_MS) throw new MemoryError(422, 'Recall ranges wider than 90 days are not supported.');
    }
    const rawLimit = params.get('limit');
    const limit = rawLimit === null ? RECALL_CALL_LIMIT : /^\d+$/.test(rawLimit) ? Number(rawLimit) : NaN;
    if (!Number.isInteger(limit) || limit < 1 || limit > RECALL_CALL_LIMIT) throw new MemoryError(400, `Recall limit must be an integer between 1 and ${RECALL_CALL_LIMIT}.`);
    return resolveUnplacedMarks(listRecallCalls(recallSource(), { from, through, session, purpose, limit }), { events: getEvents(), lookupIndexed });
  }
  async function recallCall(params) {
    const id = params.get('call');
    if (!id || !/^[\w.:-]{1,128}$/.test(id)) throw new MemoryError(400, 'A valid recall call id is required.');
    const detail = await recallCallDetail(recallSource(), id, { events: getEvents(), lookupIndexed });
    if (!detail) throw new MemoryError(404, 'No recall call with this id is recorded.');
    return detail;
  }
  return async function handleMemory(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (!url.pathname.startsWith('/api/memory/') && url.pathname !== '/api/activity-scope') return false;
    let status = 200;
    let body;
    try {
      if (req.method !== 'GET') throw new MemoryError(405, 'Memory endpoints are read-only.');
      if (url.pathname === '/api/memory/health') {
        const corpusId = `corpus-${stableHash([path.resolve(corpusRoot)])}`;
        body = { status: 'ok', contract_version: MEMORY_CONTRACT_VERSION, corpus_root: corpusRoot, refresh_ms: MEMORY_REFRESH_MS, source: { mode: 'warm-corpus', corpusId } };
      }
      else if (url.pathname === '/api/memory/state') body = hasExactScope(url.searchParams)
        ? await scopedSnapshot(url.searchParams)
        : await snapshot(readEnd(url.searchParams.get('end')), null, readHours(url.searchParams.get('hours')));
      else if (url.pathname === '/api/memory/activity' || url.pathname === '/api/activity-scope') body = await activity(url.searchParams);
      else if (url.pathname === '/api/memory/recall') body = await recallCalls(url.searchParams);
      else if (url.pathname === '/api/memory/recall/call') body = await recallCall(url.searchParams);
      else if (url.pathname === '/api/memory/day') body = await dayDigest(readDayParams(url.searchParams));
      else if (url.pathname === '/api/memory/session') {
        const id = url.searchParams.get('session');
        if (!id) throw new MemoryError(400, 'A session id is required.');
        body = hasExactScope(url.searchParams)
          ? await scopedSnapshot(url.searchParams, id)
          : await snapshot(readEnd(url.searchParams.get('end')), id, readHours(url.searchParams.get('hours')));
        if (!body.sessions.length) throw new MemoryError(404, 'This session has no recorded activity in the selected window.');
      }
      else if (url.pathname === '/api/memory/file') {
        const id = url.searchParams.get('session');
        if (!id) throw new MemoryError(400, 'A session id is required.');
        const exact = hasExactScope(url.searchParams);
        const end = readEnd(url.searchParams.get('end'));
        const hours = readHours(url.searchParams.get('hours'));
        const field = exact ? await scopedSnapshot(url.searchParams) : await snapshot(end, null, hours);
        const source = field.sessions.some(session => session.id === id) ? field : exact ? field : await snapshot(end, id, hours);
        if (url.searchParams.get('download') === '1') {
          await downloadFile(source, id, url.searchParams.get('path'), corpusRoot, res);
          return true;
        }
        // Bound the diff by the session's whole life, not the desk's window.
        body = await reviewFile(source, id, url.searchParams.get('path'), corpusRoot, { bounds: sessionBounds(getEvents(), id), now: now() });
        url.searchParams.set('download', '1');
        body.downloadUrl = url.pathname + url.search;
      }
      else throw new MemoryError(404, 'Memory endpoint not found.');
    } catch (error) {
      if (res.headersSent) { res.destroy(); return true; }
      status = error.status || (error.code === 'ENOENT' ? 404 : 500);
      body = { error: error.status ? error.message : 'Unable to read current memory state.' };
    }
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
    return true;
  };
}
