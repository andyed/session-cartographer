#!/usr/bin/env node
/**
 * Peer-session standup: what else is running, and what is it about to hit.
 *
 * `/focus` answers "what has happened in this PROJECT"; this answers "who ELSE
 * is in it with me right now". Those are different questions because Andy runs
 * 3-5 concurrent sessions and the corpus is already session-attributed — every
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
import { statSync, existsSync, openSync, readSync, closeSync } from 'fs';
import { execFileSync } from 'child_process';
import { join, isAbsolute, resolve as resolvePath, relative } from 'path';
import { homedir } from 'os';
import { isNonProject, nonProjectNames } from './non-projects.js';
import { editSummaryPaths } from './edit-paths.js';
import { isResolved } from './sentinels.js';

const HOUR = 3600e3;

function parseSince(s) {
  const m = String(s).match(/^(\d+(?:\.\d+)?)\s*([mhd])$/i);
  if (!m) return 6 * HOUR;
  const n = parseFloat(m[1]);
  return n * { m: 60e3, h: HOUR, d: 24 * HOUR }[m[2].toLowerCase()];
}

function fmtAge(ms) {
  const min = Math.round(ms / 60e3);
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  return `${h}h${String(min % 60).padStart(2, '0')}m`;
}

/**
 * Read only the tail of the changelog. It is ~69 MB and grows; a full parse to
 * answer a 6-hour question is the kind of cost that makes a command not get
 * run. Budget bytes from the window, floored generously — a short read that
 * misses the window start would silently under-report contention, which is the
 * one failure mode this tool cannot have.
 */
