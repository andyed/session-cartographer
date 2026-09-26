#!/usr/bin/env node
/**
 * hermes-source.js — bring Hermes Agent sessions and workspace artifacts into
 * the corpus.
 *
 * Hermes keeps its history in SQLite (`<hermes home>/state.db`, one per
 * profile under `profiles/<name>/state.db`), not in transcript files, so none
 * of the file-walking machinery that serves Claude and Codex applies: there is
 * no file to `find`, no mtime to checkpoint on, and nothing for the
 * `--transcript` grep fallback to read. This is the third source adapter, and
 * the first one whose units are rows. Its three steps are kept separate on
 * purpose — enumerate units, compute a change signature, parse units into
 * records — because that is the shape TODO.md's source-adapter boundary will
 * be extracted from, and a third concrete implementation is worth more to that
 * design than a second abstract one.
 *
 * What it must share with the other two is the TURN CONTRACT, not the
 * mechanics: one provider-neutral document per turn, grouped from one user
 * prompt to the next (`transcript-to-turns.awk`, `codex-transcript-to-turns.awk`),
 * `type: "transcript"`, deterministic `event_id`, indexed through
 * `index-event.sh`. tests/unit/hermes-source.test.js holds it to that shape.
 *
 * Records, and where they land:
 *   - Workspace artifacts (configured globs — e.g. daily consolidations,
 *     ledgers): one row per content version in session-milestones.jsonl, with
 *     the full redacted text in `description` for both BM25 engines, plus one
 *     semantic document per `##` section. `transcript_path` names the file,
 *     because the file IS the territory a reader should open.
 *   - Conversation sessions: one lifecycle row once the session settles, plus
 *     semantic turns. Tool RESULTS are never indexed — they are bulky, and in
 *     practice they are where an agent's governance boilerplate lives.
 *   - Cron runs: one lifecycle row, plus a single turn holding the final
 *     reply. The prompt is never indexed: a scheduled agent's prompt can embed
 *     this corpus's own pulse, and indexing it would feed Cartographer's
 *     summaries back into Cartographer.
 *
 * Privacy is policy, and policy lives in the user's config file, never here:
 *   - `exclude_projects` drops a whole session or artifact whose project, cwd
 *     or path matches (case-insensitive substring, the allowlist's own rule).
 *   - `redact_patterns` replaces matching LINES with `[excluded]` before
 *     anything is written or embedded. Line-level, not record-level, and that
 *     was measured rather than preferred: on the corpus this was built against,
 *     the excluded terms appeared in 105 of 106 cron runs and 66 of 67 daily
 *     consolidations, nearly all as the agent's own scope rules ("touch no X
 *     systems"). A mention-means-drop filter looks fail-closed and silently
 *     deletes the agent.
 *   - Paths under `~/.openclaw` are refused outright.
 *
 * Databases are opened read-only (Hermes may hold a WAL write lock). A busy or
 * unreadable database fails the run without checkpointing, so the next run
 * retries rather than skipping what it never read.
 *
 * Usage:
 *   node scripts/hermes-source.js                 dry run: counts, writes nothing
 *   node scripts/hermes-source.js --write         append rows, index, checkpoint
 *   node scripts/hermes-source.js --show <sid>    print one session's turns (drill-down)
 *   node scripts/hermes-source.js --print-config-path   where the policy file is looked for
 *   Options: --config PATH, --json, --profile NAME, --session ID, --since-days N,
 *            --full (ignore checkpoints), --only sessions|artifacts
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { registryConfigDir } from './project-registry.js';
import { isNonProject, nonProjectNames } from './non-projects.js';
import { flattenSummary } from './build-prompt-history.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOME = os.homedir();

export const PROVIDER = 'hermes';

// Salience priors. Artifacts sit just under an authored /wrapup (0.9): they
// are syntheses, but unattended ones that mix observation with forecast.
// Conversation turns match the Claude/Codex default (0.5) so no provider
// outranks another by construction. Cron turns are repetitive by design.
export const SALIENCE = {
  lifecycle: 0.25,
  turn: 0.5,
  subagent_turn: 0.4,
  cron_turn: 0.3,
};

const REDACTED = '[excluded]';
const DEFAULT_TURN_BODY_MAX = 1200;
const SECTION_BODY_MAX = 1200;
const ARTIFACT_DESCRIPTION_MAX = 20000;
const EXCERPT_MAX = 300;
// A session whose last message is this recent may still be titling itself or
// mid-reply; its lifecycle row waits. Turns are upserted by deterministic id,
// so they can be indexed early and corrected later — an appended row cannot.
const SETTLE_SECONDS = 3600;
// Hermes re-inserts some tail messages when it compacts a conversation, so
// the same prompt exists once compacted and once active. Short texts ("go",
// "continue") legitimately repeat and are never treated as copies.
const DUPLICATE_MIN_CHARS = 20;
// Novelty-gate thresholds handed to index-event.sh (its default is 0.85).
// Turns turn it off, as retro-index.sh does: a grown turn re-indexed under
// its own id matches itself at ~1.0. Artifact sections keep a gate, but only
// for near-verbatim repeats. Measured on the first backfill: 748 of 835
// sections were rejected at 0.85, including every section of the newest daily
// note, because notes written from one template score 0.85-0.93 against each
// other while saying different things. The near-verbatim cluster (run
// reports, re-runs) sat apart, at 0.97-1.0.
const GATE_OFF = '2.0';
const SECTION_GATE = '0.97';

export class HermesSourceError extends Error {
  constructor(message, code = 2) {
    super(message);
    this.code = code;
  }
}

// ─── Config ─────────────────────────────────────────────────────────────────

export function expandHome(p) {
  if (typeof p !== 'string' || !p) return p;
  if (p === '~') return HOME;
  if (p.startsWith('~/')) return path.join(HOME, p.slice(2));
  return p;
}

export function defaultConfigPath(env = process.env) {
  if (env.CARTOGRAPHER_HERMES_CONFIG) return path.resolve(expandHome(env.CARTOGRAPHER_HERMES_CONFIG));
  return path.join(registryConfigDir(env), 'hermes.json');
}

/**
 * Refuse any path that resolves into ~/.openclaw. Resolved through symlinks,
 * because a workspace directory that is itself a symlink is exactly how an
 * archive would get read by accident.
 */
