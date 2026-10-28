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
 * SILENT and UNCLAIMED (standup-silence.js) cover the other failure: a session whose hooks
 * never fire is not idle in this view, it is absent. They report activity the log did not
 * record — a Codex transcript written in the window with no logged events, an untrusted Codex
 * hook file, tracked files changed in the window that no logged session edited.
 *
 * Two folds keep the roster readable when a desktop agent spawns threads by the dozen.
 * A session that left only lifecycle rows — fewer than SHORT_MAX_EVENTS events inside
 * SHORT_MAX_SPAN_MS, nothing edited or committed — is a short session: counted on one
 * line per provider, never a peer, never contention. Measured 2026-10-27, 137 of the 171
 * sessions in a 2-day window were Codex Desktop threads that lived a median 6 s, fired one
 * Stop hook and persisted no rollout, so nothing on disk names a parent for them
 * (docs/standup-codex-threads-2026-10-27.md). A Codex rollout whose session_meta does name
 * a parent_thread_id is a sub-thread (guardian_review, a spawned agent): SILENT counts
 * those under their parent instead of listing them as sessions the hooks missed, because
 * the parent's hooks did log and the sub-thread fires none of its own.
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
import { codexRollouts, claudeTranscripts, codexHookTrust, unclaimedChanges, transcriptMentions, commandEvidence, codexThreadMeta } from './standup-silence.js';

/**
 * Exit only after stdout has handed everything to the OS.
 *
 * On macOS Node writes to a pipe asynchronously, so process.exit() straight
 * after a large write discards whatever the pipe had not yet taken, and the
 * reader gets a prefix that ends mid-string. Measured 2026-10-16: a `--json`
 * roster over 3d arrived cut at 131,041 bytes, and the MCP server's spawn of
 * it failed to parse at byte 8,192 once a worktree's UNCLAIMED list grew. A
 * write's callback runs only after every write queued before it has completed,
 * so an empty write is the drain point. Falling off the end of the module is
 * also safe (Node waits for pending writes); only an explicit exit is not.
 */
async function exitWhenFlushed(code) {
  await new Promise((resolve) => process.stdout.write('', resolve));
  process.exit(code);
}

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
// --roster answers only "who else is active": no SILENT or UNCLAIMED pass. The
// SessionStart note runs this on every session start, and the transcript pass
// below has cost seconds (see "Two passes"). In JSON the skipped sections read
// null rather than [], so a check that was not run never reads as a clean one.
const rosterOnly = flag('roster');
// Short sessions fold into one line per provider unless --no-fold ("Two folds" above).
const noFold = flag('no-fold');
const SHORT_MAX_EVENTS = 3;           // fewer than this many events…
const SHORT_MAX_SPAN_MS = 2 * 60e3;   // …inside this span, with nothing edited or committed
const countBy = (list, key) => {
  const out = {};
  for (const x of list) { const k = key(x); out[k] = (out[k] || 0) + 1; }
  return out;
};

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
    await exitWhenFlushed(0);
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
  await exitWhenFlushed(0);
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

// ---- short sessions ---------------------------------------------------
// A session that left only lifecycle rows is counted, not listed: fewer than
// SHORT_MAX_EVENTS events inside SHORT_MAX_SPAN_MS, and no edit candidate
// (resolved or not), commit or push. The last clause keeps a one-edit
// `codex exec` run or a one-commit session in the roster — a file or a sha is
// something a peer can collide with; a Stop row is not. Your own session is
// never folded: a session just started has one event and is still you.
// Folded sessions leave the roster before contention, so a project line no
// longer reads "28 sessions" when 24 of them were one Stop row each. They had
// no files, so file contention is unchanged by construction, and `short()`
// below no longer widens a real id to tell it from a neighbour that shares its
// UUIDv7 time prefix (`01a17f5d-e` was the symptom).
const isShort = (s) => s.n < SHORT_MAX_EVENTS && (s.last - s.first) < SHORT_MAX_SPAN_MS
  && !s.commits.length && !s.pushes && !s.files.size && !s.unresolvedEdits;
const folded = noFold ? [] : roster.filter((s) => s.id !== selfId && isShort(s));
if (folded.length) {
  const foldedIds = new Set(folded.map((s) => s.id));
  roster = roster.filter((s) => !foldedIds.has(s.id));
}
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

