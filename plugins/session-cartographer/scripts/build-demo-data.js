#!/usr/bin/env node
// build-demo-data.js — Cache real pipeline results for the GH Pages demo.
//
// Requires the Explorer server running on :2526.
// Hits the live API, sanitizes paths, writes static JSON to demo/.
//
// Usage:
//   cd explorer && npm run dev &   # start server
//   node scripts/build-demo-data.js

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DEMO = join(ROOT, 'demo');
const API = 'http://127.0.0.1:2526';

// ─── Sanitization ───

// Map of real project names → fake replacements
// Case-insensitive replacements — product names appear in conversation text too
const REAL_TO_FAKE = {
  // Product/brand names (case-sensitive patterns added below)
  'Scrutinizer': 'Quantum Toaster', 'scrutinizer2025': 'quantum-toaster', 'scrutinizer-www': 'quantum-toaster-www',
  'scrutinizer-figma': 'quantum-toaster-figma', 'scrutinizer': 'quantum-toaster',
  'Psychodeli+': 'Turtle Surfboard+', 'Psychodeli': 'Turtle Surfboard', 'PsychoDeli': 'Turtle Surfboard',
  'psychodeli-webgl-port': 'turtle-surfboard', 'psychodeli-plus-tvos': 'turtle-surfboard-tvos',
  'psychodeli-plus-firetv': 'turtle-surfboard-firetv', 'psychodeli-brand-guide': 'turtle-surfboard-brand',
  'psychodeli-metal': 'turtle-surfboard-metal', 'psychodeli-osx-vx': 'turtle-surfboard-osx',
  'psychodeli': 'turtle-surfboard',
  'iBlipper': 'Haunted Spreadsheet', 'iblipper2025': 'haunted-spreadsheet', 'iblipper': 'haunted-spreadsheet',
  'ClickSense': 'Robot Bartender', 'clicksense': 'robot-bartender',
  'interests2025': 'hobbit-village', 'interests': 'hobbit-village',
  'histospire': 'hobbit-village-sensor',
  'Mind Bending Pixels': 'Demo Brand', 'mindbendingpixels-www': 'demo-brand-www', 'mindbendingpixels': 'demo-brand',
  'sciprogfi-web': 'yeti-memoir-web', 'sciprogfi': 'yeti-memoir',
  'oled-fireworks-tvos': 'disco-jellyfish-tvos', 'oled-fireworks-firetv': 'disco-jellyfish-firetv',
  'cymatics-firetv': 'disco-jellyfish-cymatics',
  'pixelbop': 'disco-jellyfish-pixels',
  'nokings-blipper-firetv': 'protest-penguin', 'nokings': 'protest-penguin',
  'fisheye-menu': 'fisheye-menu',
  'marginalia': 'footnote-factory',
  'arxiv-paper': 'paper-airplane',
  'science-agent': 'lab-hamster',
  'reading_depth': 'bookmark-worm',
  'claude-code-session-bridge': 'bridge-troll',
  'claude-code-history-viewer': 'time-machine',
  'fovi': 'owl-vision',
  'nanobot': 'nanobot',
  'reference-hallucination-benchmark': 'truth-detector',
  'pize': 'parallel-universe',
  'andyed': 'demo-user',
  'Andy Edmonds': 'Demo User',
  'Andy': 'Demo',
};

