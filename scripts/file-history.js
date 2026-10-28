/**
 * First-edit file history: what the corpus already knows about a file, said
 * once, at the moment an agent is about to change it.
 *
 * Recall is fast, but agents almost never call it mid-session: on 2026-10-15,
 * 4 of 72 prompts carrying a memory cue ("thought we fixed this?", "did that
 * criteria survive?", "we already have X") got a recall. Those prompts are
 * rework on a file whose history the agent never looked at. The pre-edit hook
 * is the one point where Cartographer knows exactly which file is about to
 * change, so a line of that file's history there costs the agent nothing to
 * read and no decision to make.
 *
 * Three sources, newest first, at most two lines in all:
 *
 * - /investigate diagnoses that name the file, open or confirmed. A refuted or
 *   abandoned hypothesis is not knowledge about the file. A backfilled record
 *   with no outcome reads "unclosed", not "open": it predates the close step,
 *   so the missing outcome says nothing about the bug. A record with a
 *   `files` list is matched on that list only; a record without one (118 of
 *   153 on 2026-10-15) is matched on a mention in its summary.
 * - The newest commit naming the file by another session within the window.
 *   When there is none, the newest edit of it by another session: commits made
 *   from a `.claude/worktrees/` session write no event at all, so an edit row is
 *   sometimes the only trace that a peer changed the file.
 * - A wrapup that names the file, when the first two leave room.
 *
 * The current session's own records are excluded: it already knows them.
 *
 * Matching is by (project, repository-relative path), not absolute path. The
 * same file is recorded from main checkouts, Claude and Codex worktrees, and
 * sessions whose cwd is a subdirectory, and commit rows carry paths relative to
 * the repository root. Comparing (project, path) needs no realpath or git call
 * per event, which matters because a common basename puts thousands of rows in
 * front of the matcher.
 *
 * A mention in prose is weaker evidence than a files list. A summary naming the
 * repository-relative path counts. A bare basename counts only when git says
 * the repository has exactly one file of that name, because `main.js` in prose
 * says nothing about which of two `main.js` files was meant. That lookup runs
 * only when a bare mention exists.
 *
 * Cost. Called on every edit when enabled, but the scan runs once per
 * (session, file): later edits cost one read of a small state file. The scan
 * is one `rg` over changelog.jsonl and session-milestones.jsonl (~40 ms on the
 * 2026-10-15 corpus, 108 MB + 12 MB, spawn included). Without rg it falls back
 * to a chunked in-process scan (~110 ms), not grep: BSD grep took ~1,500 ms on
 * the same files, ten times the budget. Turbo was considered and not used: no
 * existing facts verb answers a per-file question, the hook needs the scan
 * path anyway because Turbo is opt-in, and a new verb would not be served
 * until a release restarts the managed server.
 *
 * Writes. Never to the five searched logs. Evaluations go to a trial log in
 * $CARTOGRAPHER_DEV_DIR so the note can be judged on whether it fires and is
 * used; per-session state goes to the OS temp directory beside the collision
 * check's.
 *
 * Env:
 *   CARTOGRAPHER_FILE_HISTORY_ON_EDIT=1   enable (default off)
 *   CARTOGRAPHER_FILE_HISTORY_DAYS=14     commit/edit/wrapup window in days
 */

import { spawnSync, execFileSync } from 'child_process';
import {
  existsSync, readFileSync, writeFileSync, mkdirSync, statSync, openSync, readSync,
  closeSync, fstatSync, readdirSync, unlinkSync, appendFileSync,
} from 'fs';
import { join, basename, dirname, isAbsolute, resolve as resolvePath } from 'path';
import { homedir, tmpdir } from 'os';
import { COMMIT_RE, contentionKey } from './contention.js';
import { editSummaryPaths } from './edit-paths.js';
import { isResolved } from './sentinels.js';

const DAY = 86400e3;
const DEFAULT_DAYS = 14;
const SCAN_TIMEOUT_MS = 1500;     // the hook's own timeout is 3 s; the collision note must survive
const STATE_MAX_KEYS = 512;       // a session that edits more distinct files than this repeats a few notes
const STATE_MAX_AGE_MS = 7 * DAY; // stale state files are pruned when a new session writes its first
const MARKERS = ['"type":"investigation', '"type":"git_commit"', '"type":"tool_file_edit"', '"milestone":"session_wrapup"'];
const OUTCOME_NEEDLE = '"type":"investigation_outcome"';
const KEPT_OUTCOMES = new Set(['open', 'confirmed']);
const PATH_CHAR = /[\w./-]/;

