import fs from 'node:fs';
import path from 'node:path';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { transcriptRoots, isAllowedTranscriptPath } from './transcripts.js';
import { epochMsFromTimestamp } from './event-time.js';

const FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite', 'total'];
const MAX_PASS_BYTES = 64 * 1024 * 1024;
const MAX_LINE_BYTES = 8 * 1024 * 1024;
const number = (value) => Number.isFinite(value) && value >= 0 ? value : null;
const same = (a, b) => a && b && FIELDS.every((key) => a[key] === b[key]);

export function missingTokens(reason = 'No token usage is recorded for this session.') {
  return { status: 'missing', output: null, input: null, cacheRead: null, cacheWrite: null, total: null, samples: 0, source: null, scope: 'window', reason, capturedUntil: null };
}

function usage(raw, provider) {
  if (!raw || number(raw.input_tokens) === null || number(raw.output_tokens) === null) return null;
  const cacheRead = number(provider === 'claude' ? raw.cache_read_input_tokens : raw.cached_input_tokens) ?? 0;
  const cacheWrite = number(provider === 'claude' ? raw.cache_creation_input_tokens : raw.cache_write_input_tokens) ?? 0;
  // Anthropic input_tokens excludes the two cache buckets. Codex includes
  // them. Normalize once: input always means all input, total=input+output.
  const input = raw.input_tokens + (provider === 'claude' ? cacheRead + cacheWrite : 0);
  return { input, output: raw.output_tokens, cacheRead, cacheWrite, total: input + raw.output_tokens };
}

function messageText(content) {
  return typeof content === 'string' ? content : Array.isArray(content)
    ? content.filter((item) => ['text', 'input_text'].includes(item.type)).map((item) => item.text || '').join(' ') : '';
}

export function meaningfulPrompt(value) {
  const result = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
  if (result.length < 8 || result.startsWith('<') || result.startsWith('# AGENTS.md') || /^(This session is being continued|Base directory for this skill|You are |\[Request interrupted)/.test(result)) return '';
  return result.slice(0, 600);
}

// A deliberately small lexical reader for literal tool inputs inside the
// functions.exec wrapper. It never runs JavaScript, expands variables, parses
// a shell command, or matches strings/comments as executable tool calls.
function literals(source) {
  const tokens = [];
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    if (/\s/.test(c)) { i++; continue; }
    if (source.startsWith('//', i)) { const end = source.indexOf('\n', i); i = end < 0 ? source.length : end + 1; continue; }
    if (source.startsWith('/*', i)) { const end = source.indexOf('*/', i + 2); i = end < 0 ? source.length : end + 2; continue; }
    if ('"\'`'.includes(c)) {
      const quote = c;
      let value = '';
      let valid = true;
      i++;
      while (i < source.length && source[i] !== quote) {
        if (quote === '`' && source.startsWith('${', i)) valid = false;
        if (source[i] !== '\\') { value += source[i++]; continue; }
        i++;
        const escaped = source[i++];
        const simple = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', '0': '\0' };
        if (escaped === 'u' || escaped === 'x') {
          const length = escaped === 'u' ? 4 : 2;
          const hex = source.slice(i, i + length);
          if (!new RegExp(`^[a-fA-F0-9]{${length}}$`).test(hex)) valid = false;
          else value += String.fromCharCode(parseInt(hex, 16));
          i += length;
        } else if (escaped !== '\n') value += simple[escaped] ?? escaped;
      }
      if (source[i] !== quote) valid = false;
      i++;
      tokens.push({ type: 'string', value: valid ? value : null });
      continue;
    }
    const identifier = source.slice(i).match(/^[A-Za-z_$][\w$]*/)?.[0];
    if (identifier) { tokens.push({ type: 'identifier', value: identifier }); i += identifier.length; continue; }
    tokens.push({ type: 'punctuation', value: c });
    i++;
  }
  return tokens;
}

export function literalToolInputs(source) {
  if (typeof source !== 'string') return [];
  const tokens = literals(source);
  const calls = [];
  for (let i = 0; i < tokens.length - 4; i++) {
    if (tokens[i].type !== 'identifier' || tokens[i].value !== 'tools' || tokens[i + 1].value !== '.' || tokens[i + 3].value !== '(') continue;
    const name = tokens[i + 2].value;
    if (name === 'apply_patch' && tokens[i + 4].type === 'string' && tokens[i + 5]?.value === ')') {
      if (tokens[i + 4].value) calls.push({ name, input: tokens[i + 4].value });
    } else if (name === 'exec_command' && tokens[i + 4].value === '{') {
      const input = {};
      let depth = 1;
      for (let j = i + 5; j < tokens.length && depth; j++) {
        if (tokens[j].value === '{' && tokens[j].type === 'punctuation') depth++;
        if (tokens[j].value === '}' && tokens[j].type === 'punctuation') depth--;
        if (depth === 1 && ['cmd', 'workdir'].includes(tokens[j].value) && tokens[j + 1]?.value === ':' && tokens[j + 2]?.type === 'string' && [',', '}'].includes(tokens[j + 3]?.value)) input[tokens[j].value] = tokens[j + 2].value;
      }
      if (input.cmd && input.workdir) calls.push({ name, input });
    }
  }
  return calls;
}