function readTail(path, windowMs) {
  const size = statSync(path).size;
  const bytes = Math.min(size, Math.max(8e6, Math.ceil(windowMs / HOUR) * 2e6));
  const fd = openSync(path, 'r');
  const buf = Buffer.alloc(bytes);
  readSync(fd, buf, 0, bytes, size - bytes);
  closeSync(fd);
  const text = buf.toString('utf-8');
  // Drop the first line: reading mid-file almost certainly split a record.
  return (bytes < size ? text.slice(text.indexOf('\n') + 1) : text)
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

const COMMIT_RE = /Commit\s+([0-9a-f]{6,40}):\s*([^|]*)(?:\|\s*files:\s*(.*))?$/;

/**
 * Resolve an edit candidate to an absolute file, loosely.
 *
 * Same policy as session-digest's resolver and for the same reason: this names
 * files rather than serving them, so confining to the indexed corpus would drop
 * real edits. It is also what `editSummaryPaths` needs to tell a filename
 * containing a comma from the hook's comma-separated multi-file form.
 */
const resolvedEdits = new Map();
function resolveEditedFile(candidate, cwd) {
  if (typeof candidate !== 'string') return null;
  let value = candidate.trim();
  if (/^(["'`]).*\1$/.test(value)) value = value.slice(1, -1);
  if (!value || value.includes('\0')) return null;
  if (!isAbsolute(value) && !(typeof cwd === 'string' && isAbsolute(cwd))) return null;
  const absolute = isAbsolute(value) ? value : resolvePath(cwd, value);
  if (!resolvedEdits.has(absolute)) {
    let hit = null;
    try { hit = statSync(absolute).isFile() ? absolute : null; } catch { hit = null; }
    resolvedEdits.set(absolute, hit);
  }
  return resolvedEdits.get(absolute);
}

/**
 * Files an event touched, as repo-relative paths.
 *
 * Edit summaries are parsed by edit-paths.js, not here. A bare /^Modified:\s+(\S+)/
 * looks adequate and is not: the hook writes bash-mediated edits as
 * `Modified: src/a.js,src/b.js (via bash)`, which that pattern turns into one
 * fabricated filename — so two sessions editing the same file through different
 * tools would never collide, and contention would under-report silently.
 */
function eventFiles(e) {
  if (e.type === 'tool_file_edit') {
    const files = [];
    let unresolved = 0;
    for (const c of editSummaryPaths(e.summary, (v) => resolveEditedFile(v, e.cwd))) {
      const abs = resolveEditedFile(c, e.cwd);
      if (abs) files.push(abs);
      else unresolved++;
    }
    return { files, unresolved };
  }
  if (e.type === 'git_commit') {
    const m = (e.summary || '').match(COMMIT_RE);
    if (!m || !m[3]) return { files: [], unresolved: 0 };
    return {
      files: m[3].split(',').map((f) => f.trim()).filter(Boolean)
        .map((f) => (isAbsolute(f) || !e.cwd ? f : resolvePath(e.cwd, f))),
      unresolved: 0,
    };
  }
  return { files: [], unresolved: 0 };
}

/**
 * Collapse a Claude Code worktree path onto the repository it belongs to.
 *
 * Agent control rooms put a worktree behind every task, so the emerging default
 * collision is one agent in `repo/js/x.js` and another in
 * `repo/.claude/worktrees/<name>/js/x.js`. Those are two absolute paths and one
 * file, and keying on the path alone makes exactly the collision this tool
 * exists for invisible. The real path is kept for display; only the contention
 * key is canonical. Scoped to the `.claude/worktrees` layout on purpose —
 * a worktree parked anywhere else needs a git call to recognise, and this
 * command makes none on the roster path.
 */
const WORKTREE_SEGMENT = /\/\.claude\/worktrees\/[^/]+(?=\/)/;
function contentionKey(absolutePath) {
  return absolutePath.replace(WORKTREE_SEGMENT, '');
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

// ---- commit attribution (--commit) ------------------------------------
if (commitQuery) {
  const q = commitQuery.replace(/^#/, '').toLowerCase();
  const hits = all.filter((e) => e.type === 'git_commit' && (e.summary || '').toLowerCase().includes(q));
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
      const sib = all.filter((x) => x.session_id === e.session_id && x.type === 'git_commit');
      if (sib.length > 1) console.log(`  context  ${sib.length} commits from this session in window`);
    }
    console.log();
  }
  process.exit(0);
}

// ---- roster -----------------------------------------------------------
const events = all.filter((e) => {
  const t = Date.parse(e.timestamp);
  return Number.isFinite(t) && now - t <= windowMs;
});

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
if (projectFilter) roster = roster.filter((s) => s.projects.has(projectFilter));

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
for (const s of roster) for (const p of s.projects.keys()) {
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
  if (projectFilter && meta.project !== projectFilter) continue;
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
const short = (id) => id.slice(0, 8);
const out = [];
out.push(`STANDUP — last ${opt('since', '6h')}${projectFilter ? ` · ${projectFilter}` : ''}   ${roster.length} session${roster.length === 1 ? '' : 's'}`);
if (mine) out.push(`you are ${short(mine.id)} · ${[...mine.projects.keys()].join(', ')}`);
out.push('');

if (!peers.length) {
  out.push('No other sessions in this window. You have the workspace to yourself.');
} else {
  for (const s of peers) {
    const idle = now - s.last;
    const mark = idle <= liveMs ? '●' : '○';
    const self = s.id === selfId ? ' (you)' : '';
    const projs = [...s.projects.entries()].sort((a, b) => b[1] - a[1]).map(([p]) => p);
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
if (unresolvedTotal || unattributed) {
  out.push('');
  const notes = [];
  if (unresolvedTotal) notes.push(`${unresolvedTotal} edit candidate${unresolvedTotal === 1 ? '' : 's'} did not resolve to a file on disk (mostly the hook's non-paths; a since-deleted file also lands here)`);
  if (unattributed) notes.push(`${unattributed} event${unattributed === 1 ? '' : 's'} carry no resolvable session id and were counted, not grouped`);
  out.push(`NOT COUNTED — ${notes.join('; ')}.`);
}

console.log(out.join('\n'));
