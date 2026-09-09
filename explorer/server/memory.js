import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { firstResolved, isResolved } from '../../scripts/sentinels.js';
import { eventEpochMs } from './event-time.js';
import { CORPUS_ROOT } from './jsonl.js';
import { createTranscriptEnricher, missingTokens } from './memory-transcript.js';

const execFileAsync = promisify(execFile);
const DAY_MS = 24 * 60 * 60 * 1000;
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
  const match = summary.match(/^(?:Modified|Created|Wrote):\s*(.+)$/i);
  if (match) {
    const value = match[1].replace(/\s+\(via bash\)\s*$/, '').trim();
    // A real filename may contain a comma. Preserve it before interpreting the
    // hook's comma-separated multi-file form.
    if (resolveMemoryFile(value, event.cwd, corpusRoot)) candidates.push(value);
    else candidates.push(...value.split(',').map((item) => item.trim()));
  }
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
export function projectMemory(events, { now = Date.now(), corpusRoot = CORPUS_ROOT } = {}) {
  const start = now - DAY_MS;
  const deduped = new Map();
  const anonymous = [];
  for (const event of events) {
    const t = eventEpochMs(event);
    if (!Number.isFinite(t) || t < start || t > now) continue;
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
      sessions.set(id, { id, title: '', fullTitle: '', group: '', projects: Object.create(null), events: [], wraps: [], notes: [], count: 0, lifecycleOnly: true, transcript: null, transcriptPaths: [], promptTitle: '', _editEvidence: [] });
      fileMaps.set(id, new Map());
    }
    const session = sessions.get(id);
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
    if (note) session.notes.push({ t, id: eventId, type: eventType(event), text: note });
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
  return { start, end: now, total: rows.length, unattributed, groups: [...new Set(result.map((session) => session.group))].sort(), sessions: result, files };
}

export async function enrichMemory(snapshot, enricher, corpusRoot = CORPUS_ROOT) {
  await Promise.all(snapshot.sessions.map(async (session) => {
    let transcript;
    try { transcript = await enricher.read(session, snapshot); }
    catch { transcript = { valid: false, reason: 'Transcript analysis is unavailable.' }; }
    if (transcript.valid) {
      session.transcript = transcript.path;
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
  }));
  return snapshot;
}

class MemoryError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function reviewFile(snapshot, sessionId, filePath, corpusRoot) {
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
  let diff = '';
  let diffAvailable = false;
  let diffReason = null;
  try {
    const options = { cwd: path.dirname(filePath), timeout: 2500, maxBuffer: 512 * 1024, encoding: 'utf8', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' } };
    const { stdout: root } = await execFileAsync('git', ['rev-parse', '--show-toplevel'], options);
    const relative = path.relative(root.trim(), filePath);
    await execFileAsync('git', ['--literal-pathspecs', '-C', root.trim(), 'ls-files', '--error-unmatch', '--', relative], options);
    const { stdout } = await execFileAsync('git', ['--literal-pathspecs', '-C', root.trim(), 'diff', '--no-ext-diff', '--no-textconv', '--no-color', 'HEAD', '--', relative], options);
    diff = stdout;
    diffAvailable = true;
  } catch {
    diffReason = 'A bounded diff from HEAD is unavailable for this file.';
  }
  return { path: filePath, name: evidence.name, content, diff, diffAvailable, diffReason, evidence: evidence.edits, session: sessionId, title: session.title, state: 'current', diffBase: 'HEAD', note: 'Current file and working-tree diff from HEAD; edits may include other sessions.' };
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
  async function snapshot(end = null, sessionId = null) {
    const key = `${end ?? 'live'}:${sessionId || ''}`;
    const time = now();
    const existing = cache.get(key);
    if (existing && time >= existing.at && time - existing.at < cacheMs) return existing.promise;
    let events = getEvents();
    let windowEnd = end ?? time;
    if (sessionId) {
      if (!/^[\w-]{1,256}$/.test(sessionId)) throw new MemoryError(400, 'Invalid session id.');
      events = events.filter(event => String(firstResolved([event.session_id, event.session, event.sessionId], '')) === sessionId);
      // A live permalink follows the session while active. Once it has left
      // the field, reopen its last recorded 24-hour window, not an empty view.
      const latest = events.reduce((last, event) => {
        const t = eventEpochMs(event);
        return Number.isFinite(t) && t <= time ? Math.max(last, t) : last;
      }, 0);
      if (end === null && latest && latest < time - DAY_MS) windowEnd = latest;
    }
    const promise = enrichMemory(projectMemory(events, { now: windowEnd, corpusRoot }), transcriptEnricher, corpusRoot);
    cache.delete(key);
    cache.set(key, { at: time, promise });
    while (cache.size > 12) cache.delete(cache.keys().next().value);
    try { return await promise; }
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
      else if (url.pathname === '/api/memory/state') body = await snapshot(readEnd(url.searchParams.get('end')));
      else if (url.pathname === '/api/memory/session') {
        const id = url.searchParams.get('session');
        if (!id) throw new MemoryError(400, 'A session id is required.');
        body = await snapshot(readEnd(url.searchParams.get('end')), id);
        if (!body.sessions.length) throw new MemoryError(404, 'This session has no recorded activity in the selected window.');
      }
      else if (url.pathname === '/api/memory/file') {
        const id = url.searchParams.get('session');
        if (!id) throw new MemoryError(400, 'A session id is required.');
        const end = readEnd(url.searchParams.get('end'));
        const field = await snapshot(end);
        const source = field.sessions.some(session => session.id === id) ? field : await snapshot(end, id);
        body = await reviewFile(source, id, url.searchParams.get('path'), corpusRoot);
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
