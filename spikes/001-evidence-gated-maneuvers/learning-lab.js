#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const STRENGTH = Object.freeze({ none: 0, weak: 1, moderate: 2, strong: 3 });
const STRENGTH_NAME = ['none', 'weak', 'moderate', 'strong'];
const VERIFIER_CEILING = Object.freeze({
  test: STRENGTH.strong,
  compiler: STRENGTH.strong,
  build: STRENGTH.strong,
  exact_match: STRENGTH.strong,
  environment_predicate: STRENGTH.strong,
  independent_review: STRENGTH.moderate,
  evaluator_model: STRENGTH.moderate,
  self_report: STRENGTH.weak,
});

function hasText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function verifierStrength(episode) {
  const verifier = episode?.verifier;
  if (!hasText(verifier?.artifact)) return STRENGTH.none;
  const claimed = STRENGTH[verifier?.strength] ?? STRENGTH.none;
  const ceiling = VERIFIER_CEILING[verifier?.type] ?? STRENGTH.none;
  return Math.min(claimed, ceiling);
}

function episodeScope(episode) {
  return hasText(episode?.project) ? `project:${episode.project.trim()}` : 'global';
}

function uniqueByTrajectory(episodes) {
  const seen = new Set();
  return episodes.filter((episode) => {
    const id = episode.trajectory_id;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function confidenceFor({ successCount, harmfulCount, maxStrength, conflictingContent }) {
  if (harmfulCount > 0 || conflictingContent) return 0.35;
  if (maxStrength === STRENGTH.strong && successCount > 0) return 0.75;
  if (maxStrength === STRENGTH.moderate && successCount >= 2) return 0.7;
  if (maxStrength === STRENGTH.moderate && successCount === 1) return 0.55;
  if (maxStrength === STRENGTH.weak && successCount > 0) return 0.45;
  return 0.25;
}

function assessEvidence(episodes) {
  const successes = uniqueByTrajectory(episodes.filter((episode) => episode.outcome === 'passed'));
  const failures = uniqueByTrajectory(episodes.filter((episode) => episode.outcome === 'failed'));
  const maxStrength = successes.reduce((best, episode) => Math.max(best, verifierStrength(episode)), 0);
  const strongSuccess = successes.some((episode) => verifierStrength(episode) === STRENGTH.strong);
  const moderateSuccesses = successes.filter((episode) => verifierStrength(episode) >= STRENGTH.moderate).length;
  const lessons = new Set(episodes.map((episode) => episode.lesson.trim()));
  const conflictingContent = lessons.size > 1;
  const disputed = failures.length > 0 || conflictingContent;
  const eligible = !disputed && (strongSuccess || moderateSuccesses >= 2);
  const reasons = [];

  if (failures.length > 0) reasons.push('attributed failure disputes the maneuver');
  if (conflictingContent) reasons.push('conflicting lesson text shares one maneuver key');
  if (!disputed && strongSuccess) reasons.push('one strongly verified successful trajectory');
  else if (!disputed && moderateSuccesses >= 2) reasons.push('two distinct moderately verified successful trajectories');
  else if (!disputed && maxStrength <= STRENGTH.weak) reasons.push('weak evidence cannot promote');
  else if (!disputed) reasons.push('insufficient independent verified support');

  return {
    successes,
    failures,
    maxStrength,
    conflictingContent,
    disputed,
    eligible,
    reasons,
  };
}

export function buildCandidateLedger(episodes) {
  if (!Array.isArray(episodes)) throw new TypeError('episodes must be an array');

  const rejected = [];
  const groups = new Map();
  const seenEventIds = new Set();
  episodes.forEach((episode, index) => {
    if (!hasText(episode?.event_id)) {
      rejected.push({ index, reason: 'missing event_id' });
      return;
    }
    if (!hasText(episode?.trajectory_id)) {
      rejected.push({ index, reason: 'missing trajectory_id' });
      return;
    }
    if (!hasText(episode?.project)) {
      rejected.push({ index, reason: 'missing project' });
      return;
    }
    if (!hasText(episode?.maneuver_key)) {
      rejected.push({ index, reason: 'missing maneuver_key' });
      return;
    }
    if (!hasText(episode?.lesson)) {
      rejected.push({ index, reason: 'missing lesson' });
      return;
    }
    if (!['passed', 'failed', 'unverified'].includes(episode.outcome)) {
      rejected.push({ index, reason: 'unsupported outcome' });
      return;
    }
    if (seenEventIds.has(episode.event_id)) {
      rejected.push({ index, reason: 'duplicate event_id' });
      return;
    }
    seenEventIds.add(episode.event_id);
    const scope = episodeScope(episode);
    const groupId = `${scope}\0${episode.maneuver_key}`;
    if (!groups.has(groupId)) {
      groups.set(groupId, { key: episode.maneuver_key, scope, evidence: [] });
    }
    groups.get(groupId).evidence.push(episode);
  });

  const candidates = [...groups.values()].map(({ key, scope, evidence }) => {
    const assessment = assessEvidence(evidence);
    const first = evidence[0];
    return {
      id: `maneuver:${scope}:${key}`,
      type: 'procedure',
      content: first.lesson.trim(),
      scope,
      applicability: hasText(first.applicability) ? first.applicability.trim() : '',
      provenance_event_ids: evidence.map((episode) => episode.event_id),
      verifier_strength: STRENGTH_NAME[assessment.maxStrength],
      success_count: assessment.successes.length,
      harmful_count: assessment.failures.length,
      confidence: confidenceFor({
        successCount: assessment.successes.length,
        harmfulCount: assessment.failures.length,
        maxStrength: assessment.maxStrength,
        conflictingContent: assessment.conflictingContent,
      }),
      status: assessment.disputed ? 'disputed' : 'candidate',
      eligible_for_promotion: assessment.eligible,
      shadow_only: true,
      reasons: assessment.reasons,
    };
  });

  return { candidates, rejected };
}

function summarizeVariant(rows) {
  const verified = rows.filter((row) => row.verified === true).length;
  return {
    tasks: rows.length,
    verified_completions: verified,
    verified_completion_rate: rows.length > 0 ? verified / rows.length : null,
    regressions: rows.reduce((sum, row) => sum + row.regressions, 0),
    retries: rows.reduce((sum, row) => sum + row.retries, 0),
    tokens: rows.reduce((sum, row) => sum + row.tokens, 0),
  };
}

function validateTrial(row) {
  if (!hasText(row?.task_id)) return 'missing task_id';
  if (!['baseline', 'shadow'].includes(row.variant)) return 'unsupported variant';
  if (typeof row.verified !== 'boolean') return 'verified must be boolean';
  for (const field of ['regressions', 'retries', 'tokens']) {
    if (typeof row[field] !== 'number' || !Number.isFinite(row[field]) || row[field] < 0) {
      return `${field} must be a finite non-negative number`;
    }
  }
  return null;
}

export function compareShadowOutcomes(trials) {
  if (!Array.isArray(trials)) throw new TypeError('trials must be an array');

  const byTask = new Map();
  const rejected = [];
  for (let index = 0; index < trials.length; index++) {
    const row = trials[index];
    const rejection = validateTrial(row);
    if (rejection) {
      rejected.push({ index, reason: rejection });
      continue;
    }
    if (!byTask.has(row.task_id)) byTask.set(row.task_id, {});
    if (byTask.get(row.task_id)[row.variant]) {
      rejected.push({ index, reason: 'duplicate task variant' });
      continue;
    }
    byTask.get(row.task_id)[row.variant] = row;
  }
  const unpairedTaskIds = [...byTask.entries()]
    .filter(([, pair]) => !pair.baseline || !pair.shadow)
    .map(([taskId]) => taskId);
  const pairs = [...byTask.values()].filter((pair) => pair.baseline && pair.shadow);
  const baseline = summarizeVariant(pairs.map((pair) => pair.baseline));
  const shadow = summarizeVariant(pairs.map((pair) => pair.shadow));
  const delta = {
    verified_completion_rate: shadow.verified_completion_rate === null || baseline.verified_completion_rate === null
      ? null
      : shadow.verified_completion_rate - baseline.verified_completion_rate,
    regressions: shadow.regressions - baseline.regressions,
    retries: shadow.retries - baseline.retries,
    tokens: shadow.tokens - baseline.tokens,
  };
  const reasons = [];
  let verdict = 'PARTIAL';

  if (pairs.length === 0) {
    reasons.push('no paired baseline and shadow trials');
  } else if (delta.regressions > 0) {
    verdict = 'INVALIDATED';
    reasons.push('regressions increased');
  } else if (delta.verified_completion_rate < 0) {
    verdict = 'INVALIDATED';
    reasons.push('verified completion decreased');
  } else if (rejected.length > 0 || unpairedTaskIds.length > 0) {
    if (rejected.length > 0) reasons.push('invalid trial rows were rejected');
    if (unpairedTaskIds.length > 0) reasons.push('incomplete task pairs were excluded');
  } else if (delta.verified_completion_rate > 0) {
    verdict = 'VALIDATED';
    reasons.push('verified completion improved without added regressions');
  } else {
    reasons.push('no verified completion improvement');
  }

  return {
    tasks_compared: pairs.length,
    rejected,
    unpaired_task_ids: unpairedTaskIds,
    baseline,
    shadow,
    delta,
    verdict,
    reasons,
  };
}

function readJsonl(filePath) {
  return fs.readFileSync(filePath, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`${filePath}:${index + 1}: invalid JSON: ${error.message}`);
      }
    });
}

function valueAfter(args, flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : null;
}

function runCli(args) {
  const episodesPath = valueAfter(args, '--episodes');
  const trialsPath = valueAfter(args, '--trials');
  if (!episodesPath) {
    console.error('usage: learning-lab.js --episodes <episodes.jsonl> [--trials <trials.jsonl>]');
    return 2;
  }

  const report = {
    mode: 'shadow-only',
    canonical_writes: false,
    ledger: buildCandidateLedger(readJsonl(path.resolve(episodesPath))),
  };
  if (trialsPath) report.shadow_evaluation = compareShadowOutcomes(readJsonl(path.resolve(trialsPath)));
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return 0;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) process.exitCode = runCli(process.argv.slice(2));
