/**
 * tests/unit/profile-decisions.test.js
 *
 * The profile's "Durable decisions" section harvested `session_end_strategic`
 * events carrying a `decisions` array. Two such records existed in the entire
 * corpus. Meanwhile /wrapup had written 508 `session_wrapup` milestones — to a
 * different file, which the profile never read — so the section presented five
 * decisions from one project on one day as the standing set.
 *
 * Two failures, both silent, both asserted here: the wrong source file, and a
 * zero-coverage harvester that renders as a short section rather than an error.
 *
 * Run with: node --test tests/unit/profile-decisions.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = path.join(ROOT, 'scripts', 'build-profile.js');

const RECENT = new Date(Date.now() - 2 * 86400_000).toISOString();

function buildProfile({ changelog = [], milestones = [] }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-profile-'));
  fs.mkdirSync(path.join(dir, '.carto'), { recursive: true });
  const write = (name, rows) => {
    const p = path.join(dir, name);
    fs.writeFileSync(p, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
    return p;
  };
  // At least one non-synthesis event, or the script exits early on an empty log.
  const changelogRows = [
    { event_id: 'evt-base', timestamp: RECENT, type: 'tool_bash', project: 'p', summary: 'Ran: ls' },
    ...changelog,
  ];

  const result = spawnSync('node', [SCRIPT, '--out', path.join(dir, '.carto', 'profile.md')], {
    encoding: 'utf8',
    env: {
      ...process.env,
      CARTOGRAPHER_DEV_DIR: dir,
      CARTOGRAPHER_CHANGELOG: write('changelog.jsonl', changelogRows),
      CARTOGRAPHER_MILESTONES: write('session-milestones.jsonl', milestones),
      CARTOGRAPHER_SERVED_LOG: write('served-log.jsonl', []),
      CARTOGRAPHER_ACCESS_LEDGER: write('access-ledger.jsonl', []),
    },
  });
  const out = { stdout: result.stdout, stderr: result.stderr, status: result.status, dir };
  fs.rmSync(dir, { recursive: true, force: true });
  return out;
}

const wrapup = (over = {}) => ({
  event_id: `evt-w${Math.random().toString(36).slice(2, 8)}`,
  timestamp: RECENT,
  milestone: 'session_wrapup',
  project: 'proj-a',
  session_id: 'sid-1',
  description: 'A paragraph of prose about the session.',
  ...over,
});

test('decisions are harvested from session_wrapup in the milestones log', () => {
  const { stdout, status, stderr } = buildProfile({
    milestones: [
      wrapup({ decisions: ['Chose proximity over window coverage', 'Refused ambiguous matches'] }),
      wrapup({ key_insight: 'A silent consumer is worse than a loud one' }),
    ],
  });
  assert.equal(status, 0, stderr);
  assert.match(stdout, /Chose proximity over window coverage/,
    'a decision written by /wrapup must reach the profile');
  assert.match(stdout, /Refused ambiguous matches/);
  assert.match(stdout, /A silent consumer is worse than a loud one/,
    'key_insight counts as a durable decision');
});

test('the legacy session_end_strategic shape still works', () => {
  const { stdout, status } = buildProfile({
    changelog: [{
      event_id: 'evt-legacy', timestamp: RECENT, type: 'session_end_strategic',
      project: 'optimac', decisions: ['Legacy shape decision', 'Second legacy decision'],
    }],
  });
  assert.equal(status, 0);
  assert.match(stdout, /Legacy shape decision/, 'backward compatibility');
});

test('prose-only syntheses are not mined for decisions', () => {
  // 4% of real descriptions carry a decision marker; guessing from prose would
  // fill this section with mislabeled content. Absent is the correct output.
  const { stdout, stderr } = buildProfile({
    milestones: Array.from({ length: 12 }, () => wrapup({
      description: 'We decided to use the thing, and chose X over Y. Hard problem: the boundary.',
    })),
  });
  assert.doesNotMatch(stdout, /Durable decisions/,
    'no structured decisions means no section, not a regex guess');
  assert.match(stderr, /0 of 12 session syntheses carry a structured decisions field/);
});

test('a thin, unrepresentative slice warns rather than passing silently', () => {
  // The original bug was non-zero: 1 record of 509 had the field. A guard that
  // only checks for zero would have stayed quiet through exactly that.
  const { stderr } = buildProfile({
    milestones: [
      wrapup({ decisions: ['The only structured decision'] }),
      ...Array.from({ length: 30 }, () => wrapup()),
    ],
  });
  assert.match(stderr, /only 1 of 31 session syntheses carry structured decisions/);
});

test('a milestone mirrored into both logs is counted once', () => {
  const shared = wrapup({ event_id: 'evt-dupe', decisions: ['Counted once', 'Filler so the section clears minLines'] });
  const { stdout } = buildProfile({ changelog: [shared], milestones: [shared] });
  const hits = stdout.split('Counted once').length - 1;
  assert.equal(hits, 1, 'de-duplication by event_id');
});
