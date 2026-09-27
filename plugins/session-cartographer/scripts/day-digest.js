/**
 * Day digest: one local calendar day across every session, grouped by project,
 * with every commit checked against git.
 *
 * The session digest answers "what did this session do". This answers "what
 * did the day do" — the standup, the timesheet, the receipt, and the molt
 * FrakBot writes each morning. Andy runs three to five sessions at once, so a
 * day is not a sum of session panels: the same hour is claimed by several of
 * them, and the same repository appears under several.
 *
 * Why commits are checked rather than quoted. The receipt is only worth
 * reading if a line on it means the work landed. A hook-logged commit can have
 * been amended or rebased away by evening, and a commit made in a plain
 * terminal was never logged at all. Asking git settles both: every logged
 * commit is marked landed (reachable from a branch, remote, or tag), rewritten
 * (the object exists but nothing reaches it), missing, or unverified, and git
 * commits of yours that no session logged are listed as git-only.
 *
 * Active time is wall clock, not a sum: the count of five-minute bins holding
 * any logged event, with every session in the project merged. Three sessions
 * working the same hour are one hour. Gaps with no tool call — reading,
 * thinking, a long model turn — do not count, so this undercounts, and says so.
 *
 * Scope. With no --projects it covers everything, which is right for a person
 * reading their own day. A scheduled agent must pass --projects: out-of-scope
 * work is reported as a count of events and projects, never by name, because a
 * report that names what it skipped is itself the disclosure.
 *
 * Usage (through session-digest.js, which owns the command):
 *   node scripts/session-digest.js --day                    today, local time
 *   node scripts/session-digest.js --day yesterday --md     paste-ready standup
 *   node scripts/session-digest.js --day 2026-09-26 --json  machine contract
 *   … --projects a,b  --deny-regex RE  --no-git  --commits N  --files N  --width N
 */
import fs from 'fs';
import path from 'path';
import { isResolved } from './sentinels.js';
import { editSummaryPaths } from './edit-paths.js';
import { expandProjectAlias } from './project-registry.js';
import { isNonProject, nonProjectNames } from './non-projects.js';
import { eventEpochMs } from '../explorer/server/event-time.js';
import { projectMatcher } from '../explorer/server/project-filter.js';
import {
  abbrev, commitParts, createEditResolver, fmtDuration, git, relativize, repoState, sparkline, truncate,
} from './digest-parts.js';

export const SCHEMA = 'carto.day-digest/1';
const BIN_MS = 5 * 60 * 1000;
const OUTSIDE = 'outside any repo';

function option(args, flag, fallback) {
  const idx = args.indexOf(flag);
  if (idx < 0) return fallback;
  const next = args[idx + 1];
  return next && !next.startsWith('--') ? next : fallback;
}

const pad2 = (n) => String(n).padStart(2, '0');
const localDate = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
};
const localClock = (ms) => {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};
const utcDate = (ms) => new Date(ms).toISOString().slice(0, 10);

/**
 * Local-midnight bounds for a day spec. Built from calendar fields rather than
 * `start + 24h` so a DST day is 23 or 25 hours long, as it actually was.
 */
export function dayBounds(spec, now = new Date()) {
  let y; let m; let d;
  if (!spec || spec === 'today') {
    [y, m, d] = [now.getFullYear(), now.getMonth(), now.getDate()];
  } else if (spec === 'yesterday') {
    const t = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
    [y, m, d] = [t.getFullYear(), t.getMonth(), t.getDate()];
  } else {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(spec);
    if (!match) return null;
    [y, m, d] = [Number(match[1]), Number(match[2]) - 1, Number(match[3])];
    const probe = new Date(y, m, d);
    // Date rolls 2026-02-31 into March without complaint; refuse it instead.
    if (probe.getFullYear() !== y || probe.getMonth() !== m || probe.getDate() !== d) return null;
  }
  const start = new Date(y, m, d).getTime();
  const end = new Date(y, m, d + 1).getTime();
  return { start, end, day: localDate(start) };
}

function tzLabel(ms) {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'local';
  const part = new Intl.DateTimeFormat('en-US', { timeZoneName: 'short' })
    .formatToParts(new Date(ms)).find((p) => p.type === 'timeZoneName');
  return { zone, abbrev: part ? part.value : zone };
}

/**
 * Events inside [start, end), deduplicated by event_id.
 *
 * The substring guard keeps this from parsing 140k rows to find 4k. ~2% of
 * rows are stamped with a UTC offset (`2026-09-26T21:21:04-07:00`), and an
 * offset moves the date in the string by up to 14 hours, so the guard admits
 * every calendar date within 14 hours of the day's edges. Guarded rows are
 * then placed by their parsed time, never by the string. Some writers stamp
 * epoch numbers instead (event-time.js reads both), and those rows carry no
 * date string at all, so a numeric timestamp is always admitted.
 */
