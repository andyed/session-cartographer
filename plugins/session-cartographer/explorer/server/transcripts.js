import { join, resolve, sep } from 'path';
import { homedir } from 'os';
import { existsSync, readdirSync } from 'fs';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

export function transcriptRoots(env = process.env, home = homedir()) {
  return [
    resolve(env.CARTOGRAPHER_CLAUDE_TRANSCRIPTS_DIR || env.CARTOGRAPHER_TRANSCRIPTS_DIR || `${home}/.claude/projects`),
    resolve(env.CARTOGRAPHER_CODEX_TRANSCRIPTS_DIR || `${home}/.codex/sessions`),
    // Codex moves finished sessions here instead of deleting them. Without this
    // root, isAllowedTranscriptPath() rejects every archived transcript.
    resolve(env.CARTOGRAPHER_CODEX_ARCHIVED_DIR || `${home}/.codex/archived_sessions`),
  ];
}

export function isAllowedTranscriptPath(path, roots) {
  return roots.some(root => path === root || path.startsWith(`${root}${sep}`));
}

function classifyNoise(content) {
  if (content.includes('<task-notification>')) return 'task-notification';
  if (content.includes('<command-name>')) return 'slash-command';
  if (content.includes('<local-command-caveat>')) return 'command-caveat';
  if (content.includes('<local-command-stdout>') || content.includes('<local-command-stderr>')) return 'command-output';
  if (content.startsWith('Base directory for this skill:')) return 'skill-injection';
  if (content.startsWith('Launching skill:')) return 'skill-launch';
  if (content.startsWith('This session is being continued')) return 'compaction-summary';
  return null;
}

