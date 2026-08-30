#!/usr/bin/env node
/**
 * Derived coverage and pending queue for strategic /wrapup syntheses.
 *
 * Raw transcripts and lifecycle hooks remain the complete substrate. This
 * report answers a narrower question: which completed (or stale) sessions were
 * material enough to benefit from authored decisions/unresolved context, and
 * which of those still lack a session_wrapup event?
 */
import fs from 'node:fs';
import path from 'node:path';
import { isResolved, firstResolved } from './sentinels.js';

const DEV = process.env.CARTOGRAPHER_DEV_DIR || path.join(process.env.HOME, 'Documents/dev');
const CHANGELOG = process.env.CARTOGRAPHER_CHANGELOG || path.join(DEV, 'changelog.jsonl');
const MILESTONES = process.env.CARTOGRAPHER_MILESTONES || path.join(DEV, 'session-milestones.jsonl');

const args = process.argv.slice(2);
const valueAfter = (flag, fallback) => {
  const index = args.indexOf(flag);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const numberAfter = (flag, fallback) => {
  const value = Number(valueAfter(flag, String(fallback)));
  return Number.isFinite(value) && value >= 0 ? value : fallback;
};

const AS_JSON = args.includes('--json');
const SESSION_FILTER = valueAfter('--session', '');
const LIMIT = Math.max(1, numberAfter('--limit', 12));
const MIN_EVENTS = numberAfter(
  '--min-events',
  Number(process.env.CARTOGRAPHER_WRAPUP_MIN_EVENTS) || 20,
);
const MIN_MINUTES = numberAfter(
  '--min-minutes',
  Number(process.env.CARTOGRAPHER_WRAPUP_MIN_MINUTES) || 20,
);
const STALE_HOURS = numberAfter(
  '--stale-hours',
  Number(process.env.CARTOGRAPHER_WRAPUP_STALE_HOURS) || 12,
);
const NOW = Date.parse(valueAfter('--now', process.env.CARTOGRAPHER_NOW || '')) || Date.now();

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').flatMap((line) => {
    if (!line) return [];
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}

// The changelog mirrors many lifecycle events from session-milestones.jsonl.
// Merge matching ids instead of counting them twice; the milestone copy often
// carries richer structured fields than its changelog summary.
const eventsById = new Map();
let anonymous = 0;
for (const event of [...readJsonl(CHANGELOG), ...readJsonl(MILESTONES)]) {
  const id = isResolved(event.event_id) ? event.event_id : `anonymous-${anonymous++}`;
  eventsById.set(id, { ...(eventsById.get(id) || {}), ...event });
}

const sessions = new Map();
for (const event of eventsById.values()) {
  const sessionId = firstResolved([event.session_id, event.session]);
  if (!isResolved(sessionId)) continue;
  if (SESSION_FILTER && sessionId !== SESSION_FILTER) continue;
  if (!sessions.has(sessionId)) sessions.set(sessionId, []);
  sessions.get(sessionId).push(event);
}

function typeOf(event) {
  return firstResolved([event.type, event.milestone], 'unknown');
}