const NUMERIC_TIMESTAMP = /"timestamp":\s*\d/;
function readDayEvents(filePath, start, end) {
  const SLACK = 14 * 3600000;
  const guards = [];
  for (let t = start - SLACK; t < end + SLACK + 86400000; t += 86400000) {
    const date = utcDate(Math.min(t, end + SLACK));
    if (!guards.includes(date)) guards.push(date);
  }
  const text = fs.readFileSync(filePath, 'utf8');
  const out = [];
  const seen = new Set();
  let duplicates = 0;
  let undated = 0;
  for (const line of text.split('\n')) {
    if (!line || !(guards.some((g) => line.includes(g)) || NUMERIC_TIMESTAMP.test(line))) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    const ts = eventEpochMs(event);
    if (ts === null) { undated += 1; continue; }
    if (ts < start || ts >= end) continue;
    if (isResolved(event.event_id)) {
      if (seen.has(event.event_id)) { duplicates += 1; continue; }
      seen.add(event.event_id);
    }
    out.push({ ...event, _ms: ts });
  }
  out.sort((a, b) => a._ms - b._ms);
  // The newest row anywhere in the log separates "a quiet day" from "the hooks
  // stopped writing", which a zero alone cannot.
  let logNewest = null;
  const tail = text.slice(Math.max(0, text.length - 8192)).trimEnd().split('\n').pop();
  try { logNewest = JSON.parse(tail).timestamp || null; } catch { logNewest = null; }
  return { events: out, duplicates, undated, logNewest };
}

function providerOf(event) {
  if (isResolved(event.provider)) return event.provider;
  const t = String(event.transcript_path || '');
  if (t.includes('/.codex/')) return 'codex';
  if (t.includes('/.claude/')) return 'claude';
  return null;
}

/**
 * The repository a project name refers to. `project` is the basename of the
 * git common dir, so a candidate only counts when its common dir resolves to
 * that name: a session's cwd can be the workspace root (it ran `cd repo && git
 * commit`) or a sibling repository, and asking the wrong repo about a sha
 * reports a real commit as missing.
 */
