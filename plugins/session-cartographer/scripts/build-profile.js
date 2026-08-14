#!/usr/bin/env node
/**
 * Derive a length-budgeted profile from the event corpus.
 *
 * The event logs answer "what happened on 2026-04-05." They do not answer
 * "what does this person work on, when, and how" without an agent reading a
 * few thousand events first. This renders that standing summary once, to a
 * stable path, so recall can start from the top of the pyramid instead of
 * always starting from a record lookup.
 *
 * Everything here is derived — delete the file and it rebuilds. It is not a
 * place to write facts by hand; CLAUDE.md already owns hand-authored context,
 * and duplicating it here would create two sources of truth that drift.
 *
 * Ownership matters: backfilled git history includes commits from cloned
 * repos by other authors. A profile built without filtering those describes
 * a composite of everyone whose repo you ever cloned. Commits count only when
 * the author matches the owner set or the commit carries a session_id.
 *
 * Usage:
 *   node scripts/build-profile.js
 *   node scripts/build-profile.js --budget 6000 --window 180d
 *   node scripts/build-profile.js --json
 *   node scripts/build-profile.js --no-write        # print only
 */
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';

const DEV = process.env.CARTOGRAPHER_DEV_DIR || path.join(process.env.HOME, 'Documents/dev');
const CHANGELOG = process.env.CARTOGRAPHER_CHANGELOG || path.join(DEV, 'changelog.jsonl');
// /wrapup writes to session-milestones.jsonl, and only a handful of milestones
// are mirrored into the changelog. Reading the changelog alone left the whole
// synthesis layer — 508 records — outside the profile's view.
const MILESTONES = process.env.CARTOGRAPHER_MILESTONES || path.join(DEV, 'session-milestones.jsonl');
const SERVED_LOG = process.env.CARTOGRAPHER_SERVED_LOG || path.join(DEV, 'served-log.jsonl');
const ACCESS_LEDGER = process.env.CARTOGRAPHER_ACCESS_LEDGER || path.join(DEV, 'access-ledger.jsonl');

const args = process.argv.slice(2);
const valueAfter = (flag, fallback) => {
  const idx = args.indexOf(flag);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : fallback;
};
const AS_JSON = args.includes('--json');
const WRITE = !args.includes('--no-write');
const QUIET = args.includes('--quiet');
const BUDGET = Math.max(500, Number.parseInt(valueAfter('--budget', '4000'), 10) || 4000);
const OUT = valueAfter('--out', path.join(DEV, '.carto', 'profile.md'));

// Activity sections describe the current working surface, so they are
// windowed. Preferences and decisions are the stable layer and are not.
const WINDOW_DAYS = (() => {
  const raw = valueAfter('--window', '90d');
  const m = /^(\d+)\s*([dwmy])?$/.exec(String(raw).trim());
  if (!m) return 90;
  const n = Number(m[1]);
  return { d: n, w: n * 7, m: n * 30, y: n * 365 }[m[2] || 'd'];
})();

// ─── Owner identity ───
function gitUserName() {
  try {
    return execFileSync('git', ['config', '--global', 'user.name'], { encoding: 'utf8' }).trim();
  } catch { return ''; }
}
const OWNERS = new Set(
  (process.env.CARTOGRAPHER_PROFILE_AUTHORS || gitUserName())
    .split(',').map((s) => s.trim()).filter(Boolean)
    // Agent-authored commits made inside the owner's sessions are the owner's
    // work for profiling purposes — they are what the owner shipped.
    .concat(['Claude', 'claude'])
);

// ─── Non-projects ───
// `project` is derived from the session cwd, so sessions started in the home
// directory or the workspace root produce a "project" named after that
// directory. Left in, `andyed` outranks every real project on event count and
// the active surface describes the filesystem instead of the work.
const NON_PROJECTS = new Set(
  (process.env.CARTOGRAPHER_PROFILE_EXCLUDE || '')
    .split(',').map((s) => s.trim()).filter(Boolean)
    .concat([
      path.basename(process.env.HOME || ''),
      path.basename(DEV),
      '/', '?', '', 'unknown', 'tmp', 'Documents',
    ])
);

// ─── Project family lookup ───
const familyOf = (() => {
  const map = new Map();
  for (const dir of [path.join(DEV, 'session-cartographer'), process.cwd()]) {
    const file = path.join(dir, 'project-registry.json');
    if (!fs.existsSync(file)) continue;
    try {
      const registry = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const [family, members] of Object.entries(registry.aliases || {})) {
        for (const member of members) map.set(member, family);
      }
      break;
    } catch { /* registry is optional */ }
  }
  return (project) => map.get(project) || '';
})();