function patchPaths(patch) {
  return typeof patch === 'string' ? [...patch.matchAll(/^\*\*\* (?:Add File|Update File|Move to): (.+)$/gm)].map((match) => match[1].trim()) : [];
}

function fresh(expected) {
  return { expected, offset: 0, size: 0, mtime: 0, inode: null, boundary: null, provider: null, identity: false, cwd: null, customTitle: '', prompts: [], counters: [], previous: null, messages: new Map(), tools: new Map(), malformed: false, limited: false, incomplete: false };
}

function rememberTool(state, { name, input, callId, t, cwd }) {
  const suffix = name?.split('__').at(-1)?.split('.').at(-1);
  if (suffix === 'exec' && typeof input === 'string') {
    literalToolInputs(input).forEach((call, index) => rememberTool(state, { ...call, callId: `${callId}:${index}`, t, cwd }));
    return;
  }
  const paths = suffix === 'apply_patch' ? patchPaths(input)
    : ['Edit', 'Write', 'MultiEdit'].includes(suffix) && typeof input?.file_path === 'string' ? [input.file_path] : [];
  const workdir = input?.workdir || input?.cwd || cwd;
  if (paths.length || (suffix === 'exec_command' && typeof input?.cmd === 'string' && path.isAbsolute(workdir || ''))) {
    state.tools.set(callId, { t, callId, cwd: workdir, paths, command: suffix === 'exec_command' ? input.cmd : null });
  }
}

function consume(state, row) {
  const t = epochMsFromTimestamp(row.timestamp);
  const p = row.payload || {};
  if (row.type === 'session_meta') {
    state.provider = 'codex';
    state.identity = (p.id || p.session_id) === state.expected;
    state.cwd = p.cwd || null;
    return;
  }
  if (row.sessionId === state.expected && !state.provider) { state.provider = 'claude'; state.identity = true; }
  if (!state.identity || (state.provider === 'claude' && row.sessionId && row.sessionId !== state.expected)) return;
  if (row.type === 'turn_context' && p.cwd) state.cwd = p.cwd;
  if (row.type === 'custom-title' && meaningfulPrompt(row.customTitle)) state.customTitle = meaningfulPrompt(row.customTitle);
  const user = state.provider === 'codex'
    ? (row.type === 'response_item' && p.type === 'message' && p.role === 'user' ? messageText(p.content) : row.type === 'event_msg' && p.type === 'user_message' ? p.message : '')
    : row.type === 'user' ? messageText(row.message?.content) : '';
  const prompt = meaningfulPrompt(user);
  if (prompt && state.prompts.length < 30 && !state.prompts.some((entry) => entry.text === prompt)) state.prompts.push({ t, text: prompt });
  if (state.provider === 'codex') {
    if (row.type === 'event_msg' && p.type === 'token_count' && Number.isFinite(t)) {
      const total = usage(p.info?.total_token_usage, 'codex');
      const last = usage(p.info?.last_token_usage, 'codex');
      if (total && !same(total, state.previous?.usage)) {
        let delta;
        let partial = false;
        if (!state.previous) { delta = last || total; partial = !same(last, total); }
        else {
          delta = Object.fromEntries(FIELDS.map((key) => [key, total[key] - state.previous.usage[key]]));
          if (FIELDS.some((key) => delta[key] < 0)) { delta = last; partial = true; }
        }
        if (delta) state.counters.push({ t, ...delta, partial, previousAt: state.previous?.t ?? null });
        state.previous = { t, usage: total };
      }
    }
    if (row.type === 'response_item' && ['function_call', 'custom_tool_call'].includes(p.type)) {
      let input = p.input;
      if (p.arguments) { try { input = JSON.parse(p.arguments); } catch { return; } }
      rememberTool(state, { name: p.name, input, callId: p.call_id || p.id, t, cwd: state.cwd });
    }
    if (row.type === 'response_item' && ['function_call_output', 'custom_tool_call_output'].includes(p.type)) {
      const failed = p.is_error === true || (typeof p.output === 'string' && /^(Error:|Failed to find expected lines|apply_patch verification failed)/.test(p.output));
      for (const [id, tool] of state.tools) if (id === p.call_id || id.startsWith(`${p.call_id}:`)) { tool.end = t; tool.failed = failed; }
    }
  } else if (row.type === 'assistant') {
    const msg = row.message || {};
    const id = msg.id || row.uuid;
    if (id && Number.isFinite(t)) {
      const record = usage(msg.usage, 'claude');
      const prior = state.messages.get(id);
      if (record) {
        const combined = prior?.usage ? Object.fromEntries(FIELDS.map((key) => [key, Math.max(record[key], prior.usage[key])])) : record;
        state.messages.set(id, { t: Math.max(t, prior?.t || 0), usage: combined });
      } else if (!prior && msg.model !== '<synthetic>') state.messages.set(id, { t, usage: null });
    }
    if (Array.isArray(msg.content)) for (const block of msg.content) if (block.type === 'tool_use') rememberTool(state, { name: block.name, input: block.input, callId: block.id, t, cwd: row.cwd || state.cwd });
  } else if (row.type === 'user' && Array.isArray(row.message?.content)) {
    for (const block of row.message.content) if (block.type === 'tool_result') {
      const tool = state.tools.get(block.tool_use_id);
      if (tool) { tool.end = t; tool.failed = block.is_error === true; }
    }
  }
}

