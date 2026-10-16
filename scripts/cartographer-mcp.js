#!/usr/bin/env node
/**
 * cartographer-mcp.js — Session Cartographer recall as typed MCP tools, over stdio.
 *
 * Why this exists. Measured 2026-10-15 over 30 days: 21% of Claude sessions
 * recalled at all, nearly all on turn one, and 1 of 59 Codex sessions that saw
 * the startup nudge ever did. Recall had become fast (Turbo p90 377 ms), so the
 * bottleneck was reaching it: an agent had to choose to load a skill, resolve
 * the plugin root, and assemble a command line whose argument order it often got
 * wrong. A typed tool sits in the tool list of every MCP client — Claude Code,
 * Codex, Hermes, the desktop app — with a description that says when to call it.
 *
 * What this deliberately is not:
 *
 * - **A second telemetry writer.** recall, get, mark_used, thread and orient
 *   shell out to scripts/cartographer-search.sh, which stays the single writer
 *   of served, search-call and access rows and selects Turbo itself. Calling
 *   Turbo's HTTP API from here would have been faster to write and would have
 *   bypassed delta serving, the served log and the access ledger at once.
 *   facts and standup call their own read-only CLIs, which write nothing.
 *
 * - **A source of session identity.** Every child runs with this process's
 *   environment, so the script resolves the session chain exactly as it does
 *   for a Bash tool call. A session id is never a tool argument: a model that
 *   could name the session would be able to attribute its marks to any session
 *   it had seen an id for. Measured 2026-10-15 on this machine, Claude Code
 *   gives every stdio MCP child CLAUDE_CODE_SESSION_ID (the id it was spawned
 *   with); Codex 0.160 gives an MCP child nine variables and no session; Hermes
 *   gives eight. Under the last two every row says attribution_status
 *   "no_session" and a mark carries no call_id. That is the honest answer, and
 *   docs/MCP.md records it as a known limitation.
 *
 * - **A dependency.** The protocol surface used here is initialize, ping,
 *   tools/list, tools/call and cancellation: newline-delimited JSON-RPC that
 *   fits in a few hundred lines, in keeping with the repo's zero-dependency
 *   runtime (bm25-search.awk is the exemplar). The plugin ships no node_modules.
 *
 * - **A source of structuredContent.** Every tool answers with compact text
 *   only: one line per hit, call_id always present. Measured 2026-10-16, Claude
 *   Code 2.1.277 and Codex 0.160 hand the model JSON.stringify(structuredContent)
 *   whenever it is present and drop the text, and Hermes 0.21 hands it both.
 *   A recall that also carried structuredContent cost Claude Code ~1,600
 *   tokens at 3 hits and ~4,700 at 10, unclipped summaries and all; as text it
 *   costs ~590 and ~1,650. No client reads the JSON programmatically, so the
 *   text is the whole answer (docs/MCP.md, "What each client shows the model").
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { isResolved } from './sentinels.js';
import { renderText as renderFactsText } from './facts-render.js';

// Resolve physically, as cartographer-search.sh does: a skills symlink into the
// checkout makes a lexical `..` point somewhere else than the kernel's.
const SCRIPT_DIR = path.dirname(fs.realpathSync(fileURLToPath(import.meta.url)));
const ROOT = path.dirname(SCRIPT_DIR);
const SEARCH = path.join(SCRIPT_DIR, 'cartographer-search.sh');
const FACTS = path.join(SCRIPT_DIR, 'cartographer-facts.js');
const STANDUP = path.join(SCRIPT_DIR, 'cartographer-standup.js');
const TURBO_CONTROL = path.join(SCRIPT_DIR, 'cartographer-turbo.js');
const GRAPH = path.join(SCRIPT_DIR, 'cooccurrence-graph.js');
const REGISTRY = path.join(SCRIPT_DIR, 'project-registry.sh');

const SERVER_VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version || '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

// Newest first. A client asking for one of these gets it back; anything else
// gets the newest, which the client may accept or refuse (spec: lifecycle).
const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

// Telemetry purpose for every call this server makes. One value for all of
// them is load-bearing, not tidy: --touch and --get join a mark to its serve
// on (session, purpose, call_id), so an orient served under "focus" could never
// be marked used from here. Calls from this server are told apart from skill
// calls by purpose alone.
const PURPOSE = 'mcp';

// Same order and same sentinel rule as cartographer-search.sh. Read here only
// to report attribution back to the caller; the script resolves it for itself.
const SESSION_CHAIN = ['CARTOGRAPHER_SESSION_ID', 'CLAUDE_SESSION_ID', 'CLAUDE_CODE_SESSION_ID', 'CODEX_SESSION_ID'];

// Mirrors VALID_INTENTS in cartographer-search.sh / classify-prompt-intent.js.
const INTENTS = [
  'feature-design', 'implementation', 'bug-fixes', 'git-commands', 'deploy-release', 'run-build-app',
  'code-review-qa', 'planning-strategy', 'research', 'documentation', 'testing-verification',
  'refactor-cleanup', 'content-creation', 'data-analysis', 'feedback-context', 'plan-approvals', 'other',
];

const SEARCH_TIMEOUT_MS = 120_000;
const QUICK_TIMEOUT_MS = 30_000;
const OUTPUT_CAP_BYTES = 8 * 1024 * 1024;
const SUMMARY_CLIP = 180;

const devDir = () => process.env.CARTOGRAPHER_DEV_DIR || path.join(os.homedir(), 'Documents', 'dev');

let clientInfo = null;
let callSeq = 0;

// ─── Small utilities ───

class ToolInputError extends Error {}

function flatten(value) {
  return String(value ?? '').replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim();
}

function clip(value, max) {
  const text = flatten(value);
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Mirrors the CLI's own `call-<UTC stamp>-<pid>` shape, unique per server call. */
function mintCallId() {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
  callSeq += 1;
  return `call-${stamp}-mcp${process.pid}-${callSeq}`;
}

function sessionAttribution(env = process.env) {
  for (const name of SESSION_CHAIN) {
    if (isResolved(env[name])) return { attribution_status: 'session', session_source: name };
  }
  return { attribution_status: 'no_session', session_source: '' };
}

