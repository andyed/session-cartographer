/**
 * tests/unit/prune-contentless.test.js
 *
 * Guards the removal predicate of scripts/prune-contentless-milestones.js.
 *
 * Why this test exists: the script deletes rows from the milestone log and
 * points from Qdrant. The whole safety argument rests on one intersection —
 * a row is dropped only when it is BOTH unreachable AND recorded no activity.
 * Of 9,862 session_end_other rows, 79 had a dead transcript over real logged
 * work. Those are a lost transcript on a genuine session, and deleting them
 * would destroy the only surviving record of it.
 *
 * A predicate that widens by one clause silently eats those 79. So the keep
 * cases matter more here than the drop case.
 *
 * Run with: node --test tests/unit/prune-contentless.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isContentless } from '../../scripts/prune-contentless-milestones.js';

const GHOST = path.join(os.tmpdir(), 'carto-nonexistent-transcript.jsonl');

test('drops a session end that is unreachable and did nothing', () => {
  assert.equal(isContentless({
    milestone: 'session_end_other', transcript_path: GHOST, session_event_count: 0,
  }), true);
});

test('keeps a session end with real activity behind a lost transcript', () => {
  // The 79. A lost transcript is not an empty session.
  assert.equal(isContentless({
    milestone: 'session_end_other', transcript_path: GHOST, session_event_count: 42,
  }), false);
});

test('keeps a session end whose transcript still resolves', () => {
  const f = path.join(os.tmpdir(), `carto-real-${Date.now()}.jsonl`);
  fs.writeFileSync(f, '{}\n');
  try {
    assert.equal(isContentless({
      milestone: 'session_end_other', transcript_path: f, session_event_count: 0,
    }), false);
  } finally {
    fs.rmSync(f, { force: true });
  }
});

test('never touches milestone types outside session_end_*', () => {
  for (const m of ['compaction_auto', 'agent_Explore', 'turn_stop', 'session_wrapup']) {
    assert.equal(isContentless({
      milestone: m, transcript_path: GHOST, session_event_count: 0,
    }), false, `${m} must be out of scope`);
  }
});

test('never drops an authored wrapup, whatever its transcript looks like', () => {
  assert.equal(isContentless({
    milestone: 'session_end_other', transcript_path: GHOST, session_event_count: 0,
    decisions: ['a decision worth keeping'],
  }), false);
  assert.equal(isContentless({
    milestone: 'session_end_other', transcript_path: GHOST, session_event_count: 0,
    key_insight: 'the one thing worth remembering',
  }), false);
});

test('a missing event count reads as zero, not as unknown-and-safe', () => {
  assert.equal(isContentless({ milestone: 'session_end_other', transcript_path: GHOST }), true);
});

test('malformed rows are never eligible for deletion', () => {
  for (const r of [null, undefined, {}, { milestone: 42 }]) {
    assert.equal(isContentless(r), false);
  }
});
