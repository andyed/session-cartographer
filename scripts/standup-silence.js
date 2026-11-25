/**
 * standup-silence.js — what /standup cannot see, made visible.
 *
 * Standup reads the event log, so a session whose hooks never fire is not in it at all: not
 * idle, ABSENT. On 2026-10-04 a Codex session edited a file in psychodeli-webgl-port for an
 * hour while standup reported every session idle and the file uncontested. The cause was a
 * week old: 0.8.1 pointed Codex at hooks/codex-hooks.json, Codex records hook trust per hook
 * file and definition hash, and every stored trust record named hooks/hooks.json. Codex
 * skips untrusted hooks without a word, so Codex events went from ~1,500 a day to 8 on
 * 2026-09-28 and to none after — about half the corpus — and nothing in Claude's sessions
 * said so.
 *
 * Three read-only checks, each answering "what happened that the log did not record":
 *   - codexRollouts + the caller's session map: a Codex transcript written in the window
 *     with zero logged events is a session the hooks missed. Activity without events, not
 *     a drop in event rate — a rate rule would cry wolf whenever Codex simply wasn't used.
 *   - codexHookTrust: whether config.toml holds trust records for the hook file the
 *     installed Codex manifest declares. It compares file and event names only; Codex
 *     hashes each definition by a scheme this does not reproduce, so an edited hook under
 *     an unchanged name still reads as trusted here.
 *   - unclaimedChanges + transcriptMentions: tracked files changed in the window that no
 *     logged session edited, and which transcripts written in the window name them. A
 *     mention is evidence, not authorship; the output says "mentioned by", never "edited by".
 *   - codexThreadMeta: who started a rollout. Codex Desktop spawns helper threads from a
 *     conversation (guardian_review, spawned agents) whose session_meta names the parent;
 *     they fire no hooks, so without this every one of them read as a session the log missed
 *     (73 of 78 SILENT rows on 2026-10-27, docs/standup-codex-threads-2026-10-27.md).
 */
import { readdirSync, statSync, readFileSync, existsSync, writeFileSync, mkdtempSync, rmSync, openSync, readSync, closeSync } from 'fs';
import { join, delimiter, resolve } from 'path';
import { homedir, tmpdir } from 'os';
import { execFileSync } from 'child_process';
import { isResolved } from './sentinels.js';

let SqliteDatabaseSync = null;
{
  const origEmitWarning = process.emitWarning;
  process.emitWarning = function patched(warning, ...rest) {
    const text = typeof warning === 'string' ? warning : warning?.message;
    if (/SQLite/i.test(String(text))) return;
    return origEmitWarning.call(this, warning, ...rest);
  };
  try {
    ({ DatabaseSync: SqliteDatabaseSync } = await import('node:sqlite'));
  } catch {
    SqliteDatabaseSync = null;
  } finally {
    process.emitWarning = origEmitWarning;
  }
}

function expandHomeDir(p, home) {
  if (typeof p !== 'string' || !p) return '';
  if (p === '~') return home;
  if (p.startsWith('~/')) return join(home, p.slice(2));
  return p;
}

function resolveAntigravityRoots(env = process.env, home = homedir()) {
  const roots = [];
  const push = (raw) => {
    if (!raw || typeof raw !== 'string') return;
    for (const part of raw.split(delimiter)) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const abs = resolve(expandHomeDir(trimmed, home));
      if (!roots.includes(abs)) roots.push(abs);
    }
  };
  if (env.CARTOGRAPHER_ANTIGRAVITY_TRANSCRIPTS_DIR) {
    push(env.CARTOGRAPHER_ANTIGRAVITY_TRANSCRIPTS_DIR);
    if (env.CARTOGRAPHER_ANTIGRAVITY_IDE_TRANSCRIPTS_DIR) push(env.CARTOGRAPHER_ANTIGRAVITY_IDE_TRANSCRIPTS_DIR);
    if (env.CARTOGRAPHER_ANTIGRAVITY_CLI_TRANSCRIPTS_DIR) push(env.CARTOGRAPHER_ANTIGRAVITY_CLI_TRANSCRIPTS_DIR);
    return roots;
  }
  push(join(home, '.gemini', 'antigravity', 'brain'));
  push(env.CARTOGRAPHER_ANTIGRAVITY_IDE_TRANSCRIPTS_DIR || join(home, '.gemini', 'antigravity-ide', 'brain'));
  push(env.CARTOGRAPHER_ANTIGRAVITY_CLI_TRANSCRIPTS_DIR || join(home, '.gemini', 'antigravity-cli', 'brain'));
  return roots;
}