function windowResult(state, start, end, transcriptPath) {
  if (!state.identity) return { valid: false, reason: 'Transcript metadata does not match this session.' };
  const inWindow = (item) => Number.isFinite(item.t) && item.t >= start && item.t <= end;
  const raw = state.provider === 'codex' ? state.counters : [...state.messages.values()].filter((entry) => entry.usage).map((entry) => ({ t: entry.t, ...entry.usage }));
  const series = raw.filter(inWindow).sort((a, b) => a.t - b.t);
  const missing = state.provider === 'claude' && [...state.messages.values()].some((entry) => inWindow(entry) && !entry.usage);
  const partial = state.malformed || state.limited || state.incomplete || missing || series.some((item) => item.partial);
  let tokens = missingTokens('No token usage samples are recorded in this time window.');
  tokens.source = state.provider;
  if (series.length) {
    const totals = Object.fromEntries(FIELDS.map((key) => [key, series.reduce((sum, item) => sum + item[key], 0)]));
    tokens = { ...tokens, ...totals, status: partial ? 'partial' : 'available', samples: series.length, capturedUntil: series.at(-1).t, reason: partial ? 'Some transcript usage is unavailable or its cumulative baseline is incomplete; shown tokens are observed usage.' : null };
  } else if (state.limited) tokens.reason = 'Transcript parsing is catching up; token coverage is not yet available.';
  return { valid: true, provider: state.provider, path: transcriptPath, title: state.customTitle || state.prompts.find((item) => !item.text.startsWith('/'))?.text || state.prompts[0]?.text || '', tokens, tokenSeries: series.map(({ t, input, output, cacheRead, cacheWrite, total }) => ({ t, input, output, cacheRead, cacheWrite, total })), tools: [...state.tools.values()].filter((tool) => inWindow(tool) && !tool.failed && tool.end).map(({ command, ...tool }) => ({ ...tool, commandPrefix: command?.replace(/\s+/g, ' ').trim().slice(0, 180) || null })) };
}

