/**
 * tests/unit/backfill-investigations.test.js
 *
 * The /investigate skill wrote 64 root-cause diagnoses to a path nothing reads,
 * in four different record shapes, because its jq block was paraphrased rather
 * than run. This backfill normalizes them into the searched log.
 *
 * The assertions that matter are the ones the original bug would have failed:
 * a summary containing a newline splits the TSV row downstream, and a record
 * keyed on `id`/`ts` instead of `event_id`/`timestamp` is invisible to the
 * pipeline no matter which file it lives in.
 *
 * Run with: node --test tests/unit/backfill-investigations.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = path.join(ROOT, 'scripts', 'backfill-investigations.js');

// One of each shape found in the corpus, plus a record that must be ignored.
const FIXTURES = [
  // canonical
  { id: 'evt-canon01', ts: '2026-07-04T17:47:41Z', type: 'investigation',
    provider: 'codex', session_id: 'sid-a', project: 'proj-a',
    symptom: 'thing is broken', hypothesis: 'Cause: x. Mechanism: y. Disproof: z.' },
  // multi-line hypothesis — the case that splits a TSV row downstream
  { id: 'evt-multi01', ts: '2026-07-05T10:00:00Z', type: 'investigation',
    provider: 'codex', session_id: 'sid-a', project: 'proj-a',
    symptom: 'focus escapes\tthe list',
    hypothesis: 'Cause: innerHTML replaced.\nMechanism: activeElement falls to BODY.\r\nDisproof: a trace.' },
  // literal backslash-n, as earlier hooks' escaping produced
  { id: 'evt-esc01', ts: '2026-07-06T10:00:00Z', type: 'investigation',
    project: 'proj-a', session_id: 'sid-a',
    symptom: 'escaped newline', hypothesis: 'Cause: a.\\nMechanism: b.\\nDisproof: c.' },
  // variant type names
  { id: 'evt-var01', ts: '2026-07-07T10:00:00Z', type: 'DebugHypothesis',
    project: 'proj-b', symptom: 'variant one', hypothesis: 'Cause: v1.' },
  { id: 'evt-var02', ts: '2026-07-08T10:00:00Z', type: 'diagnosis',
    project: 'proj-b', symptom: 'variant two', hypothesis: 'Cause: v2.' },
  { id: 'evt-var03', timestamp: '2026-07-09T10:00:00Z', type: 'investigation_hypothesis',
    project: 'proj-b', root_cause_layer: 'boundary',
    symptom: 'variant three', hypothesis: 'Cause: v3.' },
  // must be ignored — not an investigation
  { id: 'evt-other01', ts: '2026-07-10T10:00:00Z', type: 'tool_bash',
    project: 'proj-b', summary: 'Ran: ls' },
];

function runBackfill(extraArgs = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-inv-'));
  const eventsDir = path.join(dir, 'events');
  fs.mkdirSync(eventsDir);
  fs.writeFileSync(path.join(eventsDir, '2026-07.jsonl'),
    `${FIXTURES.map((f) => JSON.stringify(f)).join('\n')}\n`);
  const target = path.join(dir, 'changelog.jsonl');
  fs.writeFileSync(target, '');

  const result = spawnSync('node', [
    SCRIPT, '--events-dir', eventsDir, '--target', target, ...extraArgs,
  ], {
    encoding: 'utf8',
    env: { ...process.env, CARTOGRAPHER_DEV_DIR: dir, CARTOGRAPHER_TRANSCRIPTS_DIR: path.join(dir, 'none') },
  });

  const appended = fs.existsSync(target)
    ? fs.readFileSync(target, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : [];
  return { result, appended, dir, target, eventsDir };
}

test('every investigation shape is normalized, non-investigations are skipped', () => {
  const { result, appended } = runBackfill(['--write']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(appended.length, 6, 'six investigations, tool_bash excluded');
  for (const event of appended) {
    assert.equal(event.type, 'investigation', 'all variants collapse to one type');
  }
});

test('records use the field names the pipeline indexes on', () => {
  const { appended } = runBackfill(['--write']);
  for (const event of appended) {
    assert.ok(event.event_id, 'event_id required — `id` is invisible to the pipeline');
    assert.ok(event.timestamp, 'timestamp required — `ts` is invisible to the pipeline');
    assert.equal(event.id, undefined, 'the legacy `id` key must not survive');
    assert.equal(event.ts, undefined, 'the legacy `ts` key must not survive');
  }
});

test('summaries are single-line and carry both symptom and hypothesis', () => {
  const { appended } = runBackfill(['--write']);
  for (const event of appended) {
    assert.ok(event.summary, 'summary is first in the extraction chain');
    assert.ok(!/[\n\r\t]/.test(event.summary),
      `summary must not contain newline or tab: ${JSON.stringify(event.summary)}`);
    assert.ok(!event.summary.includes('\\n'),
      `literal backslash-n must be flattened: ${JSON.stringify(event.summary)}`);
  }
  const multi = appended.find((e) => e.event_id === 'evt-multi01');
  assert.match(multi.summary, /focus escapes the list/, 'symptom is searchable');
  assert.match(multi.summary, /activeElement falls to BODY/, 'hypothesis is searchable');
});

test('rerunning appends nothing', () => {
  const { target, eventsDir, dir } = runBackfill(['--write']);
  const before = fs.readFileSync(target, 'utf8');
  const rerun = spawnSync('node', [
    SCRIPT, '--events-dir', eventsDir, '--target', target, '--write',
  ], {
    encoding: 'utf8',
    env: { ...process.env, CARTOGRAPHER_DEV_DIR: dir, CARTOGRAPHER_TRANSCRIPTS_DIR: path.join(dir, 'none') },
  });
  assert.equal(rerun.status, 0, rerun.stderr);
  assert.equal(fs.readFileSync(target, 'utf8'), before, 'second run must be a no-op');
});

test('dry run writes nothing', () => {
  const { result, appended } = runBackfill([]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(appended.length, 0, 'nothing is written without --write');
  assert.match(result.stdout, /Dry run/);
});
