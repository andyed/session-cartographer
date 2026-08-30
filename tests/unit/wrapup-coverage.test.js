import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const COVERAGE = path.join(ROOT, 'scripts', 'wrapup-coverage.js');
const NOW = '2026-08-30T20:00:00.000Z';

const event = (event_id, session_id, timestamp, type, extra = {}) => ({
  event_id,
  session_id,
  timestamp,
  type,
  provider: 'codex',
  project: 'fixture',
  ...extra,
});

function fixture() {
  const dev = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-wrapup-coverage-'));
  const changelog = [
    event('evt-pending-edit', 'session-pending', '2026-08-30T10:00:00Z', 'tool_file_edit'),
    event('evt-pending-end', 'session-pending', '2026-08-30T10:05:00Z', 'milestone_session_end_other', { provider: 'claude' }),

    event('evt-wrapped-edit', 'session-wrapped', '2026-08-30T19:00:00Z', 'tool_file_edit'),

    event('evt-stale-edit', 'session-stale', '2026-08-28T10:00:00Z', 'tool_file_edit'),
    event('evt-stale-stop', 'session-stale', '2026-08-28T10:05:00Z', 'milestone_turn_stop'),

    event('evt-trivial-1', 'session-trivial', '2026-08-27T10:00:00Z', 'tool_bash'),
    event('evt-trivial-2', 'session-trivial', '2026-08-27T10:02:00Z', 'milestone_turn_stop'),

    ...Array.from({ length: 25 }, (_, index) => event(
      `evt-active-${index}`,
      'session-active',
      `2026-08-30T19:${String(index).padStart(2, '0')}:00Z`,
      'tool_bash',
    )),
  ];
  const milestones = [
    // Same id as the changelog mirror: coverage must merge, not double count.
    {
      event_id: 'evt-pending-end',
      session_id: 'session-pending',
      timestamp: '2026-08-30T10:05:00Z',
      milestone: 'session_end_other',
      provider: 'claude',
      project: 'fixture',
    },
    {
      event_id: 'evt-wrapped-synthesis',
      session_id: 'session-wrapped',
      timestamp: '2026-08-30T19:05:00Z',
      milestone: 'session_wrapup',
      provider: 'codex',
      project: 'fixture',
      description: 'Authored strategic context.',
    },
  ];
  fs.writeFileSync(path.join(dev, 'changelog.jsonl'), `${changelog.map(JSON.stringify).join('\n')}\n`);
  fs.writeFileSync(path.join(dev, 'session-milestones.jsonl'), `${milestones.map(JSON.stringify).join('\n')}\n`);
  return dev;
}

function report(dev, extraArgs = []) {
  return JSON.parse(execFileSync('node', [COVERAGE, '--json', '--now', NOW, ...extraArgs], {
    encoding: 'utf8',
    env: { ...process.env, CARTOGRAPHER_DEV_DIR: dev },
  }));
}

test('coverage denominator is completed or stale material sessions, not every session', () => {
  const result = report(fixture());
  assert.deepEqual(result.coverage, {
    observed_sessions: 5,
    material_sessions: 3,
    wrapped: 1,
    pending: 2,
    in_progress_material: 1,
    trivial: 1,
    percent: 33,
  });
  assert.deepEqual(result.pending.map((row) => row.session_id).sort(), [
    'session-pending',
    'session-stale',
  ]);
});

test('explicit lifecycle end and stale Codex activity both make material sessions eligible', () => {
  const result = report(fixture());
  const pending = Object.fromEntries(result.pending.map((row) => [row.session_id, row]));
  assert.equal(pending['session-pending'].explicit_end, true);
  assert.equal(pending['session-pending'].event_count, 2, 'mirrored lifecycle event is de-duplicated');
  assert.equal(pending['session-stale'].explicit_end, false);
  assert.equal(pending['session-stale'].stale, true);
});

test('a current material session is visible but excluded from wrapup coverage', () => {
  const result = report(fixture(), ['--session', 'session-active']);
  assert.equal(result.sessions[0].status, 'in_progress');
  assert.equal(result.sessions[0].material, true);
  assert.equal(result.coverage.material_sessions, 0);
  assert.equal(result.coverage.in_progress_material, 1);
});