export function guardPath(p) {
  let real = path.resolve(p);
  try { real = fs.realpathSync(real); } catch { /* not there yet; check the literal path */ }
  const parts = real.split(path.sep);
  if (parts.includes('.openclaw')) {
    throw new HermesSourceError(`refusing to read ${p}: resolves under .openclaw, which is archive material and never a source`);
  }
  return real;
}

function compilePatterns(list, field) {
  if (list === undefined) return [];
  if (!Array.isArray(list)) throw new HermesSourceError(`config.${field} must be an array of regular expressions`);
  return list.map((src) => {
    try { return new RegExp(src, 'i'); } catch (err) {
      throw new HermesSourceError(`config.${field}: invalid pattern ${JSON.stringify(src)} (${err.message})`);
    }
  });
}

/**
 * Load and validate the policy file. There is no built-in default policy: an
 * adopter who has not written one has not decided what to exclude, and an
 * ingest that guesses would be complete, correct, and inappropriate — the same
 * reasoning that makes cartographer-pulse.sh refuse to run without --projects.
 */
export function loadConfig(configPath) {
  if (!configPath || !fs.existsSync(configPath)) {
    throw new HermesSourceError(
      `no Hermes config at ${configPath}; refusing to ingest without an explicit policy ` +
      '(see docs/examples/hermes.example.json)');
  }
  let raw;
  try { raw = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch (err) {
    throw new HermesSourceError(`cannot parse ${configPath}: ${err.message}`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new HermesSourceError(`${configPath} must hold a JSON object`);
  }

  const hermesHome = expandHome(raw.hermes_home || '~/.hermes');
  const sources = raw.sources ?? ['desktop', 'acp', 'subagent', 'cron'];
  if (!Array.isArray(sources) || sources.some((s) => typeof s !== 'string')) {
    throw new HermesSourceError('config.sources must be an array of Hermes session sources');
  }
  const artifacts = (raw.artifacts ?? []).map((a, i) => {
    if (!a || typeof a.kind !== 'string' || !/^[a-z][a-z0-9_]*$/.test(a.kind)) {
      throw new HermesSourceError(`config.artifacts[${i}].kind must be a lowercase identifier`);
    }
    if (typeof a.dir !== 'string' || !a.dir) throw new HermesSourceError(`config.artifacts[${i}].dir is required`);
    const salience = a.salience ?? 0.7;
    if (!Number.isFinite(salience) || salience < 0 || salience > 1) {
      throw new HermesSourceError(`config.artifacts[${i}].salience must be within 0..1`);
    }
    return {
      kind: a.kind,
      dir: path.resolve(hermesHome, expandHome(a.dir)),
      match: compilePatterns([a.match ?? '\\.md$'], `artifacts[${i}].match`)[0],
      exclude: compilePatterns(a.exclude ?? ['(^|/)README\\.md$'], `artifacts[${i}].exclude`),
      depth: Number.isInteger(a.depth) ? a.depth : 0,
      salience,
      project: a.project || null,
    };
  });

  const pathProjects = Object.entries(raw.path_projects ?? {})
    .map(([prefix, project]) => [path.resolve(expandHome(prefix)), String(project)])
    // Longest prefix wins, so a nested mapping beats its parent.
    .sort((a, b) => b[0].length - a[0].length);

  const excludeProjects = (raw.exclude_projects ?? []).map((s) => String(s)).filter(Boolean);
  // An excluded project's NAME is redacted too. Dropping its sessions is not
  // enough: an agent's run reports name what they skipped ("excludes 70
  // events from <project>"), and that sentence is itself the disclosure.
  const redactPatterns = [
    ...compilePatterns(raw.redact_patterns, 'redact_patterns'),
    ...excludeProjects.map((name) => new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')),
  ];

  return {
    path: configPath,
    hermesHome,
    profiles: Array.isArray(raw.profiles) ? raw.profiles.map(String) : null,
    sources: new Set(sources),
    minUserPrompts: Number.isInteger(raw.min_user_prompts) ? raw.min_user_prompts : 2,
    defaultProject: String(raw.default_project || 'hermes'),
    pathProjects,
    cronProjects: { ...(raw.cron_projects ?? {}) },
    cronSkipTurns: new Set((raw.cron_skip_turns ?? []).map(String)),
    excludeProjects: excludeProjects.map((s) => s.toLowerCase()),
    redactPatterns,
    artifacts,
  };
}

// ─── Text handling ──────────────────────────────────────────────────────────

/** One line, no control characters. Every summary in this pipeline is single-line. */
export function oneLine(text) {
  return flattenSummary(String(text ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' '));
}

/**
 * A field the portable keyword engine reads. Until 2026-09-25 `bm25-search.awk`
 * extracted a JSON string by cutting at the first `"`, escaped or not, so a
 * straight double quote silently truncated everything after it: a title in
 * quotes hid the whole session, and a markdown note with a quotation in its
 * first paragraph was searchable only up to that point. The awk now honors
 * escapes, so this is no longer required; it stays because it is harmless.
 * Quotes become apostrophes, which tokenize identically.
 */
export function searchable(text) {
  return oneLine(text).replace(/"/g, "'");
}

export function clip(text, max) {
  const s = String(text ?? '');
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * Line-level redaction. Returns the text with every matching line replaced,
 * and how many lines were replaced so the run can report it. A redaction that
 * happens silently is indistinguishable from content that was never there.
 */
export function makeRedactor(patterns) {
  return function redact(text) {
    if (text === null || text === undefined) return { text: '', redacted: 0 };
    const s = String(text);
    if (!patterns.length) return { text: s, redacted: 0 };
    let redacted = 0;
    const lines = s.split(/\r?\n/).map((line) => {
      if (patterns.some((re) => re.test(line))) { redacted += 1; return REDACTED; }
      return line;
    });
    return { text: lines.join('\n'), redacted };
  };
}

/** Tool names from an OpenAI-style tool_calls JSON column. Arguments are never kept. */
export function toolNames(toolCalls) {
  if (!toolCalls) return [];
  try {
    const parsed = JSON.parse(toolCalls);
    const list = Array.isArray(parsed) ? parsed : [parsed];
    return list.map((c) => c?.function?.name || c?.name).filter((n) => typeof n === 'string' && n);
  } catch {
    return [...String(toolCalls).matchAll(/"name"\s*:\s*"([^"]+)"/g)].map((m) => m[1]);
  }
}

/**
 * Paths inside tool-call arguments that fall under `root`, kept to their first
 * three segments. One segment is not enough: under a workspace root the first
 * segment is often a family directory (`interests/`) or a sibling worktree
 * (`widget-web-some-task/`), and neither is the repository. The caller
 * resolves each candidate through git.
 */
export function pathCandidatesIn(toolCalls, root) {
  if (!toolCalls || !root) return [];
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  const out = [];
  let from = 0;
  const s = String(toolCalls);
  while ((from = s.indexOf(prefix, from)) !== -1) {
    const rest = s.slice(from + prefix.length).match(/^[A-Za-z0-9._\-/]+/)?.[0] || '';
    const segs = rest.split('/').filter(Boolean).slice(0, 3);
    if (segs.length) out.push(segs.join('/'));
    from += prefix.length;
  }
  return out;
}

/** The repository a tool path belongs to: the deepest existing directory, via the shared resolver. */
export function resolveCandidate(rel, root, resolveDir) {
  const segs = rel.split('/');
  for (let n = segs.length; n >= 1; n -= 1) {
    const dir = path.join(root, ...segs.slice(0, n));
    let isDir = false;
    try { isDir = fs.statSync(dir).isDirectory(); } catch { /* gone or a file */ }
    if (isDir) return resolveDir(dir);
  }
  return segs[0];
}

export function isoFromEpochSeconds(seconds) {
  const n = Number(seconds);
  if (!Number.isFinite(n) || n <= 0) return null;
  return `${new Date(n * 1000).toISOString().slice(0, 19)}Z`;
}

export function hash8(text) {
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 8);
}

// ─── Turns ──────────────────────────────────────────────────────────────────

/**
 * Group a session's messages into turns: one user prompt through everything up
 * to the next user prompt. This is Cartographer's canonical boundary; do not
 * substitute one item per response.
 *
 * Skipped, each for a measured reason:
 *   - `_compressed_summary` rows: synthetic compaction digests, not history.
 *   - inactive rows that were never compacted: the user rewound past them.
 *   - active copies of a compacted user/assistant message: compaction
 *     re-inserted them (41 prompts across 18 sessions in the reference corpus).
 * Compacted originals ARE kept — they are the real conversation.
 */
export function buildTurns(messages, { redact, bodyMax = DEFAULT_TURN_BODY_MAX, devRoot = '' } = {}) {
  const compactedTexts = new Set();
  for (const m of messages) {
    if (m.compacted && (m.role === 'user' || m.role === 'assistant')
        && typeof m.content === 'string' && m.content.length > DUPLICATE_MIN_CHARS) {
      compactedTexts.add(`${m.role}\u0000${m.content}`);
    }
  }

  const turns = [];
  const workdirVotes = new Map();
  let current = null;
  let redacted = 0;
  let skipped = 0;

  const addText = (text) => {
    if (!current || !text) return;
    const r = redact(text);
    redacted += r.redacted;
    const line = oneLine(r.text);
    if (line) current.parts.push(line);
  };

  for (const m of messages) {
    if (m.compressed_summary) { skipped += 1; continue; }
    if (!m.active && !m.compacted) { skipped += 1; continue; }
    if (m.active && !m.compacted && (m.role === 'user' || m.role === 'assistant')
        && typeof m.content === 'string' && m.content.length > DUPLICATE_MIN_CHARS
        && compactedTexts.has(`${m.role}\u0000${m.content}`)) {
      skipped += 1;
      continue;
    }

    for (const rel of pathCandidatesIn(m.tool_calls, devRoot)) {
      workdirVotes.set(rel, (workdirVotes.get(rel) || 0) + 1);
    }

    if (m.role === 'user') {
      current = { rowid: m.id, timestamp: m.timestamp, parts: [], tools: new Set() };
      turns.push(current);
      addText(m.content);
    } else if (m.role === 'assistant') {
      addText(m.content);
      if (current) for (const name of toolNames(m.tool_calls)) current.tools.add(name);
    }
    // role 'tool' (results) and 'system' are deliberately never indexed.
  }

  const shaped = turns.map((t, i) => {
    const tools = t.tools.size ? ` [tools: ${[...t.tools].join(', ')}]` : '';
    const body = clip(`${t.parts.join(' ')}${tools}`.trim(), bodyMax);
    return { rowid: t.rowid, timestamp: t.timestamp, idx: i + 1, body };
  }).filter((t) => t.body);

  return { turns: shaped, redacted, skipped, workdirVotes };
}

/** The last non-empty assistant reply — a cron run's output. */
export function finalReply(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m.role === 'assistant' && !m.compressed_summary && typeof m.content === 'string' && m.content.trim()) {
      return m;
    }
  }
  return null;
}

// ─── Project attribution ────────────────────────────────────────────────────

/** `cron_<jobid>_<YYYYMMDD>_<HHMMSS>` → job id; title `job-name · Sep 25 04:03` → name. */
export function parseCron(session) {
  const jobId = String(session.id).match(/^cron_([0-9a-f]+)_\d{8}_\d{6}$/)?.[1] || '';
  const jobName = String(session.title || '').split(' · ')[0].trim() || jobId || 'cron';
  return { jobId, jobName };
}

function underPath(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Attribute a Hermes session to a project. First hit wins:
 *   1. cwd or git root inside the corpus root → the shared resolver
 *      (cartographer_project, git common dir), never a new derivation.
 *   2. cwd under a configured path prefix → its mapped project.
 *   3. cron → the configured job→project map.
 *   4. tool-call paths under the corpus root → the dominant repository, only
 *      when it is not a non-project and clearly leads (≥ 2 votes, ≥ 60%).
 *   5. the configured default.
 */
export function resolveProject(session, { config, devRoot, resolveDir, workdirVotes = new Map(), nonProjects }) {
  const dirs = [session.git_repo_root, session.cwd].filter((d) => typeof d === 'string' && d);
  for (const dir of dirs) {
    if (devRoot && underPath(path.resolve(dir), devRoot)) {
      const name = resolveDir(dir);
      if (name && !isNonProject(name, nonProjects)) return { project: name, via: 'cwd' };
    }
  }
  for (const dir of dirs) {
    const abs = path.resolve(dir);
    const hit = config.pathProjects.find(([prefix]) => underPath(abs, prefix));
    if (hit) return { project: hit[1], via: 'path_projects' };
  }
  if (session.source === 'cron') {
    const { jobId } = parseCron(session);
    if (jobId && config.cronProjects[jobId]) return { project: config.cronProjects[jobId], via: 'cron_projects' };
  }
  const byProject = new Map();
  for (const [rel, count] of workdirVotes) {
    const name = devRoot ? resolveCandidate(rel, devRoot, resolveDir) : rel.split('/')[0];
    byProject.set(name, (byProject.get(name) || 0) + count);
  }
  const votes = [...byProject.entries()]
    .filter(([name]) => !isNonProject(name, nonProjects))
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const total = votes.reduce((n, [, v]) => n + v, 0);
  if (votes.length && votes[0][1] >= 2 && votes[0][1] / total >= 0.6) {
    return { project: votes[0][0], via: 'tool_paths' };
  }
  return { project: config.defaultProject, via: 'default' };
}

export function isExcluded(config, ...values) {
  if (!config.excludeProjects.length) return false;
  return values.some((v) => {
    const s = String(v ?? '').toLowerCase();
    return s && config.excludeProjects.some((term) => s.includes(term));
  });
}

/** cartographer_project() via its CLI face, cached per directory. */
export function makeDirResolver() {
  const cache = new Map();
  const script = path.join(HERE, 'cartographer-project.sh');
  return function resolveDir(dir) {
    if (cache.has(dir)) return cache.get(dir);
    let name = '';
    if (fs.existsSync(dir)) {
      try { name = execFileSync('bash', [script, dir], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { name = ''; }
    }
    // A cwd that no longer exists (a pruned tmp dir) still names its repo.
    if (!name) name = path.basename(dir);
    cache.set(dir, name);
    return name;
  };
}

// ─── Enumerate ──────────────────────────────────────────────────────────────

/** Every `state.db` Hermes owns: the default profile plus profiles/<name>. Never backups. */
export function discoverDatabases(config) {
  const home = guardPath(config.hermesHome);
  const found = [];
  const main = path.join(home, 'state.db');
  if (fs.existsSync(main)) found.push({ profile: 'default', path: main });
  const profilesDir = path.join(home, 'profiles');
  let entries = [];
  try { entries = fs.readdirSync(profilesDir, { withFileTypes: true }); } catch { /* no profiles */ }
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const db = path.join(profilesDir, entry.name, 'state.db');
    if (fs.existsSync(db)) found.push({ profile: entry.name, path: db });
  }
  return found
    .filter((d) => !config.profiles || config.profiles.includes(d.profile))
    .map((d) => ({ ...d, path: guardPath(d.path) }));
}

let sqliteModule = null;
async function sqlite() {
  if (sqliteModule) return sqliteModule;
  // node:sqlite prints an ExperimentalWarning on Node 22. It is expected, and
  // on a SessionStart path it would read as a fault, so only that one is muted.
  const original = process.emitWarning;
  process.emitWarning = function patched(warning, ...rest) {
    const text = typeof warning === 'string' ? warning : warning?.message;
    if (/SQLite/i.test(String(text))) return;
    return original.call(process, warning, ...rest);
  };
  try {
    sqliteModule = await import('node:sqlite');
  } catch (err) {
    throw new HermesSourceError(`node:sqlite is unavailable on Node ${process.version} (needs 22.13+): ${err.message}`, 69);
  } finally {
    process.emitWarning = original;
  }
  return sqliteModule;
}

export async function openReadOnly(dbPath) {
  const { DatabaseSync } = await sqlite();
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    db.exec('PRAGMA busy_timeout = 3000');
    db.exec('PRAGMA query_only = 1');
  } catch (err) {
    throw new HermesSourceError(`cannot open ${dbPath} read-only: ${err.message}`, 75);
  }
  return db;
}

function columns(db, table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name));
}

/** Sessions of the configured sources, with the per-session aggregates the filter needs. */
export function listSessions(db, config, { sinceEpoch = 0, sessionId = null } = {}) {
  const sCols = columns(db, 'sessions');
  const opt = (name, alias = name) => (sCols.has(name) ? `s.${name} AS ${alias}` : `NULL AS ${alias}`);
  const sources = [...config.sources];
  if (!sources.length) return [];
  const placeholders = sources.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT s.id, s.source, s.title, s.started_at, s.ended_at,
           ${opt('cwd')}, ${opt('git_repo_root')}, ${opt('parent_session_id')}, ${opt('hidden')},
           a.max_id, a.last_ts, a.user_prompts, a.tool_rows
      FROM sessions s
      JOIN (SELECT session_id, MAX(id) AS max_id, MAX(timestamp) AS last_ts,
                   SUM(role = 'user') AS user_prompts, SUM(role = 'tool') AS tool_rows
              FROM messages GROUP BY session_id) a ON a.session_id = s.id
     WHERE s.source IN (${placeholders})
       ${sessionId ? 'AND s.id = ?' : ''}
       AND a.last_ts >= ?
     ORDER BY s.started_at`).all(...sources, ...(sessionId ? [sessionId] : []), sinceEpoch);
  return rows;
}

/**
 * The noise filter. A conversation needs a second prompt or a tool call; a
 * single prompt answered in one reply is an LLM call routed through the agent
 * (171 of 212 `desktop` sessions in the reference corpus were exactly that).
 * Cron runs always pass: each is one prompt by construction.
 */
export function isConversation(session, config) {
  if (Number(session.hidden) === 1) return false;
  if (session.source === 'cron') return true;
  return Number(session.user_prompts) >= config.minUserPrompts || Number(session.tool_rows) >= 1;
}

export function readMessages(db, sessionId) {
  const mCols = columns(db, 'messages');
  const opt = (name, alias, fallback) => (mCols.has(name) ? `${name} AS ${alias}` : `${fallback} AS ${alias}`);
  return db.prepare(`
    SELECT id, role, content, tool_calls, timestamp,
           ${opt('active', 'active', 1)}, ${opt('compacted', 'compacted', 0)},
           ${opt('_compressed_summary', 'compressed_summary', 0)}
      FROM messages WHERE session_id = ? ORDER BY timestamp, id`).all(sessionId)
    .map((m) => ({ ...m, active: Number(m.active) === 1, compacted: Number(m.compacted) === 1,
      compressed_summary: Number(m.compressed_summary) === 1 }));
}

// ─── Parse: sessions ────────────────────────────────────────────────────────

export function sessionKey(profile, sid) {
  return `${profile}:${sid}`;
}

/**
 * Records for one session: an optional lifecycle row and its turns.
 * `fromRowid` limits turns to those opening at or after a checkpoint, so a
 * growing session re-embeds its tail, not its whole history.
 */
export function sessionRecords(session, messages, ctx) {
  const { config, profile, redact, devRoot, resolveDir, nonProjects, now, fromRowid = 0, bodyMax } = ctx;
  const built = buildTurns(messages, { redact, bodyMax, devRoot });
  const { project, via } = resolveProject(session, { config, devRoot, resolveDir, workdirVotes: built.workdirVotes, nonProjects });
  const base = { excluded: false, project, via, redacted: built.redacted, skipped: built.skipped };

  if (isExcluded(config, project, session.cwd, session.git_repo_root)) {
    return { ...base, excluded: true, row: null, turns: [], maxTurnRowid: 0 };
  }

  const isCron = session.source === 'cron';
  const title = oneLine(redact(session.title || '').text);
  const settled = Boolean(session.ended_at) || (now - Number(session.last_ts)) >= SETTLE_SECONDS;
  const startedIso = isoFromEpochSeconds(session.started_at);
  let redacted = built.redacted;
  let row = null;
  let turns = [];

  if (isCron) {
    const { jobId, jobName } = parseCron(session);
    const reply = finalReply(messages);
    const r = redact(reply?.content || '');
    redacted += r.redacted;
    const replyLine = oneLine(r.text);
    const minutes = session.ended_at ? Math.round((Number(session.ended_at) - Number(session.started_at)) / 60) : null;
    if (settled) {
      row = {
        event_id: `hermes-cron-${session.id}`,
        timestamp: startedIso,
        milestone: 'hermes_cron_run',
        event: 'CronRun',
        provider: PROVIDER,
        session_id: session.id,
        project,
        cwd: '',
        transcript_path: '',
        hermes_profile: profile,
        hermes_source: session.source,
        cron_job_id: jobId,
        cron_job: jobName,
        ended_at: isoFromEpochSeconds(session.ended_at),
        summary: searchable(`Hermes cron ${jobName} (${Number(session.tool_rows) || 0} tool results`
          + `${minutes === null ? '' : `, ${minutes} min`}): ${clip(replyLine, EXCERPT_MAX)}`),
        salience: SALIENCE.lifecycle,
      };
    }
    if (reply && replyLine && !config.cronSkipTurns.has(jobId)) {
      turns = [{
        event_id: `turn-hermes-${session.id}-${reply.id}`,
        timestamp: isoFromEpochSeconds(reply.timestamp),
        project,
        type: 'transcript',
        provider: PROVIDER,
        summary: clip(`${jobName}: ${replyLine}`, bodyMax || DEFAULT_TURN_BODY_MAX),
        session: session.id,
        turn_idx: 1,
        salience: SALIENCE.cron_turn,
        _rowid: reply.id,
      }];
    }
  } else {
    const firstPrompt = built.turns[0]?.body || '';
    if (settled) {
      row = {
        event_id: `hermes-session-${session.id}`,
        timestamp: startedIso,
        milestone: 'hermes_session',
        event: 'HermesSession',
        provider: PROVIDER,
        session_id: session.id,
        project,
        cwd: session.cwd || '',
        transcript_path: '',
        hermes_profile: profile,
        hermes_source: session.source,
        ...(session.parent_session_id ? { parent_session_id: session.parent_session_id } : {}),
        summary: searchable(`Hermes ${session.source} session${title ? ` — ${title}` : ''}: ${clip(firstPrompt, EXCERPT_MAX)}`),
        salience: SALIENCE.lifecycle,
      };
    }
    const salience = session.source === 'subagent' || session.parent_session_id ? SALIENCE.subagent_turn : SALIENCE.turn;
    turns = built.turns.map((t) => ({
      event_id: `turn-hermes-${session.id}-${t.rowid}`,
      timestamp: isoFromEpochSeconds(t.timestamp),
      project,
      type: 'transcript',
      provider: PROVIDER,
      summary: t.body,
      session: session.id,
      turn_idx: t.idx,
      salience,
      _rowid: t.rowid,
    }));
  }

  const maxTurnRowid = turns.reduce((n, t) => Math.max(n, t._rowid), 0);
  return {
    ...base,
    redacted,
    row,
    turns: turns.filter((t) => t._rowid >= fromRowid),
    maxTurnRowid,
  };
}

// ─── Enumerate + parse: artifacts ───────────────────────────────────────────

export function walkArtifacts(spec) {
  const root = guardPath(spec.dir);
  const out = [];
  const visit = (dir, depth) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < spec.depth) visit(full, depth + 1);
        continue;
      }
      if (!entry.isFile() && !entry.isSymbolicLink()) continue;
      const rel = path.relative(root, full).split(path.sep).join('/');
      if (!spec.match.test(rel) || spec.exclude.some((re) => re.test(rel))) continue;
      out.push({ file: guardPath(full), rel });
    }
  };
  visit(root, 0);
  return out;
}

/** Split markdown into `##` sections, keeping the heading. */
export function markdownSections(text) {
  const sections = [];
  let current = null;
  for (const line of String(text).split(/\r?\n/)) {
    const h = line.match(/^##\s+(.+?)\s*#*\s*$/);
    if (h) {
      current = { heading: h[1], lines: [] };
      sections.push(current);
    } else if (current) {
      current.lines.push(line);
    }
  }
  return sections.map((s) => ({ heading: s.heading, body: s.lines.join('\n') }));
}

/** Title (first H1) and the first real paragraph after it — the artifact's headline. */
export function headline(text) {
  const lines = String(text).split(/\r?\n/);
  const title = lines.find((l) => /^#\s+/.test(l))?.replace(/^#\s+/, '').trim() || '';
  const para = [];
  let started = false;
  for (const line of lines) {
    if (/^#/.test(line)) { if (started) break; continue; }
    if (!line.trim()) { if (para.length) break; continue; }
    started = true;
    para.push(line);
  }
  return { title, lead: para.join(' ') };
}

export function artifactRecords(spec, entry, ctx) {
  const { config, redact } = ctx;
  const raw = fs.readFileSync(entry.file, 'utf8');
  const project = spec.project || config.defaultProject;
  if (isExcluded(config, project, entry.file)) return { excluded: true, redacted: 0, row: null, sections: [] };

  const r = redact(raw);
  const text = r.text;
  const hash = hash8(raw);
  const slug = entry.rel.replace(/\.md$/i, '').replace(/[^A-Za-z0-9._-]+/g, '-');
  const eventId = `hermes-${spec.kind}-${slug}-${hash}`;
  const mtime = fs.statSync(entry.file).mtime;
  const timestamp = `${mtime.toISOString().slice(0, 19)}Z`;
  const { title, lead } = headline(text);
  const kindLabel = spec.kind.charAt(0).toUpperCase() + spec.kind.slice(1);

  const row = {
    event_id: eventId,
    timestamp,
    milestone: `hermes_${spec.kind}`,
    event: kindLabel,
    provider: PROVIDER,
    session_id: '',
    project,
    cwd: '',
    transcript_path: entry.file,
    artifact_kind: spec.kind,
    artifact_path: entry.rel,
    content_hash: hash,
    summary: searchable(clip(`${title || entry.rel}: ${oneLine(lead)}`, EXCERPT_MAX + 100)),
    description: clip(searchable(text), ARTIFACT_DESCRIPTION_MAX),
    salience: spec.salience,
  };

  const sections = markdownSections(text)
    .map((s, i) => ({ ...s, i: i + 1, line: oneLine(s.body) }))
    .filter((s) => s.line && s.line !== REDACTED)
    .map((s) => ({
      event_id: `${eventId}-s${s.i}`,
      timestamp,
      project,
      // Its own source label: routine sections repeat daily, and the indexer's
      // novelty gate is what keeps a hundred identical run reports out of the
      // semantic ladder. The row itself rides the milestone path.
      type: 'hermes_artifact',
      provider: PROVIDER,
      summary: clip(`${kindLabel} ${entry.rel} § ${oneLine(s.heading)}: ${s.line}`, SECTION_BODY_MAX),
      transcript_path: entry.file,
      parent_event_id: eventId,
      salience: spec.salience,
    }));

  return { excluded: false, redacted: r.redacted, row, sections, hash };
}

// ─── State, writing, indexing ───────────────────────────────────────────────

export function loadState(file) {
  try {
    const s = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { version: 1, sessions: s.sessions || {}, artifacts: s.artifacts || {} };
  } catch {
    return { version: 1, sessions: {}, artifacts: {} };
  }
}

export function saveState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state)}\n`);
  fs.renameSync(tmp, file);
}

/** event_ids of this source already in the log, so a rerun appends nothing twice. */
export function existingIds(logFile) {
  const ids = new Set();
  let text = '';
  try { text = fs.readFileSync(logFile, 'utf8'); } catch { return ids; }
  for (const m of text.matchAll(/"event_id":"(hermes-[^"]+)"/g)) ids.add(m[1]);
  return ids;
}

function appendRows(logFile, rows) {
  if (!rows.length) return;
  fs.appendFileSync(logFile, rows.map((r) => `${JSON.stringify(r)}\n`).join(''));
}

/**
 * Index one document through index-event.sh — the single indexing path, which
 * records its own failures in .carto/index-errors.jsonl. Turns disable the
 * novelty gate exactly as retro-index.sh does: re-indexing a grown turn under
 * its own id would otherwise match itself at ~1.0 and be rejected.
 */
function indexDoc(doc, { indexer, gate }) {
  const { _rowid, ...payload } = doc;
  const result = spawnSync(indexer, [], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, ...(gate ? { PE_GATE_REJECT: gate } : {}) },
    stdio: ['pipe', 'ignore', 'pipe'],
  });
  return result.status === 0;
}

/** The milestone path's own source label for artifact rows (bypasses the novelty gate, like /wrapup). */
function indexInputForRow(row) {
  return row.milestone && row.milestone !== 'hermes_session' && row.milestone !== 'hermes_cron_run'
    ? { ...row, type: 'milestones' }
    : row;
}

// ─── Orchestration ──────────────────────────────────────────────────────────

export async function collect(config, options = {}) {
  const {
    devRoot = path.resolve(process.env.CARTOGRAPHER_DEV_DIR || path.join(HOME, 'Documents', 'dev')),
    state = { sessions: {}, artifacts: {} },
    profile: onlyProfile = null,
    sessionId = null,
    sinceEpoch = 0,
    now = Date.now() / 1000,
    resolveDir = makeDirResolver(),
    bodyMax = Number(process.env.TURN_BODY_MAX) || DEFAULT_TURN_BODY_MAX,
    full = false,
    only = null,
  } = options;
  if (only && only !== 'sessions' && only !== 'artifacts') {
    throw new HermesSourceError(`--only must be 'sessions' or 'artifacts', not ${JSON.stringify(only)}`);
  }
  const redact = makeRedactor(config.redactPatterns);
  const nonProjects = nonProjectNames(process.env, devRoot);
  const receipt = {
    databases: [], sessions_seen: 0, sessions_filtered: 0, sessions_unchanged: 0,
    sessions_excluded: 0, artifacts_seen: 0, artifacts_unchanged: 0, artifacts_excluded: 0,
    lines_redacted: 0, messages_skipped: 0, attribution: {}, by_kind: {},
  };
  const units = [];

  for (const dbInfo of only === 'artifacts' ? [] : discoverDatabases(config)) {
    if (onlyProfile && dbInfo.profile !== onlyProfile) continue;
    const db = await openReadOnly(dbInfo.path);
    try {
      const sessions = listSessions(db, config, { sinceEpoch, sessionId });
      receipt.databases.push({ profile: dbInfo.profile, path: dbInfo.path, sessions: sessions.length });
      for (const session of sessions) {
        receipt.sessions_seen += 1;
        if (!isConversation(session, config)) { receipt.sessions_filtered += 1; continue; }
        const key = sessionKey(dbInfo.profile, session.id);
        const prior = full ? null : state.sessions[key];
        if (prior && prior.max_id === session.max_id && prior.row) { receipt.sessions_unchanged += 1; continue; }

        const messages = readMessages(db, session.id);
        const recs = sessionRecords(session, messages, {
          config, profile: dbInfo.profile, redact, devRoot, resolveDir, nonProjects, now,
          fromRowid: prior ? prior.last_turn_rowid || 0 : 0, bodyMax,
        });
        receipt.lines_redacted += recs.redacted;
        receipt.messages_skipped += recs.skipped;
        if (recs.excluded) { receipt.sessions_excluded += 1; continue; }
        receipt.attribution[recs.via] = (receipt.attribution[recs.via] || 0) + 1;
        const kind = session.source === 'cron' ? 'cron' : session.source;
        receipt.by_kind[kind] = (receipt.by_kind[kind] || 0) + 1;
        units.push({
          kind: 'session', key, session, project: recs.project,
          rows: recs.row && !(prior && prior.row) ? [recs.row] : [],
          docs: recs.turns,
          next: { max_id: session.max_id, project: recs.project, row: Boolean(recs.row) || Boolean(prior?.row),
            last_turn_rowid: recs.maxTurnRowid || prior?.last_turn_rowid || 0 },
        });
      }
    } finally {
      db.close();
    }
  }

  if (!sessionId && only !== 'sessions') {
    for (const spec of config.artifacts) {
      for (const entry of walkArtifacts(spec)) {
        receipt.artifacts_seen += 1;
        const recs = artifactRecords(spec, entry, { config, redact });
        if (recs.excluded) { receipt.artifacts_excluded += 1; continue; }
        if (!full && state.artifacts[entry.file] === recs.hash) { receipt.artifacts_unchanged += 1; continue; }
        receipt.lines_redacted += recs.redacted;
        receipt.by_kind[spec.kind] = (receipt.by_kind[spec.kind] || 0) + 1;
        units.push({ kind: 'artifact', key: entry.file, rows: [recs.row], docs: recs.sections, hash: recs.hash });
      }
    }
  }

  return { units, receipt };
}

export function write(units, { logFile, indexer, state, onCheckpoint = () => {} }) {
  const known = existingIds(logFile);
  const out = { rows_written: 0, rows_present: 0, docs_indexed: 0, index_failures: 0, units_checkpointed: 0 };
  for (const unit of units) {
    const fresh = unit.rows.filter((r) => !known.has(r.event_id));
    out.rows_present += unit.rows.length - fresh.length;
    // The durable row first: an indexing failure must never erase the record.
    appendRows(logFile, fresh);
    for (const r of fresh) known.add(r.event_id);
    out.rows_written += fresh.length;

    let ok = true;
    for (const row of unit.rows) {
      if (indexDoc(indexInputForRow(row), { indexer })) out.docs_indexed += 1;
      else { ok = false; out.index_failures += 1; }
    }
    for (const doc of unit.docs) {
      const gate = doc.type === 'transcript' ? GATE_OFF : doc.type === 'hermes_artifact' ? SECTION_GATE : null;
      if (indexDoc(doc, { indexer, gate })) out.docs_indexed += 1;
      else { ok = false; out.index_failures += 1; }
    }
    // Checkpoint only a unit that fully landed; the rest are retried next run.
    if (!ok) continue;
    if (unit.kind === 'session') state.sessions[unit.key] = unit.next;
    else state.artifacts[unit.key] = unit.hash;
    out.units_checkpointed += 1;
    // Persist as it goes: a first backfill is ~2,000 indexer calls, and an
    // interrupted run should resume, not start over.
    if (out.units_checkpointed % 25 === 0) onCheckpoint(state);
  }
  return out;
}

// ─── CLI ────────────────────────────────────────────────────────────────────

function printReceipt(receipt, writeResult, units, { json }) {
  const docs = units.reduce((n, u) => n + u.docs.length, 0);
  const rows = units.reduce((n, u) => n + u.rows.length, 0);
  if (json) {
    process.stdout.write(`${JSON.stringify({ receipt, write: writeResult, pending: { units: units.length, rows, docs } })}\n`);
    return;
  }
  const lines = [
    `hermes-source: ${writeResult ? 'WRITE' : 'dry run'} — ${units.length} unit(s), ${rows} row(s), ${docs} semantic doc(s)`,
    ...receipt.databases.map((d) => `  db ${d.profile}: ${d.sessions} session(s) with messages in window (${d.path})`),
    `  sessions: ${receipt.sessions_seen} seen, ${receipt.sessions_filtered} filtered as non-conversation, `
      + `${receipt.sessions_unchanged} unchanged, ${receipt.sessions_excluded} excluded by policy`,
    `  artifacts: ${receipt.artifacts_seen} seen, ${receipt.artifacts_unchanged} unchanged, ${receipt.artifacts_excluded} excluded by policy`,
    `  redacted lines: ${receipt.lines_redacted}; skipped messages (rewound/synthetic/duplicate): ${receipt.messages_skipped}`,
    `  by kind: ${JSON.stringify(receipt.by_kind)}; attribution: ${JSON.stringify(receipt.attribution)}`,
  ];
  if (writeResult) {
    lines.push(`  wrote ${writeResult.rows_written} row(s) (${writeResult.rows_present} already present); `
      + `indexed ${writeResult.docs_indexed}, failed ${writeResult.index_failures}; checkpointed ${writeResult.units_checkpointed}`);
  }
  process.stdout.write(`${lines.join('\n')}\n`);
}

async function show(config, sessionId, profile) {
  const redact = makeRedactor(config.redactPatterns);
  for (const dbInfo of discoverDatabases(config)) {
    if (profile && dbInfo.profile !== profile) continue;
    const db = await openReadOnly(dbInfo.path);
    try {
      const session = db.prepare('SELECT id, source, title, started_at, ended_at FROM sessions WHERE id = ?').get(sessionId);
      if (!session) continue;
      const { turns } = buildTurns(readMessages(db, sessionId), { redact, bodyMax: Number.MAX_SAFE_INTEGER });
      process.stdout.write(`# ${session.title || session.id} (${dbInfo.profile}/${session.source}, started ${isoFromEpochSeconds(session.started_at)})\n\n`);
      for (const t of turns) process.stdout.write(`## Turn ${t.idx} — ${isoFromEpochSeconds(t.timestamp)}\n${t.body}\n\n`);
      return 0;
    } finally {
      db.close();
    }
  }
  process.stderr.write(`hermes-source: session ${sessionId} not found\n`);
  return 1;
}

