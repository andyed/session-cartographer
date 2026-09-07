import assert from 'node:assert/strict';
import test from 'node:test';

import { buildCandidateLedger, compareShadowOutcomes } from './learning-lab.js';

const episode = (overrides = {}) => ({
  event_id: 'evt-1',
  trajectory_id: 'traj-1',
  timestamp: '2026-09-01T12:00:00Z',
  project: 'session-cartographer',
  maneuver_key: 'test-node-script',
  lesson: 'Run the focused Node test before the full regression suite.',
  applicability: 'Node scripts with focused node:test coverage',
  outcome: 'passed',
  verifier: { type: 'test', strength: 'strong', artifact: 'node --test tests/unit/example.test.js: 4 passed' },
  ...overrides,
});

test('a strongly verified trajectory creates an eligible candidate without activating it', () => {
  const ledger = buildCandidateLedger([episode()]);

  assert.equal(ledger.rejected.length, 0);
  assert.equal(ledger.candidates.length, 1);
  assert.deepEqual(ledger.candidates[0], {
    id: 'maneuver:project:session-cartographer:test-node-script',
    type: 'procedure',
    content: 'Run the focused Node test before the full regression suite.',
    scope: 'project:session-cartographer',
    applicability: 'Node scripts with focused node:test coverage',
    provenance_event_ids: ['evt-1'],
    verifier_strength: 'strong',
    success_count: 1,
    harmful_count: 0,
    confidence: 0.75,
    status: 'candidate',
    eligible_for_promotion: true,
    shadow_only: true,
    reasons: ['one strongly verified successful trajectory'],
  });
});

test('two distinct moderate successes are required when no strong verifier exists', () => {
  const one = episode({ verifier: { type: 'independent_review', strength: 'moderate', artifact: 'review-1' } });
  const first = buildCandidateLedger([one]).candidates[0];
  assert.equal(first.eligible_for_promotion, false);

  const second = episode({
    event_id: 'evt-2',
    trajectory_id: 'traj-2',
    timestamp: '2026-09-02T12:00:00Z',
    verifier: { type: 'independent_review', strength: 'moderate', artifact: 'review-2' },
  });
  const repeated = buildCandidateLedger([one, second]).candidates[0];
  assert.equal(repeated.eligible_for_promotion, true);
  assert.equal(repeated.success_count, 2);
  assert.equal(repeated.confidence, 0.7);
  assert.deepEqual(repeated.provenance_event_ids, ['evt-1', 'evt-2']);
});

test('weak self-report never creates promotion eligibility by repetition alone', () => {
  const episodes = [1, 2, 3].map((n) => episode({
    event_id: `evt-${n}`,
    trajectory_id: `traj-${n}`,
    verifier: { type: 'self_report', strength: 'weak', artifact: `claim-${n}` },
  }));

  const candidate = buildCandidateLedger(episodes).candidates[0];
  assert.equal(candidate.success_count, 3);
  assert.equal(candidate.eligible_for_promotion, false);
  assert.match(candidate.reasons.join(' '), /weak evidence cannot promote/);
});

test('a producer cannot upgrade self-report to strong evidence by relabeling it', () => {
  const candidate = buildCandidateLedger([
    episode({ verifier: { type: 'self_report', strength: 'strong', artifact: 'trust me' } }),
  ]).candidates[0];

  assert.equal(candidate.verifier_strength, 'weak');
  assert.equal(candidate.eligible_for_promotion, false);
});

test('a verifier without an artifact carries no promotion strength', () => {
  const candidate = buildCandidateLedger([
    episode({ verifier: { type: 'test', strength: 'strong', artifact: '' } }),
  ]).candidates[0];

  assert.equal(candidate.verifier_strength, 'none');
  assert.equal(candidate.eligible_for_promotion, false);
});

test('unverified strong evidence cannot inflate weak successful support', () => {
  const candidate = buildCandidateLedger([
    episode({ verifier: { type: 'self_report', strength: 'weak', artifact: 'claim' } }),
    episode({
      event_id: 'evt-unverified',
      trajectory_id: 'traj-unverified',
      outcome: 'unverified',
      verifier: { type: 'test', strength: 'strong', artifact: 'test was not tied to an outcome' },
    }),
  ]).candidates[0];

  assert.equal(candidate.verifier_strength, 'weak');
  assert.equal(candidate.confidence, 0.45);
  assert.equal(candidate.eligible_for_promotion, false);
});

test('an attributed failure disputes the candidate and blocks promotion', () => {
  const failed = episode({
    event_id: 'evt-fail',
    trajectory_id: 'traj-fail',
    timestamp: '2026-09-03T12:00:00Z',
    outcome: 'failed',
    verifier: { type: 'test', strength: 'strong', artifact: 'node --test: 1 failed' },
  });

  const candidate = buildCandidateLedger([episode(), failed]).candidates[0];
  assert.equal(candidate.status, 'disputed');
  assert.equal(candidate.harmful_count, 1);
  assert.equal(candidate.eligible_for_promotion, false);
  assert.deepEqual(candidate.provenance_event_ids, ['evt-1', 'evt-fail']);
});