// ─── Load ───
const now = Date.now();
const windowStart = now - WINDOW_DAYS * 86400000;
const toMs = (ts) => {
  const ms = Date.parse(ts || '');
  return Number.isFinite(ms) ? ms : null;
};

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    try { out.push(JSON.parse(line)); } catch { /* skip torn line */ }
  }
  return out;
}

// Derived output hides its own gaps: a section built from zero matching events
// renders as a short section, not as an error. Warnings go to stderr so they
// never contaminate --json or the profile itself.
const warnings = [];
function warn(message) {
  warnings.push(message);
  console.error(`warning: ${message}`);
}

const events = readJsonl(CHANGELOG);
if (!events.length) {
  console.error(`No events in ${CHANGELOG}. Nothing to profile.`);
  process.exit(2);
}

function isOwn(event) {
  if (event.type !== 'git_commit') return true;
  if (event.session_id) return true;
  return OWNERS.has(event.author || '');
}

const own = events.filter(isOwn);
const corpusEnd = own.reduce((max, e) => {
  const ms = toMs(e.timestamp);
  return ms && ms > max ? ms : max;
}, 0);
const recent = own.filter((e) => {
  const ms = toMs(e.timestamp);
  return ms !== null && ms >= windowStart && ms <= now + 86400000;
});

// ─── Aggregates ───
const projects = new Map();
for (const e of recent) {
  const name = e.project;
  if (!name || NON_PROJECTS.has(name)) continue;
  if (!projects.has(name)) {
    projects.set(name, { name, events: 0, commits: 0, sessions: new Set(), last: 0 });
  }
  const p = projects.get(name);
  p.events++;
  if (e.type === 'git_commit') p.commits++;
  if (e.session_id) p.sessions.add(e.session_id);
  const ms = toMs(e.timestamp);
  if (ms && ms > p.last) p.last = ms;
}
const activeProjects = [...projects.values()].sort((a, b) => b.last - a.last);

// Sessions: span and per-hour occupancy, from the windowed own-event stream.
const sessions = new Map();
const hourCounts = new Array(24).fill(0);
const hourSessions = new Map();
let weekendEvents = 0;
for (const e of recent) {
  const ms = toMs(e.timestamp);
  if (ms === null) continue;
  const d = new Date(ms);
  hourCounts[d.getHours()]++;
  if (d.getDay() === 0 || d.getDay() === 6) weekendEvents++;
  if (!e.session_id) continue;
  if (!sessions.has(e.session_id)) sessions.set(e.session_id, { first: ms, last: ms, n: 0 });
  const s = sessions.get(e.session_id);
  s.n++;
  if (ms < s.first) s.first = ms;
  if (ms > s.last) s.last = ms;
  const bucket = Math.floor(ms / 3600000);
  if (!hourSessions.has(bucket)) hourSessions.set(bucket, new Set());
  hourSessions.get(bucket).add(e.session_id);
}