/**
 * The client names itself in `initialize`. That is a statement about which
 * agent is calling, not about which session, so it may fill the provider when
 * nothing else names one: under Codex and Hermes the child sees none of the
 * variables the script infers a provider from, and CARTOGRAPHER_SESSION_ID
 * names a session but no agent. Every row would otherwise read provider
 * "unknown". A session from CLAUDE_CODE_SESSION_ID or CODEX_SESSION_ID already
 * names its agent, and the script's inference from it is left alone.
 */
function providerFromClient(name) {
  const value = String(name || '').toLowerCase();
  if (value.includes('claude')) return 'claude';
  if (value.includes('codex')) return 'codex';
  if (value.includes('hermes')) return 'hermes';
  return '';
}

function childEnv() {
  const env = { ...process.env, CARTOGRAPHER_PURPOSE: PURPOSE };
  const { session_source: source } = sessionAttribution(env);
  if (!isResolved(env.CARTOGRAPHER_PROVIDER) && (source === '' || source === 'CARTOGRAPHER_SESSION_ID')) {
    const provider = providerFromClient(clientInfo?.name);
    if (provider) env.CARTOGRAPHER_PROVIDER = provider;
  }
  return env;
}

/**
 * Run a child to completion. Detached into its own process group so a
 * cancellation or timeout can stop the awk/grep workers the search script
 * spawns, not just the bash parent.
 */
function run(command, args, { timeoutMs = SEARCH_TIMEOUT_MS, signal, env = childEnv() } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    } catch (error) {
      resolve({ code: 127, stdout: '', stderr: error.message, timedOut: false, cancelled: false });
      return;
    }
    const out = [];
    const err = [];
    let outBytes = 0;
    let errBytes = 0;
    let timedOut = false;
    let cancelled = false;
    const killGroup = () => {
      try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch {} }
    };
    const timer = setTimeout(() => { timedOut = true; killGroup(); }, timeoutMs);
    const onAbort = () => { cancelled = true; killGroup(); };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    child.stdout.on('data', (chunk) => {
      if (outBytes < OUTPUT_CAP_BYTES) out.push(chunk);
      outBytes += chunk.length;
    });
    child.stderr.on('data', (chunk) => {
      if (errBytes < OUTPUT_CAP_BYTES) err.push(chunk);
      errBytes += chunk.length;
    });
    child.on('error', (error) => err.push(Buffer.from(`${error.message}\n`)));
    child.on('close', (code) => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        timedOut,
        cancelled,
      });
    });
  });
}

function stderrLines(stderr, max = 8) {
  return String(stderr || '').split('\n').map((line) => line.trim()).filter(Boolean).slice(0, max);
}

function failure(label, result) {
  if (result.timedOut) return `${label} timed out and was stopped.`;
  if (result.cancelled) return `${label} was cancelled.`;
  const detail = stderrLines(result.stderr, 6).join(' | ') || `exit ${result.code}`;
  return `${label} failed: ${detail}`;
}

/** Last row in a JSONL file that satisfies `match`, reading only its tail. */
function tailRows(file, match, { bytes = 512 * 1024 } = {}) {
  if (!file || file === '/dev/null') return [];
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const length = Math.min(size, bytes);
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, size - length);
    const rows = [];
    for (const line of buffer.toString('utf8').split('\n')) {
      if (!line.startsWith('{')) continue;
      try {
        const row = JSON.parse(line);
        if (match(row)) rows.push(row);
      } catch {}
    }
    return rows;
  } catch {
    return [];
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch {}
  }
}

// `||`, not `??`: the CLI reads these with ${VAR:-default}, so empty means default.
const searchCallLog = () => process.env.CARTOGRAPHER_SEARCH_CALL_LOG || path.join(devDir(), '.carto', 'search-calls.jsonl');
const accessLedger = () => process.env.CARTOGRAPHER_ACCESS_LEDGER || path.join(devDir(), 'access-ledger.jsonl');

// ─── Argument validation ───
// Input errors come back as isError results, not protocol errors, so the model
// sees what was wrong and can correct the call.

function readString(args, key, { required = false, max = 500, pattern, hint, allowDash = false } = {}) {
  const raw = args?.[key];
  if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) {
    if (required) throw new ToolInputError(`${key} is required${hint ? ` (${hint})` : ''}.`);
    return '';
  }
  if (typeof raw !== 'string') throw new ToolInputError(`${key} must be a string.`);
  const value = raw.trim();
  if (value.length > max) throw new ToolInputError(`${key} is longer than ${max} characters.`);
  if (/[\u0000-\u001f]/.test(value)) throw new ToolInputError(`${key} must be a single line.`);
  // The shell CLIs read a leading dash as a flag.
  if (!allowDash && value.startsWith('-')) throw new ToolInputError(`${key} must not start with "-".`);
  if (pattern && !pattern.test(value)) throw new ToolInputError(`${key} ${hint || 'is malformed'}: ${value}`);
  return value;
}

function readInt(args, key, { min, max, fallback }) {
  const raw = args?.[key];
  if (raw === undefined || raw === null || raw === '') return fallback;
  const value = typeof raw === 'string' ? Number(raw) : raw;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ToolInputError(`${key} must be an integer from ${min} to ${max}.`);
  }
  return value;
}

function readBool(args, key) {
  const raw = args?.[key];
  if (raw === undefined || raw === null) return false;
  if (typeof raw === 'boolean') return raw;
  if (raw === 'true' || raw === 'false') return raw === 'true';
  throw new ToolInputError(`${key} must be true or false.`);
}

// Same character class the CLI enforces for --get/--touch ids.
const EVENT_ID = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,199}$/;
// Same class the CLI enforces for --call-id.
const CALL_ID = /^[A-Za-z0-9_.:][A-Za-z0-9_.:-]{0,159}$/;

function readIds(args, key, { max = 25 } = {}) {
  let raw = args?.[key];
  // Accept "a,b" as well as ["a","b"]: models pass both, and refusing the
  // string form costs a round trip for no safety benefit.
  if (typeof raw === 'string') raw = raw.split(',');
  if (!Array.isArray(raw)) throw new ToolInputError(`${key} must be an array of event_id strings.`);
  const ids = [];
  for (const item of raw) {
    const id = String(item ?? '').trim();
    if (!id) continue;
    if (!EVENT_ID.test(id)) throw new ToolInputError(`${key} contains a malformed event_id: ${id}`);
    if (!ids.includes(id)) ids.push(id);
  }
  if (ids.length === 0) throw new ToolInputError(`${key} must name at least one event_id.`);
  if (ids.length > max) throw new ToolInputError(`${key} accepts at most ${max} ids per call.`);
  return ids;
}

