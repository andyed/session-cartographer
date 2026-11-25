import { join, resolve, sep } from 'path';
import { homedir } from 'os';
import { existsSync, readdirSync } from 'fs';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { normalizeEvidenceEntries } from './transcript-evidence.js';
import { listCodexRollouts } from '../../scripts/codex-call-evidence.js';
import { isCompressedTranscript, readTranscriptText } from '../../scripts/transcript-file.js';

function antigravityBrainRoots(env = process.env, home = homedir()) {
  if (env.CARTOGRAPHER_ANTIGRAVITY_TRANSCRIPTS_DIR) {
    return [resolve(env.CARTOGRAPHER_ANTIGRAVITY_TRANSCRIPTS_DIR)];
  }
  return [
    resolve(`${home}/.gemini/antigravity/brain`),
    resolve(`${home}/.gemini/antigravity-ide/brain`),
    resolve(`${home}/.gemini/antigravity-cli/brain`),
  ];
}

export function transcriptRoots(env = process.env, home = homedir()) {
  return [
    resolve(env.CARTOGRAPHER_CLAUDE_TRANSCRIPTS_DIR || env.CARTOGRAPHER_TRANSCRIPTS_DIR || `${home}/.claude/projects`),
    resolve(env.CARTOGRAPHER_CODEX_TRANSCRIPTS_DIR || `${home}/.codex/sessions`),
    // Codex moves finished sessions here instead of deleting them. Without this
    // root, isAllowedTranscriptPath() rejects every archived transcript.
    resolve(env.CARTOGRAPHER_CODEX_ARCHIVED_DIR || `${home}/.codex/archived_sessions`),
    ...antigravityBrainRoots(env, home),
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

/**
 * Every parseable row of a transcript, in either spelling. A missing file is
 * no rows. A compressed file this process cannot decode throws
 * CompressedTranscriptError, so its caller can say "compressed" instead of
 * "empty".
 */
export function readTranscriptEntries(file) {
  let text;
  try {
    text = readTranscriptText(file);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  return text.split('\n').flatMap((line) => {
    // The last line of a live transcript can be a row still being written.
    try { return line.trim() ? [JSON.parse(line)] : []; } catch { return []; }
  });
}

export function normalizeTranscriptEntries(entries) {
  const normalized = normalizeEvidenceEntries(entries);
  for (const message of normalized.messages) {
    // A result containing the word <task-notification> is still tool evidence,
    // never a collapsible machinery-only notice.
    const proseOnly = message.blocks.every(block => block.type === 'text');
    message.noise = proseOnly ? classifyNoise(message.content) : null;
    message.noiseSummary = message.noise ? noiseSummary(message.content, message.noise) : null;
  }
  return normalized;
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
//
// Both also cover both SPELLINGS. Codex zstd-compresses a rollout in place
// about a week after its session (rollout-….jsonl → rollout-….jsonl.zst), so a
// reader matching *.jsonl alone sees only the last week: 270 of 3,916 rollouts
// on 2026-11-13 (docs/COMPRESSED_ROLLOUTS.md). A path either function returns
// may end in .jsonl.zst, and whatever opens it reads through
// scripts/transcript-file.js.

const RESOLVER = resolve(fileURLToPath(import.meta.url), '..', '..', '..', 'scripts', 'resolve-transcript.sh');

// Windows cannot exec a .sh file (EFTYPE), so every lookup by session id and
// every moved or archived transcript came back unresolved there. The resolver
// runs under Git's bash.exe, found as the hook launcher finds it (`bash` on
// PATH may be WSL's), with a /-path as the launcher passes it. A miss leaves
// it unresolved, as before.
function resolverCommand(platform = process.platform) {
  if (platform !== 'win32') return [RESOLVER, []];
  const here = fileURLToPath(new URL('.', import.meta.url));
  const launcher = [resolve(here, '..', '..', 'hooks', 'run-hook.cjs'),
    resolve(here, '..', '..', 'plugins', 'session-cartographer', 'hooks', 'run-hook.cjs')].find(existsSync);
  return [createRequire(import.meta.url)(launcher).resolveBash(platform), [RESOLVER.replaceAll('\\', '/')]];
}

// A miss is cached briefly, not forever: a transcript can appear after a query
// (catch-up backfill, a session that archives mid-view). A hit is kept while
// its file is still there: Codex archives and compresses under a long-running
// server, and either one renames the file a cached hit points at.
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
  if (cached && (cached.path ? existsSync(cached.path) : cached.until > now())) return cached.path;

  let path = '';
  if (existsSync(needle)) {
    path = needle; // the common case, one stat
  } else {
    try {
      const [command, prefix] = resolverCommand();
      path = execFileSync(command, [...prefix, needle], {
        encoding: 'utf8',
        timeout: 10_000,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      // find joins its root and the file with `/`, which a Windows root
      // (C:\…\archived_sessions) leaves half-converted.
      if (path) path = resolve(path);
    } catch {
      path = ''; // exit 1 is "not found", not a failure worth surfacing
    }
  }

  cache.set(needle, { path, until: now() + MISS_TTL_MS });
  return path;
}

const INDEX_TTL_MS = 30_000;
let codexIndexCache = null;

/**
 * Map of Codex session id → transcript path, across live and archived stores
 * and both spellings. Rollout files are named
 * rollout-<timestamp>-<session-uuid>.jsonl[.zst], so the id is the tail of the
 * basename — the same relationship the hooks record. The walk and the name
 * rule are listCodexRollouts' (scripts/codex-call-evidence.js); this adds only
 * the choice between two files for one session.
 */
export function codexSessionIndex({ env = process.env, home = homedir(), now = Date.now, force = false } = {}) {
  if (!force && codexIndexCache && codexIndexCache.until > now()) return codexIndexCache.map;

  const [, sessions] = transcriptRoots(env, home);
  const map = new Map();
  const rank = new Map();
  for (const { file, session_id: id } of listCodexRollouts({ env, home })) {
    if (!id) continue;
    // A plain file beats a compressed one: both are readable, the plain one
    // without a decompression, and it is the one Codex is still writing if the
    // two ever coexist. Then live beats archived, as before: the live path is
    // the one the hooks are still stamping.
    const score = (isCompressedTranscript(file) ? 0 : 2) + (file.startsWith(`${sessions}${sep}`) ? 1 : 0);
    if (rank.has(id) && rank.get(id) >= score) continue;
    rank.set(id, score);
    map.set(id, file);
  }

  codexIndexCache = { map, until: now() + INDEX_TTL_MS };
  return map;
}

let antigravityIndexCache = null;

/**
 * Map of Antigravity conversation id → transcript path, across configured brain
 * roots. Antigravity writes each conversation's compact JSONL log at
 * `<brain>/<conversation-id>/.system_generated/logs/transcript.jsonl`.
 */
export function antigravitySessionIndex({ env = process.env, home = homedir(), now = Date.now, force = false } = {}) {
  if (!force && antigravityIndexCache && antigravityIndexCache.until > now()) return antigravityIndexCache.map;

  const map = new Map();
  for (const root of antigravityBrainRoots(env, home)) {
    let entries;
    try {
      entries = readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || map.has(entry.name)) continue;
      const candidate = join(root, entry.name, '.system_generated', 'logs', 'transcript.jsonl');
      if (existsSync(candidate)) map.set(entry.name, candidate);
    }
  }

  antigravityIndexCache = { map, until: now() + INDEX_TTL_MS };
  return map;
}