function repoForProject(project, dirs, dev) {
  for (const dir of [...dirs, path.join(dev, project)]) {
    if (!dir || !fs.existsSync(dir)) continue;
    try {
      const common = git(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
      const root = path.basename(common) === '.git' ? path.dirname(common) : common;
      if (path.basename(root) === project) return root;
    } catch { /* not a repo */ }
  }
  return null;
}

/**
 * Check logged commits against the repository, and find the day's commits that
 * no session logged. One `git log` over the day's neighbourhood answers most
 * of it; a sha that log did not return gets an exact reachability probe, since
 * absence from a date-bounded walk is not proof that nothing reaches it.
 */
function verifyCommits(root, commits, start, end) {
  const DAY = 86400000;
  let email = '';
  try { email = git(root, ['config', 'user.email']).toLowerCase(); } catch { email = ''; }
  const nearby = new Map();
  try {
    const out = git(root, [
      'log', '--branches', '--remotes', '--tags', '--no-color',
      `--since=${new Date(start - DAY).toISOString()}`, `--until=${new Date(end + DAY).toISOString()}`,
      '--format=%H%x09%ae%x09%at%x09%ct%x09%s',
    ]);
    for (const row of out.split('\n').filter(Boolean)) {
      const [sha, ae, at, ct, ...rest] = row.split('\t');
      nearby.set(sha, { sha, email: ae.toLowerCase(), authored: Number(at) * 1000, committed: Number(ct) * 1000, subject: rest.join('\t') });
    }
  } catch { /* an empty neighbourhood falls through to exact probes */ }

  const findNearby = (sha) => {
    if (nearby.has(sha)) return nearby.get(sha);
    for (const [full, row] of nearby) if (full.startsWith(sha)) return row;
    return null;
  };

  for (const c of commits) {
    const hit = findNearby(c.sha);
    if (hit) {
      c.status = 'landed';
      c.sha = hit.sha;
      if (hit.subject) { c.subject = hit.subject; c.subject_source = 'git'; }
      continue;
    }
    let exists = false;
    try { exists = git(root, ['cat-file', '-t', c.sha]) === 'commit'; } catch { exists = false; }
    if (!exists) { c.status = 'missing'; continue; }
    let reachable = '';
    try {
      reachable = git(root, ['for-each-ref', '--contains', c.sha, '--count=1', '--format=%(refname)',
        'refs/heads', 'refs/remotes', 'refs/tags']);
    } catch { reachable = ''; }
    c.status = reachable ? 'landed' : 'rewritten';
    try {
      const [at, ...subject] = git(root, ['log', '-1', '--format=%at%x09%s', c.sha]).split('\t');
      c.authored = Number(at) * 1000;
      if (subject.join('\t')) { c.subject = subject.join('\t'); c.subject_source = 'git'; }
    } catch { /* keep the hook's subject */ }
  }

  // A rewritten commit usually did land — under a new sha. Rebase, cherry-pick
  // and amend all keep the author date, so a reachable commit with the same
  // author time and subject is the same change, moved. Without this pairing a
  // worktree agent's commit cherry-picked onto main counts twice: once as
  // "rewritten" under the sha the session logged, once as "git-only" under the
  // sha that landed. When the successor was itself logged (a second amend the
  // hook caught), the older sha is only superseded and stays out of the count.
  const loggedShas = new Set(commits.map((c) => c.sha));
  const claimed = new Set();
  for (const c of commits) {
    if (c.status !== 'rewritten' || !Number.isFinite(c.authored)) continue;
    const successor = [...nearby.values()].find((row) => row.authored === c.authored
      && row.subject === c.subject && row.sha !== c.sha && !claimed.has(row.sha));
    if (!successor) continue;
    claimed.add(successor.sha);
    if (loggedShas.has(successor.sha)) { c.superseded_by = successor.sha; continue; }
    c.status = 'landed';
    c.landed_as = successor.sha;
  }

  // Git-only: yours, authored AND committed inside the day. Requiring both
  // keeps a rebase of last week's work — new shas, today's committer date —
  // from reading as a day of new commits.
  const logged = commits.map((c) => c.sha);
  const gitOnly = [];
  if (email) {
    for (const row of nearby.values()) {
      if (row.email !== email) continue;
      if (row.authored < start || row.authored >= end) continue;
      if (row.committed < start || row.committed >= end) continue;
      if (claimed.has(row.sha)) continue;
      if (logged.some((sha) => row.sha.startsWith(sha) || sha.startsWith(row.sha))) continue;
      gitOnly.push({ sha: row.sha, hash: row.sha.slice(0, 7), subject: row.subject, at: row.committed });
    }
  }
  gitOnly.sort((a, b) => a.at - b.at);
  return gitOnly;
}

// Conventional-commit type and scope, when the subject has them.
const CONVENTIONAL = /^([a-z]+)(?:\(([^)]+)\))?!?:\s/;
const TYPE_RANK = { feat: 0, fix: 1, perf: 2, refactor: 3, test: 4, build: 5, docs: 6, chore: 7 };

/**
 * The commits a receipt lists when a project had more than fit. Features and
 * fixes first, newest first within a type, merges never; then shown in time
 * order, because a receipt reads as the day happened. A cherry-pick onto a
 * second branch is two commits in git and one change on a receipt, so a
 * repeated subject is listed once.
 */
function receiptPicks(commits, max) {
  const seen = new Set();
  const unique = [];
  for (const c of commits) {
    const subject = c.subject || '';
    if (/^Merge (branch|pull request|remote-tracking)/.test(subject) || seen.has(subject)) continue;
    seen.add(subject);
    unique.push(c);
  }
  const rank = (c) => {
    const m = CONVENTIONAL.exec(c.subject || '');
    return m && m[1] in TYPE_RANK ? TYPE_RANK[m[1]] : 8;
  };
  const picked = [...unique].sort((a, b) => rank(a) - rank(b) || b.at - a.at).slice(0, max);
  return { picked: picked.sort((a, b) => a.at - b.at), unique: unique.length };
}

function scopeLine(commits) {
  const counts = {};
  for (const c of commits) {
    const m = CONVENTIONAL.exec(c.subject || '');
    if (m && m[2]) counts[m[2]] = (counts[m[2]] || 0) + 1;
  }
  const ranked = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (ranked.length < 2) return '';
  const head = ranked.slice(0, 6).map(([k, n]) => `${k} ${n}`).join(' · ');
  return ranked.length > 6 ? `${head} · …` : head;
}

function newProject(name, kind) {
  return {
    name, kind, events: 0, event_ids: [], sessions: new Map(), bins: new Set(),
    commits: new Map(), pushes: 0, files: {}, files_unresolved: 0,
    investigations: new Map(), outcomes: [], cwds: new Set(), members: new Set(),
  };
}