// ---- silence: what the log did not record -----------------------------
// A session whose hooks never fire has no events, so nothing above can see it.
// Read the providers' own transcript stores and the repo's working tree instead.
const codexHome = process.env.CODEX_HOME || join(homedir(), '.codex');
const claudeHome = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
const sinceMs = now - windowMs;
const loggedIds = new Set([...sessions.keys()].map((id) => id.toLowerCase()));
const rollouts = rosterOnly ? [] : codexRollouts({ codexHome, sinceMs, now });
const unloggedRollouts = rollouts.filter((r) => !loggedIds.has(r.id));
const hookTrust = rosterOnly ? { status: 'not_checked' } : codexHookTrust({ codexHome });
const hookTrustProblem = hookTrust.status === 'untrusted' || hookTrust.status === 'partial';

// A Codex Desktop sub-thread (guardian_review, a spawned agent) persists a rollout whose
// session_meta names its parent_thread_id and fires no hooks of its own. Its parent's
// hooks did log, so it is not a session the log missed: count it under the parent rather
// than list it beside sessions whose hooks really are silent. One bounded read of each
// unlogged rollout's first line, never on the --roster path (rollouts is empty there).
// The parent id is grouped on only when resolved: a sentinel there would fuse every
// parentless thread into one phantom family.
const threadMeta = new Map(unloggedRollouts.map((r) => [r.id, codexThreadMeta(r.path)]));
const parentOf = (r) => {
  const p = threadMeta.get(r.id)?.parent;
  return isResolved(p) ? String(p).toLowerCase() : null;
};
const subthreadKind = (r) => threadMeta.get(r.id)?.threadSource || threadMeta.get(r.id)?.subagent || 'subagent';
const subthreads = unloggedRollouts.filter((r) => parentOf(r));
const standaloneSilent = unloggedRollouts.filter((r) => !parentOf(r));
const subthreadParents = Object.entries(countBy(subthreads, parentOf))
  .map(([id, children]) => ({ id, children, logged: loggedIds.has(id) }))
  .sort((a, b) => b.children - a.children || a.id.localeCompare(b.id));

