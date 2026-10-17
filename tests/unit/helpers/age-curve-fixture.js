// Synthetic corpus for the age-curve gate (tests/unit/age-curve-gate.test.js).
//
// Built at test time, relative to the moment the test runs, because a fixed
// file would age: a record planted at 5 days old is 40 days old a month later
// and the buckets would drift with the calendar.
//
// What it plants, and why each part is there:
//
// - Known items, 8 per age bucket (<7d, 7-30d, 30-90d, 90d+), in the three
//   sources the live sampler draws from (milestones, research, prompts). Each
//   carries three tokens no other record has together, so the query naming
//   them is a known item exactly as scripts/age-curve.js defines one.
// - Recent partial matches for every known item: each of its three tokens also
//   appears alone in two changelog rows and three tool-use rows from the last
//   few days. That is the shape of the live corpus (routine recent events
//   share a word with almost any query) and the shape of the loss: under RRF a
//   rank-1 hit in one ladder scores the same as a rank-1 partial hit in
//   another, so any age penalty hands the page to the partial hits.
// - Recency families: fourteen records sharing two tokens across 160 days, the
//   older ones shorter so BM25 prefers them. The newest is the target. An arm
//   that never decays ranks it 14th; that is how the gate catches an arm that
//   wins the known-item curve by switching recency off.
// - Filler in every log, spread across 180 days, so no query token has a
//   document frequency near half of any log (BM25 clamps that idf to zero and
//   the fixture would assert nothing — docs/TESTING.md).

import fs from 'node:fs';
import path from 'node:path';

const DAY_MS = 86400e3;
const LOGS = {
  changelog: 'changelog.jsonl',
  research: 'research-log.jsonl',
  milestones: 'session-milestones.jsonl',
  'tool-use': 'tool-use-log.jsonl',
  prompts: 'prompt-history.jsonl',
};

// Ages in days, eight per bucket.
const KNOWN_AGES = {
  '<7d': [0.8, 1.5, 2.2, 3.0, 3.9, 4.6, 5.4, 6.3],
  '7-30d': [8.5, 11, 13.5, 16, 19, 22, 25, 28.5],
  '30-90d': [33, 40, 47, 54, 61, 68, 75, 85],
  '90d+': [95, 104, 113, 122, 131, 140, 152, 168],
};
// Rotating target kinds, matching the salience the hooks stamp.
const TARGET_KINDS = [
  { source: 'milestones', type: 'wrapup', salience: 0.9 },
  { source: 'research', type: 'web_fetch', salience: 0.5 },
  { source: 'prompts', type: 'prompt', salience: 0.6 },
  { source: 'milestones', type: 'compaction', salience: 0.5 },
];
const FAMILY_AGES = [0.6, 11, 20, 32, 45, 58, 70, 84, 97, 110, 122, 135, 148, 160];
const FAMILY_SOURCES = [
  { source: 'changelog', type: 'git_commit', salience: 0.5 },
  { source: 'milestones', type: 'wrapup', salience: 0.9 },
  { source: 'prompts', type: 'prompt', salience: 0.6 },
];
const COMMON = ['update', 'session', 'notes', 'review', 'build', 'checked', 'layout', 'config',
  'tests', 'merged', 'branch', 'window', 'results', 'plan', 'draft', 'script', 'runner', 'cleanup'];

function lcg(seed) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 4294967296);
}

function wordMaker(rand) {
  const cons = 'bdfgklmnprstvz';
  const vows = 'aeiou';
  const used = new Set();
  return () => {
    for (;;) {
      let w = '';
      for (let i = 0; i < 4; i++) w += cons[Math.floor(rand() * cons.length)] + vows[Math.floor(rand() * vows.length)];
      if (!used.has(w)) { used.add(w); return w; }
    }
  };
}

const iso = (ms) => new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z');

/**
 * Write the fixture's five logs into `dir`. Returns the cases the gate ranks:
 * `{ kind: 'known'|'recency', bucket, id, query }`.
 */
export function writeAgeCurveFixture(dir, { nowMs = Date.now(), seed = 4242 } = {}) {
  const rand = lcg(seed);
  const word = wordMaker(rand);
  const pick = (n) => Array.from({ length: n }, () => COMMON[Math.floor(rand() * COMMON.length)]).join(' ');
  const rows = Object.fromEntries(Object.keys(LOGS).map((source) => [source, []]));
  let seq = 0;
  const add = (source, { ageDays, type, salience, summary }) => {
    const id = `evt-agecurve${String(++seq).padStart(5, '0')}`;
    rows[source].push({ event_id: id, timestamp: iso(nowMs - ageDays * DAY_MS), type,
      project: 'agecurve', salience, summary });
    return id;
  };

  const cases = [];
  let k = 0;
  for (const [bucket, ages] of Object.entries(KNOWN_AGES)) {
    for (const ageDays of ages) {
      const kind = TARGET_KINDS[k++ % TARGET_KINDS.length];
      const terms = [word(), word(), word()];
      const id = add(kind.source, { ageDays, type: kind.type, salience: kind.salience,
        summary: `${pick(2)} ${terms[0]} ${pick(1)} ${terms[1]} ${terms[2]} ${pick(2)}` });
      cases.push({ kind: 'known', bucket, id, query: terms.join(' '), source: kind.source });
      for (const term of terms) {
        for (let i = 0; i < 2; i++) {
          add('changelog', { ageDays: 0.1 + rand() * 4, type: 'git_commit', salience: 0.5,
            summary: `Commit ${pick(2)} ${term} ${pick(3)}` });
        }
        for (let i = 0; i < 3; i++) {
          add('tool-use', { ageDays: 0.05 + rand() * 4, type: 'tool_bash', salience: 0.2,
            summary: `Ran: ${pick(1)} ${term} ${pick(2)}` });
        }
      }
    }
  }

  FAMILY_SOURCES.forEach((family, f) => {
    const terms = [word(), word()];
    let newest = null;
    FAMILY_AGES.forEach((ageDays, i) => {
      // Older members are shorter, so BM25's length normalization favours them.
      const padding = FAMILY_AGES.length - 1 - i;
      const id = add(family.source, { ageDays, type: family.type, salience: family.salience,
        summary: `${terms[0]} ${terms[1]} status ${pick(padding)}`.trim() });
      if (i === 0) newest = id;
    });
    cases.push({ kind: 'recency', bucket: '<7d', id: newest, query: terms.join(' '), family: f });
  });

  for (const source of Object.keys(LOGS)) {
    for (let i = 0; i < 120; i++) {
      add(source, { ageDays: rand() * 180, type: source === 'tool-use' ? 'tool_bash' : 'note',
        salience: 0.5, summary: `${pick(6)}` });
    }
  }

  fs.mkdirSync(dir, { recursive: true });
  for (const [source, name] of Object.entries(LOGS)) {
    fs.writeFileSync(path.join(dir, name), rows[source].map((r) => JSON.stringify(r)).join('\n') + '\n');
  }
  return cases;
}

export function fixtureLogFiles(dir) {
  return Object.fromEntries(Object.entries(LOGS).map(([source, name]) => [source, path.join(dir, name)]));
}