export function dayDigest(args, env = process.env) {
  const DEV = env.CARTOGRAPHER_DEV_DIR || path.join(env.HOME, 'Documents/dev');
  const CHANGELOG = env.CARTOGRAPHER_CHANGELOG || path.join(DEV, 'changelog.jsonl');
  const AS_JSON = args.includes('--json');
  const AS_MD = args.includes('--md');
  const WITH_GIT = !args.includes('--no-git');
  const WIDTH = Math.max(60, Number.parseInt(option(args, '--width', '84'), 10) || 84);
  const MAX_COMMITS = Number.parseInt(option(args, '--commits', '8'), 10) || 8;
  const MAX_FILES = Number.parseInt(option(args, '--files', '3'), 10) || 3;
  const fail = (code, message) => ({ text: '', code, error: message });

  const spec = option(args, '--day', 'today');
  const bounds = dayBounds(spec);
  if (!bounds) {
    process.stderr.write(`--day takes today, yesterday, or YYYY-MM-DD; got "${spec}"\n`);
    return fail(2, 'bad day');
  }
  const { start, end, day } = bounds;
  const now = Date.now();
  const tz = tzLabel(start + 12 * 3600000);

  let denyRe = null;
  const denySpec = option(args, '--deny-regex', null);
  if (denySpec) {
    try { denyRe = new RegExp(denySpec, 'i'); } catch {
      process.stderr.write(`--deny-regex is not a valid expression: ${denySpec}\n`);
      return fail(2, 'bad regex');
    }
  }
  const denied = (text) => Boolean(denyRe && denyRe.test(String(text || '')));

  // Same scope rule as the pulse: registry-expanded names, matched as a
  // case-insensitive substring, so a family name admits its repositories.
  const projectsSpec = option(args, '--projects', null);
  let scopeNames = null;
  if (projectsSpec) {
    scopeNames = [...new Set(projectsSpec.split(',').map((s) => s.trim()).filter(Boolean)
      .flatMap((name) => expandProjectAlias(name, env)))];
    if (scopeNames.length === 0) {
      process.stderr.write('--projects expanded to zero projects\n');
      return fail(2, 'empty scope');
    }
  }
  const inScope = projectMatcher(scopeNames ? scopeNames.join('|') : '');

  if (!fs.existsSync(CHANGELOG)) {
    process.stderr.write(`No event log at ${CHANGELOG}. This is an outage, not a quiet day.\n`);
    return fail(1, 'no log');
  }
  const { events, duplicates, undated, logNewest } = readDayEvents(CHANGELOG, start, end);

  const nonProjects = nonProjectNames(env, DEV);
  const resolveEditedFile = createEditResolver();
  const projects = new Map();
  const allBins = new Set();
  const allSessions = new Map();
  const hours = new Array(24).fill(0);
  const unattributed = { project: 0, session: 0 };
  const outOfScope = { events: 0, projects: new Set() };
  let deniedCount = 0;

  for (const e of events) {
    if (!isResolved(e.project)) { unattributed.project += 1; continue; }
    if (!inScope(e.project)) { outOfScope.events += 1; outOfScope.projects.add(e.project); continue; }
    if (denied(e.project)) { deniedCount += 1; continue; }

    const nonRepo = isNonProject(e.project, nonProjects);
    const key = nonRepo ? OUTSIDE : e.project;
    if (!projects.has(key)) projects.set(key, newProject(key, nonRepo ? 'non_repo' : 'repo'));
    const p = projects.get(key);
    p.members.add(e.project);
    p.events += 1;
    if (isResolved(e.event_id) && p.event_ids.length < 3) p.event_ids.push(e.event_id);
    if (e.cwd) p.cwds.add(e.cwd);

    const bin = Math.floor(e._ms / BIN_MS);
    p.bins.add(bin);
    allBins.add(bin);
    hours[new Date(e._ms).getHours()] += 1;

    const sid = isResolved(e.session_id) ? e.session_id : (isResolved(e.session) ? e.session : null);
    if (sid) {
      const provider = providerOf(e);
      for (const map of [p.sessions, allSessions]) {
        const s = map.get(sid) || { id: sid, provider: null, first: e._ms, last: e._ms, events: 0 };
        s.provider = s.provider || provider;
        s.last = e._ms;
        s.events += 1;
        map.set(sid, s);
      }
    } else {
      unattributed.session += 1;
    }

    if (e.type === 'git_commit') {
      const parts = commitParts(e.summary);
      if (!parts || p.commits.has(parts.sha)) continue;
      if (denied(parts.subject)) { deniedCount += 1; continue; }
      const shape = e.diff_shape || {};
      p.commits.set(parts.sha, {
        sha: parts.sha, hash: parts.hash, subject: parts.subject, subject_source: 'hook',
        type: parts.type, at: e._ms, added: shape.lines_added ?? null, removed: shape.lines_removed ?? null,
        quadrant: shape.quadrant || null, status: 'unverified',
        event_id: isResolved(e.event_id) ? e.event_id : null, session_id: sid, cwd: e.cwd || null,
      });
    } else if (e.type === 'git_push') {
      p.pushes += 1;
    } else if (e.type === 'tool_file_edit') {
      for (const candidate of editSummaryPaths(e.summary, (value) => resolveEditedFile(value, e.cwd))) {
        const absolute = resolveEditedFile(candidate, e.cwd);
        if (!absolute) { p.files_unresolved += 1; continue; }
        const rel = relativize(absolute, e.project, DEV);
        if (denied(rel)) { deniedCount += 1; continue; }
        p.files[rel] = (p.files[rel] || 0) + 1;
      }
    } else if (e.type === 'investigation') {
      const text = e.symptom || e.summary;
      if (denied(text)) { deniedCount += 1; continue; }
      p.investigations.set(e.event_id, { event_id: e.event_id, symptom: String(text || ''), outcome: 'open' });
    } else if (e.type === 'investigation_outcome') {
      if (p.investigations.has(e.resolves)) p.investigations.get(e.resolves).outcome = e.outcome || 'closed';
      else p.outcomes.push({ event_id: e.event_id, resolves: e.resolves || null, outcome: e.outcome || 'closed' });
    }
  }

  // ------------------------------------------------------------ git checks

  for (const p of projects.values()) {
    p.commit_list = [...p.commits.values()].sort((a, b) => a.at - b.at);
    p.git_only = [];
    p.repo = null;
    if (!WITH_GIT || p.kind !== 'repo') continue;
    const commitDirs = p.commit_list.map((c) => c.cwd);
    const root = repoForProject(p.name, [...new Set([...commitDirs, ...p.cwds])], DEV);
    if (!root) continue;
    p.git_only = verifyCommits(root, p.commit_list, start, end).filter((c) => !denied(c.subject));
    const state = repoState(root);
    if (state) p.repo = { name: state.name, branch: state.branch, dirty: state.dirty, unpushed: state.unpushed };
  }

  // ------------------------------------------------------------- summary

  const list = [...projects.values()];
  for (const p of list) {
    p.landed = p.commit_list.filter((c) => c.status === 'landed' || c.status === 'unverified');
    p.active_ms = p.bins.size * BIN_MS;
  }
  // Commits first, because they are the part that is checkable; then time.
  // The pseudo-project for work outside any repository always sits last.
  list.sort((a, b) => (a.kind === 'non_repo') - (b.kind === 'non_repo')
    || (b.landed.length + b.git_only.length) - (a.landed.length + a.git_only.length)
    || b.active_ms - a.active_ms);

  const all = list.flatMap((p) => p.commit_list);
  const totals = {
    events: list.reduce((n, p) => n + p.events, 0),
    sessions: allSessions.size,
    projects: list.filter((p) => p.kind === 'repo').length,
    commits_logged: all.length,
    commits_landed: all.filter((c) => c.status === 'landed').length,
    commits_moved: all.filter((c) => c.landed_as).length,
    commits_rewritten: all.filter((c) => c.status === 'rewritten').length,
    commits_missing: all.filter((c) => c.status === 'missing').length,
    commits_unverified: all.filter((c) => c.status === 'unverified').length,
    commits_git_only: list.reduce((n, p) => n + p.git_only.length, 0),
    pushes: list.reduce((n, p) => n + p.pushes, 0),
    active_minutes: Math.round((allBins.size * BIN_MS) / 60000),
  };
  const agents = {};
  for (const s of allSessions.values()) agents[s.provider || 'unknown'] = (agents[s.provider || 'unknown'] || 0) + 1;
  const complete = end <= now;
  // With git on, the headline claims only what git confirmed; unverified rows
  // are counted on the git line, never folded into the total.
  const claimable = (c) => c.status === 'landed' || (!WITH_GIT && c.status === 'unverified');
  const claimedTotal = list.reduce((n, p) => n + p.commit_list.filter((c) => c.status === 'landed' || (!WITH_GIT && c.status === 'unverified')).length + p.git_only.length, 0);
  // A project with no commits, diagnoses, edits, or repo state has nothing to
  // report but its time; it gets a mention, not a section.
  const isMinor = (p) => !p.commit_list.length && !p.git_only.length && !p.investigations.size
    && !p.outcomes.length && !Object.keys(p.files).length && !p.repo;

  if (AS_JSON) {
    const doc = {
      schema: SCHEMA,
      generated_at: new Date(now).toISOString(),
      day, tz: tz.zone, tz_abbrev: tz.abbrev,
      start: new Date(start).toISOString(), end: new Date(end).toISOString(),
      complete,
      log_newest: logNewest,
      scope: {
        projects: scopeNames,
        out_of_scope: { events: outOfScope.events, projects: outOfScope.projects.size },
        denied: deniedCount,
      },
      totals,
      agents,
      hours,
      unattributed,
      duplicates_dropped: duplicates,
      undated_dropped: undated,
      projects: list.map((p) => ({
        name: p.name,
        kind: p.kind,
        members: p.kind === 'non_repo' ? [...p.members].sort() : undefined,
        events: p.events,
        event_ids: p.event_ids,
        active_minutes: Math.round(p.active_ms / 60000),
        sessions: [...p.sessions.values()].map((s) => ({
          id: s.id, provider: s.provider, first: new Date(s.first).toISOString(),
          last: new Date(s.last).toISOString(), events: s.events,
        })),
        commits: p.commit_list.map(({ cwd: _cwd, authored: _authored, ...c }) => ({ ...c, at: new Date(c.at).toISOString() })),
        git_only_commits: p.git_only.map((c) => ({ ...c, at: new Date(c.at).toISOString() })),
        pushes: p.pushes,
        files: Object.fromEntries(Object.entries(p.files).sort((a, b) => b[1] - a[1])),
        files_unresolved: p.files_unresolved,
        investigations: [...p.investigations.values()],
        investigation_outcomes: p.outcomes,
        repo: p.repo,
      })),
    };
    return { text: JSON.stringify(doc, null, 2), code: 0 };
  }

  const weekday = new Date(start).toLocaleDateString('en-US', { weekday: 'short' });
  const agentLine = Object.entries(agents).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(' · ');
  const leavingFlags = (r) => {
    const flags = [];
    if (r.dirty > 0) flags.push(`${r.dirty} uncommitted`);
    if (r.unpushed && r.unpushed !== '0') flags.push(`${r.unpushed} unpushed`);
    return flags;
  };
  const leavingText = (r) => `${r.branch} · ${leavingFlags(r).join(' · ') || 'clean'}`;
  const statusMark = { landed: ' ', unverified: '?', rewritten: '↺', missing: '✗' };

  if (AS_MD) return { text: renderMarkdown(), code: 0 };
  return { text: renderPanel(), code: 0 };

  function renderPanel() {
    const LABEL = 10;
    const lines = [];
    const fit = (value) => truncate(String(value).trimEnd(), WIDTH - LABEL - 2);
    const row = (label, value) => lines.push(`  ${String(label).padEnd(LABEL)}${fit(value)}`);
    const cont = (value) => lines.push(`  ${' '.repeat(LABEL)}${fit(value)}`);
    const rule = (title) => {
      const head = title ? `━━ ${title} ` : '';
      lines.push(head + '━'.repeat(Math.max(0, WIDTH - head.length)));
    };

    rule(`day digest · ${weekday} ${day} · ${tz.abbrev}${complete ? '' : ' · so far'}`);
    lines.push('');
    if (totals.events === 0) {
      row('day', 'no logged events in scope');
      row('log', `newest event ${logNewest || 'unknown'} — ${logNewest && Date.parse(logNewest) >= start ? 'hooks are writing' : 'check the hooks'}`);
    } else {
      const commitsText = `${claimedTotal} commit${claimedTotal === 1 ? '' : 's'}`;
      const n = (count, word) => `${count.toLocaleString('en-US')} ${word}${count === 1 ? '' : 's'}`;
      row('day', [n(totals.events, 'event'), n(totals.sessions, 'session'), n(totals.projects, 'project'), commitsText]
        .concat(totals.pushes ? [n(totals.pushes, 'push').replace(/pushs$/, 'pushes')] : []).join(' · '));
      row('active', `${fmtDuration(totals.active_minutes * 60000)} wall clock · 5-min bins with any event`);
      row('hours', `${sparkline(hours)}  00→23`);
      if (agentLine) row('agents', agentLine);
      if (WITH_GIT && totals.commits_logged + totals.commits_git_only) {
        // Moved is a subset of landed; beside it the two would read as a sum.
        const g = [`${totals.commits_landed} landed${totals.commits_moved ? ` (${totals.commits_moved} moved →)` : ''}`];
        if (totals.commits_rewritten) g.push(`${totals.commits_rewritten} rewritten ↺`);
        if (totals.commits_missing) g.push(`${totals.commits_missing} missing ✗`);
        if (totals.commits_unverified) g.push(`${totals.commits_unverified} unverified ?`);
        if (totals.commits_git_only) g.push(`${totals.commits_git_only} git-only +`);
        // Wrap rather than truncate: the tail of this line is the part that
        // says something went wrong.
        const room = WIDTH - LABEL - 2;
        const packed = [];
        for (const item of g) {
          const last = packed.length - 1;
          if (last >= 0 && `${packed[last]} · ${item}`.length <= room) packed[last] = `${packed[last]} · ${item}`;
          else packed.push(item);
        }
        packed.forEach((text, i) => (i === 0 ? row('git', text) : cont(text)));
      }
    }
    const notes = [];
    if (scopeNames) notes.push(`${outOfScope.events.toLocaleString('en-US')} events in ${outOfScope.projects.size} projects out of scope`);
    if (deniedCount) notes.push(`${deniedCount} denied`);
    if (unattributed.project) notes.push(`${unattributed.project} with no project`);
    if (notes.length) row('not shown', notes.join(' · '));
    lines.push('');

    const minor = [];
    for (const p of list) {
      if (isMinor(p)) { minor.push(`${p.name} ${fmtDuration(p.active_ms)}`); continue; }
      const shownCommits = [
        ...p.commit_list.filter((c) => c.status !== 'rewritten').map((c) => (c.landed_as
          ? { ...c, hash: c.landed_as.slice(0, 7), mark: '→' }
          : { ...c, mark: statusMark[c.status] })),
        ...p.git_only.map((c) => ({ ...c, mark: '+', added: null })),
      ].sort((a, b) => a.at - b.at);
      const rewritten = p.commit_list.length - p.commit_list.filter((c) => c.status !== 'rewritten').length;
      const head = [p.name];
      // The header claims what the git line claims; ✗ and ? rows are shown
      // below for audit but are not counted as work.
      const claimedHere = p.commit_list.filter(claimable).length + p.git_only.length;
      if (p.kind === 'repo') head.push(`${claimedHere} commit${claimedHere === 1 ? '' : 's'}`);
      head.push(`${p.sessions.size} session${p.sessions.size === 1 ? '' : 's'}`, fmtDuration(p.active_ms));
      rule(head.join(' · '));
      lines.push('');
      if (p.kind === 'non_repo') row('as', [...p.members].sort().join(' · '));

      if (shownCommits.length) {
        const shown = shownCommits.slice(-MAX_COMMITS).map((c) => ({
          ...c, tail: c.added === null || c.added === undefined ? '' : `+${abbrev(c.added)} −${abbrev(c.removed)}`,
        }));
        const tailWidth = Math.max(...shown.map((c) => c.tail.length));
        // 5 clock + 2 + mark + 7 hash + 2, and the tail column when present.
        const room = Math.max(16, WIDTH - LABEL - 2 - 5 - 2 - 1 - 7 - 2 - (tailWidth ? tailWidth + 2 : 0));
        shown.forEach((c, i) => {
          const subject = truncate(c.subject || '(no subject)', room).padEnd(room);
          const tail = tailWidth ? `  ${c.tail.padStart(tailWidth)}` : '';
          const text = `${localClock(c.at)}  ${c.mark}${c.hash}  ${subject}${tail}`;
          if (i === 0) row('commits', text); else cont(text);
        });
        if (shownCommits.length > MAX_COMMITS) cont(`… ${shownCommits.length - MAX_COMMITS} earlier`);
      }
      if (rewritten) row('rewritten', `${rewritten} logged commit${rewritten === 1 ? '' : 's'} no longer on any branch (amend or rebase)`);

      for (const inv of p.investigations.values()) row('diagnosed', `${inv.outcome} · ${inv.symptom}`);
      if (p.outcomes.length) row('closed', p.outcomes.map((o) => `${o.outcome} ${o.resolves || ''}`.trim()).join(' · '));

      const fileRank = Object.entries(p.files).sort((a, b) => b[1] - a[1]);
      if (fileRank.length || p.files_unresolved) {
        row('files', `${fileRank.length} touched${p.files_unresolved ? ` · ${p.files_unresolved} unresolved` : ''}`);
        const room = WIDTH - LABEL - 2 - 6;
        for (const [file, n] of fileRank.slice(0, MAX_FILES)) cont(`${truncate(file, room).padEnd(room)}  ×${n}`);
      }
      if (p.repo) row('leaving', leavingText(p.repo));
      lines.push('');
    }

    if (minor.length) {
      row('also', minor.join(' · '));
      lines.push('');
    }
    if (list.length && WITH_GIT && (totals.commits_logged || totals.commits_git_only)) {
      lines.push('  → landed under a new sha  ↺ rewritten away  ✗ not in git  ? unchecked  + git only');
      lines.push('');
    }
    lines.push('━'.repeat(WIDTH));
    return lines.join('\n');
  }

  function renderMarkdown() {
    const out = [];
    const title = new Date(start).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
    out.push(`## ${title}${complete ? '' : ' (so far)'}`, '');
    if (totals.events === 0) {
      out.push(`No logged events in scope. Newest event in the log: ${logNewest || 'unknown'}.`, '');
      return out.join('\n');
    }
    const commitTotal = claimedTotal;
    out.push(`${commitTotal} commit${commitTotal === 1 ? '' : 's'} across ${totals.projects} project${totals.projects === 1 ? '' : 's'} · ~${fmtDuration(totals.active_minutes * 60000)} active · ${totals.sessions} sessions (${agentLine})`, '');

    const minor = [];
    for (const p of list) {
      const shown = [
        ...p.commit_list.filter(claimable).map((c) => ({ ...c, hash: (c.landed_as || c.sha).slice(0, 7), gitOnly: false })),
        ...p.git_only.map((c) => ({ ...c, gitOnly: true })),
      ].sort((a, b) => a.at - b.at);
      const unchecked = WITH_GIT ? p.commit_list.filter((c) => c.status === 'unverified').length : 0;
      const notInGit = p.commit_list.filter((c) => c.status === 'missing').length;
      const invs = [...p.investigations.values()];
      // A project with nothing to report but a few minutes of reads is a
      // mention, not a section.
      if (!shown.length && !unchecked && !notInGit && !invs.length && p.active_ms < 15 * 60000) {
        minor.push(p.name);
        continue;
      }
      const head = [];
      if (p.kind === 'repo') head.push(shown.length ? `${shown.length} commit${shown.length === 1 ? '' : 's'}` : 'no commits');
      head.push(`${p.sessions.size} session${p.sessions.size === 1 ? '' : 's'}`, `~${fmtDuration(p.active_ms)}`);
      out.push(`### ${p.kind === 'repo' ? p.name : `Outside any repo (${[...p.members].sort().join(', ')})`} — ${head.join(' · ')}`);
      // Whether a commit was logged by a session is an audit fact; the panel
      // and the JSON carry it. A receipt only needs to know that git has it.
      if (shown.length >= 10) {
        const scopes = scopeLine(shown);
        if (scopes) out.push(`By scope: ${scopes}`, '');
      }
      const { picked, unique } = receiptPicks(shown, MAX_COMMITS);
      for (const c of picked) out.push(`- ${c.subject || '(no subject)'} \`${c.hash}\``);
      if (unique > picked.length) out.push(`- …and ${unique - picked.length} more`);
      if (notInGit) out.push(`- _${notInGit} logged commit${notInGit === 1 ? '' : 's'} not found in git, so not listed_`);
      if (unchecked) out.push(`- _${unchecked} logged commit${unchecked === 1 ? '' : 's'} could not be checked against git, so ${unchecked === 1 ? 'it is' : 'they are'} not listed_`);
      for (const inv of invs) out.push(`- Diagnosed (${inv.outcome}): ${truncate(inv.symptom, 160)}`);
      if (!shown.length) {
        const top = Object.entries(p.files).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([f]) => f);
        if (top.length) out.push(`- Edited: ${top.join(', ')}${Object.keys(p.files).length > top.length ? ', …' : ''}`);
      }
      // Live state, read now: it describes the repository at render time, not
      // at the end of the day being described.
      if (p.repo && leavingFlags(p.repo).length) {
        out.push(`- Now: ${leavingFlags(p.repo).join(', ')} on \`${p.repo.branch}\``);
      }
      out.push('');
    }
    if (minor.length) out.push(`Also touched: ${minor.join(', ')}.`, '');
    const foot = ['Active time counts 5-minute bins with any logged event, sessions merged.'];
    if (WITH_GIT) foot.unshift('Commits are checked against git: each is reachable from a branch, remote, or tag.');
    if (scopeNames) foot.push(`${outOfScope.events} events in ${outOfScope.projects.size} projects outside the requested scope are not shown.`);
    out.push(`_${foot.join(' ')}_`);
    return out.join('\n');
  }
}