// The repo whose working tree to check: the --project checkout, else the one this ran in.
function scopeRepo() {
  const top = (dir) => {
    try {
      return execFileSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'],
        { encoding: 'utf-8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
    } catch { return null; }
  };
  if (projectFilter) { const d = join(dev, projectFilter); return existsSync(d) ? top(d) : null; }
  return top(process.cwd());
}
const repo = rosterOnly ? null : scopeRepo();
const claimed = new Set();
for (const sess of sessions.values()) for (const key of sess.files.keys()) claimed.add(key);
const unclaimed = repo ? unclaimedChanges({ repo, sinceMs, claimed, keyOf: contentionKey }) : [];
let mentions = new Map();
// First: a logged command that named the file just before it changed (sed -i, a Python heredoc).
for (const u of unclaimed) {
  const hit = commandEvidence({ events: all, rel: u.rel, abs: u.abs, mtimeMs: u.mtimeMs })
    .find((h) => isResolved(h.id));
  if (hit) u.command = hit;
}
const needingTranscripts = unclaimed.filter((u) => !u.command);
if (needingTranscripts.length) {
  const self = (selfId || '').toLowerCase();
  const needles = needingTranscripts.slice(0, 20).map((u) => u.rel);
  // Two passes. The unlogged sessions' transcripts are few and are where the answer usually
  // is; the rest include Claude transcripts of 100 MB+, which took a run from under 1 s to
  // ~5.7 s on 2026-10-04. Only paths the first pass could not place pay for the second.
  const silentPaths = new Set(unloggedRollouts.map((r) => r.path));
  mentions = transcriptMentions({ transcripts: unloggedRollouts.filter((t) => t.id !== self), needles });
  const unplaced = needles.filter((n) => !(mentions.get(n) || []).length);
  if (unplaced.length) {
    const rest = [...rollouts.filter((r) => !silentPaths.has(r.path)), ...claudeTranscripts({ claudeHome, sinceMs })]
      .filter((t) => t.id !== self);
    for (const [n, list] of transcriptMentions({ transcripts: rest, needles: unplaced })) mentions.set(n, list);
  }
  // A session that logs its edits would have CLAIMED the file, so the likeliest author of an
  // unclaimed change is one whose events are missing. Raw counts alone favour long transcripts
  // that name a busy file hundreds of times over a whole day (seen 2026-10-04: a Claude
  // session with 407 mentions of flag-registry.js outranking the unlogged Codex editor).
  const silentIds = new Set(unloggedRollouts.map((r) => r.id));
  for (const list of mentions.values()) {
    for (const m of list) m.unlogged = silentIds.has(m.id);
    list.sort((a, b) => (b.unlogged - a.unlogged) || (b.count - a.count) || (b.mtimeMs - a.mtimeMs));
  }
}

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
      // Contention keys (worktree-collapsed absolute paths), most recent first:
      // what a peer is in the middle of, for a reader deciding where not to edit.
      recent_files: [...s.files.entries()].sort((a, b) => b[1].t - a[1].t).slice(0, 5).map(([key]) => key),
    })),
    // Folded out of `sessions` and out of contention ("short sessions" above).
    // Empty under --no-fold; the rule is stated so a reader can tell why a row is absent.
    short_sessions: {
      count: folded.length,
      events: folded.reduce((n, s) => n + s.n, 0),
      live: folded.filter((s) => now - s.last <= liveMs).length,
      newest_idle_ms: folded.length ? Math.min(...folded.map((s) => now - s.last)) : null,
      rule: { max_events_exclusive: SHORT_MAX_EVENTS, max_span_ms: SHORT_MAX_SPAN_MS, edits: 0, commits: 0, pushes: 0 },
      by_provider: countBy(folded, (s) => s.provider),
      sessions: folded.map((s) => ({
        id: s.id, provider: s.provider, events: s.n,
        last_active: new Date(s.last).toISOString(), idle_ms: now - s.last,
        projects: Object.fromEntries(s.projects), types: Object.fromEntries(s.types),
      })),
    },
    contention: {
      projects: contestedProjects.map(([p, ss]) => ({ project: p, sessions: ss.map((s) => s.id) })),
      files: contestedFiles.map(([key, hits]) => ({
        path: key,
        paths: [...new Set(hits.map((h) => h.path))],
        worktree_split: new Set(hits.map((h) => h.path)).size > 1,
        sessions: [...new Set(hits.map((h) => h.s.id))],
      })),
    },
    silent: rosterOnly ? null : {
      codex_sessions_without_events: unloggedRollouts.map((r) => ({
        id: r.id, transcript_written: new Date(r.mtimeMs).toISOString(),
        // A sub-thread names the session that spawned it; null for a thread of its own.
        parent: parentOf(r),
        thread_source: threadMeta.get(r.id)?.threadSource || null,
        subagent: threadMeta.get(r.id)?.subagent || null,
      })),
      codex_subthreads: {
        count: subthreads.length,
        by_source: countBy(subthreads, subthreadKind),
        parents: subthreadParents,
      },
      codex_hook_trust: hookTrust,
    },
    unclaimed_changes: rosterOnly ? null : unclaimed.map((u) => ({
      path: u.rel, repo, changed: new Date(u.mtimeMs).toISOString(),
      named_in_command: u.command ? { id: u.command.id, provider: u.command.provider, at: new Date(u.command.t).toISOString() } : null,
      mentioned_by: (mentions.get(u.rel) || []).slice(0, 3).map((m) => ({ id: m.id, provider: m.provider, mentions: m.count, unlogged: !!m.unlogged })),
    })),
  }, null, 2));
  await exitWhenFlushed(0);
}

// ---- render -----------------------------------------------------------
const short = (id) => {
  let length = 8;
  while (length < id.length && roster.some((s) => s.id !== id && s.id.slice(0, length) === id.slice(0, length))) length++;
  return id.slice(0, length);
};
const out = [];
out.push(`STANDUP — last ${opt('since', '6h')}${projectFilter ? ` · ${projectFilter}` : ''}   ${roster.length} session${roster.length === 1 ? '' : 's'}`
  + (folded.length ? ` + ${folded.length} short (folded)` : ''));
if (mine) out.push(`you are ${short(mine.id)} · ${[...mine.projects.keys()].join(', ')}`);
out.push('');