const parsed = new Map();
function parseFile({ filePath, expected, start, end }) {
  const stat = fs.statSync(filePath);
  const key = `${filePath}\0${expected}`;
  let state = parsed.get(key);
  let fd;
  try {
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    let reset = !state || state.inode !== stat.ino || stat.size < state.offset || (stat.size === state.size && stat.mtimeMs !== state.mtime);
    if (!reset && state.offset && state.boundary) {
      const check = Buffer.alloc(state.boundary.length);
      fs.readSync(fd, check, 0, check.length, state.offset - check.length);
      reset = !check.equals(state.boundary);
    }
    if (reset) state = fresh(expected);
    const until = Math.min(stat.size, state.offset + MAX_PASS_BYTES);
    let cursor = state.offset;
    let carry = Buffer.alloc(0);
    let oversized = false;
    while (cursor < until) {
      const buffer = Buffer.alloc(Math.min(256 * 1024, until - cursor));
      const length = fs.readSync(fd, buffer, 0, buffer.length, cursor);
      if (!length) break;
      cursor += length;
      const data = Buffer.concat([carry, buffer.subarray(0, length)]);
      let at = 0;
      let newline;
      while ((newline = data.indexOf(10, at)) >= 0) {
        const line = data.subarray(at, newline);
        if (!oversized && line.length <= MAX_LINE_BYTES) {
          try { consume(state, JSON.parse(line.toString('utf8'))); } catch { if (line.length) state.malformed = true; }
        } else state.malformed = true;
        oversized = false;
        at = newline + 1;
      }
      carry = data.subarray(at);
      state.offset = cursor - carry.length;
      if (carry.length > MAX_LINE_BYTES) { oversized = true; carry = Buffer.alloc(0); state.malformed = true; state.offset = cursor; }
    }
    state.inode = stat.ino;
    state.size = stat.size;
    state.mtime = stat.mtimeMs;
    state.limited = cursor < stat.size;
    state.incomplete = carry.length > 0;
    state.boundary = Buffer.alloc(Math.min(64, state.offset));
    if (state.boundary.length) fs.readSync(fd, state.boundary, 0, state.boundary.length, state.offset - state.boundary.length);
    parsed.delete(key);
    parsed.set(key, state);
    while (parsed.size > 64) parsed.delete(parsed.keys().next().value);
    return windowResult(state, start, end, filePath);
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

if (!isMainThread && workerData?.kind === 'memory-transcript') {
  parentPort.on('message', ({ id, request }) => {
    try { parentPort.postMessage({ id, result: parseFile(request) }); }
    catch { parentPort.postMessage({ id, result: { valid: false, reason: 'Transcript is not currently readable.' } }); }
  });
}

/** Parse incrementally off the warm service's event loop; no subprocesses. */
export function createTranscriptEnricher({ roots = transcriptRoots() } = {}) {
  let worker;
  let nextId = 0;
  const pending = new Map();
  const pathCache = new Map();
  let fileIndex;
  let indexedAt = 0;
  async function allowed(candidate) {
    try {
      if (typeof candidate !== 'string' || !candidate.endsWith('.jsonl')) return null;
      const canonical = await fs.promises.realpath(candidate);
      const realRoots = (await Promise.all(roots.map((root) => fs.promises.realpath(root).catch(() => null)))).filter(Boolean);
      if (!isAllowedTranscriptPath(canonical, realRoots)) return null;
      return (await fs.promises.stat(canonical)).isFile() ? canonical : null;
    } catch { return null; }
  }
  async function indexFiles() {
    if (fileIndex && Date.now() - indexedAt < 60000) return fileIndex;
    fileIndex = (async () => {
      const files = [];
      const stack = [...roots];
      let inspected = 0;
      while (stack.length && inspected < 100000) {
        const dir = stack.pop();
        let entries;
        try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { continue; }
        for (const entry of entries) {
          inspected++;
          if (entry.isDirectory()) stack.push(path.join(dir, entry.name));
          else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(path.join(dir, entry.name));
        }
      }
      return files;
    })();
    indexedAt = Date.now();
    return fileIndex;
  }
  async function resolveSession(session) {
    const candidates = [...(session.transcriptPaths || []), session.transcript, pathCache.get(session.id)].filter(Boolean);
    // A shared event may carry a subagent transcript. Its filename is not a
    // match, even if the parent session id was copied onto the event.
    for (const candidate of candidates) if (path.basename(candidate).includes(session.id)) {
      const valid = await allowed(candidate);
      if (valid) { pathCache.set(session.id, valid); return valid; }
    }
    if (!/^[\da-f]{8}-[\da-f-]{27}$/i.test(session.id)) return null;
    for (const candidate of await indexFiles()) if (path.basename(candidate).includes(session.id)) {
      const valid = await allowed(candidate);
      if (valid) { pathCache.set(session.id, valid); return valid; }
    }
    return null;
  }
  function parse(request) {
    if (!worker) {
      // Node's test runner and packaged hosts add process-only exec flags that
      // Worker rejects. The parser needs no inherited CLI switches.
      worker = new Worker(new URL(import.meta.url), { workerData: { kind: 'memory-transcript' }, execArgv: [] });
      worker.on('message', ({ id, result }) => {
        pending.get(id)?.(result);
        pending.delete(id);
        if (!pending.size) worker.unref();
      });
      worker.on('error', () => {
        for (const resolve of pending.values()) resolve({ valid: false, reason: 'Transcript analysis is unavailable.' });
        pending.clear();
        worker = null;
      });
    }
    worker.ref();
    const id = ++nextId;
    return new Promise((resolve) => { pending.set(id, resolve); worker.postMessage({ id, request }); });
  }
  return {
    async read(session, { start, end }) {
      const filePath = await resolveSession(session);
      if (!filePath) return { valid: false, reason: 'No matching readable transcript was found for this session.' };
      return parse({ filePath, expected: session.id, start, end });
    },
    close() { worker?.terminate(); worker = null; },
  };
}
