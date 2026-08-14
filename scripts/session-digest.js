#!/usr/bin/env node
/**
 * Compact, checkable digest of a single session.
 *
 * Reads what the hooks already recorded for one session_id and renders it as a
 * glanceable panel: tempo, commits with diff shape, hottest files, research,
 * recall telemetry, and the live git state of every repo the session touched.
 *
 * Two audiences, one artifact. The human gets a session they can verify at a
 * glance (every line traces back to an event or to `git log`). The agent gets
 * ground truth to write its /wrapup synthesis against, instead of recalling the
 * session from its own conversation memory.
 *
 * Usage:
 *   node scripts/session-digest.js
 *   node scripts/session-digest.js --session <session-id>
 *   node scripts/session-digest.js --json
 *   node scripts/session-digest.js --no-git --commits 10
 */
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { isResolved, firstResolved } from './sentinels.js';

const DEV = process.env.CARTOGRAPHER_DEV_DIR || path.join(process.env.HOME, 'Documents/dev');
const CHANGELOG = process.env.CARTOGRAPHER_CHANGELOG || path.join(DEV, 'changelog.jsonl');
const SERVED_LOG = process.env.CARTOGRAPHER_SERVED_LOG || path.join(DEV, 'served-log.jsonl');
const ACCESS_LEDGER = process.env.CARTOGRAPHER_ACCESS_LEDGER || path.join(DEV, 'access-ledger.jsonl');

const args = process.argv.slice(2);
const valueAfter = (flag, fallback) => {
  const idx = args.indexOf(flag);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : fallback;
};
const AS_JSON = args.includes('--json');
const WITH_GIT = !args.includes('--no-git');
const WIDTH = Math.max(60, Number.parseInt(valueAfter('--width', '84'), 10) || 84);
const MAX_COMMITS = Number.parseInt(valueAfter('--commits', '6'), 10) || 6;
const MAX_FILES = Number.parseInt(valueAfter('--files', '5'), 10) || 5;
// CLAUDE_CODE_SESSION_ID is what Claude Code exports to tool calls;
// CLAUDE_SESSION_ID is a legacy name that is never actually set.
const SESSION = valueAfter(
  '--session',
  process.env.CARTOGRAPHER_SESSION_ID
    || process.env.CLAUDE_SESSION_ID
    || process.env.CLAUDE_CODE_SESSION_ID
    || process.env.CODEX_SESSION_ID
    || ''
);

if (!isResolved(SESSION)) {
  console.error('No session id. Pass --session <id> or set CARTOGRAPHER_SESSION_ID.');
  process.exit(2);
}

// changelog.jsonl is the union of the research, milestone, and tool-use logs —
// read it alone or every event gets counted twice.
function readSessionEvents(filePath, sessionId) {
  if (!fs.existsSync(filePath)) return [];
  const out = [];
  for (const line of fs.readFileSync(filePath, 'utf8').split('\n')) {
    // Substring guard first: parsing 60k JSON objects to find ~500 is wasteful.
    if (!line || !line.includes(sessionId)) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    const sid = event.session_id || event.session || '';
    if (sid === sessionId) out.push(event);
  }
  return out.sort((a, b) => (a.timestamp || '').localeCompare(b.timestamp || ''));
}

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8').split('\n')
    .filter(Boolean)
    .map((line) => { try { return JSON.parse(line); } catch { return null; } })
    .filter(Boolean);
}

const events = readSessionEvents(CHANGELOG, SESSION);
if (events.length === 0) {
  console.error(`No events logged for session ${SESSION}.`);
  console.error('Hooks may be disabled, or this session made no tracked tool calls yet.');
  process.exit(1);
}

// ---------------------------------------------------------------- aggregation

const counts = {};
for (const e of events) counts[e.type || '?'] = (counts[e.type || '?'] || 0) + 1;

const times = events.map((e) => Date.parse(e.timestamp)).filter(Number.isFinite);
const startMs = Math.min(...times);
const endMs = Math.max(...times);

function fmtDuration(ms) {
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  return `${h}h${String(mins % 60).padStart(2, '0')}m`;
}

