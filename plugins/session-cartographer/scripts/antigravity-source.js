#!/usr/bin/env node
/**
 * antigravity-source.js — Antigravity conversation metadata, project inference,
 * drill-down, and optional read-only pre-JSONL SQLite backfill.
 *
 * Antigravity stores live transcripts as JSONL files under:
 *   ~/.gemini/antigravity/brain/<conversation-id>/.system_generated/logs/transcript.jsonl
 * (plus product roots antigravity-ide and antigravity-cli), and indexes metadata
 * plus pre-JSONL full-text chunks in:
 *   ~/.gemini/antigravity/conversation_summaries.db
 *
 * The SQLite database is ALWAYS opened strictly read-only (`{ readOnly: true }`).
 * If `node:sqlite` is unavailable or the DB is missing/busy/unreadable, metadata
 * reads degrade gracefully to empty results without failing callers.
 *
 * Usage:
 *   node scripts/antigravity-source.js --project <conversation-id> [transcript-path]
 *   node scripts/antigravity-source.js --show <conversation-id> [--json]
 *   node scripts/antigravity-source.js --backfill [--write] [--since-days N] [--limit N] [--fresh] [--json]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { isNonProject, nonProjectNames } from './non-projects.js';
import { isResolved } from './sentinels.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PROVIDER = 'antigravity';
const DEFAULT_TURN_BODY_MAX = 1200;
const GATE_OFF = '2.0';

// Load node:sqlite once cleanly, suppressing the expected Node 22 ExperimentalWarning.
let DatabaseSync = null;
{
  const originalEmitWarning = process.emitWarning;
  process.emitWarning = function patched(warning, ...rest) {
    const text = typeof warning === 'string' ? warning : warning?.message;
    if (/SQLite/i.test(String(text))) return;
    return originalEmitWarning.call(this, warning, ...rest);
  };
  try {
    ({ DatabaseSync } = await import('node:sqlite'));
  } catch {
    DatabaseSync = null;
  } finally {
    process.emitWarning = originalEmitWarning;
  }
}

function expandHome(p, home = os.homedir()) {
  if (typeof p !== 'string' || !p) return '';
  if (p === '~') return home;
  if (p.startsWith('~/')) return path.join(home, p.slice(2));
  return p;
}

/**
 * Brain directories holding Antigravity conversation transcripts.
 * When CARTOGRAPHER_ANTIGRAVITY_TRANSCRIPTS_DIR is explicitly set, only
 * explicitly configured roots are returned so tests stay isolated from $HOME.
 */
export function defaultAntigravityRoots(env = process.env, home = os.homedir()) {
  const roots = [];
  const push = (raw) => {
    if (!raw || typeof raw !== 'string') return;
    for (const part of raw.split(path.delimiter)) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const resolved = path.resolve(expandHome(trimmed, home));
      if (!roots.includes(resolved)) roots.push(resolved);
    }
  };

  if (env.CARTOGRAPHER_ANTIGRAVITY_TRANSCRIPTS_DIR) {
    push(env.CARTOGRAPHER_ANTIGRAVITY_TRANSCRIPTS_DIR);
    if (env.CARTOGRAPHER_ANTIGRAVITY_IDE_TRANSCRIPTS_DIR) push(env.CARTOGRAPHER_ANTIGRAVITY_IDE_TRANSCRIPTS_DIR);
    if (env.CARTOGRAPHER_ANTIGRAVITY_CLI_TRANSCRIPTS_DIR) push(env.CARTOGRAPHER_ANTIGRAVITY_CLI_TRANSCRIPTS_DIR);
    return roots;
  }

  push(path.join(home, '.gemini', 'antigravity', 'brain'));
  push(env.CARTOGRAPHER_ANTIGRAVITY_IDE_TRANSCRIPTS_DIR || path.join(home, '.gemini', 'antigravity-ide', 'brain'));
  push(env.CARTOGRAPHER_ANTIGRAVITY_CLI_TRANSCRIPTS_DIR || path.join(home, '.gemini', 'antigravity-cli', 'brain'));
  return roots;
}