const median = (nums) => {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

// Substantive = more than one event. Sessions that opened and closed without
// doing anything are the majority, and counting them makes concurrency read
// as 114 simultaneous sessions when the real figure is single digits.
const substantive = new Set(
  [...sessions.entries()].filter(([, s]) => s.n > 1).map(([id]) => id)
);
const sessionSpans = [...sessions.values()].filter((s) => s.n > 1).map((s) => (s.last - s.first) / 60000);
const concurrency = [...hourSessions.values()]
  .map((set) => [...set].filter((id) => substantive.has(id)).length)
  .filter((n) => n > 0);
const multiSessionHours = concurrency.filter((n) => n > 1).length;

const ownCommits = recent.filter((e) => e.type === 'git_commit');
const quadrants = new Map();
const commitTypes = new Map();
const churn = [];
for (const c of ownCommits) {
  const shape = c.diff_shape || {};
  if (shape.quadrant) quadrants.set(shape.quadrant, (quadrants.get(shape.quadrant) || 0) + 1);
  if (shape.commit_type) commitTypes.set(shape.commit_type, (commitTypes.get(shape.commit_type) || 0) + 1);
  const added = Number(shape.lines_added);
  const removed = Number(shape.lines_removed);
  if (Number.isFinite(added) && Number.isFinite(removed)) churn.push(added + removed);
}

const compactions = recent.filter((e) => String(e.type).startsWith('milestone_compaction')).length;

// Preferences and decisions come from the whole corpus, not the window — a
// standing instruction does not expire because it was written in March.
const memoryEvents = own.filter((e) => e.type === 'memory_feedback' || e.type === 'memory_user');
const latestByName = new Map();
for (const e of memoryEvents) {
  const key = e.memory_name || e.event_id;
  const prev = latestByName.get(key);
  if (!prev || (toMs(e.timestamp) || 0) > (toMs(prev.timestamp) || 0)) latestByName.set(key, e);
}
const preferences = [...latestByName.values()]
  .sort((a, b) => (toMs(b.timestamp) || 0) - (toMs(a.timestamp) || 0));

// Two shapes carry structured session outcomes. `session_end_strategic` is the
// original; `session_wrapup` is what /wrapup writes today. Reading only the
// first meant this section drew from the two strategic records in the entire
// corpus while 508 wrapups went unseen — five decisions from one project on one
// day, presented as the standing set.
//
// A wrapup's prose `description` is deliberately NOT mined for decisions.
// Measured across 508 of them, explicit decision markers appear in ~4%, while
// the one frequent marker ("hard problem", 29.5%) is a problem, not a decision.
// Regex-harvesting it would fill this section with mislabeled content, which is
// worse than showing less. Decisions come from the structured field or not at all.
const isStrategic = (e) => e.type === 'session_end_strategic'
  || e.milestone === 'session_end_strategic'
  || e.milestone === 'session_wrapup';

// Milestones are read from their own log and de-duplicated against the few the
// changelog mirrors, so a record present in both is not counted twice.
const seenMilestoneIds = new Set(events.map((e) => e.event_id).filter(Boolean));
const milestoneEvents = readJsonl(MILESTONES)
  .filter((e) => !e.event_id || !seenMilestoneIds.has(e.event_id));

const strategic = [...own, ...milestoneEvents.filter(isOwn)]
  .filter(isStrategic)
  .sort((a, b) => (toMs(b.timestamp) || 0) - (toMs(a.timestamp) || 0));
const decisions = [];
for (const s of strategic) {
  for (const d of s.decisions || []) {
    if (typeof d !== 'string' || !d.trim()) continue;
    decisions.push({ project: s.project || '?', when: (s.timestamp || '').slice(0, 10), text: d.trim() });
  }
  if (typeof s.key_insight === 'string' && s.key_insight.trim()) {
    decisions.push({
      project: s.project || '?',
      when: (s.timestamp || '').slice(0, 10),
      text: s.key_insight.trim(),
    });
  }
}

// A harvester that matches nothing is indistinguishable from a quiet corpus.
// Both of this file's silent failures — the strategic-only filter here and the
// owner filter on commits — would have announced themselves months earlier with
// one line of output.
// Warning on zero alone is too weak a guard: before 0.5.1 this section drew 5
// decisions from the 2 records in the corpus that had the field, while 508
// wrapups had none — non-zero, and completely unrepresentative. Report coverage
// so a thin section is legible as a thin section.
const withDecisions = strategic.filter(
  (s) => (Array.isArray(s.decisions) && s.decisions.length) || s.key_insight
).length;
if (strategic.length === 0) {
  warn('no session_wrapup or session_end_strategic events found — "Durable decisions" will be empty');
} else if (withDecisions === 0) {
  warn(`0 of ${strategic.length} session syntheses carry a structured decisions field — `
    + '"Durable decisions" will be empty until /wrapup (0.5.1+) writes them');
} else if (withDecisions < strategic.length * 0.1) {
  warn(`only ${withDecisions} of ${strategic.length} session syntheses carry structured `
    + 'decisions — this section is drawn from a small, possibly unrepresentative slice');
}

// Recall behaviour: how the owner's agents actually use the memory they have.
const served = readJsonl(SERVED_LOG);
const uses = readJsonl(ACCESS_LEDGER);
const exactUses = new Set(uses.filter((u) => u.call_id && u.event_id).map((u) => `${u.call_id}\0${u.event_id}`));
const attributedServed = served.filter((r) => r.call_id);
const servedHits = attributedServed.filter((r) => exactUses.has(`${r.call_id}\0${r.event_id}`)).length;
const purposes = new Map();
for (const r of served) purposes.set(r.purpose || 'legacy', (purposes.get(r.purpose || 'legacy') || 0) + 1);

// ─── Render ───
const pct = (n, d) => (d ? Math.round((n / d) * 100) : 0);
const ago = (ms) => {
  if (!ms) return 'never';
  const mins = Math.round((now - ms) / 60000);
  if (mins < 60) return `${mins}m ago`;
  if (mins < 1440) return `${Math.round(mins / 60)}h ago`;
  return `${Math.round(mins / 1440)}d ago`;
};
const clip = (s, n) => {
  const flat = String(s || '').replace(/\s+/g, ' ').trim();
  return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat;
};
const topN = (map, n) => [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);

const peakHours = hourCounts
  .map((n, h) => ({ h, n }))
  .sort((a, b) => b.n - a.n)
  .slice(0, 3)
  .sort((a, b) => a.h - b.h)
  .map(({ h }) => `${String(h).padStart(2, '0')}:00`);

// Sections render in priority order and are trimmed from the tail to fit the
// budget. A profile that silently grows past its budget is just the corpus
// again, which is the thing this file exists to avoid.
const sections = [];

sections.push({
  title: 'Active surface',
  minLines: 3,
  // Session count is dropped deliberately: a project whose events arrive from
  // a background service shows thousands of one-event sessions and reads as
  // the busiest thing on the list. Events and commits are the honest signals.
  lines: activeProjects.slice(0, 8).map((p) => {
    const family = familyOf(p.name);
    const bits = [`${p.events} events`];
    if (p.commits) bits.push(`${p.commits} commits`);
    return `- **${p.name}**${family ? ` _(${family})_` : ''} — ${ago(p.last)} · ${bits.join(' · ')}`;
  }),
});

if (preferences.length) {
  sections.push({
    title: 'Standing preferences and instructions',
    minLines: 2,
    note: 'Derived from captured memory files. The memory file is authoritative; this is an index.',
    lines: preferences.slice(0, 6).map((p) => {
      const summary = clip(String(p.summary || '').replace(/^Memory \[[a-z]+\]:\s*/, ''), 140);
      // Root-scoped memories carry the home directory as their "project".
      // Tagging every global preference with it is noise.
      const scope = NON_PROJECTS.has(p.project) || /^Users-/.test(p.project || '') ? '' : p.project;
      return `- ${summary}${scope ? ` _(${scope})_` : ''}`;
    }),
  });
}

if (decisions.length) {
  sections.push({
    title: 'Durable decisions',
    minLines: 2,
    note: 'From /wrapup syntheses — the non-obvious calls that were expensive to derive.',
    lines: decisions.slice(0, 5).map((d) => `- ${clip(d.text, 150)} _(${d.project}, ${d.when})_`),
  });
}

if (ownCommits.length) {
  // Percentages run against commits that actually carry a diff shape, not all
  // commits — backfilled history often has none, and using the full commit
  // count silently reports a mix that sums to well under 100%.
  const shaped = [...quadrants.values()].reduce((a, b) => a + b, 0);
  const shapeLine = topN(quadrants, 4)
    .map(([k, v]) => `${k} ${pct(v, shaped)}%`)
    .join(' · ');
  const typeLine = topN(commitTypes, 5).map(([k, v]) => `${k} ${v}`).join(' · ');
  sections.push({
    title: 'Work shape',
    minLines: 1,
    lines: [
      `- ${ownCommits.length} own commits in the last ${WINDOW_DAYS}d across ${new Set(ownCommits.map((c) => c.project)).size} projects`,
      shapeLine ? `- Diff shape: ${shapeLine} _(of ${shaped} shaped commits)_` : '',
      typeLine ? `- Commit types: ${typeLine}` : '',
      churn.length ? `- Median commit churn: ${Math.round(median(churn))} lines` : '',
    ].filter(Boolean),
  });
}

sections.push({
  title: 'Cadence',
  minLines: 1,
  lines: [
    // Most session ids appear once, from a session that opened and closed
    // without doing anything. Leading with the raw count overstates the work.
    `- ${sessionSpans.length} substantive sessions in the last ${WINDOW_DAYS}d (${sessions.size} opened) · median span ${Math.round(median(sessionSpans))}m`,
    `- Peak hours (local): ${peakHours.join(', ')} · weekend share ${pct(weekendEvents, recent.length)}%`,
    concurrency.length
      ? `- Concurrent work: ${multiSessionHours} of ${concurrency.length} active hours had >1 session (max ${Math.max(...concurrency)})`
      : '',
    compactions ? `- ${compactions} compactions — ${(compactions / Math.max(1, sessionSpans.length)).toFixed(2)} per substantive session` : '',
  ].filter(Boolean),
});

if (served.length) {
  sections.push({
    title: 'Recall behaviour',
    minLines: 1,
    lines: [
      `- ${served.length} results served · ${uses.length} recorded uses`,
      attributedServed.length
        ? `- Exactly-attributed hit rate: ${pct(servedHits, attributedServed.length)}% of ${attributedServed.length} served rows`
        : '- No exactly-attributed rows yet — treat use counts as a floor, not a rate',
      `- By purpose: ${topN(purposes, 4).map(([k, v]) => `${k} ${v}`).join(' · ')}`,
    ].filter(Boolean),
  });
}

const header = [
  '# Profile',
  '',
  `_Derived from ${own.length.toLocaleString()} own events (${events.length.toLocaleString()} total) through ` +
    `${new Date(corpusEnd).toISOString().slice(0, 10)}. Activity sections cover the last ${WINDOW_DAYS} days._`,
  `_Generated ${new Date(now).toISOString().slice(0, 16).replace('T', ' ')}Z by \`scripts/build-profile.js\`. ` +
    'Regenerate rather than edit — hand edits are lost on rebuild._',
  '',
];

// First-come-first-served spending starves the tail: twelve project lines eat
// the budget and the cadence and recall sections never render. Each section
// may spend everything except what the sections after it need to clear their
// own minimums, so priority still wins ties but never crowds anyone out.
const minCost = (section) =>
  `## ${section.title}\n`.length
  + (section.note ? section.note.length + 6 : 0)
  + section.lines.slice(0, section.minLines).reduce((sum, line) => sum + line.length + 1, 0)
  + 2;

let used = header.join('\n').length;
const rendered = [...header];
const omitted = [];
const thin = []; // dropped for lack of content, not for budget
for (let i = 0; i < sections.length; i++) {
  const section = sections[i];
  const reserved = sections.slice(i + 1).reduce((sum, s) => sum + minCost(s), 0);
  const allowance = BUDGET - reserved;
  const head = `## ${section.title}\n`;
  const note = section.note ? `_${section.note}_\n\n` : '';
  let cost = head.length + note.length + 2;
  const kept = [];
  for (const line of section.lines) {
    if (used + cost + line.length + 1 > allowance) break;
    kept.push(line);
    cost += line.length + 1;
  }
  if (kept.length < section.minLines) {
    // Two different causes, and conflating them sends you hunting the wrong
    // one: the section may have had too little content to begin with, or the
    // budget may have squeezed it out. Say which.
    if (section.lines.length < section.minLines) thin.push(section.title);
    else omitted.push(section.title);
    continue;
  }
  rendered.push(`## ${section.title}`, '');
  if (section.note) rendered.push(`_${section.note}_`, '');
  rendered.push(...kept, '');
  used += cost;
  if (kept.length < section.lines.length) {
    const dropped = section.lines.length - kept.length;
    rendered.push(`_(${dropped} more trimmed for budget)_`, '');
    used += 40;
  }
}
if (omitted.length) rendered.push(`_Sections omitted for budget: ${omitted.join(', ')}._`, '');
if (thin.length) {
  rendered.push(`_Sections with too little data yet: ${thin.join(', ')}._`, '');
  warn(`too little data to render: ${thin.join(', ')}`);
}

const markdown = rendered.join('\n');

if (AS_JSON) {
  console.log(JSON.stringify({
    generated: new Date(now).toISOString(),
    corpus: { total: events.length, own: own.length, through: new Date(corpusEnd).toISOString() },
    window_days: WINDOW_DAYS,
    budget: BUDGET,
    bytes: markdown.length,
    projects: activeProjects.slice(0, 12).map((p) => ({
      name: p.name, family: familyOf(p.name), events: p.events,
      commits: p.commits, sessions: p.sessions.size, last: new Date(p.last).toISOString(),
    })),
    preferences: preferences.slice(0, 10).map((p) => ({ project: p.project, summary: p.summary, path: p.memory_path })),
    decisions: decisions.slice(0, 8),
    work_shape: { commits: ownCommits.length, quadrants: Object.fromEntries(quadrants), types: Object.fromEntries(commitTypes) },
    cadence: {
      sessions: sessions.size,
      median_span_min: Math.round(median(sessionSpans)),
      peak_hours: peakHours,
      weekend_pct: pct(weekendEvents, recent.length),
      substantive_sessions: sessionSpans.length,
      max_concurrent: concurrency.length ? Math.max(...concurrency) : 0,
      compactions,
    },
    recall: { served: served.length, uses: uses.length, attributed: attributedServed.length, hits: servedHits },
    omitted,
  }, null, 2));
} else if (!QUIET) {
  console.log(markdown);
}

if (WRITE) {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, `${markdown}\n`);
  if (!AS_JSON) console.error(`\n(wrote ${markdown.length} chars to ${OUT}, budget ${BUDGET})`);
}