function resolveAntigravityDbPath(env = process.env, home = homedir()) {
  if (env.CARTOGRAPHER_ANTIGRAVITY_DB) return resolve(expandHomeDir(env.CARTOGRAPHER_ANTIGRAVITY_DB, home));
  return join(home, '.gemini', 'antigravity', 'conversation_summaries.db');
}

const UUID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
const DAY = 86400e3;
const pad = (n) => String(n).padStart(2, '0');

/**
 * Codex rollout transcripts written since `sinceMs`. Codex files a rollout under the LOCAL
 * date its session started (sessions/YYYY/MM/DD), and a long session keeps writing there, so
 * the walk covers the last `days` dated directories and filters on mtime.
 * @returns {{id: string, provider: 'codex', path: string, mtimeMs: number}[]}
 */
export function codexRollouts({ codexHome, sinceMs, now = Date.now(), days = 8 }) {
  const root = join(codexHome, 'sessions');
  const out = [];
  if (!existsSync(root)) return out;
  for (let d = 0; d < days; d++) {
    const day = new Date(now - d * DAY);
    const dir = join(root, String(day.getFullYear()), pad(day.getMonth() + 1), pad(day.getDate()));
    let names;
    try { names = readdirSync(dir); } catch { continue; }
    for (const name of names) {
      const m = name.match(UUID_RE);
      if (!m) continue;
      const path = join(dir, name);
      let st;
      try { st = statSync(path); } catch { continue; }
      if (st.mtimeMs >= sinceMs) out.push({ id: m[1].toLowerCase(), provider: 'codex', path, mtimeMs: st.mtimeMs });
    }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/**
 * Claude Code transcripts written since `sinceMs` (projects/<dir>/<session-id>.jsonl).
 * @returns {{id: string, provider: 'claude', path: string, mtimeMs: number}[]}
 */
export function claudeTranscripts({ claudeHome, sinceMs }) {
  const root = join(claudeHome, 'projects');
  const out = [];
  let dirs;
  try { dirs = readdirSync(root); } catch { return out; }
  for (const d of dirs) {
    let names;
    try { names = readdirSync(join(root, d)); } catch { continue; }
    for (const name of names) {
      const m = name.match(UUID_RE);
      if (!m) continue;
      const path = join(root, d, name);
      let st;
      try { st = statSync(path); } catch { continue; }
      if (st.mtimeMs >= sinceMs) out.push({ id: m[1].toLowerCase(), provider: 'claude', path, mtimeMs: st.mtimeMs });
    }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/**
 * Who started a Codex rollout, from its first line (`session_meta`).
 *
 * Codex Desktop spawns helper threads out of a conversation and files each as a rollout of
 * its own: `thread_source: "guardian_review"` with `source: {subagent: {other: "guardian"}}`,
 * or a spawned agent with `source: {subagent: {thread_spawn: {parent_thread_id, …}}}`. Both
 * carry the thread they came from in `parent_thread_id`; a conversation the person opened
 * has none. One bounded read: the meta line embeds the base instructions and runs to ~30 KB,
 * so `maxBytes` leaves room, and a first line that does not fit reads as unknown rather than
 * as a thread of its own. Returns null when the first line is not a session_meta record (an
 * older Codex, a fixture) — the caller treats null as "no parent known".
 * @returns {{id: string|null, parent: string|null, threadSource: string|null,
 *   subagent: string|null, originator: string|null, cwd: string|null}|null}
 */
export function codexThreadMeta(path, { maxBytes = 256 * 1024 } = {}) {
  let head;
  let n;
  try {
    const fd = openSync(path, 'r');
    try {
      const buf = Buffer.alloc(maxBytes);
      n = readSync(fd, buf, 0, maxBytes, 0);
      head = buf.toString('utf-8', 0, n);
    } finally { closeSync(fd); }
  } catch { return null; }
  const nl = head.indexOf('\n');
  if (nl < 0 && n >= maxBytes) return null;       // the first line did not fit: unknown, not standalone
  let rec;
  try { rec = JSON.parse(nl < 0 ? head : head.slice(0, nl)); } catch { return null; }
  if (!rec || rec.type !== 'session_meta' || !rec.payload || typeof rec.payload !== 'object') return null;
  const p = rec.payload;
  const str = (v) => (typeof v === 'string' && v ? v : null);
  const sub = p.source && typeof p.source === 'object' && p.source.subagent && typeof p.source.subagent === 'object'
    ? p.source.subagent : null;
  const spawn = sub && sub.thread_spawn && typeof sub.thread_spawn === 'object' ? sub.thread_spawn : null;
  const subagent = !sub ? null : spawn ? 'thread_spawn' : str(sub.other) || Object.keys(sub)[0] || 'subagent';
  return {
    id: str(p.id),
    parent: str(p.parent_thread_id) || (spawn ? str(spawn.parent_thread_id) : null),
    threadSource: str(p.thread_source),
    subagent,
    originator: str(p.originator),
    cwd: str(p.cwd),
  };
}

/**
 * Antigravity transcripts written since `sinceMs`
 * (`<brain>/<conversation-id>/.system_generated/logs/transcript.jsonl`).
 * @returns {{id: string, provider: 'antigravity', path: string, mtimeMs: number}[]}
 */
export function antigravityTranscripts({ env = process.env, home = homedir(), roots, sinceMs = 0 } = {}) {
  const searchRoots = roots || resolveAntigravityRoots(env, home);
  const out = [];
  const seen = new Set();
  for (const root of searchRoots) {
    let entries;
    try { entries = readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const cid = entry.name;
      if (!isResolved(cid)) continue;
      const lower = cid.toLowerCase();
      if (seen.has(lower)) continue;
      const file = join(root, cid, '.system_generated', 'logs', 'transcript.jsonl');
      let st;
      try { st = statSync(file); } catch { continue; }
      if (st.mtimeMs >= sinceMs) {
        seen.add(lower);
        out.push({ id: lower, provider: 'antigravity', path: file, mtimeMs: st.mtimeMs });
      }
    }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/**
 * Parent-child metadata for Antigravity conversations, read strictly read-only
 * from `conversation_summaries.db` (`parent_conversation_id` and `conversation_parents`).
 *
 * Parallel to `codexThreadMeta()`: Antigravity spawns subagent conversations whose
 * parent is recorded in SQLite rather than inside the transcript header. Only
 * explicit, `isResolved()` parent IDs are returned — never inferred from time
 * adjacency. Gracefully returns an empty Map if the DB is missing or unreadable.
 *
 * @returns {Map<string, {id: string, parent: string|null, threadSource: string|null, subagent: string|null, nestingDepth: number}>}
 */
export function antigravityThreadMeta(env = process.env, home = homedir()) {
  const out = new Map();
  const dbPath = typeof env === 'string'
    ? env
    : (env && typeof env.dbPath === 'string' ? env.dbPath : resolveAntigravityDbPath(env, home));
  if (!SqliteDatabaseSync || !dbPath || !existsSync(dbPath)) return out;

  let db;
  try {
    db = new SqliteDatabaseSync(dbPath, { readOnly: true, readBigInts: true });
    try {
      db.exec('PRAGMA busy_timeout = 2000');
      db.exec('PRAGMA query_only = 1');
    } catch { /* ignore pragma errors on read-only DB */ }

    const hasTable = (name) => Boolean(
      db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name = ?").get(name),
    );
    const parentLookup = new Map();
    if (hasTable('conversation_parents')) {
      try {
        for (const r of db.prepare('SELECT conversation_id, parent_id FROM conversation_parents').all()) {
          const cid = String(r.conversation_id || '').trim().toLowerCase();
          const pid = String(r.parent_id || '').trim().toLowerCase();
          if (isResolved(cid) && isResolved(pid) && cid !== pid) parentLookup.set(cid, pid);
        }
      } catch { /* ignore schema mismatch */ }
    }

    if (hasTable('conversation_summaries')) {
      const cols = new Set(db.prepare('PRAGMA table_info(conversation_summaries)').all().map((c) => c.name));
      const opt = (name, defSql = "''") => (cols.has(name) ? name : `${defSql} AS ${name}`);
      const rows = db.prepare(`
        SELECT conversation_id,
               ${opt('parent_conversation_id')},
               ${opt('agent_name')},
               ${opt('nesting_depth', '0')}
          FROM conversation_summaries
      `).all();
      for (const row of rows) {
        const rawId = String(row.conversation_id || '').trim();
        if (!isResolved(rawId)) continue;
        const id = rawId.toLowerCase();
        const rawParent = String(row.parent_conversation_id || '').trim() || parentLookup.get(id) || '';
        const parent = isResolved(rawParent) ? rawParent.toLowerCase() : null;
        const validParent = parent && parent !== id ? parent : null;
        const agentName = row.agent_name ? String(row.agent_name).trim() : null;
        out.set(id, {
          id,
          parent: validParent,
          threadSource: agentName || (validParent ? 'subagent' : null),
          subagent: validParent ? (agentName || 'subagent') : null,
          nestingDepth: Number(row.nesting_depth || 0),
        });
      }
    }

    for (const [cid, pid] of parentLookup) {
      if (!out.has(cid)) {
        out.set(cid, {
          id: cid,
          parent: pid,
          threadSource: 'subagent',
          subagent: 'subagent',
          nestingDepth: 1,
        });
      }
    }
  } catch {
    return out;
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
  return out;
}

/**
 * Fold Antigravity subagent threads under their resolved parent conversation ID.
 * Threads without an explicit resolved parent stay in `standalone` (never grouped
 * by time adjacency or sentinel parent values).
 *
 * @param {{id: string}[]} threads
 * @param {Map<string, {parent: string|null, threadSource?: string|null, subagent?: string|null}>} metaMap
 * @returns {{standalone: object[], subthreads: object[], byParent: Map<string, object[]>}}
 */
export function foldAntigravityThreads(threads, metaMap) {
  const standalone = [];
  const subthreads = [];
  const byParent = new Map();
  for (const thread of threads || []) {
    const id = isResolved(thread?.id) ? String(thread.id).trim().toLowerCase() : '';
    const meta = id && metaMap instanceof Map ? metaMap.get(id) : null;
    const parent = meta && isResolved(meta.parent) ? String(meta.parent).trim().toLowerCase() : null;
    if (parent && parent !== id) {
      subthreads.push({ ...thread, parent, subagent: meta.subagent || meta.threadSource || 'subagent' });
      if (!byParent.has(parent)) byParent.set(parent, []);
      byParent.get(parent).push(thread);
    } else {
      standalone.push(thread);
    }
  }
  return { standalone, subthreads, byParent };
}

/** PostToolUse → post_tool_use: Codex's trust keys spell events in snake case. */
const snake = (event) => event.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();

/**
 * Does Codex trust the hook file its installed copy of this plugin declares?
 * @returns {{status: 'trusted'|'partial'|'untrusted'|'not-installed'|'unknown',
 *   hookFile?: string, version?: string, trustedFiles?: string[], missingEvents?: string[], reason?: string}}
 */
export function codexHookTrust({ codexHome, pluginId = 'session-cartographer@session-cartographer' }) {
  const [name, marketplace] = pluginId.split('@');
  const cache = join(codexHome, 'plugins', 'cache', marketplace || name, name);
  let versions;
  try { versions = readdirSync(cache); } catch { return { status: 'not-installed' }; }
  // The newest installed copy is the one Codex loads; mtime orders them without parsing semver.
  const installed = versions
    .map((v) => ({ v, manifest: join(cache, v, '.codex-plugin', 'plugin.json') }))
    .filter((x) => existsSync(x.manifest))
    .sort((a, b) => statSync(b.manifest).mtimeMs - statSync(a.manifest).mtimeMs)[0];
  if (!installed) return { status: 'not-installed' };
  let manifest;
  try { manifest = JSON.parse(readFileSync(installed.manifest, 'utf-8')); } catch { return { status: 'unknown', reason: 'unreadable manifest' }; }
  const hookFile = String(manifest.hooks || './hooks/hooks.json').replace(/^\.\//, '');
  let events = [];
  try {
    const defs = JSON.parse(readFileSync(join(cache, installed.v, hookFile), 'utf-8'));
    events = Object.keys(defs.hooks || defs).map(snake);
  } catch { /* trust can still be judged by file name */ }

  let config;
  try { config = readFileSync(join(codexHome, 'config.toml'), 'utf-8'); } catch { return { status: 'unknown', hookFile, version: installed.v, reason: 'no config.toml' }; }
  const escaped = pluginId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const key = new RegExp(`^\\[hooks\\.state\\."${escaped}:([^:"]+):([a-z_]+):\\d+:\\d+"\\]`, 'gm');
  const trusted = new Map();
  for (const m of config.matchAll(key)) {
    if (!trusted.has(m[1])) trusted.set(m[1], new Set());
    trusted.get(m[1]).add(m[2]);
  }
  const base = { hookFile, version: installed.v, trustedFiles: [...trusted.keys()] };
  if (!trusted.has(hookFile)) return { status: 'untrusted', ...base };
  const missingEvents = events.filter((e) => !trusted.get(hookFile).has(e));
  return missingEvents.length ? { status: 'partial', ...base, missingEvents } : { status: 'trusted', ...base };
}

/**
 * Tracked files in `repo` changed since `sinceMs` that no logged session edited. Untracked
 * files are left out (build output and scratch would bury the signal); a file older than the
 * window is someone's standing work, not news.
 * @param {(abs: string) => string} keyOf the caller's canonical-path function (contentionKey)
 * @returns {{rel: string, abs: string, mtimeMs: number}[]}
 */
export function unclaimedChanges({ repo, sinceMs, claimed, keyOf = (p) => p }) {
  let raw;
  try {
    raw = execFileSync('git', ['-C', repo, 'status', '--porcelain=v1', '-z', '--untracked-files=no'],
      { encoding: 'utf-8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch { return []; }
  const parts = raw.split('\0').filter(Boolean);
  const out = [];
  for (let i = 0; i < parts.length; i++) {
    const code = parts[i].slice(0, 2);
    const rel = parts[i].slice(3);
    if (/[RC]/.test(code)) i++;            // -z puts a rename's ORIGINAL path in the next field
    const abs = join(repo, rel);
    let st;
    try { st = statSync(abs); } catch { continue; }   // deleted: no mtime to judge the window by
    if (st.mtimeMs < sinceMs) continue;
    if (claimed.has(keyOf(abs))) continue;
    out.push({ rel, abs, mtimeMs: st.mtimeMs });
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/**
 * Logged events that name the file shortly before it changed — the strongest evidence an
 * unclaimed change has. The edit hook recognises Edit/Write and simple shell forms; a change
 * made through `sed -i` or a Python heredoc logs only a `Ran: …` summary, which still names
 * the path (summaries are truncated near 200 characters, and the path usually comes early).
 * A command up to `beforeMs` before the change (or a few seconds after: hook timestamps are
 * written when the tool returns) counts; the closest wins.
 * @returns {{id, provider, t, summary}[]} nearest first
 */
export function commandEvidence({ events, rel, abs, mtimeMs, beforeMs = 10 * 60e3, afterMs = 5e3 }) {
  const hits = [];
  for (const e of events) {
    const t = Date.parse(e.timestamp);
    if (!Number.isFinite(t) || t < mtimeMs - beforeMs || t > mtimeMs + afterMs) continue;
    const s = e.summary || '';
    if (!s.includes(rel) && !s.includes(abs)) continue;
    hits.push({ id: String(e.session_id || ''), provider: e.provider || '?', t, summary: s });
  }
  return hits.sort((a, b) => Math.abs(a.t - mtimeMs) - Math.abs(b.t - mtimeMs));
}

/**
 * How often each transcript names each path, via one fixed-string grep per transcript
 * (Claude transcripts run to 100 MB+; reading them in Node would dominate standup's runtime).
 * @returns {Map<string, {id, provider, mtimeMs, count}[]>} needle → transcripts, most mentions first
 */
export function transcriptMentions({ transcripts, needles }) {
  const result = new Map(needles.map((n) => [n, []]));
  if (!needles.length || !transcripts.length) return result;
  const dir = mkdtempSync(join(tmpdir(), 'standup-needles-'));
  const patterns = join(dir, 'patterns');
  writeFileSync(patterns, needles.join('\n') + '\n');
  try {
    for (const t of transcripts) {
      let raw = '';
      try {
        raw = execFileSync('grep', ['-o', '-F', '-f', patterns, t.path],
          { encoding: 'utf-8', timeout: 15000, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
      } catch (e) { raw = e.stdout || ''; }        // grep exits 1 on no match
      const counts = new Map();
      for (const hit of raw.split('\n')) if (hit) counts.set(hit, (counts.get(hit) || 0) + 1);
      for (const [needle, count] of counts) {
        if (result.has(needle)) result.get(needle).push({ id: t.id, provider: t.provider, mtimeMs: t.mtimeMs, count });
      }
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
  for (const list of result.values()) list.sort((a, b) => b.count - a.count || b.mtimeMs - a.mtimeMs);
  return result;
}