if (!peers.length && !folded.length) {
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
  // One row per provider for the sessions that left only lifecycle rows, in the
  // roster's own two-line shape: the mark says whether any of them is live.
  const foldedByProvider = new Map();
  for (const s of folded) {
    if (!foldedByProvider.has(s.provider)) foldedByProvider.set(s.provider, []);
    foldedByProvider.get(s.provider).push(s);
  }
  for (const [provider, list] of [...foldedByProvider.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const live = list.filter((s) => now - s.last <= liveMs).length;
    const newest = Math.min(...list.map((s) => now - s.last));
    const events = list.reduce((n, s) => n + s.n, 0);
    out.push(`${live ? '●' : '○'} ${list.length} short ${provider} session${list.length === 1 ? '' : 's'} (${events} event${events === 1 ? '' : 's'}) — folded`);
    out.push(`    each <${SHORT_MAX_EVENTS} events in <${SHORT_MAX_SPAN_MS / 60e3}m, nothing edited or committed · ${live} live · newest ${fmtAge(newest)} ago · --no-fold lists them`);
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
} else if (peers.length || folded.length) {
  out.push('CONTENTION — none. No shared project or file across these sessions.');
}

// SILENT before UNCLAIMED: the first is usually the cause of the second.
if (unloggedRollouts.length || hookTrustProblem) {
  out.push('');
  out.push('SILENT — activity the event log did not record');
  // Three newest threads of their own, then a count; sub-threads go under their parents.
  for (const r of standaloneSilent.slice(0, 3)) {
    out.push(`  codex  ${r.id.slice(0, 8)}  transcript written ${fmtAge(now - r.mtimeMs)} ago · 0 events logged`);
  }
  if (standaloneSilent.length > 3) {
    const more = standaloneSilent.length - 3;
    out.push(`  … ${more} more Codex session${more === 1 ? '' : 's'} with no events (${standaloneSilent.length} in all, 3 newest shown)`);
  }
  if (subthreads.length) {
    const kinds = Object.entries(countBy(subthreads, subthreadKind)).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(', ');
    const unlogged = subthreadParents.filter((p) => !p.logged).length;
    const shown = subthreadParents.slice(0, 3).map((p) => `${short(p.id)} ×${p.children}${p.logged ? '' : ' (not logged)'}`).join(', ');
    out.push(`  ${subthreads.length} Codex Desktop sub-thread${subthreads.length === 1 ? '' : 's'} (${kinds}) of ${subthreadParents.length} parent session${subthreadParents.length === 1 ? '' : 's'}: ${shown}${subthreadParents.length > 3 ? `, … ${subthreadParents.length - 3} more` : ''}`);
    out.push(`    sub-threads logged no events of their own; ${unlogged ? `${unlogged} parent${unlogged === 1 ? '' : 's'} logged nothing in the window` : 'every parent is in the roster above'}`);
  }
  if (hookTrustProblem) {
    const was = hookTrust.trustedFiles?.length ? ` (trust is recorded for ${hookTrust.trustedFiles.join(', ')})` : '';
    out.push(hookTrust.status === 'untrusted'
      ? `  Codex hooks untrusted: ${hookTrust.hookFile} (${hookTrust.version}) has no trust record${was}. Codex skips untrusted hooks silently — approve with /hooks in the Codex CLI.`
      : `  Codex hooks partly trusted: ${hookTrust.hookFile} (${hookTrust.version}) lacks trust for ${hookTrust.missingEvents.join(', ')}. Approve with /hooks in the Codex CLI.`);
  }
}
if (unclaimed.length) {
  out.push('');
  out.push('UNCLAIMED — tracked files changed in the window that no logged session edited');
  for (const u of unclaimed.slice(0, 10)) {
    const top = (mentions.get(u.rel) || [])[0];
    const c = u.command;
    const who = (id) => `${id.slice(0, 8)}${id === selfId ? ' (you)' : ''}`;
    const by = c ? ` · named in a command logged by ${c.provider} ${who(c.id)} ${fmtAge(Math.abs(u.mtimeMs - c.t))} ${c.t <= u.mtimeMs ? 'before' : 'after'} the change`
      : top ? ` · mentioned by ${top.provider} ${who(top.id)}${top.unlogged ? ' (no events logged)' : ''} (${top.count}×, transcript ${fmtAge(now - top.mtimeMs)} ago)`
        : ' · no transcript in the window names it';
    out.push(`  ${u.rel}   changed ${fmtAge(now - u.mtimeMs)} ago${by}`);
  }
  if (unclaimed.length > 10) out.push(`  … ${unclaimed.length - 10} more`);
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