function scrubProjectNames(str) {
  if (!str) return str;
  let result = str;
  // Sort by length descending so longer names match first
  const sorted = Object.entries(REAL_TO_FAKE).sort((a, b) => b[0].length - a[0].length);
  for (const [real, fake] of sorted) {
    // Case-sensitive replace first (preserves intentional casing in fake names)
    result = result.replaceAll(real, fake);
    // Also catch ALL CAPS and other case variants
    const re = new RegExp(real.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    result = result.replace(re, fake);
  }
  return result;
}

function sanitizePath(str) {
  if (!str) return str;
  return str
    .replace(/\/Users\/\w+/g, '/home/user')
    .replace(/\/home\/user\/\.claude\/projects\/[^/]+/g, '/home/user/.claude/projects/demo-project');
}

function sanitizeEvent(e) {
  // Brute force: serialize, scrub everything, deserialize
  let json = JSON.stringify(e);
  json = sanitizePath(json);
  json = scrubProjectNames(json);
  return JSON.parse(json);
}

// Filter to session-cartographer project data only
const DEMO_PROJECT = 'session-cartographer';

function isCartoProject(project) {
  if (!project) return false;
  const p = project.toLowerCase();
  return p === DEMO_PROJECT || p.includes(DEMO_PROJECT);
}

function isCartoSession(session) {
  return (session.projects || []).some(p => isCartoProject(p)) ||
    isCartoProject(session.project);
}

// ─── API helpers ───

async function api(path) {
  const res = await fetch(`${API}${path}`);
  if (!res.ok) throw new Error(`${path}: ${res.status} ${res.statusText}`);
  return res.json();
}

// ─── Main ───

async function main() {
  // Verify server is running
  try {
    await api('/api/projects');
  } catch {
    console.error('Explorer server not running on :2526. Start it first:');
    console.error('  cd explorer && npm run dev');
    process.exit(1);
  }

  const queries = JSON.parse(readFileSync(join(DEMO, 'queries.json'), 'utf-8'));
  mkdirSync(join(DEMO, 'results'), { recursive: true });

  // Shared state for replacing real project names with fake ones
  const fakeReplacements = ['hobbit-village', 'turtle-surfboard', 'haunted-spreadsheet', 'quantum-toaster', 'robot-bartender'];
  let fakeIdx = 0;
  const projectMap = new Map();

  // ─── 1. Cache search results for each query ───

  console.log(`Caching ${queries.length} queries...`);
  for (const q of queries) {
    console.log(`  "${q.query}" (${q.id})...`);
    const rawData = await api(`/api/search?q=${encodeURIComponent(q.query)}`);
    const data = JSON.parse(scrubProjectNames(sanitizePath(JSON.stringify(rawData))));

    writeFileSync(
      join(DEMO, 'results', `${q.id}.json`),
      JSON.stringify(data, null, 2) + '\n'
    );
    console.log(`    ${data.results?.length || 0} results, ${data.meta?.duration_ms}ms`);
  }

  // ─── 2. Cache autocomplete prefixes ───

  // For each query, generate the prefixes a user would type (2+ chars)
  // and cache the autocomplete + coterm responses.
  const autocomplete = {};
  const coterms = {};

  for (const q of queries) {
    const words = q.query.split(/\s+/);
    for (const word of words) {
      for (let len = 2; len <= word.length; len++) {
        const prefix = word.slice(0, len).toLowerCase();
        if (autocomplete[prefix]) continue;

        const acData = await api(`/api/autocomplete?prefix=${encodeURIComponent(prefix)}`);
        autocomplete[prefix] = acData.suggestions || [];

        // Cache coterms for the full word
        if (len === word.length) {
          const ctData = await api(`/api/coterms?term=${encodeURIComponent(word.toLowerCase())}`);
          coterms[word.toLowerCase()] = ctData.terms || [];
        }
      }
    }
  }

  writeFileSync(
    join(DEMO, 'autocomplete.json'),
    JSON.stringify({ autocomplete, coterms }, null, 2) + '\n'
  );
  console.log(`Cached ${Object.keys(autocomplete).length} autocomplete prefixes, ${Object.keys(coterms).length} coterm entries`);

  // ─── 3. Cache sessions (for timeline view) — filtered to carto project ───

  console.log('Caching sessions...');
  let allSessions = await api('/api/sessions?days=30');
  const cartoSessionIds = new Set();

  if (allSessions.sessions) {
    allSessions.sessions = allSessions.sessions
      .filter(isCartoSession)
      .map(s => { cartoSessionIds.add(s.session_id); return s; });
    // Scrub entire sessions blob at once
    allSessions = JSON.parse(scrubProjectNames(sanitizePath(JSON.stringify(allSessions))));
    // Filter overlaps to only include carto sessions
    allSessions.overlaps = (allSessions.overlaps || []).filter(o =>
      o.sessions.every(sid => cartoSessionIds.has(sid))
    );
  }

  // Add synthetic distractor sessions so the timeline isn't empty
  const fakeSummaries = {
    'hobbit-village': ['[feature] Commit abc0: Add round door hitbox detection', '[fix] Commit abc1: Second breakfast scheduler off by one', '[feature] Commit abc2: Shire zoning permits API'],
    'turtle-surfboard': ['[feature] Commit abc0: Fin stabilizer for hawksbill stance', '[fix] Commit abc1: Wax application fails on wet shell', '[feature] Commit abc2: Wave detection sonar integration'],
    'haunted-spreadsheet': ['[fix] Commit abc0: Cell B7 screams on hover', '[feature] Commit abc1: Poltergeist auto-sort algorithm', '[fix] Commit abc2: Ghost cells appear in print preview'],
    'quantum-toaster': ['[feature] Commit abc0: Bread exists in superposition until observed', '[fix] Commit abc1: Toast simultaneously burnt and frozen', '[feature] Commit abc2: Entangled crumb tray notification'],
    'robot-bartender': ['[feature] Commit abc0: Implement olive spear trajectory planning', '[fix] Commit abc1: Shaker arm exceeds torque limits on margaritas', '[feature] Commit abc2: Tip jar sentiment analysis'],
  };
  function fakeSummary(proj, i) { return (fakeSummaries[proj] || [])[i % 3] || `[feature] Commit abc${i}: ${proj} progress`; }
  const fakeTypes = { git_commit: 3, tool_file_edit: 2, research_fetch: 1 };
  const fakeCommitTypes = { feature: 2, fix: 1 };
  const now = new Date();

  for (let i = 0; i < 8; i++) {
    const proj = fakeReplacements[i % fakeReplacements.length];
    const hoursAgo = 4 + i * 7 + Math.random() * 10;
    const duration = 1 + Math.random() * 4; // 1-5 hours
    const start = new Date(now - hoursAgo * 3600000).toISOString();
    const end = new Date(now - (hoursAgo - duration) * 3600000).toISOString();
    const eventCount = 5 + Math.floor(Math.random() * 40);
    const sid = `demo-${proj}-${i}`;

    allSessions.sessions.push({
      session_id: sid,
      start, end,
      event_count: eventCount,
      project: proj,
      projects: [proj],
      types: { ...fakeTypes },
      quadrants: { construct: Math.floor(eventCount * 0.6), surgical: Math.floor(eventCount * 0.4) },
      commit_types: { ...fakeCommitTypes },
      transcript_path: '',
      events: [
        { event_id: `fake-${sid}-1`, timestamp: start, type: 'git_commit', project: proj, summary: fakeSummary(proj, i) },
        { event_id: `fake-${sid}-2`, timestamp: end, type: 'tool_file_edit', project: proj, summary: `Modified: src/${proj}/main.js` },
      ],
    });
  }

  // Add overlaps between fake sessions and carto sessions where time ranges overlap
  for (const fake of allSessions.sessions.filter(s => s.session_id.startsWith('demo-'))) {
    for (const real of allSessions.sessions.filter(s => !s.session_id.startsWith('demo-'))) {
      if (fake.start < real.end && real.start < fake.end) {
        allSessions.overlaps.push({
          sessions: [fake.session_id, real.session_id],
          start: fake.start > real.start ? fake.start : real.start,
          end: fake.end < real.end ? fake.end : real.end,
        });
      }
    }
  }

  writeFileSync(
    join(DEMO, 'sessions.json'),
    JSON.stringify(allSessions, null, 2) + '\n'
  );
  console.log(`  ${allSessions.sessions?.length || 0} sessions (${cartoSessionIds.size} real + ${8} synthetic), ${allSessions.overlaps?.length || 0} overlaps`);

  // ─── 4. Cache recent events — filtered to carto project ───

  console.log('Caching events...');
  const allEvents = await api('/api/events?limit=400');
  const cartoEvents = (allEvents.events || allEvents || [])
    .filter(e => isCartoProject(e.project))
    .map(sanitizeEvent);

  writeFileSync(
    join(DEMO, 'events.json'),
    JSON.stringify({ events: cartoEvents.slice(0, 200) }, null, 2) + '\n'
  );
  console.log(`  ${Math.min(cartoEvents.length, 200)} events (filtered to ${DEMO_PROJECT})`);

  // ─── 5. Cache project list ───

  const projects = await api('/api/projects');
  if (projects.projects) {
    projects.projects = projects.projects
      .filter(p => isCartoProject(p))
      .map(p => sanitizePath(p));
  }
  writeFileSync(
    join(DEMO, 'projects.json'),
    JSON.stringify(projects, null, 2) + '\n'
  );

  console.log('\nDone. Demo data written to demo/');
  console.log('Files:');
  console.log('  demo/results/<query-id>.json  — search results per query');
  console.log('  demo/autocomplete.json        — prefix completions + coterms');
  console.log('  demo/sessions.json            — session timeline data');
  console.log('  demo/events.json              — recent event stream');
  console.log('  demo/projects.json            — project list');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