const iso = (ms) => new Date(ms).toISOString();
const clock = (ms) => iso(ms).slice(11, 16);
const day = (ms) => iso(ms).slice(0, 10);
// Sessions get resumed across days. Suppressing the date would render a
// five-day arc as a one-hour one.
const MULTI_DAY = day(startMs) !== day(endMs);
const stamp = (ms) => (MULTI_DAY ? `${iso(ms).slice(5, 10)} ${clock(ms)}` : clock(ms));

// Tempo: bucket every event across the span. Shows where the work actually was,
// which a start/end timestamp pair hides.
const SPARK = '▁▂▃▄▅▆▇█';
function tempo(buckets) {
  const span = endMs - startMs;
  if (span <= 0) return { bar: '█', bucketMs: 0 };
  const bins = new Array(buckets).fill(0);
  for (const t of times) {
    const idx = Math.min(buckets - 1, Math.floor(((t - startMs) / span) * buckets));
    bins[idx] += 1;
  }
  const peak = Math.max(...bins);
  const bar = bins.map((n) => {
    if (n === 0) return '·'; // an empty bucket is a gap, not a low bar
    return SPARK[Math.min(SPARK.length - 1, Math.floor((n / peak) * SPARK.length))];
  }).join('');
  return { bar, bucketMs: span / buckets };
}

const projects = {};
for (const e of events) {
  const p = e.project || 'unknown';
  projects[p] = (projects[p] || 0) + 1;
}
const projectRank = Object.entries(projects).sort((a, b) => b[1] - a[1]);

