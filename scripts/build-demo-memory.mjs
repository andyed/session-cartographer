#!/usr/bin/env node
// build-demo-memory.mjs — Derive the static working-memory field for the GH Pages demo.
//
// The demo corpus is already sanitized: demo/sessions.json ships 14 sessions
// with nested event arrays, scrubbed by build-demo-data.js. projectMemory() is
// a pure fold over an event array, so the demo field is DERIVED from fixtures
// that are already public rather than snapshotted from the live API and
// scrubbed afterwards. That keeps the demo off the sanitization critical path
// entirely — there is no new leak surface, because there is no new source.
//
// Usage: node scripts/build-demo-memory.mjs [--write]

import { readFileSync, writeFileSync, mkdirSync, cpSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { projectMemory, enrichMemory } from '../explorer/server/memory.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = join(ROOT, 'demo', 'sessions.json');
const OUT = join(ROOT, 'demo', 'memory', 'state.json');
// demo.js reads ${BASE}demo/demo/… ; that nesting is the deployed layout, so
// the fixtures have to land in the copy the browser actually fetches. That
// directory is GITIGNORED, so on a clean checkout it does not exist at all —
// and a Vite build with no fixtures under public/ still succeeds, producing a
// demo whose every view is empty. Mirror the tracked demo/ tree into it rather
// than leaving the working copy as the only place the demo has ever built.
const LIVE_DIR = join(ROOT, 'explorer', 'public', 'demo', 'demo');
const LIVE = join(LIVE_DIR, 'memory', 'state.json');
const DAY_MS = 86400000;

// A transcript reader that always declines. enrichMemory already has a
// no-transcript path (it stamps missingTokens and drops the private evidence
// keys), so the demo field comes out of the SAME code as production instead of
// a hand-rolled shape that can drift from it.
const absentTranscripts = {
  read: async () => ({ valid: false, reason: 'Transcripts are not included in the static demo.' }),
};

function flatten(sessions) {
  const events = [];
  for (const session of sessions) {
    for (const event of session.events || []) {
      events.push({ ...event, session_id: session.session_id, transcript_path: session.transcript_path });
    }
  }
  return events;
}

// Pin the window to the busiest 24 hours in the corpus. A demo field must be
// deterministic (the same page for every visitor, forever) and it must be full
// — a window chosen for tidiness rather than density renders an empty
// instrument that reads as broken rather than as quiet.
function busiestWindowEnd(events) {
  const times = events.map(e => Date.parse(e.timestamp)).filter(Number.isFinite).sort((a, b) => a - b);
  let best = { count: 0, end: times.at(-1) ?? Date.now() };
  for (const end of times) {
    let count = 0;
    for (const t of times) if (t > end - DAY_MS && t <= end) count++;
    if (count > best.count) best = { count, end };
  }
  return best;
}

const write = process.argv.includes('--write');
const sessions = JSON.parse(readFileSync(SOURCE, 'utf8')).sessions;
const events = flatten(sessions);
const { end, count } = busiestWindowEnd(events);
const field = await enrichMemory(projectMemory(events, { now: end }), absentTranscripts);

// Which comparison axes this fixture can actually support. Derived, not
// listed: a hardcoded set drifts the moment the fixture is regenerated, and
// the failure is silent — the axis still renders, just flat at zero, which
// reads as "nothing happened" rather than "not in this demo".
function availableAxes(snapshot) {
  const counts = {};
  let tokens = false;
  for (const session of snapshot.sessions) {
    for (const [key, value] of Object.entries(session.metrics?.counts || {})) counts[key] = (counts[key] || 0) + value;
    if (session.metrics?.tokens?.status !== 'missing') tokens = true;
  }
  const files = snapshot.sessions.some(session => (snapshot.files[session.id] || []).length);
  return [
    ...(tokens ? ['output', 'total'] : []),
    ...(counts.edit ? ['edit'] : []),
    ...(files ? ['files'] : []),
    ...(counts.research ? ['research'] : []),
    ...(counts.commit ? ['commit'] : []),
    ...(snapshot.total ? ['events'] : []),
  ];
}

const axes = availableAxes(field);
const fixture = { generated_from: 'demo/sessions.json', window_end: new Date(end).toISOString(), axes, field };

const totals = { sessions: field.sessions.length, groups: field.groups.length, events: field.total };
console.log(`window ends ${fixture.window_end} — ${count} events in the last 24h`);
console.log(`field: ${totals.sessions} sessions, ${totals.groups} groups, ${totals.events} events`);
const counts = {};
for (const session of field.sessions) {
  for (const [key, value] of Object.entries(session.metrics?.counts || {})) counts[key] = (counts[key] || 0) + value;
}
console.log('metric counts:', JSON.stringify(counts));
console.log('files per session:', field.sessions.map(s => (field.files[s.id] || []).length).join(','));
console.log('comparison axes:', axes.join(', ') || '(none)');

if (!write) { console.log('\n(dry run — pass --write to emit)'); process.exit(0); }
if (!field.sessions.length) { console.error('refusing to write an empty field'); process.exit(1); }
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(fixture));
console.log('wrote', OUT.replace(ROOT + '/', ''));

mkdirSync(LIVE_DIR, { recursive: true });
cpSync(join(ROOT, 'demo'), LIVE_DIR, { recursive: true, filter: source => !source.endsWith('.DS_Store') });
console.log('synced demo/ →', LIVE_DIR.replace(ROOT + '/', ''));