test('records without immutable provenance are rejected instead of guessed', () => {
  const ledger = buildCandidateLedger([episode({ event_id: '' })]);

  assert.equal(ledger.candidates.length, 0);
  assert.deepEqual(ledger.rejected, [{ index: 0, reason: 'missing event_id' }]);
});

test('records without project scope are rejected instead of pooled globally', () => {
  const ledger = buildCandidateLedger([episode({ project: '' })]);

  assert.equal(ledger.candidates.length, 0);
  assert.deepEqual(ledger.rejected, [{ index: 0, reason: 'missing project' }]);
});

test('duplicate event ids cannot masquerade as independent support', () => {
  const verifier = { type: 'independent_review', strength: 'moderate', artifact: 'review' };
  const ledger = buildCandidateLedger([
    episode({ verifier }),
    episode({ trajectory_id: 'traj-2', verifier }),
  ]);

  assert.equal(ledger.candidates[0].success_count, 1);
  assert.equal(ledger.candidates[0].eligible_for_promotion, false);
  assert.deepEqual(ledger.rejected, [{ index: 1, reason: 'duplicate event_id' }]);
});

test('an invalid record does not reserve its event id against later valid evidence', () => {
  const ledger = buildCandidateLedger([
    episode({ trajectory_id: '' }),
    episode(),
  ]);

  assert.equal(ledger.candidates.length, 1);
  assert.deepEqual(ledger.rejected, [{ index: 0, reason: 'missing trajectory_id' }]);
});

test('project scope prevents evidence from unrelated repositories from pooling', () => {
  const ledger = buildCandidateLedger([
    episode({
      event_id: 'evt-a',
      trajectory_id: 'traj-a',
      project: 'project-a',
      verifier: { type: 'independent_review', strength: 'moderate', artifact: 'review-a' },
    }),
    episode({
      event_id: 'evt-b',
      trajectory_id: 'traj-b',
      project: 'project-b',
      verifier: { type: 'independent_review', strength: 'moderate', artifact: 'review-b' },
    }),
  ]);

  assert.equal(ledger.candidates.length, 2);
  assert.deepEqual(
    ledger.candidates.map((candidate) => candidate.id),
    ['maneuver:project:project-a:test-node-script', 'maneuver:project:project-b:test-node-script'],
  );
  assert.equal(ledger.candidates.every((candidate) => !candidate.eligible_for_promotion), true);
});

test('shadow comparison validates only verified improvement without added regressions', () => {
  const report = compareShadowOutcomes([
    { task_id: 'a', variant: 'baseline', verified: true, regressions: 0, retries: 2, tokens: 1000 },
    { task_id: 'a', variant: 'shadow', verified: true, regressions: 0, retries: 1, tokens: 800 },
    { task_id: 'b', variant: 'baseline', verified: false, regressions: 0, retries: 3, tokens: 1200 },
    { task_id: 'b', variant: 'shadow', verified: true, regressions: 0, retries: 1, tokens: 900 },
  ]);

  assert.equal(report.tasks_compared, 2);
  assert.equal(report.baseline.verified_completion_rate, 0.5);
  assert.equal(report.shadow.verified_completion_rate, 1);
  assert.equal(report.delta.verified_completion_rate, 0.5);
  assert.equal(report.delta.regressions, 0);
  assert.equal(report.delta.retries, -3);
  assert.equal(report.delta.tokens, -500);
  assert.equal(report.verdict, 'VALIDATED');
});

test('shadow comparison refuses validation when regressions increase', () => {
  const report = compareShadowOutcomes([
    { task_id: 'a', variant: 'baseline', verified: false, regressions: 0, retries: 2, tokens: 1000 },
    { task_id: 'a', variant: 'shadow', verified: true, regressions: 1, retries: 1, tokens: 800 },
  ]);

  assert.equal(report.verdict, 'INVALIDATED');
  assert.match(report.reasons.join(' '), /regressions increased/);
});

test('shadow comparison reports incomplete pairs and withholds validation', () => {
  const report = compareShadowOutcomes([
    { task_id: 'a', variant: 'baseline', verified: false, regressions: 0, retries: 2, tokens: 1000 },
    { task_id: 'a', variant: 'shadow', verified: true, regressions: 0, retries: 1, tokens: 800 },
    { task_id: 'b', variant: 'shadow', verified: false, regressions: 2, retries: 3, tokens: 900 },
  ]);

  assert.deepEqual(report.unpaired_task_ids, ['b']);
  assert.equal(report.verdict, 'PARTIAL');
  assert.match(report.reasons.join(' '), /incomplete task pairs/);
});

test('shadow comparison rejects malformed metrics and duplicate variants', () => {
  const report = compareShadowOutcomes([
    { task_id: 'a', variant: 'baseline', verified: true, regressions: 0, retries: 2, tokens: 1000 },
    { task_id: 'a', variant: 'baseline', verified: true, regressions: 0, retries: 1, tokens: 900 },
    { task_id: 'a', variant: 'shadow', verified: true, regressions: -1, retries: 1, tokens: 800 },
  ]);

  assert.deepEqual(report.rejected, [
    { index: 1, reason: 'duplicate task variant' },
    { index: 2, reason: 'regressions must be a finite non-negative number' },
  ]);
  assert.equal(report.verdict, 'PARTIAL');
});
