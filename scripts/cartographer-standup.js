#!/usr/bin/env node
/**
 * Peer-session standup: what else is running, and what is it about to hit.
 *
 * `/remember --project` answers "what has happened in this PROJECT"; this answers "who ELSE
 * is in it with me right now". Those are different questions because many users run
 * several concurrent sessions and the corpus is already session-attributed — every
 * changelog event carries session_id, cwd, project and a summary that names the
 * file or the commit. Nothing new has to be captured; the grouping just has
 * never been exposed outside the Explorer's ConcurrentTimeline, which requires
 * opening a web UI mid-task.
 *
 * The load-bearing section is CONTENTION, not the roster. A roster tells you
 * five sessions are awake, which is ambient and ignorable. Contention tells you
 * another session edited the exact file you have open, which is the thing that
 * silently costs an hour. Project-level overlap is the weak signal (two sessions
 * in one repo is normal); file-level overlap is the strong one.
 *
 * Read-only. Never writes to the changelog or to retrieval telemetry.
 */
import { realpathSync, existsSync } from 'fs';
import { execFileSync } from 'child_process';
import { join, dirname, resolve as resolvePath, relative } from 'path';
import { homedir } from 'os';
import { isNonProject, nonProjectNames } from './non-projects.js';
import { HOUR, fmtAge, readTail, COMMIT_RE, eventFiles, contentionKey, unmappedWorktrees } from './contention.js';
import { isResolved } from './sentinels.js';

function parseSince(s) {
  const m = String(s).match(/^(\d+(?:\.\d+)?)\s*([mhd])$/i);
  if (!m) return 6 * HOUR;
  const n = parseFloat(m[1]);
  return n * { m: 60e3, h: HOUR, d: 24 * HOUR }[m[2].toLowerCase()];
}

/**
 * Does a contention key belong to `project`?
 *
 * Hooks name a project after its repository root (`basename` of
 * `git rev-parse --show-toplevel`), so the answer is the nearest ancestor that
 * holds `.git`. Matching any path segment instead pulled
 * `widget-web/apps/electron/x.js` into a `--project electron` view.
 * The walk stops below the corpus root, so a workspace that is itself a repo
 * does not claim every loose file; a file in no repository falls back to its
 * first directory under the corpus root. Keys are worktree-collapsed already,
 * and lookups are cached per directory — a stat per ancestor, no git calls.
 */
const repoRootCache = new Map();
let devRootReal = null;
function repoRootOf(filePath, stopAt) {
  const visited = [];
  let root = null;
  for (let dir = dirname(filePath); dir !== stopAt && dir !== dirname(dir); dir = dirname(dir)) {
    if (repoRootCache.has(dir)) { root = repoRootCache.get(dir); break; }
    visited.push(dir);
    if (existsSync(join(dir, '.git'))) { root = dir; break; }
  }
  for (const dir of visited) repoRootCache.set(dir, root);
  return root;
}

function fileInProject(filePath, project) {
  if (devRootReal === null) {
    try { devRootReal = realpathSync(dev); } catch { devRootReal = resolvePath(dev); }
  }
  const root = repoRootOf(filePath, devRootReal);
  if (root) return root.split('/').pop() === project;
  if (!filePath.startsWith(`${devRootReal}/`)) return false;
  return filePath.slice(devRootReal.length + 1).split('/')[0] === project;
}

function parseCommit(e) {
  const m = (e.summary || '').match(COMMIT_RE);
  if (!m) return null;
  const type = (e.summary.match(/^\[([a-z]+)\]/) || [])[1] || 'other';
  return { sha: m[1], subject: m[2].trim(), files: m[3] ? m[3].split(',').map((f) => f.trim()) : [], type };
}

/**
 * Recover a commit subject from git when the corpus has none.
 *
 * `git commit -q` suppresses the stdout the hook scrapes the subject from, so a
 * meaningful share of git_commit events carry an empty subject and a commit
 * roster reads as a column of shrugs. The sha is always captured, so ask the
 * repo. Best-effort by construction: the checkout may be gone, the sha may have
 * been rebased away, and either way an unlabelled sha beats a failed command.
 */
function gitSubject(sha, cwd) {
  if (!sha || !cwd || !existsSync(cwd)) return '';
  try {
    return execFileSync('git', ['-C', cwd, 'log', '-1', '--format=%s', sha], {
      encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000,
    }).trim();
  } catch { return ''; }
}