export function windowDays(env = process.env) {
  const n = Number(env.CARTOGRAPHER_FILE_HISTORY_DAYS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_DAYS;
}

// ─── Which file is this ────────────────────────────────────────────────────

/**
 * Project and repository-relative path for a contention key.
 *
 * Walks up to the nearest `.git`. A `.git` directory names the project by its
 * parent, as cartographer_project() does from the common dir. A `.git` file is
 * a linked worktree, whose project is the main checkout it points back to.
 * Claude worktrees never reach here as such: contentionKey has already
 * collapsed them onto the main checkout. No repository means no project.
 */
export function fileIdentity(key) {
  let dir = dirname(key);
  for (;;) {
    const dotGit = join(dir, '.git');
    let st = null;
    try { st = statSync(dotGit); } catch { st = null; }
    if (st) {
      let project = basename(dir);
      if (st.isFile()) {
        try {
          const gitdir = (readFileSync(dotGit, 'utf-8').match(/^gitdir:\s*(.+)$/m) || [])[1]?.trim() || '';
          const at = gitdir.indexOf('/.git/worktrees/');
          if (at > 0) project = basename(gitdir.slice(0, at));
        } catch { /* keep the worktree's own name */ }
      }
      return { key, root: dir, project: isResolved(project) ? project : null, rel: key.slice(dir.length + 1) };
    }
    const up = dirname(dir);
    if (up === dir) return { key, root: null, project: null, rel: null };
    dir = up;
  }
}

/** Collapse worktree segments the way contentionKey does, without realpath or git. */
function collapse(p) {
  return p.replace(/\/\.claude\/worktrees\/[^/]+(?=\/)/, '').replace(/\/\.codex\/worktrees\/[^/]+(?=\/)/, '');
}

/**
 * Does `candidate`, a path written in event `e`, name the file `id`?
 *
 * The event's own project must agree for a bare relative path: `js/app.js`
 * means nothing without its repository. An absolute or cwd-resolved path
 * matches when it ends at `<project>/<rel>`, which holds across checkouts,
 * worktrees and macOS's /private alias alike.
 */
export function namesFile(candidate, e, id) {
  if (typeof candidate !== 'string') return false;
  let value = candidate.trim();
  if (/^(["'`]).*\1$/.test(value)) value = value.slice(1, -1);
  if (!value || value.includes('\0')) return false;
  if (!id.project) {
    const abs = isAbsolute(value) ? value : (typeof e.cwd === 'string' && isAbsolute(e.cwd) ? resolvePath(e.cwd, value) : null);
    return !!abs && collapse(abs) === id.key;
  }
  if (value === id.rel) return isResolved(e.project) && e.project === id.project;
  const tail = `/${id.project}/${id.rel}`;
  if (`/${value}`.endsWith(tail)) return true;
  const abs = isAbsolute(value) ? value : (typeof e.cwd === 'string' && isAbsolute(e.cwd) ? resolvePath(e.cwd, value) : null);
  return !!abs && collapse(abs).endsWith(tail);
}

/**
 * Where, if anywhere, prose names the file: the repository-relative path, or a
 * bare basename the repository holds only once. Returns the index or -1.
 */
export function mentionIndex(text, id, uniqueBasename) {
  if (!text || !id.rel) return -1;
  const name = basename(id.rel);
  // A root file's path is its bare name, so it gets the bare-name rule.
  if (name !== id.rel) {
    const at = boundedIndex(text, id.rel);
    if (at >= 0) return at;
  }
  const bare = boundedIndex(text, name);
  return bare >= 0 && uniqueBasename(name) ? bare : -1;
}

function boundedIndex(text, needle) {
  let i = text.indexOf(needle);
  while (i !== -1) {
    const before = i > 0 ? text[i - 1] : '';
    const after = text[i + needle.length] || '';
    // A trailing '.' ends a sentence; anything else path-shaped extends the name.
    if (!(before && PATH_CHAR.test(before)) && !(after && after !== '.' && PATH_CHAR.test(after))) return i;
    i = text.indexOf(needle, i + 1);
  }
  return -1;
}

/** One git call per repository and name, only when a bare mention needs it. */
function basenameCounter(root) {
  const seen = new Map();
  return (name) => {
    if (!root) return false;
    if (!seen.has(name)) {
      let count = 0;
      try {
        const out = execFileSync('git', ['-C', root, 'ls-files', '-z', '--', name, `*/${name}`], {
          encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 1000, maxBuffer: 4 << 20,
        });
        count = out.split('\0').filter((p) => p && basename(p) === name).length;
      } catch { count = 0; }
      seen.set(name, count);
    }
    return seen.get(name) === 1;
  };
}

// ─── Once per (session, file) ──────────────────────────────────────────────

function stateFile(selfId, dir) {
  return join(dir, `file-history-${String(selfId).replace(/[^A-Za-z0-9_-]/g, '_')}.json`);
}

/**
 * Keys this session has not had evaluated yet, marking them evaluated.
 *
 * Marked before the scan runs, so a scan that fails or times out is not
 * retried on every later edit of the same file.
 */
export function claimFirstEdits(selfId, keys, dir = join(tmpdir(), 'session-cartographer')) {
  const file = stateFile(selfId, dir);
  let seen = null;
  try { seen = JSON.parse(readFileSync(file, 'utf-8')); } catch { seen = null; }
  const fresh = !seen || typeof seen !== 'object';
  if (fresh) seen = {};
  const unseen = keys.filter((k) => !(k in seen));
  if (!unseen.length) return [];
  const now = Date.now();
  for (const k of unseen) seen[k] = now;
  const all = Object.keys(seen);
  for (const k of all.slice(0, Math.max(0, all.length - STATE_MAX_KEYS))) delete seen[k];
  try {
    mkdirSync(dir, { recursive: true });
    if (fresh) pruneState(dir, now);
    writeFileSync(file, JSON.stringify(seen));
  } catch { /* a repeated note is tolerable; a blocked edit is not */ }
  return unseen;
}

function pruneState(dir, now) {
  try {
    for (const name of readdirSync(dir)) {
      if (!name.startsWith('file-history-') || !name.endsWith('.json')) continue;
      const p = join(dir, name);
      try { if (now - statSync(p).mtimeMs > STATE_MAX_AGE_MS) unlinkSync(p); } catch { /* raced */ }
    }
  } catch { /* nothing to prune */ }
}

// ─── The scan ──────────────────────────────────────────────────────────────

/**
 * Lines of `files` containing any needle. rg when present; otherwise an
 * in-process chunked scan. Returns { lines, via } or { lines: [], via, error }.
 */
export function scanLogs(files, needles, { timeoutMs = SCAN_TIMEOUT_MS, rg = process.env.CARTOGRAPHER_RG || 'rg' } = {}) {
  const present = files.filter((f) => existsSync(f));
  if (!present.length || !needles.length) return { lines: [], via: 'none' };
  if (rg !== 'none') {
    const args = ['--no-config', '-a', '-F', '--no-filename', '--no-line-number'];
    for (const n of needles) args.push('-e', n);
    args.push('--', ...present);
    const r = spawnSync(rg, args, { encoding: 'utf-8', timeout: timeoutMs, maxBuffer: 256 << 20, stdio: ['ignore', 'pipe', 'ignore'] });
    if (!r.error && (r.status === 0 || r.status === 1)) return { lines: r.stdout ? r.stdout.split('\n') : [], via: 'rg' };
    if (r.error?.code === 'ETIMEDOUT' || r.signal) return { lines: [], via: 'rg', error: 'timeout' };
    if (r.error?.code !== 'ENOENT') return { lines: [], via: 'rg', error: 'scan_failed' };
  }
  return scanInProcess(present, needles, timeoutMs);
}

function scanInProcess(files, needles, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const pats = needles.map((n) => Buffer.from(n));
  const lines = [];
  const CHUNK = 8 << 20;
  for (const file of files) {
    let fd;
    try { fd = openSync(file, 'r'); } catch { continue; }
    try {
      const size = fstatSync(fd).size;
      const buf = Buffer.allocUnsafe(CHUNK);
      let carry = Buffer.alloc(0);
      for (let pos = 0; pos < size;) {
        if (Date.now() > deadline) return { lines: [], via: 'node', error: 'timeout' };
        const n = readSync(fd, buf, 0, CHUNK, pos);
        if (n <= 0) break;
        pos += n;
        let block = carry.length ? Buffer.concat([carry, buf.subarray(0, n)]) : buf.subarray(0, n);
        if (pos < size) {
          const nl = block.lastIndexOf(10);
          carry = Buffer.from(block.subarray(nl + 1));
          block = block.subarray(0, nl + 1);
        } else carry = Buffer.alloc(0);
        const starts = new Set();
        for (const p of pats) {
          for (let i = block.indexOf(p); i !== -1;) {
            const s = block.lastIndexOf(10, i) + 1;
            let end = block.indexOf(10, i);
            if (end === -1) end = block.length;
            if (!starts.has(s)) { starts.add(s); lines.push(block.toString('utf-8', s, end)); }
            i = block.indexOf(p, end);
          }
        }
      }
    } finally { closeSync(fd); }
  }
  return { lines, via: 'node' };
}

// ─── What the lines say about each file ────────────────────────────────────

function eventTime(e) {
  const t = Date.parse(e?.timestamp);
  return Number.isFinite(t) ? t : null;
}

function jsonList(v) {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v !== 'string' || !v.trim()) return [];
  try { const parsed = JSON.parse(v); if (Array.isArray(parsed)) return parsed.map(String); } catch { /* prose */ }
  return [v];
}

const WRAPUP_FIELDS = [['unresolved', 'unresolved'], ['decisions', 'decision'], ['key_insight', 'insight'], ['description', 'summary']];
// Confirmed and open diagnoses outrank backfilled ones whose status is unknown.
const LABEL_RANK = { confirmed: 0, open: 0, unclosed: 1 };

/**
 * History for each identity, from scanned lines. Pure over its inputs.
 *
 * `uniqueBasename(id, name)` says whether id's repository holds one file of
 * that name. Returns Map(key → { investigations, commit, edit, wrapup }).
 */
export function collectHistory({ lines, ids, selfId, now, windowMs, uniqueBasename = () => false }) {
  const uniq = new Map(ids.map((id) => [id.key, (name) => uniqueBasename(id, name)]));
  const outcomes = new Map();
  const events = [];
  for (const line of lines) {
    if (!line) continue;
    if (line.includes(OUTCOME_NEEDLE)) {
      let e; try { e = JSON.parse(line); } catch { continue; }
      if (e.type !== 'investigation_outcome' || !e.resolves) continue;
      const t = eventTime(e) ?? 0;
      const prev = outcomes.get(e.resolves);
      if (!prev || prev.t <= t) outcomes.set(e.resolves, { outcome: e.outcome, t, event_id: e.event_id });
      continue;
    }
    if (!MARKERS.some((m) => line.includes(m))) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    events.push(e);
  }

  const out = new Map(ids.map((id) => [id.key, { investigations: [], commit: null, edit: null, wrapup: null }]));
  const peer = (e) => isResolved(e.session_id) && e.session_id !== selfId;
  const recent = (t) => t !== null && t >= now - windowMs && t <= now + 60e3;
  const self = (e) => isResolved(e.session_id) && e.session_id === selfId;

  for (const e of events) {
    const t = eventTime(e);
    for (const id of ids) {
      const h = out.get(id.key);
      if (e.type === 'investigation') {
        if (self(e)) continue;
        const named = Array.isArray(e.files) || typeof e.files === 'string'
          ? jsonList(e.files).flatMap((f) => f.split(',')).some((f) => namesFile(f, e, id))
          : isResolved(e.project) && e.project === id.project && mentionIndex(e.summary, id, uniq.get(id.key)) >= 0;
        if (!named) continue;
        const outcome = outcomes.get(e.event_id);
        const status = outcome ? String(outcome.outcome || '') : 'open';
        if (!KEPT_OUTCOMES.has(status)) continue;
        // The 64 backfilled diagnoses predate the close step, so "no outcome"
        // there says nothing about whether the bug is live.
        const label = status === 'open' && e.backfilled_by ? 'unclosed' : status;
        h.investigations.push({ event_id: e.event_id, t, status, label, outcome_id: outcome?.event_id || null,
          symptom: String(e.symptom || e.summary || '').replace(/^Investigated:\s*/, '') });
      } else if (e.type === 'git_commit') {
        if (!peer(e) || !recent(t)) continue;
        const m = String(e.summary || '').match(COMMIT_RE);
        const listed = m?.[3] || (typeof e.files_changed === 'string' ? e.files_changed : '');
        if (!m || !listed) continue;
        if (!listed.split(',').some((f) => namesFile(f, e, id))) continue;
        if (h.commit && h.commit.t >= t) continue;
        h.commit = { event_id: e.event_id, t, sha: m[1], subject: m[2].trim(), session: e.session_id,
          provider: isResolved(e.provider) ? e.provider : '?' };
      } else if (e.type === 'tool_file_edit') {
        if (!peer(e) || !recent(t)) continue;
        // The resolver is the risk: this only asks whether a candidate is the
        // one file being edited, so the target itself is the only resolver
        // needed, and the hook's loose candidates (`errors.push`) never match.
        if (!editSummaryPaths(e.summary, (v) => namesFile(v, e, id)).some((f) => namesFile(f, e, id))) continue;
        if (h.edit && h.edit.t >= t) continue;
        h.edit = { event_id: e.event_id, t, session: e.session_id, provider: isResolved(e.provider) ? e.provider : '?' };
      } else if (e.milestone === 'session_wrapup') {
        if (!peer(e) || !recent(t)) continue;
        if (!(isResolved(e.project) && e.project === id.project)) continue;
        if (h.wrapup && h.wrapup.t >= t) continue;
        for (const [field, label] of WRAPUP_FIELDS) {
          let at = -1;
          const hit = jsonList(e[field]).find((s) => (at = mentionIndex(s, id, uniq.get(id.key))) >= 0);
          if (hit) { h.wrapup = { event_id: e.event_id, t, label, text: hit, at }; break; }
        }
      }
    }
  }
  for (const h of out.values()) {
    h.investigations.sort((a, b) => (LABEL_RANK[a.label] - LABEL_RANK[b.label]) || ((b.t ?? 0) - (a.t ?? 0)));
  }
  return out;
}

// ─── The note ──────────────────────────────────────────────────────────────

export function fmtAgo(ms) {
  if (!Number.isFinite(ms) || ms < 0) return 'recently';
  if (ms < 3600e3) return `${Math.max(1, Math.round(ms / 60e3))}m ago`;
  if (ms < 2 * DAY) return `${Math.round(ms / 3600e3)}h ago`;
  return `${Math.round(ms / DAY)}d ago`;
}

function clip(s, n) {
  const flat = String(s || '').replace(/\s+/g, ' ').trim();
  return flat.length > n ? `${flat.slice(0, n - 1).trimEnd()}…` : flat;
}

/** A window of `s` that shows the mention at `at`, which may sit deep in a long field. */
function excerpt(s, at, n) {
  const text = String(s || '');
  if (!(at > n / 3)) return clip(text, n);
  return `…${clip(text.slice(Math.max(0, at - 40)).replace(/^\S*\s/, ''), n - 1)}`;
}

// An event id worth printing. Rows written before ids were stamped carry none,
// and a line reading "(undefined)" sends the agent to `--get undefined`.
const idOf = (e) => (isResolved(e?.event_id) ? e.event_id : null);
const paren = (id) => (id ? ` (${id})` : '');

/**
 * At most `max` lines across all targets: diagnoses first, then the commit
 * (or the edit standing in for one), then a wrapup if room remains.
 * `skipShas` drops a commit the collision note on the same edit already names.
 */
export function noteLines(history, ids, now, { max = 2, skipShas = [] } = {}) {
  const lines = [];
  const cited = [];
  const shown = new Map(ids.map((id) => [id.key, []]));
  for (const id of ids) {
    const h = history.get(id.key);
    if (!h) continue;
    const name = id.rel || id.key.replace(homedir(), '~');
    let named = false;
    const items = [];
    const [inv, ...more] = h.investigations;
    if (inv) {
      const moreIds = more.map(idOf).filter(Boolean);
      const listed = moreIds.length ? `: ${moreIds.slice(0, 2).join(', ')}${moreIds.length > 2 ? ', …' : ''}` : '';
      const extra = more.length ? ` (+${more.length} more${listed})` : '';
      items.push({ id: idOf(inv), text: `${inv.label} diagnosis ${fmtAgo(now - inv.t)}${paren(idOf(inv))}: ${clip(inv.symptom, 120)}${extra}` });
    }
    const commit = h.commit && !skipShas.some((s) => s && h.commit.sha.startsWith(s.slice(0, 7))) ? h.commit : null;
    if (commit) {
      // The event id fetches the session, provider and transcript; the line
      // only has to say what changed and when.
      items.push({ id: idOf(commit), text: `last commit by another session ${commit.sha.slice(0, 8)} ${fmtAgo(now - commit.t)}` +
        `${paren(idOf(commit))}: "${clip(commit.subject, 90)}"` });
    } else if (h.edit && !h.commit) {
      const eid = idOf(h.edit);
      items.push({ id: eid, text: `edited ${fmtAgo(now - h.edit.t)} by another session with no logged commit ` +
        `(${h.edit.provider} ${h.edit.session.slice(0, 8)}${eid ? `, ${eid}` : ''})` });
    }
    if (h.wrapup) {
      items.push({ id: idOf(h.wrapup), text: `wrapup ${fmtAgo(now - h.wrapup.t)}${paren(idOf(h.wrapup))}, ${h.wrapup.label}: ${excerpt(h.wrapup.text, h.wrapup.at, 120)}` });
    }
    for (const it of items) {
      if (lines.length >= max) break;
      // The path once per file; its second line needs only the name.
      lines.push(`[carto history] ${named ? basename(name) : name}: ${it.text}`);
      named = true;
      if (it.id) cited.push(it.id);
      // Counted for the trial log's `fired`, so a line with no id still counts.
      shown.get(id.key).push(it.id);
    }
    if (lines.length >= max) break;
  }
  // Point at --get only when a line gave an id to fetch.
  if (cited.length) lines[lines.length - 1] += ' · /remember --get <id> for any record.';
  return { lines, cited, shown };
}

// ─── Hook entry ────────────────────────────────────────────────────────────

function providerOf(input) {
  const tp = String(input?.transcript_path || '');
  if (tp.includes('/.codex/')) return 'codex';
  if (tp.includes('/.claude/')) return 'claude';
  return input?.turn_id || input?.model ? 'codex' : null;
}

/**
 * The history note for an edit, or null. Never throws past its caller's
 * try; never writes outside the trial log and the state file.
 */
export function fileHistoryNote({ input, targets, selfId, dev, now = Date.now(), env = process.env, skipShas = [], stateDir }) {
  if (!isResolved(selfId) || !targets.length) return null;
  const keys = [...new Set(targets.map((t) => contentionKey(t)))];
  const unseen = claimFirstEdits(selfId, keys, stateDir);
  if (!unseen.length) return null;

  const started = performance.now();
  const ids = unseen.map(fileIdentity);
  const inRepo = ids.filter((id) => id.project);
  let via = 'none';
  let history = new Map();
  let note = { lines: [], cited: [], shown: new Map() };
  let scanError = null;
  if (inRepo.length) {
    const needles = [...new Set(inRepo.map((id) => basename(id.rel)))].concat(OUTCOME_NEEDLE);
    const scan = scanLogs([join(dev, 'changelog.jsonl'), join(dev, 'session-milestones.jsonl')], needles, { rg: env.CARTOGRAPHER_RG || 'rg' });
    via = scan.via;
    if (scan.error) {
      scanError = scan.error;
    } else {
      const counters = new Map();
      const uniqueBasename = (id, name) => {
        if (!counters.has(id.root)) counters.set(id.root, basenameCounter(id.root));
        return counters.get(id.root)(name);
      };
      history = collectHistory({ lines: scan.lines, ids: inRepo, selfId, now, windowMs: windowDays(env) * DAY, uniqueBasename });
      note = noteLines(history, inRepo, now, { skipShas });
    }
  }
  const latency = Math.round((performance.now() - started) * 10) / 10;

  try {
    const provider = env.CARTOGRAPHER_PROVIDER || providerOf(input);
    const rows = ids.map((id) => {
      const h = history.get(id.key);
      const shown = note.shown.get(id.key) || [];
      const found = !!h && (h.investigations.length > 0 || !!h.commit || !!h.edit || !!h.wrapup);
      // `suppressed`: history existed but the line cap, or a collision note
      // already naming the commit, left it out.
      const reason = !id.project ? 'no_repo' : scanError || (shown.length ? 'fired' : found ? 'suppressed' : 'no_history');
      return JSON.stringify({
        timestamp: new Date(now).toISOString(),
        session: selfId,
        provider: isResolved(provider) ? provider : null,
        project: id.project,
        file: id.rel || id.key,
        fired: shown.length > 0,
        reason,
        latency_ms: latency,
        scan: via,
        investigations: h ? h.investigations.length : 0,
        commit: h?.commit?.event_id || null,
        edit: h?.commit ? null : (h?.edit?.event_id || null),
        wrapup: h?.wrapup?.event_id || null,
        shown,
      });
    });
    appendFileSync(join(dev, 'file-history-on-edit-trial.jsonl'), `${rows.join('\n')}\n`);
  } catch { /* telemetry never blocks the note */ }

  return note.lines.length ? note.lines.join('\n') : null;
}
