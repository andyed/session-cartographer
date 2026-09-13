import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { firstResolved, isResolved } from '../../scripts/sentinels.js';
import { editSummaryPaths } from '../../scripts/edit-paths.js';
import { eventEpochMs } from './event-time.js';
import { CORPUS_ROOT } from './jsonl.js';
import { createTranscriptEnricher, missingTokens } from './memory-transcript.js';

const execFileAsync = promisify(execFile);
const HOUR_MS = 60 * 60 * 1000;
const DEFAULT_WINDOW_HOURS = 24;
const MAX_WINDOW_HOURS = 90 * 24;
const FILE_LIMIT = 256 * 1024;
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
  return text(firstResolved([event.summary, event.description, event.prompt, event.url, event.query, event.event_id, event.milestone])).replace(/\s+/g, ' ').slice(0, 500);
}

/** A fold over the owning service's warm corpus, with no ranking or log reads. */
export function projectMemory(events, { now = Date.now(), hours = DEFAULT_WINDOW_HOURS, corpusRoot = CORPUS_ROOT } = {}) {
  if (!Number.isInteger(hours) || hours < 1 || hours > MAX_WINDOW_HOURS) throw new RangeError('Memory window hours must be an integer between 1 and 2160.');
  const start = now - hours * HOUR_MS;
  let availableStart = null;
  let availableEnd = null;
  const deduped = new Map();
  const anonymous = [];
  for (const event of events) {
    const t = eventEpochMs(event);
    if (!Number.isFinite(t)) continue;
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
  let unattributed = 0;
  for (const event of rows) {
    const rawId = firstResolved([event.session_id, event.session, event.sessionId]);
    if (!rawId || (typeof rawId !== 'string' && typeof rawId !== 'number')) { unattributed += 1; continue; }
    const id = String(rawId).trim();
    if (!sessions.has(id)) {
      sessions.set(id, { id, title: '', fullTitle: '', group: '', projects: Object.create(null), events: [], wraps: [], notes: [], outcomes: [], provider: null, cwd: null, count: 0, lifecycleOnly: true, transcript: null, transcriptPaths: [], promptTitle: '', _editEvidence: [] });
      fileMaps.set(id, new Map());
    }
    const session = sessions.get(id);
    if (['claude', 'codex'].includes(event.provider)) session.provider ||= event.provider;
    if (path.isAbsolute(text(event.cwd))) session.cwd ||= text(event.cwd);
    const t = eventEpochMs(event);
    const cat = category(event);
    const project = projectLabel(event);
    const eventId = text(event.event_id) || null;
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
      if (cat === 'commit' || /wrapup|session_end|sessionend|agent_stop/.test(eventType(event))) session.outcomes.push(observation);
    }
    if (cat === 'edit') session._editEvidence.push({ ...event, t });
    if (cat !== 'edit' || !eventId) continue;
    const files = fileMaps.get(id);
    for (const filePath of editPaths(event, corpusRoot)) {
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
    session.notes = session.notes.slice(-60);
    const resolved = new Set(files[session.id].flatMap((file) => file.edits.map((edit) => edit.id)));
    session.fileEvidenceStats = { recordedEdits: counts.edit, resolvedFiles: files[session.id].length, unresolvedEdits: session._editEvidence.filter((event) => !resolved.has(event.event_id)).length };
  }
  return { start, end: now, windowHours: hours, availableStart, availableEnd, total: rows.length, unattributed, groups: [...new Set(result.map((session) => session.group))].sort(), sessions: result, files };
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

async function reviewFile(snapshot, sessionId, filePath, corpusRoot, { bounds, now }) {
  const session = snapshot.sessions.find((item) => item.id === sessionId);
  const evidence = snapshot.files[sessionId]?.find((item) => item.path === filePath);
  if (!session || !evidence) throw new MemoryError(404, 'File is not recorded as edited by this session in the current window.');
  // Revalidate at read time: a file can disappear or become a symlink after the
  // two-second projection cache was populated.
  if (resolveMemoryFile(filePath, null, corpusRoot) !== filePath) throw new MemoryError(403, 'File is no longer available inside this workspace.');
  let fd;
  let content;
  try {
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new MemoryError(403, 'Only regular files can be reviewed.');
    if (stat.size > FILE_LIMIT) throw new MemoryError(413, 'File exceeds the 256 KiB review limit.');
    // Read at most the limit plus one even if a writer grows the file after
    // fstat, so concurrent work cannot turn this endpoint into an unbounded read.
    const buffer = Buffer.alloc(FILE_LIMIT + 1);
    const bytes = fs.readSync(fd, buffer, 0, buffer.length, 0);
    if (bytes > FILE_LIMIT) throw new MemoryError(413, 'File exceeds the 256 KiB review limit.');
    const data = buffer.subarray(0, bytes);
    if (data.includes(0)) throw new MemoryError(415, 'Binary files are not available in text review.');
    try { content = new TextDecoder('utf-8', { fatal: true }).decode(data); }
    catch { throw new MemoryError(415, 'File is not UTF-8 text.'); }
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  const { diff, diffAvailable, diffReason, range, note } = await reviewRange(filePath, content, bounds, now);
  const diffBase = range?.base ? range.base.short : 'none';
  return { path: filePath, name: evidence.name, content, diff, diffAvailable, diffReason, range, evidence: evidence.edits, session: sessionId, title: session.title, state: 'current', diffBase, note };
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
async function reviewRange(filePath, content, bounds, nowMs) {
  const unavailable = (diffReason, range = null) => ({ diff: '', diffAvailable: false, diffReason, range, note: diffReason });
  if (!bounds) return unavailable('This session has no dated activity to bound a diff.');
  const options = { timeout: 2500, maxBuffer: FILE_LIMIT + 4096, encoding: 'utf8', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' } };
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
      if (!(await blobAt(sha))) return null;
      const shown = await git(['show', `${sha}:${relative}`]);
      if (shown.code !== 0) return null;
      if (shown.stdout.includes('\0')) throw new MemoryError(415, 'An earlier version of this file is binary.');
      if (Buffer.byteLength(shown.stdout) > FILE_LIMIT) throw new MemoryError(413, 'An earlier version of this file exceeds the 256 KiB review limit.');
      return shown.stdout;
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
    // Work that landed after the bounded head is real but out of scope; say so
    // instead of folding it in, which is what the old HEAD-relative diff did.
    const committedAfter = useCommit ? (await blobAt('HEAD')) !== endBlob : false;
    const uncommittedAfter = useCommit ? (await git(['diff', '--quiet', 'HEAD', '--', relative])).code !== 0 : false;
    const [base, headCommit] = await Promise.all([describe(baseSha), useCommit ? describe(endSha) : null]);
    const oldContent = await contentAt(baseSha);
    const newContent = useCommit ? await contentAt(endSha) : content;
    const range = { start: bounds.start, end: bounds.end, inFlight, tracked, base, head: useCommit ? { kind: 'commit', ...headCommit } : { kind: 'working-tree' }, committedAfter, uncommittedAfter, oldContent, newContent };
    const from = base ? `commit ${base.short}` : 'before any commit';
    const to = useCommit ? `commit ${headCommit.short}` : 'the working tree';
    const note = `Changes from ${from} to ${to}, bounded by this session's first and last recorded activity. Boundaries are commit times, not authorship.`;
    return { diff, diffAvailable: true, diffReason: null, range, note };
  } catch (error) {
    if (error instanceof MemoryError) throw error;
    return unavailable('A session-bounded diff is unavailable for this file.');
  }
}

/** Shared by Express and the zero-dependency Turbo HTTP server. */
export function createMemoryHandler({ getEvents, corpusRoot = CORPUS_ROOT, now = Date.now, cacheMs = 2000, transcriptEnricher = createTranscriptEnricher() }) {
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
  return async function handleMemory(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (!url.pathname.startsWith('/api/memory/')) return false;
    let status = 200;
    let body;
    try {
      if (req.method !== 'GET') throw new MemoryError(405, 'Memory endpoints are read-only.');
      if (url.pathname === '/api/memory/health') body = { status: 'ok', contract_version: MEMORY_CONTRACT_VERSION, corpus_root: corpusRoot, refresh_ms: MEMORY_REFRESH_MS };
      else if (url.pathname === '/api/memory/state') body = await snapshot(readEnd(url.searchParams.get('end')), null, readHours(url.searchParams.get('hours')));
      else if (url.pathname === '/api/memory/session') {
        const id = url.searchParams.get('session');
        if (!id) throw new MemoryError(400, 'A session id is required.');
        body = await snapshot(readEnd(url.searchParams.get('end')), id, readHours(url.searchParams.get('hours')));
        if (!body.sessions.length) throw new MemoryError(404, 'This session has no recorded activity in the selected window.');
      }
      else if (url.pathname === '/api/memory/file') {
        const id = url.searchParams.get('session');
        if (!id) throw new MemoryError(400, 'A session id is required.');
        const end = readEnd(url.searchParams.get('end'));
        const hours = readHours(url.searchParams.get('hours'));
        const field = await snapshot(end, null, hours);
        const source = field.sessions.some(session => session.id === id) ? field : await snapshot(end, id, hours);
        // Bound the diff by the session's whole life, not the desk's window.
        body = await reviewFile(source, id, url.searchParams.get('path'), corpusRoot, { bounds: sessionBounds(getEvents(), id), now: now() });
      }
      else throw new MemoryError(404, 'Memory endpoint not found.');
    } catch (error) {
      status = error.status || (error.code === 'ENOENT' ? 404 : 500);
      body = { error: error.status ? error.message : 'Unable to read current memory state.' };
    }
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
    return true;
  };
}