export async function main(argv = process.argv.slice(2)) {
  const { values } = parseArgs({
    args: argv,
    options: {
      config: { type: 'string' },
      write: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      full: { type: 'boolean', default: false },
      only: { type: 'string' },
      profile: { type: 'string' },
      session: { type: 'string' },
      show: { type: 'string' },
      'since-days': { type: 'string' },
      'print-config-path': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help) {
    process.stdout.write(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').match(/Usage:[\s\S]*?\n \*\//)[0].replace(/\n \*\/$/, '').replace(/^ \* ?/gm, '') + '\n');
    return 0;
  }

  const configPath = values.config ? path.resolve(values.config) : defaultConfigPath();
  // Lets a caller decide "is this a Hermes user" without re-deriving the path.
  if (values['print-config-path']) { process.stdout.write(`${configPath}\n`); return 0; }
  const config = loadConfig(configPath);
  if (values.show) return show(config, values.show, values.profile);

  const devRoot = path.resolve(process.env.CARTOGRAPHER_DEV_DIR || path.join(HOME, 'Documents', 'dev'));
  const stateFile = process.env.CARTOGRAPHER_HERMES_STATE || path.join(devRoot, '.carto', 'hermes-source-state.json');
  const logFile = process.env.CARTOGRAPHER_MILESTONES || path.join(devRoot, 'session-milestones.jsonl');
  const indexer = process.env.CARTOGRAPHER_INDEXER || path.join(HERE, 'index-event.sh');
  const days = values['since-days'] ? Number(values['since-days']) : 0;
  if (values['since-days'] && !(days > 0)) throw new HermesSourceError('--since-days must be a positive number');

  const state = loadState(stateFile);
  const { units, receipt } = await collect(config, {
    devRoot, state, profile: values.profile || null, sessionId: values.session || null,
    sinceEpoch: days ? Date.now() / 1000 - days * 86400 : 0, full: values.full, only: values.only || null,
  });

  if (!values.write) {
    printReceipt(receipt, null, units, values);
    return 0;
  }
  const result = write(units, { logFile, indexer, state, onCheckpoint: (st) => saveState(stateFile, st) });
  saveState(stateFile, state);
  printReceipt(receipt, result, units, values);
  return result.index_failures ? 1 : 0;
}

const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().then((code) => { process.exitCode = code; }).catch((err) => {
    process.stderr.write(`hermes-source: ${err.message}\n`);
    process.exitCode = err instanceof HermesSourceError ? err.code : 1;
  });
}