function summarize(sessionId, events) {
  events.sort((a, b) => String(a.timestamp || '').localeCompare(String(b.timestamp || '')));
  const timestamps = events.map((event) => Date.parse(event.timestamp)).filter(Number.isFinite);
  const startedMs = timestamps.length ? Math.min(...timestamps) : 0;
  const endedMs = timestamps.length ? Math.max(...timestamps) : 0;
  const durationMinutes = startedMs && endedMs ? Math.round((endedMs - startedMs) / 60000) : 0;
  const types = events.map(typeOf);
  const projects = [...new Set(events.map((event) => event.project).filter(isResolved))];
  const provider = firstResolved(events.map((event) => event.provider), 'unknown');
  const transcriptPath = firstResolved(events.map((event) => event.transcript_path), '');
  const wrapped = events.some((event) => event.milestone === 'session_wrapup'
    || event.milestone === 'session_end_strategic'
    || event.type === 'session_end_strategic');
  const explicitEnd = events.some((event) => /^session_end_/.test(typeOf(event))
    || /^milestone_session_end_/.test(typeOf(event)));
  const stale = Boolean(endedMs && endedMs <= NOW - STALE_HOURS * 3600000);

  const edits = types.filter((type) => type === 'tool_file_edit').length;
  const commits = types.filter((type) => type === 'git_commit').length;
  const compactions = types.filter((type) => type.includes('compaction')).length;
  const reasons = [];
  if (commits) reasons.push('commit');
  if (edits) reasons.push('file_edit');
  if (compactions) reasons.push('compaction');
  if (projects.length > 1) reasons.push('multi_project');
  if (events.length >= MIN_EVENTS) reasons.push('event_volume');
  if (durationMinutes >= MIN_MINUTES) reasons.push('duration');
  if (wrapped) reasons.push('authored_wrapup');

  const material = reasons.length > 0;
  const finalized = explicitEnd || stale;
  const eligible = material && (finalized || wrapped);
  const status = !material ? 'trivial'
    : wrapped ? 'wrapped'
      : eligible ? 'pending'
        : 'in_progress';

  return {
    session_id: sessionId,
    provider,
    status,
    material,
    finalized,
    explicit_end: explicitEnd,
    stale,
    wrapped,
    event_count: events.length,
    started_at: startedMs ? new Date(startedMs).toISOString() : null,
    ended_at: endedMs ? new Date(endedMs).toISOString() : null,
    duration_minutes: durationMinutes,
    projects,
    edits,
    commits,
    compactions,
    material_reasons: reasons,
    transcript_path: transcriptPath || null,
  };
}

const rows = [...sessions.entries()].map(([id, events]) => summarize(id, events))
  .sort((a, b) => String(b.ended_at || '').localeCompare(String(a.ended_at || '')));

if (SESSION_FILTER && rows.length === 0) {
  console.error(`No logged events found for session ${SESSION_FILTER}.`);
  process.exit(1);
}

const pending = rows.filter((row) => row.status === 'pending');
const wrapped = rows.filter((row) => row.status === 'wrapped');
const inProgress = rows.filter((row) => row.status === 'in_progress');
const trivial = rows.filter((row) => row.status === 'trivial');
const materialTotal = pending.length + wrapped.length;
const coveragePct = materialTotal ? Math.round((wrapped.length / materialTotal) * 100) : 100;

const result = {
  generated_at: new Date(NOW).toISOString(),
  policy: {
    min_events: MIN_EVENTS,
    min_minutes: MIN_MINUTES,
    stale_hours: STALE_HOURS,
    material_signals: ['commit', 'file_edit', 'compaction', 'multi_project', 'event_volume', 'duration'],
  },
  coverage: {
    observed_sessions: rows.length,
    material_sessions: materialTotal,
    wrapped: wrapped.length,
    pending: pending.length,
    in_progress_material: inProgress.length,
    trivial: trivial.length,
    percent: coveragePct,
  },
  sessions: SESSION_FILTER ? rows : undefined,
  pending: pending.slice(0, LIMIT),
};

if (AS_JSON) {
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}

const short = (value) => value ? value.slice(0, 8) : 'unknown';
const date = (value) => value ? value.slice(0, 10) : 'unknown';
const projectLabel = (row) => row.projects.length ? row.projects.slice(0, 2).join(',') : 'unknown';

console.log('━━ wrapup coverage ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('');
console.log(`  material  ${materialTotal} completed/stale · ${wrapped.length} wrapped · ${pending.length} pending (${coveragePct}%)`);
console.log(`  outside   ${inProgress.length} material still active · ${trivial.length} trivial`);
console.log(`  policy    edit/commit/compaction/multi-project or ≥${MIN_EVENTS} events/≥${MIN_MINUTES}m · stale ${STALE_HOURS}h`);

if (SESSION_FILTER) {
  const row = rows[0];
  console.log('');
  console.log(`  session   ${row.session_id} · ${row.status}`);
  console.log(`  evidence  ${row.event_count} events · ${row.duration_minutes}m · ${row.material_reasons.join(', ') || 'none'}`);
} else if (pending.length) {
  console.log('');
  console.log('  pending');
  for (const row of pending.slice(0, LIMIT)) {
    console.log(`  ${date(row.ended_at)}  ${short(row.session_id)}  ${projectLabel(row).padEnd(24).slice(0, 24)}  ${String(row.event_count).padStart(4)} events  ${row.material_reasons.slice(0, 3).join(',')}`);
  }
  if (pending.length > LIMIT) console.log(`  … ${pending.length - LIMIT} more`);
}

console.log('');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