export function defaultAntigravityDbPath(env = process.env, home = os.homedir()) {
  if (env.CARTOGRAPHER_ANTIGRAVITY_DB) {
    return path.resolve(expandHome(env.CARTOGRAPHER_ANTIGRAVITY_DB, home));
  }
  return path.join(home, '.gemini', 'antigravity', 'conversation_summaries.db');
}

export function findAntigravityTranscript(conversationId, { env = process.env, home = os.homedir(), roots } = {}) {
  if (!isResolved(conversationId)) return null;
  const cid = String(conversationId).trim();
  if (cid.includes('/') || cid.includes('\\') || cid === '.' || cid === '..') return null;
  const searchRoots = roots || defaultAntigravityRoots(env, home);
  for (const root of searchRoots) {
    const candidate = path.join(root, cid, '.system_generated', 'logs', 'transcript.jsonl');
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function openDbReadOnly(dbPath) {
  if (!DatabaseSync || !dbPath || !fs.existsSync(dbPath)) return null;
  try {
    // readBigInts: true prevents RangeError on conversations_fts nanosecond epoch columns.
    const db = new DatabaseSync(dbPath, { readOnly: true, readBigInts: true });
    try {
      db.exec('PRAGMA busy_timeout = 2000');
      db.exec('PRAGMA query_only = 1');
    } catch { /* read-only DBs still work if pragmas are unsupported */ }
    return db;
  } catch {
    return null;
  }
}

function tableExists(db, name) {
  try {
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name = ?").get(name);
    return Boolean(row);
  } catch {
    return false;
  }
}

function tableColumns(db, name) {
  try {
    return new Set(db.prepare(`PRAGMA table_info(${name})`).all().map((r) => r.name));
  } catch {
    return new Set();
  }
}

function uriToPath(raw) {
  if (typeof raw !== 'string') return '';
  const trimmed = raw.trim();
  if (!trimmed) return '';
  if (trimmed.startsWith('file://')) {
    try {
      return fileURLToPath(trimmed);
    } catch {
      return trimmed.replace(/^file:\/\//, '');
    }
  }
  return trimmed;
}

function parseWorkspaceUris(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.filter((v) => typeof v === 'string' && v.trim());
  const text = String(raw).trim();
  if (!text) return [];
  if (text.startsWith('[')) {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) return parsed.filter((v) => typeof v === 'string' && v.trim());
    } catch { /* fall through */ }
  }
  return [text];
}

function makeGitProjectResolver() {
  const cache = new Map();
  return function resolveGitDir(dir) {
    if (cache.has(dir)) return cache.get(dir);
    let project = '';
    if (fs.existsSync(dir)) {
      try {
        const common = execFileSync('git', ['-C', dir, 'rev-parse', '--git-common-dir'], {
          encoding: 'utf8',
          timeout: 2000,
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
        if (common) {
          const absCommon = path.resolve(dir, common);
          if (path.basename(absCommon) === '.git') {
            project = path.basename(path.dirname(absCommon));
          } else {
            project = path.basename(absCommon).replace(/\.git$/, '');
          }
        }
      } catch {
        project = '';
      }
    }
    cache.set(dir, project);
    return project;
  };
}

function resolvePathToProject(rawPath, { workspaceRoot = '', resolveGitDir, nonProjects }) {
  const localPath = uriToPath(rawPath);
  if (!localPath || !path.isAbsolute(localPath)) return '';

  // Walk up to the nearest existing directory (paths from tool_calls may name files).
  let existingDir = '';
  let cur = path.resolve(localPath);
  for (let i = 0; i < 16; i++) {
    try {
      const st = fs.statSync(cur);
      if (st.isDirectory()) { existingDir = cur; break; }
    } catch { /* keep walking up */ }
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }

  if (existingDir) {
    const gitProject = resolveGitDir(existingDir);
    if (gitProject && !isNonProject(gitProject, nonProjects)) return gitProject;
  }

  // Non-git or pruned path under workspaceRoot: take the first real segment under workspaceRoot.
  if (workspaceRoot) {
    const rootAbs = path.resolve(workspaceRoot);
    const rel = path.relative(rootAbs, path.resolve(localPath));
    if (rel && rel !== '.' && !rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel)) {
      const segs = rel.split(path.sep).filter(Boolean);
      const first = segs[0] || '';
      if (first && !isNonProject(first, nonProjects)) return first;
    }
  }

  const fallback = path.basename(existingDir || localPath);
  return fallback && !isNonProject(fallback, nonProjects) ? fallback : '';
}

function normalizeTimestamp(raw) {
  if (raw === null || raw === undefined || raw === '') return '';
  if (typeof raw === 'bigint') {
    let ms = 0;
    if (raw > 1_000_000_000_000_000n) ms = Number(raw / 1_000_000n);
    else if (raw > 1_000_000_000_000n) ms = Number(raw);
    else if (raw > 0n) ms = Number(raw) * 1000;
    if (!Number.isFinite(ms) || ms <= 0) return '';
    return `${new Date(ms).toISOString().slice(0, 19)}Z`;
  }
  if (typeof raw === 'number') {
    let ms = raw;
    if (raw > 1e15) ms = Math.floor(raw / 1e6);
    else if (raw > 0 && raw < 1e11) ms = raw * 1000;
    if (!Number.isFinite(ms) || ms <= 0) return '';
    return `${new Date(ms).toISOString().slice(0, 19)}Z`;
  }
  const s = String(raw).trim();
  if (!s) return '';
  const isoLike = s.replace(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})/, '$1T$2');
  const parsed = Date.parse(isoLike);
  if (Number.isFinite(parsed) && parsed > 0) {
    return `${new Date(parsed).toISOString().slice(0, 19)}Z`;
  }
  return s;
}