function noiseSummary(content, noiseType) {
  switch (noiseType) {
    case 'task-notification': {
      const status = content.match(/<status>([^<]+)/)?.[1] || '';
      const summary = content.match(/<summary>([^<]+)/)?.[1] || '';
      return `agent ${status}${summary ? `: ${summary.slice(0, 80)}` : ''}`;
    }
    case 'slash-command':
      return content.match(/<command-name>([^<]+)/)?.[1] || '';
    case 'command-caveat':
      return 'local command output follows';
    case 'command-output': {
      const text = content.replace(/<[^>]+>/g, '').trim();
      return text.slice(0, 80) || 'command output';
    }
    case 'skill-injection': {
      const name = content.match(/^Base directory for this skill:[^\n]*\n+#\s*(.+)/m)?.[1] || 'skill';
      return `skill loaded: ${name}`;
    }
    case 'skill-launch': {
      const skill = content.match(/^Launching skill:\s*(.+)/)?.[1] || '';
      return `launching ${skill}`;
    }
    case 'compaction-summary':
      return 'session continuation summary';
    default:
      return null;
  }
}

function codexMessage(e) {
  const p = e.payload || {};
  let content = '';
  let role = 'tool';

  if (e.type === 'event_msg') {
    content = p.message || '';
    role = 'user';
  } else if (p.type === 'message') {
    content = Array.isArray(p.content)
      ? p.content.map(block => block.text || block.content || '').filter(Boolean).join('\n')
      : p.content || '';
    role = p.role || 'assistant';
  } else if (p.type === 'custom_tool_call' || p.type === 'function_call') {
    const input = p.input || p.arguments || '';
    content = `${p.name || 'tool'}${input ? `\n${input}` : ''}`;
  } else {
    content = typeof p.output === 'string' ? p.output : JSON.stringify(p.output || '');
  }

  const noise = classifyNoise(content);
  return {
    uuid: p.id || p.call_id || '',
    type: p.type || e.type,
    timestamp: e.timestamp,
    role,
    content,
    model: '',
    toolUseID: p.call_id || '',
    parentToolUseID: '',
    isSidechain: false,
    agentId: '',
    noise,
    noiseSummary: noise ? noiseSummary(content, noise) : null,
  };
}

function claudeMessage(e) {
  const content = typeof e.message?.content === 'string'
    ? e.message.content
    : Array.isArray(e.message?.content)
      ? e.message.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
      : e.data?.type || '';
  const noise = classifyNoise(content);
  return {
    uuid: e.uuid,
    type: e.type,
    timestamp: e.timestamp,
    role: e.message?.role || e.type,
    content,
    model: e.message?.model || '',
    toolUseID: e.toolUseID || '',
    parentToolUseID: e.parentToolUseID || '',
    isSidechain: e.isSidechain ?? false,
    agentId: e.agentId || '',
    noise,
    noiseSummary: noise ? noiseSummary(content, noise) : null,
  };
}

export function normalizeTranscriptEntries(entries) {
  const provider = entries.some(entry => entry.type === 'session_meta') ? 'codex' : 'claude';
  const messages = entries.filter(entry => provider === 'codex'
    ? (entry.type === 'event_msg' && entry.payload?.type === 'user_message') ||
      (entry.type === 'response_item' && ['message', 'custom_tool_call', 'custom_tool_call_output', 'function_call', 'function_call_output'].includes(entry.payload?.type))
    : entry.type === 'user' || entry.type === 'assistant' || entry.type === 'progress'
  ).map(provider === 'codex' ? codexMessage : claudeMessage).filter(message => message.content);

  return { provider, messages };
}

// ─── Resolution ──────────────────────────────────────────────────────────────
//
// Codex ARCHIVES a finished session: the rollout file moves from
// ~/.codex/sessions/<y>/<m>/<d>/ to the flat ~/.codex/archived_sessions/. Every
// transcript_path the hooks stamped at event time therefore goes stale the
// moment the session ends, while the data is still on disk. A consumer that
// stats the recorded path and stops reports "transcript not found" for a fully
// recoverable transcript — a silent recall failure, which is worse than an
// error. Measured on the Explorer's default 7-day window: of 30 Codex sessions,
// 3 carried a stale-but-recoverable path and 19 carried none at all, against a
// derivation that could only ever produce a ~/.claude/projects/ path.
//
// Two shapes, because list views and detail views have different budgets:
//
//   resolveTranscriptPath()  one id/path, full ladder, shells out to
//                            scripts/resolve-transcript.sh so the ladder keeps
//                            exactly one definition. Costs a find on a miss.
//   codexSessionIndex()      every Codex rollout id → path in one directory
//                            walk, for summarising a whole window at once.
//                            ~1.4k filenames on this machine; a per-session
//                            find would be one subprocess per row.
//
// Both cover both Codex roots. Do not reintroduce a bare find over
// ~/.codex/sessions alone.

const RESOLVER = resolve(fileURLToPath(import.meta.url), '..', '..', '..', 'scripts', 'resolve-transcript.sh');

// A miss is cached briefly, not forever: a transcript can appear after a query
// (catch-up backfill, a session that archives mid-view). A hit never changes.
const MISS_TTL_MS = 60_000;
const resolutionCache = new Map();

/** True for a needle safe to hand the resolver's `find -name "*<id>*"`. */
export function isResolvableNeedle(needle) {
  return typeof needle === 'string'
    && needle.length > 0
    && needle.length < 512
    && !/[*?[\]]/.test(needle)
    && !needle.split('/').includes('..');
}

/**
 * Recorded path (or bare session id) → a path that exists on disk. Returns ''
 * when nothing matches. The caller still owns the allow-list check: this
 * resolves, it does not authorize.
 */
export function resolveTranscriptPath(needle, { cache = resolutionCache, now = Date.now } = {}) {
  if (!isResolvableNeedle(needle)) return '';

  const cached = cache.get(needle);
  if (cached && (cached.path || cached.until > now())) return cached.path;

  let path = '';
  if (existsSync(needle)) {
    path = needle; // the common case, one stat
  } else {
    try {
      path = execFileSync(RESOLVER, [needle], {
        encoding: 'utf8',
        timeout: 10_000,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch {
      path = ''; // exit 1 is "not found", not a failure worth surfacing
    }
  }

  cache.set(needle, { path, until: now() + MISS_TTL_MS });
  return path;
}

function walkJsonl(dir, out, depth = 0) {
  if (depth > 6) return out;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walkJsonl(full, out, depth + 1);
    else if (entry.name.endsWith('.jsonl')) out.push(full);
  }
  return out;
}

const INDEX_TTL_MS = 30_000;
let codexIndexCache = null;

/**
 * Map of Codex session id → transcript path, across live and archived stores.
 * Rollout files are named rollout-<timestamp>-<session-uuid>.jsonl, so the id
 * is the tail of the basename — the same relationship the hooks record.
 */
export function codexSessionIndex({ env = process.env, home = homedir(), now = Date.now, force = false } = {}) {
  if (!force && codexIndexCache && codexIndexCache.until > now()) return codexIndexCache.map;

  const [, sessions, archived] = transcriptRoots(env, home);
  const map = new Map();
  for (const file of [...walkJsonl(archived, []), ...walkJsonl(sessions, [])]) {
    const base = file.slice(file.lastIndexOf(sep) + 1, -'.jsonl'.length);
    // Match the timestamp shape exactly rather than trimming leading digits:
    // a session uuid whose first group happens to be all digits (01234567-…)
    // would otherwise have its own head eaten along with the timestamp.
    const id = base.match(/^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-(.+)$/)?.[1] || base;
    // Live sessions win over archived copies of the same id: both are readable,
    // the live one is the path the hooks are still stamping.
    map.set(id, file);
  }

  codexIndexCache = { map, until: now() + INDEX_TTL_MS };
  return map;
}