function readCallId(args, { required }) {
  return readString(args, 'call_id', {
    required,
    max: 160,
    pattern: CALL_ID,
    hint: 'the call_id printed by the recall or orient call that served these ids',
  });
}

// ─── Search output parsing ───

function parseExtras(extras) {
  const out = {};
  for (const pair of String(extras || '').split('|')) {
    const colon = pair.indexOf(':');
    if (colon <= 0) continue;
    out[pair.slice(0, colon)] = pair.slice(colon + 1);
  }
  return out;
}

/**
 * The agent behind a hit. Turbo rows carry it; portable keyword rows do not,
 * but their transcript path names its store, which is a fact rather than a
 * guess. Anything else stays empty and prints as "?".
 */
function providerOf(extras) {
  if (isResolved(extras.provider)) return String(extras.provider).toLowerCase();
  const transcript = extras.transcript || '';
  if (/\/\.codex\//.test(transcript)) return 'codex';
  if (/\/\.claude\//.test(transcript)) return 'claude';
  if (/\/\.hermes\//.test(transcript)) return 'hermes';
  return '';
}

function normalizeHit(row) {
  const extras = parseExtras(row.extras);
  return {
    rank: Number(row.rank) || 0,
    event_id: row.event_id,
    timestamp: row.timestamp || '',
    project: row.project || '',
    provider: providerOf(extras),
    event_type: row.event_type || '',
    source: row.source || '',
    summary: flatten(row.summary),
    transcript_path: extras.transcript || null,
  };
}

function parseJsonl(stdout) {
  const rows = [];
  const notes = [];
  for (const line of String(stdout || '').split('\n')) {
    const text = line.trim();
    if (!text) continue;
    if (text.startsWith('{')) {
      try {
        rows.push(JSON.parse(text));
        continue;
      } catch {}
    }
    notes.push(text);
  }
  return { rows, notes };
}

/**
 * Which ladders contributed. A missing ladder is how every real recall defect in
 * this codebase presented (docs/TESTING.md), so the mix is shown, not the count.
 */
function sourceMix(hits) {
  const mix = { keyword: 0, semantic: 0, both: 0 };
  for (const hit of hits) {
    const semantic = /semantic/.test(hit.source);
    const keyword = hit.source.split('+').some((part) => part && part !== 'semantic');
    if (semantic && keyword) mix.both += 1;
    else if (semantic) mix.semantic += 1;
    else mix.keyword += 1;
  }
  return mix;
}

// Ids that live only in the semantic index (turn-<sid>-<idx>) or in a
// transcript grep (transcript-…). `get` reads the event logs, so it answers
// these "missing".
const UNFETCHABLE = /^(turn|transcript)-/;

/**
 * One hit as the model sees it, plus its transcript path when `get` cannot
 * fetch the id. That path is the only way to follow a conversation turn up,
 * and the text is all any client shows the model, so it goes here. A path
 * costs ~60 tokens, so the hits `get` can resolve leave theirs to `get`.
 */
function hitLines(hit) {
  const date = (hit.timestamp || '?').slice(0, 10);
  const type = hit.event_type ? `${hit.event_type} · ` : '';
  const lines = [`${String(hit.rank).padStart(2)}. ${date} · ${hit.project || '-'} · ${hit.provider || '?'} · ${type}`
    + `${clip(hit.summary, SUMMARY_CLIP)} · ${hit.event_id}`];
  if (UNFETCHABLE.test(hit.event_id) && hit.transcript_path) lines.push(`    transcript: ${hit.transcript_path}`);
  return lines;
}

/**
 * Run one standard search through the CLI and read back what it served. The
 * call row is read, never written: the script already wrote it.
 */
async function servedSearch({ query, project, since, before, limit, intent, includeSeen, signal }) {
  const callId = mintCallId();
  const args = [SEARCH, query, '--format', 'jsonl', '--limit', String(limit), '--call-id', callId];
  if (project) args.push('--project', project);
  if (since) args.push('--since', since);
  if (before) args.push('--before', before);
  if (intent) args.push('--intent', intent);
  if (includeSeen) args.push('--all');
  const result = await run('bash', args, { signal });
  const { rows, notes } = parseJsonl(result.stdout);
  const hits = rows.filter((row) => row && row.event_id).map(normalizeHit);
  const call = tailRows(searchCallLog(), (row) => row.call_id === callId).pop() || null;
  // Turbo rows carry the semantic leg's status; portable rows do not.
  const semanticStatus = rows.find((row) => row?.semantic_status)?.semantic_status || null;
  return { callId, result, hits, notes, call, semanticStatus };
}

/**
 * Backend, latency and semantic status, from the search-call row the CLI wrote.
 * Without that row (an unwritable log, as under Codex's sandbox) the semantic
 * status still comes from Turbo's rows: a missing ladder is the signal worth
 * keeping (docs/TESTING.md).
 */
function backendLine(call, semanticStatus) {
  if (!call) return semanticStatus ? `semantic ${semanticStatus}` : '';
  const backend = call.selected_backend === 'explorer' ? 'turbo' : (call.selected_backend || 'cli');
  const parts = [`${backend} ${Number(call.elapsed_ms ?? 0)} ms`];
  if (call.semantic_status && call.semantic_status !== 'unknown') parts.push(`semantic ${call.semantic_status}`);
  if (call.fallback_reason) parts.push(`fallback: ${call.fallback_reason}`);
  return parts.join(' · ');
}

// ─── Tools ───

async function toolRecall(args, { signal }) {
  const query = readString(args, 'query', { required: true, max: 500, hint: 'the words the original work would have used' });
  const project = readString(args, 'project', { max: 200 });
  const since = readString(args, 'since', { max: 64 });
  const before = readString(args, 'before', { max: 64 });
  const limit = readInt(args, 'limit', { min: 1, max: 50, fallback: 10 });
  const intent = readString(args, 'intent', { max: 40 });
  if (intent && !INTENTS.includes(intent)) {
    throw new ToolInputError(`intent must be one of: ${INTENTS.join(', ')}.`);
  }
  const includeSeen = readBool(args, 'include_seen');

  const search = await servedSearch({ query, project, since, before, limit, intent, includeSeen, signal });
  if (search.result.code !== 0) return errorResult(failure('recall', search.result));

  const { callId, hits, call, semanticStatus } = search;
  const filters = [project && `project ${project}`, since && `since ${since}`, before && `before ${before}`,
    intent && `intent ${intent}`].filter(Boolean).join(' · ');
  const backend = backendLine(call, semanticStatus);
  const lines = [];
  lines.push(`recall "${clip(query, 120)}" — ${hits.length} result${hits.length === 1 ? '' : 's'} · call_id ${callId}`
    + `${filters ? ` · ${filters}` : ''}${backend ? ` · ${backend}` : ''}`);
  if (hits.length) {
    const mix = sourceMix(hits);
    lines.push(`sources: keyword ${mix.keyword} · semantic ${mix.semantic} · both ${mix.both}`);
    for (const hit of hits) lines.push(...hitLines(hit));
    lines.push('');
    lines.push(`Summaries are truncated. Next: get(event_ids, call_id="${callId}") for full records and transcript paths;`
      + ` mark_used(event_ids, call_id="${callId}") for the hits that informed your answer.`
      + (hits.some((hit) => UNFETCHABLE.test(hit.event_id))
        ? ' turn-… hits are conversation turns get cannot fetch: read the transcript under them.'
        : ''));
  } else {
    lines.push('No results. Try the words the original work would have used (file, component, error text), drop'
      + ' project/since, or widen the window.'
      + (sessionAttribution(childEnv()).attribution_status === 'session' && !includeSeen
        ? ' Hits already shown earlier in this session are hidden; include_seen=true re-shows them.'
        : ''));
  }
  for (const note of search.notes) lines.push(`(${note.replace(/^\(|\)$/g, '')})`);
  return okResult(lines.join('\n'));
}

/** Split `--get` output into records and misses. Its blocks are "=== id ===" then JSON. */
function parseGetOutput(stdout) {
  const records = [];
  const missing = [];
  const parts = String(stdout || '').split(/^=== (.+?) ===$/m);
  for (let i = 1; i < parts.length; i += 2) {
    const id = parts[i].trim();
    const body = (parts[i + 1] || '').replace(/\n?\(\d+ fetched, \d+ missing\)\s*$/, '').trim();
    if (!body || body.startsWith('(no event')) {
      missing.push(id);
      continue;
    }
    try {
      records.push(JSON.parse(body));
    } catch {
      // jq absent: the CLI prints the raw line, which is still one JSON object.
      const line = body.split('\n').find((l) => l.trim().startsWith('{'));
      try {
        records.push(JSON.parse(line));
      } catch {
        missing.push(id);
      }
    }
  }
  return { records, missing };
}

async function toolGet(args, { signal }) {
  const ids = readIds(args, 'event_ids');
  const callId = readCallId(args, { required: false });
  const cli = [SEARCH, '_', '--get', ids.join(',')];
  if (callId) cli.push('--call-id', callId);
  const result = await run('bash', cli, { signal, timeoutMs: QUICK_TIMEOUT_MS });
  // Exit 1 means nothing was found, which is an answer, not a failure.
  if (result.code !== 0 && result.code !== 1) return errorResult(failure('get', result));
  if (result.code === 1 && !/=== /.test(result.stdout)) return errorResult(failure('get', result));
  const { records, missing } = parseGetOutput(result.stdout);

  const lines = [`get — ${records.length} fetched, ${missing.length} missing${callId ? ` · call_id ${callId}` : ''}`];
  for (const record of records) {
    const provider = isResolved(record.provider) ? record.provider : providerOf({ transcript: record.transcript_path });
    lines.push('');
    // Time, project and type are in the record below; the agent is named here
    // because older rows carry no provider field and only the path tells.
    lines.push(`${record.event_id} · ${provider || '?'}`);
    const shown = { ...record };
    if (record.transcript_path_resolved || record.transcript_path) {
      if (record.transcript_path_resolved) {
        lines.push(`  transcript: ${record.transcript_path_resolved} (archived; read this path, not the recorded one)`);
      } else {
        lines.push(`  transcript: ${record.transcript_path}${record.transcript_path_status === 'missing' ? ' (MISSING on disk)' : ''}`);
      }
      // The line above says which path to read and whether it exists; printing
      // the recorded path again inside the record costs ~60 tokens and offers
      // the stale one of the two.
      delete shown.transcript_path;
      delete shown.transcript_path_resolved;
      delete shown.transcript_path_status;
    }
    lines.push(`  record: ${JSON.stringify(shown)}`);
  }
  if (missing.length) {
    lines.push('');
    lines.push(`missing: ${missing.join(', ')} — aged out, never existed, or a transcript turn (turn-…) that lives only`
      + ' in the semantic index; for a turn, read the transcript path recall returned with it. Do not answer around the gap.');
  }
  if (!callId) lines.push('(no call_id given: this fetch is recorded without attributing it to a recall)');
  return okResult(lines.join('\n'));
}

const ATTRIBUTION_MEANING = {
  explicit: 'attributed to the call',
  no_session: 'recorded without a call_id: this server received no session id from its client, so a use cannot'
    + ' be joined to the serve (expected under Codex and Hermes)',
  invalid_call: 'not attributed: that call_id did not serve this event in this session',
  prior_access: 'attributed through an earlier access',
  unique_serve: 'attributed to the only call that served it',
  ambiguous_prior_access: 'not attributed: several earlier calls are candidates',
  ambiguous_serve: 'not attributed: several calls served it',
  no_compatible_serve: 'not attributed: no call in this session served it',
};

async function toolMarkUsed(args, { signal }) {
  const ids = readIds(args, 'event_ids');
  const callId = readCallId(args, { required: true });
  const startedIso = new Date(Math.floor(Date.now() / 1000) * 1000).toISOString().replace('.000Z', 'Z');
  const result = await run('bash', [SEARCH, '_', '--touch', ids.join(','), '--call-id', callId],
    { signal, timeoutMs: QUICK_TIMEOUT_MS });
  if (result.code !== 0) return errorResult(failure('mark_used', result));

  // Read back what the script recorded rather than restating what was asked.
  const written = tailRows(accessLedger(), (row) => row.source === 'result_used'
    && row.requested_call_id === callId && ids.includes(row.event_id)
    && String(row.timestamp || '') >= startedIso);
  const byId = new Map();
  for (const row of written) byId.set(row.event_id, row);
  const marks = ids.map((id) => {
    const row = byId.get(id);
    return {
      event_id: id,
      recorded: Boolean(row),
      call_id: row?.call_id ?? null,
      attribution_status: row?.attribution_status ?? null,
    };
  });
  const recorded = marks.filter((m) => m.recorded).length;
  const lines = [`mark_used — ${recorded} of ${ids.length} recorded · call_id ${callId} · purpose ${PURPOSE}`];
  for (const mark of marks) {
    const status = mark.attribution_status;
    lines.push(`  ${mark.event_id}  ${mark.recorded ? `${status}: ${ATTRIBUTION_MEANING[status] || status}` : 'not found in the ledger'}`);
  }
  return okResult(lines.join('\n'));
}

/** Parse the `--thread` timeline: "★ [ts] [type] id", a summary line, then project/parent lines. */
function parseThread(stdout) {
  const events = [];
  let current = null;
  let detailLine = 0;
  for (const line of String(stdout || '').split('\n')) {
    const head = line.match(/^(★| ) \[(.*?)\] \[(.*?)\] (\S+)\s*$/);
    if (head) {
      current = { anchor: head[1] === '★', timestamp: head[2], type: head[3], event_id: head[4],
        summary: '', project: '', parent_event_id: '' };
      events.push(current);
      detailLine = 0;
      continue;
    }
    if (!current || !line.startsWith('    ')) continue;
    detailLine += 1;
    // The first indented line is always the summary, whatever it says.
    if (detailLine === 1) {
      current.summary = line.trim();
      continue;
    }
    const detail = line.match(/^ {4}(project|parent): (.*)$/);
    if (detail?.[1] === 'project') current.project = detail[2];
    else if (detail?.[1] === 'parent') current.parent_event_id = detail[2];
  }
  return events;
}

async function toolThread(args, { signal }) {
  const eventId = readString(args, 'event_id', { required: true, max: 200, pattern: EVENT_ID, hint: 'is not an event_id' });
  // One awk pass over the whole changelog: ~11 s on 109 MB, so the long budget.
  const result = await run('bash', [SEARCH, '_', '--thread', eventId], { signal });
  const events = parseThread(result.stdout);
  if (result.code !== 0 && events.length === 0) {
    if (/no event with id/.test(result.stdout)) {
      return okResult(`thread — no changelog event ${eventId}. Threads cover changelog events (commits, edits,`
        + ' commands, research), not transcript turns or milestones.');
    }
    return errorResult(failure('thread', result));
  }
  const lines = [`thread ${eventId} — ${events.length} event${events.length === 1 ? '' : 's'}, oldest first, ★ = anchor`];
  for (const event of events) {
    lines.push(`${event.anchor ? '★' : ' '} ${(event.timestamp || '?').slice(0, 19)} · ${event.project || '-'} · `
      + `${event.type || '-'} · ${clip(event.summary, SUMMARY_CLIP)} · ${event.event_id}`);
  }
  return okResult(lines.join('\n'));
}

/** One graph lens. Its "(no …)" answers mean "nothing to show", not an error. */
async function graphLens(flag, project, signal) {
  const result = await run('node', [GRAPH, flag, project], { signal, timeoutMs: QUICK_TIMEOUT_MS });
  const text = result.stdout.trim();
  if (result.code !== 0 || !text || /^\(no /m.test(text)) return [];
  return text.split('\n').map((line) => line.replace(/\s+$/, '')).filter(Boolean).slice(0, 12);
}

async function toolOrient(args, { signal }) {
  const project = readString(args, 'project', { required: true, max: 200, hint: 'a project or family name' });
  const limit = readInt(args, 'limit', { min: 1, max: 40, fallback: 15 });

  const family = run('bash', [REGISTRY, '--expand', project], { signal, timeoutMs: QUICK_TIMEOUT_MS });
  // The same query /remember --project runs, under this server's purpose so its
  // hits can be marked used from here.
  const recent = servedSearch({ query: 'recent activity', project, limit, signal });
  // Sequential: each run rewrites the graph's cache file.
  const lenses = (async () => ({
    related: await graphLens('--related', project, signal),
    maneuvers: await graphLens('--maneuvers', project, signal),
  }))();
  const [familyResult, search, graph] = await Promise.all([family, recent, lenses]);
  if (search.result.code !== 0) return errorResult(failure('orient', search.result));

  const members = familyResult.code === 0
    ? familyResult.stdout.split('\n').map((s) => s.trim()).filter(Boolean)
    : [];
  const isFamily = members.length > 1 || (members.length === 1 && members[0] !== project);
  const backend = backendLine(search.call, search.semanticStatus);
  const lines = [`orient ${project}${isFamily ? ` (family: ${members.join(', ')})` : ''} · call_id ${search.callId}`
    + `${backend ? ` · ${backend}` : ''}`];
  lines.push('');
  // The skill's orientation query ranks by relevance with recency decay, so
  // high-salience milestones from weeks ago can outrank today's edits. Say so
  // rather than let the list read as a timeline.
  lines.push(`Recent activity, ranked (recency-weighted relevance, not a timeline; ${search.hits.length}):`);
  if (search.hits.length) for (const hit of search.hits) lines.push(...hitLines(hit));
  else lines.push('  none recorded for this name — check the spelling, or try a family name.');
  if (graph.related.length) {
    lines.push('');
    lines.push(...graph.related);
  }
  if (graph.maneuvers.length) {
    lines.push('');
    lines.push(...graph.maneuvers);
  }
  lines.push('');
  lines.push(`Next: get/mark_used take call_id "${search.callId}"; standup(project="${project}") shows who else is working here now.`);
  return okResult(lines.join('\n'));
}

/**
 * Start the warm service the way cartographer-search.sh does before a recall:
 * only when the shared preference enables Turbo with auto-start. facts has no
 * portable fallback, so without this a facts call would fail on a service that
 * recall would have started.
 */
async function turboTarget(signal) {
  const resolved = await run('node', [TURBO_CONTROL, 'resolve'], { signal, timeoutMs: QUICK_TIMEOUT_MS });
  const [enabledRaw, autoStart, url] = resolved.stdout.trim().split(/\s+/);
  let enabled = enabledRaw === '1';
  const override = process.env.CARTOGRAPHER_TURBO;
  if (override !== undefined) enabled = /^(1|true|yes|on)$/i.test(override);
  const target = process.env.CARTOGRAPHER_TURBO_URL || url || 'http://127.0.0.1:2526';
  if (enabled && autoStart === '1') {
    await run('node', [TURBO_CONTROL, 'ensure'], { signal, timeoutMs: QUICK_TIMEOUT_MS });
  }
  return target;
}

async function toolFacts(args, { signal }) {
  const verb = readString(args, 'verb', { required: true, max: 16, hint: 'census, tempo, or delta' });
  if (!['census', 'tempo', 'delta'].includes(verb)) throw new ToolInputError('verb must be census, tempo, or delta.');
  const project = readString(args, 'project', { max: 200 });
  const since = readString(args, 'since', { max: 64 });
  const before = readString(args, 'before', { max: 64 });
  // Opaque token; the facts client passes it through without reading flags.
  const cursor = readString(args, 'cursor', { max: 65536, allowDash: true });
  if (verb === 'delta' && (since || before)) {
    throw new ToolInputError('delta is bounded by its cursor, not by since/before; omit the window.');
  }
  if (verb !== 'delta' && cursor) throw new ToolInputError('cursor applies to verb "delta" only.');
  const top = readInt(args, 'top', { min: 1, max: 200, fallback: 10 });
  const sample = readInt(args, 'sample', { min: 0, max: 10, fallback: 3 });

  const url = await turboTarget(signal);
  const cli = [FACTS, '--verb', verb, '--format', 'json', '--purpose', PURPOSE, '--top', String(top),
    '--sample', String(sample), '--url', url, '--timeout', '5000', '--corpus-root', devDir()];
  if (project) cli.push('--project', project);
  if (since) cli.push('--since', since);
  if (before) cli.push('--before', before);
  if (cursor) cli.push('--cursor', cursor);
  const result = await run('node', cli, { signal, timeoutMs: QUICK_TIMEOUT_MS });
  if (result.code !== 0) {
    const reason = failure('facts', result);
    const hint = result.code === 75
      ? ' facts needs the warm Turbo service and it did not answer. Enable Turbo (the /turbo skill), or run'
        + ' `node scripts/cartographer-turbo.js start`; recall still works without it.'
      : '';
    return errorResult(`${reason}${hint}`);
  }
  let response;
  try {
    response = JSON.parse(result.stdout);
  } catch {
    return errorResult('facts returned output that is not JSON.');
  }
  const text = renderFactsText(response, 'turbo')
    + (verb === 'delta' ? '\nPass the cursor above back as `cursor` on the next delta call.\n' : '')
    + 'Every count cites sample event_ids; verify any number with get(event_ids).\n';
  return okResult(text);
}

const WINDOW = /^\d+(\.\d+)?[mhd]$/i;

async function toolStandup(args, { signal }) {
  // The CLI falls back to 6h on a window it cannot parse, silently; refuse here
  // instead so "1w" is not answered as six hours.
  const window = readString(args, 'window', { max: 16, pattern: WINDOW, hint: 'must look like 90m, 6h or 2d' }) || '6h';
  const project = readString(args, 'project', { max: 200 });
  const commit = readString(args, 'commit', { max: 64, pattern: /^#?[A-Za-z0-9._-]{4,64}$/, hint: 'must be a sha or sha prefix' });

  const cli = [STANDUP, '--since', window];
  if (project) cli.push('--project', project);
  if (commit) cli.push('--commit', commit);
  // Without a session, the CLI guesses "you" from the freshest event, which is
  // sound for a Bash call the tool hook just logged and unsound here: nothing
  // logs an MCP call, so the guess would claim a peer and hide it from the
  // roster. "unknown" is the pipeline's own spelling of absence (sentinels.js).
  if (sessionAttribution(childEnv()).attribution_status === 'no_session') cli.push('--me', 'unknown');

  const result = await run('node', cli, { signal, timeoutMs: QUICK_TIMEOUT_MS });
  if (result.code !== 0) return errorResult(failure('standup', result));
  return okResult(result.stdout.trimEnd());
}

// ─── Tool definitions: the descriptions are the product ───
// Claude Code's tool search loads names and server instructions up front and a
// tool's schema on demand, matching only the head of a long description, so
// each description leads with the words a model would search for.

const TOOLS = [
  {
    name: 'recall',
    title: 'Recall past sessions',
    description: [
      'Search shared memory of past agent sessions (Claude Code, Codex, Hermes): decisions, bug fixes, commits,',
      'research, wrap-up notes and conversation turns, across every repo. Hybrid keyword (BM25) + semantic ranking.',
      '',
      'Call it BEFORE re-deriving something an earlier session may have settled, and whenever the user signals',
      'history: "did we…", "didn\'t we already…", "I thought we fixed…", "last time", "remember when", "what did we',
      'decide about…", "which agent tried…", "why is this like this", or names a prior fix, decision, paper or',
      'approach. Also before debugging something that looks familiar.',
      '',
      'Returns one line per hit (date · project · agent · event type · summary · event_id), the call_id and the',
      'keyword/semantic source mix; a conversation-turn hit (turn-…) also prints its transcript path, which get',
      'cannot fetch. Summaries are truncated: follow with get(event_ids, call_id) for full records and transcript',
      'paths, then mark_used(event_ids, call_id) for the hits that informed your answer.',
      '',
      'Query with the words the original work used (file, component, error text, commit phrasing), not a',
      'question. Cost: about 0.3-1 s with the warm Turbo service, 10-20 s on the portable fallback; about 600',
      'tokens for 3 hits and 1,650 for 10. Later calls in the same session hide hits already shown;',
      'include_seen=true re-shows them.',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keywords the original work would contain, e.g. "blur shader fix" or "turbo timeout fallback".' },
        project: { type: 'string', description: 'Scope to a project; case-insensitive substring, and a family name covers its repos.' },
        since: { type: 'string', description: 'Lower time bound: today, yesterday, "this morning", "this week", "last week", 7d, 2h, 2026-10-01.' },
        before: { type: 'string', description: 'Upper time bound, same forms as since.' },
        limit: { type: 'integer', minimum: 1, maximum: 50, default: 10, description: 'Hits to return (default 10).' },
        intent: { type: 'string', enum: INTENTS, description: 'Only conversation turns whose prompt had this intent. Semantic leg only.' },
        include_seen: { type: 'boolean', default: false, description: 'Re-show hits already returned earlier in this session.' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    // Recall writes retrieval telemetry (served rows), the way a GET writes an
    // access log; it changes nothing the user or the repo can see.
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    // The one schema worth loading before the model searches for tools: the
    // measured problem is that agents do not reach for recall at all.
    _meta: { 'anthropic/alwaysLoad': true },
    handler: toolRecall,
  },
  {
    name: 'get',
    title: 'Fetch full event records',
    description: [
      'Fetch complete, untruncated records by event_id: the verification step after recall or orient. Each record',
      'comes back as its full JSON (session_id, files_changed and diff_shape where recorded) under a line naming',
      'its transcript: the archived path when Codex moved the session, flagged MISSING when it is gone.',
      'Ids that resolve to nothing are listed as missing, not dropped; say so rather than answering around the gap.',
      'Transcript-turn ids (turn-…) live only in the semantic index and come back missing; read the transcript path',
      'recall printed under them instead. Pass the call_id of the call that served the ids; omit it only for ids',
      'from thread, facts or standup. Cost about 0.1 s and 600 tokens per commit record. A fetch records',
      'inspection, not use: still call mark_used for records you relied on.',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        event_ids: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 25, description: 'event_ids from recall, orient, thread, facts or standup.' },
        call_id: { type: 'string', description: 'call_id of the recall or orient call that served these ids.' },
      },
      required: ['event_ids'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    handler: toolGet,
  },
  {
    name: 'mark_used',
    title: 'Mark recall results as used',
    description: [
      'Record that specific recall results actually informed your answer or work (promote-on-reuse). Call it after',
      'you used a hit (quoted it, followed its transcript, applied its fix), with the event_ids in the order you',
      'used them and the call_id of the recall or orient call that served them. Do not mark results you read and',
      'discarded: a mark raises that event in every future session\'s ranking, so a false one misleads later',
      'agents. Returns the attribution recorded for each id. Cost about 0.1 s; appends one ledger row per id.',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        event_ids: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 25, description: 'Hits that informed your answer, in the order you used them.' },
        call_id: { type: 'string', description: 'call_id of the recall or orient call that served them.' },
      },
      required: ['event_ids', 'call_id'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    handler: toolMarkUsed,
  },
  {
    name: 'thread',
    title: 'Trace a work arc',
    description: [
      'Walk the work arc around one event: its ancestors and descendants in the same session (events chained by',
      'parent_event_id within 60 s), oldest first, the anchor marked ★. Use it for "how did we get to this commit",',
      '"what led up to that fix", "what happened right after". Anchor on an event_id from recall or get. Covers',
      'changelog events (commits, edits, commands, research), not transcript turns or milestones. Slow: one pass',
      'over the whole changelog, about 10-20 s on a 180k-event corpus. Writes nothing.',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        event_id: { type: 'string', description: 'The anchor event_id.' },
      },
      required: ['event_id'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    handler: toolThread,
  },
  {
    name: 'orient',
    title: 'Orient on a project',
    description: [
      'Catch up on one project before working in it: recent activity (milestones, commits, research), co-active',
      'related projects, and its recurring maneuvers (deploy, release, merge patterns). Use at the start of work in',
      'a repo, when switching projects, or for "where was I on X" / "catch me up on X". Project names match as a',
      'case-insensitive substring, and a registered family name covers its repos. Returns a call_id like recall, so',
      'get and mark_used work on its hits. Cost about 1-3 s. For who else is working in the project right now, use',
      'standup.',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project or family name, e.g. the repository directory name.' },
        limit: { type: 'integer', minimum: 1, maximum: 40, default: 15, description: 'Recent-activity hits (default 15).' },
      },
      required: ['project'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    handler: toolOrient,
  },
  {
    name: 'facts',
    title: 'Count corpus facts',
    description: [
      'Count what is true of the session history, deterministically. This is not a ranking: use it when the question',
      'is "how much / how many / what happened in this window", not "find the relevant thing". census: events,',
      'sessions and commits by project, type, source and provider. tempo: per-project daily activity against a',
      'baseline, z-scores labelled by reliability. delta: events appended since a cursor; the first call returns a',
      'baseline cursor to pass back next time. Every bucket cites sample event_ids you can check with get.',
      'since/before accept 24h, 7d, today, yesterday, "last week", 2026-10-01; delta takes a cursor instead.',
      'Needs the warm Turbo service, started automatically when Turbo is enabled. Cost about 0.1-0.5 s; writes',
      'nothing.',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        verb: { type: 'string', enum: ['census', 'tempo', 'delta'], description: 'census, tempo, or delta.' },
        project: { type: 'string', description: 'Scope to a project or family (substring match).' },
        since: { type: 'string', description: 'Window start for census/tempo.' },
        before: { type: 'string', description: 'Window end for census/tempo.' },
        top: { type: 'integer', minimum: 1, maximum: 200, default: 10, description: 'Buckets per dimension (default 10).' },
        sample: { type: 'integer', minimum: 0, maximum: 10, default: 3, description: 'Sample event_ids per bucket (default 3).' },
        cursor: { type: 'string', description: 'delta only: the cursor a previous delta call returned.' },
      },
      required: ['verb'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    handler: toolFacts,
  },
  {
    name: 'standup',
    title: 'Who else is working now',
    description: [
      'Who else is working right now: Claude, Codex and Hermes sessions active in a recent window, their projects',
      'and commits, and, the part that matters, CONTENTION: files two sessions both edited. Call it before editing a',
      'shared file in a busy workspace, when a commit appears that you did not make (commit=<sha> names the session',
      'behind it), or when orienting mid-task. window looks like 90m, 6h or 2d (default 6h). Cost about 0.2 s;',
      'writes nothing.',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        window: { type: 'string', description: 'Lookback window: 90m, 6h, 2d (default 6h).' },
        project: { type: 'string', description: 'Scope the roster and contention to one project.' },
        commit: { type: 'string', description: 'A commit sha or prefix: name the session that made it.' },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    handler: toolStandup,
  },
];

const TOOL_BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));

// Loaded up front by Claude Code even when tool schemas are deferred, and
// capped there at 4,096 characters; keep the cues first.
const INSTRUCTIONS = [
  'Session Cartographer is shared memory of past Claude Code, Codex and Hermes sessions: decisions, fixes,',
  'commits, research and conversations across every repo.',
  '',
  'Call `recall` before re-deriving anything an earlier session may have settled, and whenever the user says',
  '"did we…", "didn\'t we already…", "I thought we fixed…", "last time", "remember when", "what did we decide",',
  '"which agent tried…", or refers to a prior fix, decision or approach. Skip it for self-contained requests.',
  '',
  'Workflow: recall → get (full records and transcript paths, with the recall call_id) → read the transcript if',
  'the record is not enough → mark_used for the hits that actually informed your answer. orient(project) catches',
  'you up on a project; standup shows who else is working now and which files collide; thread traces how an event',
  'came about; facts counts what happened (census, tempo, delta) instead of ranking it.',
].join('\n');

// ─── Results ───

/**
 * Text only, and no outputSchema on any tool. The spec treats structuredContent
 * as the full answer and the text as its fallback, and the clients follow it:
 * Claude Code 2.1.277 and Codex 0.160 give the model the serialized JSON and
 * drop the text; Hermes 0.21 gives it both. Measured 2026-10-16 on the live
 * corpus, a 10-hit recall reached Claude Code as 9,864 characters of JSON
 * (~4,700 tokens); as text it is 3,274 (~1,650). The text here is written for
 * the model and is all it needs, so it is all that is sent.
 */
function okResult(text) {
  return { content: [{ type: 'text', text }] };
}

function errorResult(text) {
  return { content: [{ type: 'text', text }], isError: true };
}

// ─── JSON-RPC over stdio ───

const inflight = new Map();
const cancelled = new Set();
let pending = 0;
let inputClosed = false;

/**
 * Opt-in handshake trace for setup debugging: which client connected, which
 * protocol it asked for, which methods it called. Never tool arguments, which
 * would put recall queries in a second, unmanaged log. Codex and Hermes strip
 * the environment, so set it through the server entry's `env` there.
 */
function trace(message) {
  const file = process.env.CARTOGRAPHER_MCP_TRACE;
  if (!file || !message || typeof message !== 'object') return;
  const row = { at: new Date().toISOString(), pid: process.pid, method: message.method };
  if (message.method === 'initialize') {
    row.protocolVersion = message.params?.protocolVersion;
    row.clientInfo = message.params?.clientInfo;
    row.session_attribution = sessionAttribution();
  }
  if (message.method === 'tools/call') row.tool = message.params?.name;
  try { fs.appendFileSync(file, `${JSON.stringify(row)}\n`); } catch {}
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function maybeExit() {
  if (inputClosed && pending === 0) process.exit(0);
}

async function callTool(id, params) {
  const tool = TOOL_BY_NAME.get(params?.name);
  if (!tool) return rpcError(id, -32602, `Unknown tool: ${params?.name}`);
  const controller = new AbortController();
  inflight.set(id, controller);
  try {
    const args = params.arguments && typeof params.arguments === 'object' ? params.arguments : {};
    // Refuse what the schema does not declare rather than ignore it. Clients do
    // not all validate, and the one argument this must never act on is a
    // session id: a model that could name the session could attribute marks to
    // any session whose id it had seen.
    const unknown = Object.keys(args).filter((key) => !(key in tool.inputSchema.properties));
    if (unknown.length) {
      throw new ToolInputError(`${tool.name} does not take ${unknown.join(', ')}; it accepts `
        + `${Object.keys(tool.inputSchema.properties).join(', ')}.`);
    }
    const result = await tool.handler(args, { signal: controller.signal });
    return { jsonrpc: '2.0', id, result };
  } catch (error) {
    const text = error instanceof ToolInputError ? error.message : `${tool.name} failed: ${error.message}`;
    return { jsonrpc: '2.0', id, result: errorResult(text) };
  } finally {
    inflight.delete(id);
  }
}

function listedTool(tool) {
  const { handler, ...listed } = tool;
  return listed;
}

/** Answer one message. Resolves to a response, or null for a notification. */
async function handle(message) {
  if (!message || typeof message !== 'object' || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
    // A response to a request this server never sends: nothing to answer.
    if (message && typeof message === 'object' && ('result' in message || 'error' in message)) return null;
    return rpcError(message?.id, -32600, 'Invalid Request');
  }
  const { id, method, params } = message;

  if (method === 'notifications/cancelled') {
    const controller = inflight.get(params?.requestId);
    if (controller) {
      cancelled.add(params.requestId);
      controller.abort();
    }
    return null;
  }
  if (id === undefined) return null; // notifications/initialized and any other notification

  switch (method) {
    case 'initialize': {
      const requested = params?.protocolVersion;
      clientInfo = params?.clientInfo && typeof params.clientInfo === 'object' ? params.clientInfo : null;
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'session-cartographer', title: 'Session Cartographer', version: SERVER_VERSION },
          instructions: INSTRUCTIONS,
        },
      };
    }
    case 'ping':
      return { jsonrpc: '2.0', id, result: {} };
    case 'tools/list':
      // One page: seven tools need no cursor.
      return { jsonrpc: '2.0', id, result: { tools: TOOLS.map(listedTool) } };
    case 'tools/call':
      return callTool(id, params);
    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

async function answer(message) {
  trace(message);
  try {
    const response = await handle(message);
    // The spec asks a receiver not to answer a request its sender cancelled.
    if (response && message?.id !== undefined && cancelled.delete(message.id)) return null;
    return response;
  } catch (error) {
    return rpcError(message?.id, -32603, `Internal error: ${error.message}`);
  }
}

function track(promise) {
  pending += 1;
  promise.finally(() => {
    pending -= 1;
    maybeExit();
  });
}

function onLine(line) {
  const text = line.trim();
  if (!text) return;
  let message;
  try {
    message = JSON.parse(text);
  } catch {
    send(rpcError(null, -32700, 'Parse error'));
    return;
  }
  if (Array.isArray(message)) {
    // A JSON-RPC batch (protocol 2025-03-26) is answered with one array.
    if (message.length === 0) {
      send(rpcError(null, -32600, 'Invalid Request'));
      return;
    }
    track(Promise.all(message.map(answer)).then((responses) => {
      const out = responses.filter(Boolean);
      if (out.length) send(out);
    }));
    return;
  }
  track(answer(message).then((response) => {
    if (response) send(response);
  }));
}

const isMain = process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
if (isMain) {
  // A client that hangs up mid-answer leaves nothing to write to.
  process.stdout.on('error', () => process.exit(0));
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', onLine);
  rl.on('close', () => {
    inputClosed = true;
    maybeExit();
  });
}

export { TOOLS, INSTRUCTIONS, PROTOCOL_VERSIONS, parseGetOutput, parseThread, parseExtras, providerFromClient, sourceMix, hitLines };