function toEpochMs(raw) {
  const iso = normalizeTimestamp(raw);
  if (!iso) return 0;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : 0;
}

function cleanText(raw) {
  let s = String(raw ?? '');
  s = s.replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/g, ' ');
  s = s.replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/g, ' ');
  s = s.replace(/<\/?USER_REQUEST>/g, ' ');
  s = s.replace(/[\u0000-\u001f\u007f]+/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

function clip(text, max) {
  const s = String(text ?? '');
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function unquoteArg(val) {
  if (typeof val !== 'string') return '';
  let s = val.trim();
  if (s.startsWith('"') && s.endsWith('"')) {
    try {
      const parsed = JSON.parse(s);
      if (typeof parsed === 'string') return parsed;
    } catch {
      s = s.slice(1, -1);
    }
  }
  return s;
}

/**
 * Read conversation metadata from Antigravity's conversation_summaries.db (strictly read-only).
 * Returns Map<conversationId, { title, workspaceUris, project, parentId, lastModifiedTime, stepCount, agentName, nestingDepth }>.
 * Gracefully returns an empty Map if the DB is missing, unreadable, or node:sqlite is unavailable.
 */
export function readConversationMeta(
  dbPath = defaultAntigravityDbPath(),
  {
    env = process.env,
    workspaceRoot = env.CARTOGRAPHER_DEV_DIR || path.join(os.homedir(), 'Documents', 'dev'),
    resolveGitDir = makeGitProjectResolver(),
  } = {},
) {
  const result = new Map();
  const db = openDbReadOnly(dbPath);
  if (!db) return result;

  const nonProjects = nonProjectNames(env, workspaceRoot);

  try {
    const parentLookup = new Map();
    if (tableExists(db, 'conversation_parents')) {
      try {
        const parentRows = db.prepare('SELECT conversation_id, parent_id FROM conversation_parents').all();
        for (const r of parentRows) {
          const cid = String(r.conversation_id || '').trim();
          const pid = String(r.parent_id || '').trim();
          if (isResolved(cid) && isResolved(pid) && cid !== pid) {
            parentLookup.set(cid, pid);
          }
        }
      } catch { /* ignore schema variations */ }
    }

    if (tableExists(db, 'conversation_summaries')) {
      const cols = tableColumns(db, 'conversation_summaries');
      const opt = (name, defSql = "''") => (cols.has(name) ? name : `${defSql} AS ${name}`);
      const rows = db.prepare(`
        SELECT conversation_id,
               ${opt('title')},
               ${opt('workspace_uris')},
               ${opt('parent_conversation_id')},
               ${opt('last_modified_time')},
               ${opt('step_count', '0')},
               ${opt('agent_name')},
               ${opt('nesting_depth', '0')}
          FROM conversation_summaries
      `).all();

      for (const row of rows) {
        const cid = String(row.conversation_id || '').trim();
        if (!isResolved(cid)) continue;
        const workspaceUris = parseWorkspaceUris(row.workspace_uris);
        let project = null;
        for (const uri of workspaceUris) {
          const resolved = resolvePathToProject(uri, { workspaceRoot, resolveGitDir, nonProjects });
          if (resolved) { project = resolved; break; }
        }
        const rawParent = String(row.parent_conversation_id || '').trim() || parentLookup.get(cid) || '';
        const parentId = isResolved(rawParent) && rawParent !== cid ? rawParent : null;
        result.set(cid, {
          title: String(row.title || ''),
          workspaceUris,
          project,
          parentId,
          lastModifiedTime: normalizeTimestamp(row.last_modified_time),
          stepCount: Number(row.step_count || 0),
          agentName: String(row.agent_name || ''),
          nestingDepth: Number(row.nesting_depth || 0),
        });
      }
    }

    // Include any parent-only entries present in conversation_parents but absent from conversation_summaries.
    for (const [cid, pid] of parentLookup) {
      if (!result.has(cid)) {
        result.set(cid, {
          title: '',
          workspaceUris: [],
          project: null,
          parentId: pid,
          lastModifiedTime: '',
          stepCount: 0,
          agentName: '',
          nestingDepth: 1,
        });
      }
    }
  } catch {
    return result;
  } finally {
    db.close();
  }

  return result;
}

function inferProjectFromTranscript(transcriptPath, { workspaceRoot, resolveGitDir, nonProjects }) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return '';
  let content = '';
  try {
    content = fs.readFileSync(transcriptPath, 'utf8');
  } catch {
    return '';
  }

  const votes = new Map();
  const addVote = (candidatePath) => {
    const project = resolvePathToProject(candidatePath, { workspaceRoot, resolveGitDir, nonProjects });
    if (project) votes.set(project, (votes.get(project) || 0) + 1);
  };

  for (const line of content.split('\n')) {
    if (!line || !line.includes('"tool_calls"')) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    if (rec?.type !== 'PLANNER_RESPONSE' || !Array.isArray(rec.tool_calls)) continue;
    for (const call of rec.tool_calls) {
      const args = call?.args;
      if (!args || typeof args !== 'object') continue;
      for (const key of ['Path', 'path', 'TargetFile', 'SearchPath', 'DirectoryPath', 'Cwd', 'cwd']) {
        if (typeof args[key] === 'string') {
          const p = unquoteArg(args[key]);
          if (p) addVote(p);
        }
      }
      for (const key of ['CommandLine', 'command']) {
        if (typeof args[key] === 'string') {
          const cmd = unquoteArg(args[key]);
          // Extract absolute path tokens from commands (e.g. `cd /path/to/repo && ...`).
          for (const m of cmd.matchAll(/(?:^|[\s"'=:])(\/[A-Za-z0-9._\-/]+)/g)) {
            if (m[1].length > 1) addVote(m[1]);
          }
        }
      }
    }
  }

  const winner = [...votes.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];
  return winner || '';
}

/**
 * Resolve the project name for an Antigravity conversation:
 *   1. conversation_summaries.db workspace_uris (resolved via git common dir)
 *   2. Dominant repo path in transcript.jsonl PLANNER_RESPONSE tool_calls
 *   3. 'unknown'
 */
export function inferAntigravityProject(
  conversationId,
  transcriptPath = '',
  {
    dbPath = defaultAntigravityDbPath(),
    workspaceRoot = process.env.CARTOGRAPHER_DEV_DIR || path.join(os.homedir(), 'Documents', 'dev'),
    env = process.env,
    metaMap = null,
    resolveGitDir = makeGitProjectResolver(),
  } = {},
) {
  const nonProjects = nonProjectNames(env, workspaceRoot);
  if (isResolved(conversationId)) {
    const map = metaMap || readConversationMeta(dbPath, { env, workspaceRoot, resolveGitDir });
    const meta = map.get(String(conversationId).trim());
    if (meta?.project && !isNonProject(meta.project, nonProjects)) {
      return meta.project;
    }
  }

  const fromTranscript = inferProjectFromTranscript(transcriptPath, { workspaceRoot, resolveGitDir, nonProjects });
  if (fromTranscript && !isNonProject(fromTranscript, nonProjects)) {
    return fromTranscript;
  }

  return 'unknown';
}

function readFtsChunks(db, conversationId) {
  if (!tableExists(db, 'conversations_fts')) return [];
  try {
    return db.prepare(`
      SELECT conversation_id, chunk_index, chunk_first_step, chunk_last_step,
             last_modified_time, last_step_created_at, title, workspace, project,
             user_body, agent_body
        FROM conversations_fts
       WHERE conversation_id = ?
       ORDER BY chunk_index ASC
    `).all(conversationId);
  } catch {
    return [];
  }
}

export function buildFtsTurns(conversationId, chunks, { project = 'unknown', timestamp = '', bodyMax = DEFAULT_TURN_BODY_MAX } = {}) {
  let fallbackTs = timestamp;
  for (const c of chunks) {
    if (!fallbackTs) {
      fallbackTs = normalizeTimestamp(c.last_step_created_at) || normalizeTimestamp(c.last_modified_time);
    }
  }
  const turns = [];
  let idx = 0;
  for (const c of chunks) {
    if (Number(c.chunk_index) < 0) continue;
    const parts = [cleanText(c.user_body), cleanText(c.agent_body)].filter(Boolean);
    if (!parts.length) continue;
    idx += 1;
    const ts = normalizeTimestamp(c.last_step_created_at) || normalizeTimestamp(c.last_modified_time) || fallbackTs;
    turns.push({
      event_id: `turn-antigravity-${conversationId}-${idx}`,
      timestamp: ts,
      project,
      type: 'transcript',
      provider: PROVIDER,
      summary: clip(parts.join(' '), bodyMax),
      transcript_path: '',
      session: conversationId,
      turn_idx: idx,
    });
  }
  return turns;
}

function readJsonlTurns(transcriptPath, conversationId, project, bodyMax) {
  const awkScript = path.join(HERE, 'antigravity-transcript-to-turns.awk');
  const res = spawnSync('awk', [
    '-f', awkScript,
    '-v', `sid=${conversationId}`,
    '-v', `proj=${project}`,
    '-v', `tpath=${transcriptPath}`,
    transcriptPath,
  ], {
    encoding: 'utf8',
    env: { ...process.env, LC_ALL: 'C', TURN_BODY_MAX: String(bodyMax) },
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.status !== 0) return [];
  return res.stdout.split('\n').filter(Boolean).map((line) => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
}

function loadProgressSet(progressFile) {
  const set = new Set();
  try {
    const raw = fs.readFileSync(progressFile, 'utf8');
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (trimmed) set.add(trimmed);
    }
  } catch { /* no progress file yet */ }
  return set;
}

function indexTurn(doc, { indexer, env = process.env }) {
  const res = spawnSync(indexer, [], {
    input: JSON.stringify(doc),
    encoding: 'utf8',
    env: { ...env, PE_GATE_REJECT: env.PE_GATE_REJECT || GATE_OFF },
    stdio: ['pipe', 'ignore', 'pipe'],
  });
  return res.status === 0;
}

/**
 * Optional read-only backfill of pre-JSONL conversations (rows present in
 * conversation_summaries.db + conversations_fts that have no transcript.jsonl on disk).
 */
export function backfillPreJsonl({
  dbPath = defaultAntigravityDbPath(),
  roots = defaultAntigravityRoots(),
  devRoot = process.env.CARTOGRAPHER_DEV_DIR || path.join(os.homedir(), 'Documents', 'dev'),
  indexer = process.env.CARTOGRAPHER_INDEXER || path.join(HERE, 'index-event.sh'),
  env = process.env,
  write = false,
  sinceDays = 0,
  limit = 0,
  fresh = false,
  bodyMax = Number(env.TURN_BODY_MAX) || DEFAULT_TURN_BODY_MAX,
} = {}) {
  const receipt = {
    dry_run: !write,
    db_path: dbPath,
    conversations_seen: 0,
    skipped_has_jsonl: 0,
    skipped_too_old: 0,
    skipped_checkpointed: 0,
    skipped_empty: 0,
    conversations_selected: 0,
    conversations_backfilled: 0,
    turns_generated: 0,
    turns_indexed: 0,
    turns_failed: 0,
  };

  const db = openDbReadOnly(dbPath);
  if (!db) return receipt;

  const stateDir = path.join(devRoot, '.carto');
  const progressFile = path.join(stateDir, 'antigravity-sqlite-progress');
  const progressSet = fresh ? new Set() : loadProgressSet(progressFile);
  if (write) {
    fs.mkdirSync(stateDir, { recursive: true });
    if (fresh) fs.writeFileSync(progressFile, '');
  }

  const cutoffMs = sinceDays > 0 ? Date.now() - sinceDays * 86400e3 : 0;
  const resolveGitDir = makeGitProjectResolver();
  const nonProjects = nonProjectNames(env, devRoot);
  const metaMap = readConversationMeta(dbPath, { env, workspaceRoot: devRoot, resolveGitDir });

  try {
    if (!tableExists(db, 'conversations_fts')) return receipt;
    const ftsIds = db.prepare('SELECT DISTINCT conversation_id FROM conversations_fts ORDER BY conversation_id').all()
      .map((r) => String(r.conversation_id || '').trim())
      .filter((cid) => isResolved(cid));

    for (const cid of ftsIds) {
      receipt.conversations_seen += 1;

      if (findAntigravityTranscript(cid, { roots })) {
        receipt.skipped_has_jsonl += 1;
        continue;
      }

      const meta = metaMap.get(cid) || null;
      const chunks = readFtsChunks(db, cid);
      const fallbackMetaChunk = chunks.find((c) => Number(c.chunk_index) < 0);
      const ts = meta?.lastModifiedTime
        || normalizeTimestamp(fallbackMetaChunk?.last_modified_time)
        || normalizeTimestamp(fallbackMetaChunk?.last_step_created_at)
        || '';
      const tsMs = toEpochMs(ts);
      if (cutoffMs > 0 && tsMs > 0 && tsMs < cutoffMs) {
        receipt.skipped_too_old += 1;
        continue;
      }

      let project = meta?.project || '';
      if (!project && fallbackMetaChunk?.project && !isNonProject(fallbackMetaChunk.project, nonProjects)) {
        project = String(fallbackMetaChunk.project).trim();
      }
      if (!project) project = 'unknown';

      const sig = String(tsMs || meta?.stepCount || chunks.length);
      const progressKey = `antigravity-sqlite ${cid} ${sig} ${project}`;
      if (!fresh && progressSet.has(progressKey)) {
        receipt.skipped_checkpointed += 1;
        continue;
      }

      const turns = buildFtsTurns(cid, chunks, { project, timestamp: ts, bodyMax });
      if (!turns.length) {
        receipt.skipped_empty += 1;
        continue;
      }

      if (limit > 0 && receipt.conversations_selected >= limit) break;
      receipt.conversations_selected += 1;
      receipt.turns_generated += turns.length;

      if (!write) continue;

      let convFailed = 0;
      for (const turn of turns) {
        if (indexTurn(turn, { indexer, env })) {
          receipt.turns_indexed += 1;
        } else {
          receipt.turns_failed += 1;
          convFailed += 1;
        }
      }

      if (convFailed === 0) {
        fs.appendFileSync(progressFile, `${progressKey}\n`);
        progressSet.add(progressKey);
        receipt.conversations_backfilled += 1;
      }
    }
  } finally {
    db.close();
  }

  return receipt;
}

export function showConversation(
  conversationId,
  {
    dbPath = defaultAntigravityDbPath(),
    roots = defaultAntigravityRoots(),
    workspaceRoot = process.env.CARTOGRAPHER_DEV_DIR || path.join(os.homedir(), 'Documents', 'dev'),
    env = process.env,
    bodyMax = 50000,
  } = {},
) {
  const transcriptPath = findAntigravityTranscript(conversationId, { roots });
  const metaMap = readConversationMeta(dbPath, { env, workspaceRoot });
  const meta = metaMap.get(conversationId) || null;
  const project = inferAntigravityProject(conversationId, transcriptPath || '', {
    dbPath, workspaceRoot, env, metaMap,
  });

  if (transcriptPath) {
    const turns = readJsonlTurns(transcriptPath, conversationId, project, bodyMax);
    return { source: 'jsonl', conversationId, title: meta?.title || conversationId, project, transcriptPath, turns };
  }

  const db = openDbReadOnly(dbPath);
  if (!db) return null;
  try {
    const chunks = readFtsChunks(db, conversationId);
    if (!chunks.length) return null;
    const turns = buildFtsTurns(conversationId, chunks, {
      project,
      timestamp: meta?.lastModifiedTime || '',
      bodyMax,
    });
    if (!turns.length) return null;
    return { source: 'sqlite_fts', conversationId, title: meta?.title || conversationId, project, transcriptPath: '', turns };
  } finally {
    db.close();
  }
}

export function main(argv = process.argv.slice(2)) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      project: { type: 'string' },
      show: { type: 'string' },
      backfill: { type: 'boolean', default: false },
      write: { type: 'boolean', default: false },
      fresh: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      'since-days': { type: 'string' },
      limit: { type: 'string' },
      db: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  if (values.help) {
    process.stdout.write([
      'Usage:',
      '  antigravity-source.js --project <conversation-id> [transcript-path]',
      '  antigravity-source.js --show <conversation-id> [--json]',
      '  antigravity-source.js --backfill [--write] [--since-days N] [--limit N] [--fresh] [--json]',
      '',
    ].join('\n'));
    return 0;
  }

  const dbPath = values.db ? path.resolve(expandHome(values.db)) : defaultAntigravityDbPath();
  const devRoot = path.resolve(process.env.CARTOGRAPHER_DEV_DIR || path.join(os.homedir(), 'Documents', 'dev'));
  const roots = defaultAntigravityRoots();

  if (values.project !== undefined) {
    const transcriptPath = positionals[0] || '';
    const project = inferAntigravityProject(values.project, transcriptPath, {
      dbPath,
      workspaceRoot: devRoot,
    });
    process.stdout.write(`${project}\n`);
    return 0;
  }

  if (values.show !== undefined) {
    const shown = showConversation(values.show, { dbPath, roots, workspaceRoot: devRoot });
    if (!shown) {
      process.stderr.write(`antigravity-source: conversation ${values.show} not found\n`);
      return 1;
    }
    if (values.json) {
      process.stdout.write(`${JSON.stringify(shown)}\n`);
      return 0;
    }
    process.stdout.write(`# ${shown.title} (antigravity/${shown.project}, source: ${shown.source})\n\n`);
    for (const t of shown.turns) {
      process.stdout.write(`## Turn ${t.turn_idx} — ${t.timestamp || '?'}\n${t.summary}\n\n`);
    }
    return 0;
  }

  if (values.backfill) {
    const sinceDays = values['since-days'] ? Number(values['since-days']) : 0;
    if (values['since-days'] && !(sinceDays > 0)) {
      process.stderr.write('antigravity-source: --since-days must be a positive number\n');
      return 2;
    }
    const limit = values.limit ? Number(values.limit) : 0;
    if (values.limit && !(limit > 0)) {
      process.stderr.write('antigravity-source: --limit must be a positive number\n');
      return 2;
    }
    const receipt = backfillPreJsonl({
      dbPath,
      roots,
      devRoot,
      write: values.write,
      sinceDays,
      limit,
      fresh: values.fresh,
    });
    if (values.json) {
      process.stdout.write(`${JSON.stringify(receipt)}\n`);
    } else {
      process.stdout.write(
        `antigravity-source: ${receipt.dry_run ? 'dry run' : 'WRITE'} — `
        + `${receipt.conversations_selected} pre-JSONL conversation(s) selected `
        + `(${receipt.conversations_seen} seen, ${receipt.skipped_has_jsonl} have jsonl, `
        + `${receipt.skipped_checkpointed} checkpointed), ${receipt.turns_generated} turn(s)`
        + (receipt.dry_run ? '' : `, indexed ${receipt.turns_indexed}, failed ${receipt.turns_failed}, backfilled ${receipt.conversations_backfilled}`)
        + '\n',
      );
    }
    return receipt.turns_failed > 0 ? 1 : 0;
  }

  process.stderr.write('antigravity-source: specify --project, --show, or --backfill (see --help)\n');
  return 2;
}

const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  process.exitCode = main();
}