// ---- args -------------------------------------------------------------
const argv = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt;
};
const flag = (name) => argv.includes(`--${name}`);

const windowMs = parseSince(opt('since', '6h'));
const projectFilter = opt('project', null);
const commitQuery = opt('commit', null);
const asJson = flag('json');
const includeSelf = flag('all');
const liveMs = parseSince(opt('live', '20m'));

const dev = process.env.CARTOGRAPHER_DEV_DIR || join(homedir(), 'Documents/dev');
const changelog = join(dev, 'changelog.jsonl');
if (!existsSync(changelog)) {
  console.error(`standup: no changelog at ${changelog} (set CARTOGRAPHER_DEV_DIR)`);
  process.exit(2);
}

const now = Date.now();
const all = readTail(changelog, windowMs);
const events = all.filter((e) => {
  const t = Date.parse(e.timestamp);
  return Number.isFinite(t) && t >= now - windowMs && t <= now;
});

// ---- commit attribution (--commit) ------------------------------------
if (commitQuery) {
  const q = commitQuery.replace(/^#/, '').toLowerCase();
  const hits = events.filter((e) => e.type === 'git_commit' && (e.summary || '').toLowerCase().includes(q));
  if (!hits.length) {
    console.log(`No commit matching "${commitQuery}" in the last ${opt('since', '6h')} of the event log.`);
    console.log('Widen with --since 3d, or the commit predates hook coverage.');
    process.exit(0);
  }
  for (const e of hits) {
    const c = parseCommit(e) || {};
    const subj = c.subject || gitSubject(c.sha, e.cwd);
    console.log(`${c.sha || '?'}  ${subj || e.summary}`);
    // A row recovered by backfill-git-history.sh has no session — git history
    // does not carry one. Say that rather than printing `undefined`, which
    // reads as a lookup failure instead of an honest absence.
    const attributed = isResolved(e.session_id);
    console.log(attributed
      ? `  session  ${e.session_id} (${e.provider})`
      : '  session  not recorded — backfilled from git history, not observed live');
    console.log(`  project  ${e.project}   ${e.timestamp}  (${fmtAge(now - Date.parse(e.timestamp))} ago)`);
    if (c.files?.length) console.log(`  files    ${c.files.join(', ')}`);
    // Neighbouring work from the same session frames the commit: a lone commit
    // and one inside a 40-commit sweep call for different reactions from you.
    // Only meaningful when the session is real — matching undefined against
    // undefined would gather every unattributed commit into one phantom.
    if (attributed) {
      const sib = events.filter((x) => x.session_id === e.session_id && x.type === 'git_commit');
      if (sib.length > 1) console.log(`  context  ${sib.length} commits from this session in window`);
    }
    console.log();
  }
  process.exit(0);
}

// ---- roster -----------------------------------------------------------
// Self-identification, in order of trustworthiness. The env chain is what the
// rest of the CLI already uses; CLAUDE_SESSION_ID is legacy and never actually
// set, so it usually falls through. The heuristic behind it works because the
// tool-use hook logs THIS invocation before the script runs — but it is only
// sound while the newest event is genuinely fresh, or a quiet session would
// claim a stranger's id.
const envSelf = [
  process.env.CARTOGRAPHER_SESSION_ID,
  process.env.CLAUDE_SESSION_ID,
  process.env.CLAUDE_CODE_SESSION_ID,
  process.env.CODEX_SESSION_ID,
].find((v) => v && isResolved(v));
const newest = events[events.length - 1];
const selfId = opt('me', null) || envSelf
  || (newest && now - Date.parse(newest.timestamp) < 120e3 ? newest.session_id : null);

const sessions = new Map();
// Events whose session is a sentinel are counted, never grouped. `"unknown"` is
// truthy and equal to itself, so a bare `if (!id)` lets it key the map and every
// unattributed event in the window fuses into one phantom session that then
// appears to collide with everybody — including across providers.
let unattributed = 0;
for (const e of events) {
  const id = e.session_id;
  if (!isResolved(id)) { unattributed++; continue; }
  if (!sessions.has(id)) {
    sessions.set(id, {
      id, provider: e.provider || '?', first: Infinity, last: -Infinity,
      n: 0, projects: new Map(), types: new Map(), commits: [], pushes: 0, files: new Map(),
      unresolvedEdits: 0,
    });
  }
  const s = sessions.get(id);
  const t = Date.parse(e.timestamp);
  s.n++;
  s.first = Math.min(s.first, t);
  s.last = Math.max(s.last, t);
  if (e.project) s.projects.set(e.project, (s.projects.get(e.project) || 0) + 1);
  s.types.set(e.type, (s.types.get(e.type) || 0) + 1);
  if (e.type === 'git_commit') { const c = parseCommit(e); if (c) s.commits.push({ ...c, t, project: e.project, cwd: e.cwd }); }
  if (e.type === 'git_push') s.pushes++;
  const touched = eventFiles(e);
  s.unresolvedEdits += touched.unresolved;
  for (const f of touched.files) {
    // Key on the canonical absolute path so the same file reached from two cwds
    // — or from a worktree and its parent repo — is one entry, which is the
    // whole point of the contention section.
    const key = contentionKey(f);
    const prev = s.files.get(key);
    if (prev && prev.t >= t) continue;
    s.files.set(key, { t, project: e.project, cwd: e.cwd, path: f });
  }
}

let roster = [...sessions.values()].sort((a, b) => b.last - a.last);
if (projectFilter) roster = roster.filter((s) => s.projects.has(projectFilter)
  || [...s.files.keys()].some((file) => fileInProject(file, projectFilter)));

const mine = roster.find((s) => s.id === selfId);
const peers = roster.filter((s) => s.id !== selfId || includeSelf);

// ---- contention -------------------------------------------------------
// Project overlap is the weak signal, file overlap the strong one. Both are
// computed over peers-plus-self, because a collision with your own session is
// still a collision you need to know about.
// `project` is a cwd basename, so the workspace root and throwaway worktrees
// land in it. Five sessions "sharing" `dev` is the filesystem, not a collision;
// non-projects.js is the single definition of that and re-spelling it here
// would be the fourth divergent copy.
const NON_PROJECTS = nonProjectNames(process.env, dev);
const byProject = new Map();
for (const s of roster) for (const p of (projectFilter ? [projectFilter] : s.projects.keys())) {
  if (isNonProject(p, NON_PROJECTS)) continue;
  if (projectFilter && p !== projectFilter) continue;
  if (!byProject.has(p)) byProject.set(p, []);
  byProject.get(p).push(s);
}
const contestedProjects = [...byProject.entries()].filter(([, ss]) => ss.length > 1);

// A file's identity is its path, so `isNonProject` has no business here: it
// judges cwd-derived *project labels*, and applying it to files silently hid
// every collision between sessions running from the workspace root — the most
// common way two of these sessions overlap. Only `--project`, which the header
// advertises as a scope, narrows this list.
const byFile = new Map();
for (const s of roster) for (const [key, meta] of s.files) {
  if (projectFilter && meta.project !== projectFilter && !fileInProject(key, projectFilter)) continue;
  if (!byFile.has(key)) byFile.set(key, []);
  byFile.get(key).push({ s, t: meta.t, cwd: meta.cwd, path: meta.path });
}
const contestedFiles = [...byFile.entries()]
  .filter(([, hits]) => new Set(hits.map((h) => h.s.id)).size > 1)
  .sort((a, b) => Math.max(...b[1].map((h) => h.t)) - Math.max(...a[1].map((h) => h.t)));

if (asJson) {
  console.log(JSON.stringify({
    window: opt('since', '6h'), generated: new Date(now).toISOString(), self: selfId,
    unattributed_events: unattributed,
    edits_unresolved: roster.reduce((n, s) => n + s.unresolvedEdits, 0),
    worktrees_unmapped: unmappedWorktrees.size,
    sessions: roster.map((s) => ({
      id: s.id, provider: s.provider, is_self: s.id === selfId,
      last_active: new Date(s.last).toISOString(), idle_ms: now - s.last,
      span_ms: s.last - s.first, events: s.n,
      projects: Object.fromEntries(s.projects), types: Object.fromEntries(s.types),
      edits_unresolved: s.unresolvedEdits,
      commits: s.commits.map((c) => ({ sha: c.sha, subject: c.subject, type: c.type, project: c.project })),
      pushes: s.pushes,
    })),
    contention: {
      projects: contestedProjects.map(([p, ss]) => ({ project: p, sessions: ss.map((s) => s.id) })),
      files: contestedFiles.map(([key, hits]) => ({
        path: key,
        paths: [...new Set(hits.map((h) => h.path))],
        worktree_split: new Set(hits.map((h) => h.path)).size > 1,
        sessions: [...new Set(hits.map((h) => h.s.id))],
      })),
    },
  }, null, 2));
  process.exit(0);
}

// ---- render -----------------------------------------------------------
const short = (id) => {
  let length = 8;
  while (length < id.length && roster.some((s) => s.id !== id && s.id.slice(0, length) === id.slice(0, length))) length++;
  return id.slice(0, length);
};
const out = [];
out.push(`STANDUP — last ${opt('since', '6h')}${projectFilter ? ` · ${projectFilter}` : ''}   ${roster.length} session${roster.length === 1 ? '' : 's'}`);
if (mine) out.push(`you are ${short(mine.id)} · ${[...mine.projects.keys()].join(', ')}`);
out.push('');

if (!peers.length) {
  out.push('No other logged sessions in this window' + (projectFilter ? ' for this project.' : '.'));
} else {
  for (const s of peers) {
    const idle = now - s.last;
    const mark = idle <= liveMs ? '●' : '○';
    const self = s.id === selfId ? ' (you)' : '';
    const projs = [...s.projects.entries()].sort((a, b) => b[1] - a[1]).map(([p]) => p);
    if (projectFilter && !s.projects.has(projectFilter)) projs.unshift(`${projectFilter} (file)`);
    out.push(`${mark} ${short(s.id)}${self}  ${s.provider.padEnd(6)} ${projs.join(' + ')}`);
    out.push(`    ${fmtAge(idle)} idle · ${fmtAge(s.last - s.first)} span · ${s.n} events` +
      (s.commits.length ? ` · ${s.commits.length} commit${s.commits.length === 1 ? '' : 's'}` : '') +
      (s.pushes ? ` · ${s.pushes} push` : ''));
    for (const c of s.commits.slice(-3).reverse()) {
      const subj = c.subject || gitSubject(c.sha, c.cwd);
      out.push(`    ${c.sha.slice(0, 8)}  ${subj || '(subject not captured — git commit -q?)'}`.slice(0, 110));
    }
    out.push('');
  }
}

if (contestedFiles.length || contestedProjects.length) {
  out.push('CONTENTION');
  for (const [p, ss] of contestedProjects) {
    out.push(`  ${p} — ${ss.length} sessions: ${ss.map((s) => short(s.id) + (s.id === selfId ? '*' : '')).join(', ')}`);
  }
  if (contestedFiles.length) {
    if (contestedProjects.length) out.push('');
    out.push(`  Same file, different sessions (${contestedFiles.length}):`);
    for (const [f, hits] of contestedFiles.slice(0, 12)) {
      const ids = [...new Set(hits.map((h) => h.s.id))];
      const base = hits.find((h) => h.cwd)?.cwd;
      const shown = base && f.startsWith(base) ? relative(base, f) : f.replace(homedir(), '~');
      const split = new Set(hits.map((h) => h.path)).size > 1;
      out.push(`    ${shown}${split ? '   [same file, separate worktrees]' : ''}`);
      out.push(`      ${ids.map((i) => short(i) + (i === selfId ? '*' : '')).join(' · ')}   last touched ${fmtAge(now - Math.max(...hits.map((h) => h.t)))} ago`);
    }
    if (contestedFiles.length > 12) out.push(`    … ${contestedFiles.length - 12} more`);
  }
} else if (peers.length) {
  out.push('CONTENTION — none. No shared project or file across these sessions.');
}

// A silent miss and a clean result print identically, so say what was not
// counted. Most unresolved candidates are the edit hook's non-paths (`r.max`,
// `n.name`) — but a file deleted or renamed since the edit lands here too, and
// its collision is simply absent from the list above.
const unresolvedTotal = roster.reduce((n, s) => n + s.unresolvedEdits, 0);
if (unresolvedTotal || unattributed || unmappedWorktrees.size) {
  out.push('');
  const notes = [];
  if (unresolvedTotal) notes.push(`${unresolvedTotal} edit candidate${unresolvedTotal === 1 ? '' : 's'} did not resolve to a file on disk (mostly the hook's non-paths; a since-deleted file also lands here)`);
  if (unattributed) notes.push(`${unattributed} event${unattributed === 1 ? '' : 's'} carry no resolvable session id and were counted, not grouped`);
  if (unmappedWorktrees.size) notes.push(`${unmappedWorktrees.size} Codex worktree${unmappedWorktrees.size === 1 ? '' : 's'} could not be mapped to a main checkout`);
  out.push(`NOT COUNTED — ${notes.join('; ')}.`);
}

console.log(out.join('\n'));