// Commit summaries carry escaped newlines and a trailing `| files:` tail from
// the hook's flattening pass. Recover just the subject line.
function commitParts(summary) {
  const text = String(summary || '');
  const m = text.match(/Commit ([0-9a-f]{6,40}):\s*([\s\S]*)$/);
  if (!m) return null;
  const subject = m[2]
    .split(/\\n|\n/)[0]
    .split(' | files:')[0]
    .replace(/["',]\s*$/, '')
    .trim();
  const typeMatch = text.match(/^\[([a-z]+)\]/);
  return { hash: m[1].slice(0, 7), subject, type: typeMatch ? typeMatch[1] : 'other' };
}

const commits = [];
for (const e of events) {
  if (e.type !== 'git_commit') continue;
  const parts = commitParts(e.summary);
  if (!parts) continue;
  const shape = e.diff_shape || {};
  commits.push({
    ...parts,
    at: Date.parse(e.timestamp),
    added: shape.lines_added ?? null,
    removed: shape.lines_removed ?? null,
    quadrant: shape.quadrant || null,
    project: e.project || 'unknown',
  });
}
commits.sort((a, b) => b.at - a.at);

const commitTypes = {};
const commitShapes = {};
for (const c of commits) {
  commitTypes[c.type] = (commitTypes[c.type] || 0) + 1;
  if (c.quadrant) commitShapes[c.quadrant] = (commitShapes[c.quadrant] || 0) + 1;
}

// Relativize against the project segment, not cwd: the same file edited from
// the repo root and from a subdirectory must collapse to one entry.
function relativize(abs, project) {
  if (isResolved(project)) {
    const marker = `/${project}/`;
    const at = abs.lastIndexOf(marker);
    if (at >= 0) return abs.slice(at + marker.length);
  }
  return abs.startsWith(`${DEV}/`) ? abs.slice(DEV.length + 1) : abs;
}

const fileHits = {};
for (const e of events) {
  if (e.type !== 'tool_file_edit') continue;
  const m = String(e.summary || '').match(/^Modified:\s*(.+)$/);
  if (!m) continue;
  const rel = relativize(m[1].trim(), e.project);
  fileHits[rel] = (fileHits[rel] || 0) + 1;
}
const fileRank = Object.entries(fileHits).sort((a, b) => b[1] - a[1]);

const hosts = {};
for (const e of events) {
  if (e.type !== 'research_fetch' && e.type !== 'fetch') continue;
  let host;
  try { host = new URL(e.url).hostname.replace(/^www\./, ''); } catch { continue; }
  hosts[host] = (hosts[host] || 0) + 1;
}
const searches = (counts.research_search || 0) + (counts.search || 0);

const subagents = {};
for (const e of events) {
  const m = String(e.type || '').match(/^milestone_agent_(.+)$/);
  if (m) subagents[m[1]] = (subagents[m[1]] || 0) + 1;
}
const compactions = (counts.milestone_compaction_auto || 0) + (counts.milestone_compaction_manual || 0);

// Recall telemetry: how much past context this session pulled in, and how much
// of it was actually vouched for with --touch.
const servedRows = readJsonl(SERVED_LOG).filter((r) => r.session_id === SESSION);
const callIds = new Set(servedRows.map((r) => r.call_id).filter(Boolean));
const usedRows = readJsonl(ACCESS_LEDGER)
  .filter((r) => r.source === 'result_used' && callIds.has(r.call_id));
const usedEventIds = [...new Set(usedRows.map((r) => r.event_id).filter(Boolean))];

// Live git state per repo the session touched. This is the part that is not in
// any log — it is what the session is leaving behind right now.
function repoState(dir) {
  const git = (argv) => execFileSync('git', ['-C', dir, ...argv], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
  try {
    const root = git(['rev-parse', '--show-toplevel']);
    const branch = git(['branch', '--show-current']) || 'detached';
    const dirty = git(['status', '--porcelain']).split('\n').filter(Boolean).length;
    let unpushed = null;
    try {
      unpushed = git(['rev-list', '--count', '@{u}..HEAD']);
    } catch { unpushed = null; } // no upstream configured
    return { root, name: path.basename(root), branch, dirty, unpushed };
  } catch {
    return null;
  }
}

const repos = [];
if (WITH_GIT) {
  const seen = new Set();
  const dirs = [...new Set(events.map((e) => e.cwd).filter(Boolean))];
  for (const dir of dirs) {
    if (repos.length >= 4) break;
    const state = repoState(dir);
    if (!state || seen.has(state.root)) continue;
    seen.add(state.root);
    repos.push(state);
  }
}

// ------------------------------------------------------------------ rendering

const LABEL = 10;
const lines = [];
const rule = (title) => {
  const head = title ? `━━ ${title} ` : '';
  lines.push(head + '━'.repeat(Math.max(0, WIDTH - head.length)));
};
// Every row is clamped to the panel width — a wrapped line destroys the
// column alignment that makes the panel scannable.
const fit = (value) => truncate(String(value).trimEnd(), WIDTH - LABEL - 2);
const row = (label, value) => lines.push(`  ${String(label).padEnd(LABEL)}${fit(value)}`);
const cont = (value) => lines.push(`  ${' '.repeat(LABEL)}${fit(value)}`);
const blank = () => lines.push('');
const truncate = (text, max) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);
const abbrev = (n) => (n >= 10000 ? `${(n / 1000).toFixed(1)}k` : String(n));

const { bar, bucketMs } = tempo(Math.min(32, Math.max(12, WIDTH - LABEL - 22)));
const topProject = projectRank[0][0];

// Not every hook stamps provider; fall back to which store the transcript is in.
const transcriptPath = events.find((e) => e.transcript_path)?.transcript_path || '';
const provider = firstResolved(
  events.map((e) => e.provider),
  transcriptPath.includes('/.codex/') ? 'codex' : 'claude'
);

rule(`session digest · ${topProject}`);
blank();
row('session', `${SESSION.slice(0, 8)} · ${provider} · ${events.length} events`);
row('span', `${day(startMs)} ${clock(startMs)} → ${MULTI_DAY ? `${day(endMs)} ` : ''}${clock(endMs)} UTC · ${fmtDuration(endMs - startMs)}`);
// Below a few minutes of span the sparkline is two spikes and a "0m/mark"
// label — noise dressed as a chart.
if (bucketMs >= 60000) row('tempo', `${bar}  (${fmtDuration(bucketMs)}/mark)`);
if (projectRank.length > 1) {
  row('projects', projectRank.slice(0, 4).map(([p, n]) => `${p} ${n}`).join(' · '));
}

const activity = [];
if (counts.tool_file_edit) activity.push(`${counts.tool_file_edit} edits`);
if (counts.tool_bash) activity.push(`${counts.tool_bash} bash`);
if (searches) activity.push(`${searches} searches`);
if (Object.keys(hosts).length) {
  activity.push(`${Object.values(hosts).reduce((a, b) => a + b, 0)} fetches`);
}
if (compactions) activity.push(`${compactions} compaction${compactions > 1 ? 's' : ''}`);
const agentTotal = Object.values(subagents).reduce((a, b) => a + b, 0);
if (agentTotal) {
  const named = Object.entries(subagents).sort((a, b) => b[1] - a[1])
    .map(([name, n]) => (n > 1 ? `${name}×${n}` : name)).join(',');
  activity.push(`subagents ${named}`);
}
if (activity.length) row('activity', activity.join(' · '));

if (commits.length) {
  blank();
  const mix = Object.entries(commitTypes).sort((a, b) => b[1] - a[1])
    .map(([t, n]) => `${n} ${t}`).join(' · ');
  row('commits', `${commits.length}${counts.git_push ? ` · ${counts.git_push} pushes` : ''}`);
  const shape = Object.entries(commitShapes).sort((a, b) => b[1] - a[1])
    .map(([q, n]) => `${n} ${q}`).join(' · ');
  // With a single commit the mix restates the row below it.
  if (commits.length > 1) {
    cont(`${mix}${shape ? `  ▸  ${shape}` : ''}`);
    blank();
  }

  // Size the churn tail once so every row lands in the same column. Quadrant
  // lives in the aggregate line above — per-row it crowds out the subject,
  // which is the part worth reading.
  const shown = commits.slice(0, MAX_COMMITS).map((c) => ({
    ...c,
    tail: c.added === null ? '' : `+${abbrev(c.added)} −${abbrev(c.removed)}`,
  }));
  const tailWidth = Math.max(...shown.map((c) => c.tail.length));
  const timeWidth = stamp(startMs).length;
  const room = Math.max(16, WIDTH - LABEL - timeWidth - 2 - 7 - 2 - (tailWidth ? tailWidth + 2 : 0));
  for (const c of shown) {
    const subject = truncate(c.subject, room).padEnd(room);
    const tail = tailWidth ? `  ${c.tail.padStart(tailWidth)}` : '';
    cont(`${stamp(c.at)}  ${c.hash}  ${subject}${tail}`);
  }
  if (commits.length > MAX_COMMITS) cont(`… ${commits.length - MAX_COMMITS} more`);
}

if (fileRank.length) {
  blank();
  row('files', `${fileRank.length} touched`);
  for (const [file, n] of fileRank.slice(0, MAX_FILES)) {
    const room = WIDTH - LABEL - 2 - 6;
    cont(`${truncate(file, room).padEnd(room)}  ×${n}`);
  }
}

const hostRank = Object.entries(hosts).sort((a, b) => b[1] - a[1]);
if (hostRank.length) {
  blank();
  row('research', truncate(hostRank.map(([h, n]) => `${h} (${n})`).join(' · '), WIDTH - LABEL - 2));
}

if (servedRows.length) {
  blank();
  const pct = ((usedEventIds.length / servedRows.length) * 100).toFixed(0);
  const calls = `${callIds.size} call${callIds.size === 1 ? '' : 's'}`;
  row('recall', `${calls} → ${servedRows.length} served · ${usedEventIds.length} used (${pct}%)`);
  if (usedEventIds.length) cont(truncate(usedEventIds.join(' '), WIDTH - LABEL - 2));
}

if (repos.length) {
  blank();
  const NAME = 34;
  repos.forEach((r, i) => {
    const flags = [];
    if (r.dirty > 0) flags.push(`${r.dirty} uncommitted`);
    if (r.unpushed && r.unpushed !== '0') flags.push(`${r.unpushed} unpushed`);
    if (!flags.length) flags.push('clean');
    const line = `${truncate(`${r.name}@${r.branch}`, NAME).padEnd(NAME)}  ${flags.join(' · ')}`;
    if (i === 0) row('leaving', line); else cont(line);
  });
}

blank();
lines.push('━'.repeat(WIDTH));

if (AS_JSON) {
  console.log(JSON.stringify({
    session_id: SESSION,
    provider: events[0].provider || 'unknown',
    event_count: events.length,
    started_at: iso(startMs),
    ended_at: iso(endMs),
    duration_minutes: Math.round((endMs - startMs) / 60000),
    projects: Object.fromEntries(projectRank),
    counts,
    commits,
    commit_types: commitTypes,
    commit_shapes: commitShapes,
    files: Object.fromEntries(fileRank),
    research_hosts: Object.fromEntries(hostRank),
    searches,
    compactions,
    subagents,
    recall: {
      calls: callIds.size,
      served: servedRows.length,
      used: usedEventIds.length,
      used_event_ids: usedEventIds,
    },
    repos,
  }, null, 2));
} else {
  console.log(lines.join('\n'));
}
