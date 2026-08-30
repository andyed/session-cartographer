import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const INDEXER = path.join(ROOT, 'scripts', 'index-event.sh');
const RECORD_WRAPUP = path.join(ROOT, 'scripts', 'record-wrapup.sh');
const WRAPUP_SKILL = path.join(ROOT, 'plugins', 'session-cartographer', 'skills', 'wrapup', 'SKILL.md');

function harness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-index-outcomes-'));
  const bin = path.join(root, 'bin');
  const dev = path.join(root, 'dev');
  const calls = path.join(root, 'curl-calls');
  const stored = path.join(root, 'qdrant-payload');
  fs.mkdirSync(bin);
  fs.mkdirSync(dev);

  const curl = path.join(bin, 'curl');
  fs.writeFileSync(curl, `#!/bin/bash
url=""
data=""
method="GET"
while [ "$#" -gt 0 ]; do
  case "$1" in
    -d) data="$2"; shift 2 ;;
    -X) method="$2"; shift 2 ;;
    http://*|https://*) url="$1"; shift ;;
    *) shift ;;
  esac
done
printf '%s %s\n' "$method" "$url" >> "$FAKE_CALLS"
case "$url" in
  */collections/session-cartographer)
    [ "$FAKE_FAIL_STAGE" = "qdrant_health" ] && exit 22
    printf '%s\n' '{"result":{"status":"green"}}'
    ;;
  */health)
    [ "$FAKE_FAIL_STAGE" = "embedder_health" ] && exit 22
    printf '%s\n' '{"status":"ok"}'
    ;;
  */v1/embeddings)
    [ "$FAKE_FAIL_STAGE" = "embedding" ] && exit 22
    printf '%s\n' '{"data":[{"embedding":[0.1,0.2,0.3]}]}'
    ;;
  */points/search)
    [ "$FAKE_FAIL_STAGE" = "gate_search" ] && exit 22
    printf '{"result":[{"id":1,"score":%s}]}\n' "${'${FAKE_GATE_SCORE:-0.2}'}"
    ;;
  *'/points?wait=true')
    [ "$FAKE_FAIL_STAGE" = "upsert" ] && exit 22
    printf '%s' "$data" > "$FAKE_STORED_PAYLOAD"
    printf '%s\n' '{"status":"ok","result":{"status":"completed"}}'
    ;;
  */points/[0-9]*)
    [ "$FAKE_FAIL_STAGE" = "verify" ] && exit 22
    eid=$(jq -r '.points[0].payload.event_id' "$FAKE_STORED_PAYLOAD")
    [ "$FAKE_VERIFY_MISMATCH" = "1" ] && eid="evt-wrong"
    jq -n -c --arg eid "$eid" '{result:{payload:{event_id:$eid}}}'
    ;;
  *)
    printf '%s\n' '{}'
    ;;
esac
`);
  fs.chmodSync(curl, 0o755);

  const env = (overrides = {}) => ({
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    CARTOGRAPHER_DEV_DIR: dev,
    CARTOGRAPHER_QDRANT_URL: 'http://qdrant.test',
    CARTOGRAPHER_EMBED_URL: 'http://embed.test/v1/embeddings',
    CARTOGRAPHER_INDEX_RECEIPT: '1',
    FAKE_CALLS: calls,
    FAKE_STORED_PAYLOAD: stored,
    FAKE_FAIL_STAGE: '',
    FAKE_GATE_SCORE: '0.2',
    FAKE_VERIFY_MISMATCH: '0',
    ...overrides,
  });

  const run = (event, overrides = {}) => spawnSync('bash', [INDEXER], {
    input: typeof event === 'string' ? event : JSON.stringify(event),
    encoding: 'utf8',
    env: env(overrides),
  });

  const runWrapup = (event, overrides = {}) => spawnSync('bash', [RECORD_WRAPUP], {
    input: typeof event === 'string' ? event : JSON.stringify(event),
    encoding: 'utf8',
    env: env(overrides),
  });

  return { root, dev, calls, stored, run, runWrapup };
}

function receipt(result) {
  assert.equal(result.stderr, '');
  return JSON.parse(result.stdout.trim());
}

function readJsonl(file) {
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
}

test('malformed input is a recorded precondition failure, not success', () => {
  const h = harness();
  const result = h.run({ summary: 'missing its identity' });
  assert.equal(result.status, 65);
  assert.deepEqual(receipt(result), {
    event_id: null,
    outcome: 'precondition_failed',
    stage: 'missing_event_id',
  });
  const [failure] = readJsonl(path.join(h.dev, '.carto', 'index-errors.jsonl'));
  assert.equal(failure.outcome, 'precondition_failed');
  assert.equal(failure.stage, 'missing_event_id');
  assert.equal(fs.existsSync(h.calls), false, 'preconditions fail before any service call');
});

test('novelty rejection is observable and records its score', () => {
  const h = harness();
  const result = h.run({
    event_id: 'evt-rejected',
    timestamp: '2026-08-30T12:00:00Z',
    type: 'tool_bash',
    project: 'fixture',
    summary: 'routine duplicate work',
  }, { FAKE_GATE_SCORE: '0.91' });

  assert.equal(result.status, 0);
  assert.deepEqual(receipt(result), {
    event_id: 'evt-rejected',
    outcome: 'gate_rejected',
    stage: 'novelty_gate',
    point_id: receipt(result).point_id,
    source: 'tool_bash',
    score: 0.91,
    threshold: 0.85,
  });
  const [rejection] = readJsonl(path.join(h.dev, '.carto', 'index-rejects.jsonl'));
  assert.equal(rejection.event_id, 'evt-rejected');
  assert.equal(rejection.score, 0.91);
  assert.doesNotMatch(fs.readFileSync(h.calls, 'utf8'), /points\?wait=true/);
});

test('successful indexing is only reported after exact event-id readback', () => {
  const h = harness();
  const result = h.run({
    event_id: 'evt-indexed',
    timestamp: '2026-08-30T12:00:00Z',
    type: 'tool_file_edit',
    project: 'fixture',
    summary: 'implemented the outcome contract',
  });

  assert.equal(result.status, 0);
  const value = receipt(result);
  assert.equal(value.event_id, 'evt-indexed');
  assert.equal(value.outcome, 'indexed');
  assert.equal(value.stage, 'qdrant_readback');
  assert.equal(value.verified, true);
  const payload = JSON.parse(fs.readFileSync(h.stored, 'utf8'));
  assert.equal(payload.points[0].payload.event_id, 'evt-indexed');
  assert.equal(payload.points[0].payload.source, 'tool_file_edit');
});

test('detached callers avoid readback overhead when no receipt is requested', () => {
  const h = harness();
  const result = h.run({
    event_id: 'evt-detached',
    type: 'tool_bash',
    summary: 'background hook indexing',
  }, { CARTOGRAPHER_INDEX_RECEIPT: '0' });

  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
  const calls = fs.readFileSync(h.calls, 'utf8').trim().split('\n');
  assert.ok(calls.some((line) => line.includes('points?wait=true')));
  assert.equal(calls.some((line) => /\/points\/[0-9]+$/.test(line)), false);
});

test('strategic wrapups bypass the generic novelty gate and keep authored salience', () => {
  const h = harness();
  const result = h.run({
    event_id: 'evt-wrapup',
    timestamp: '2026-08-30T12:00:00Z',
    milestone: 'session_wrapup',
    session_id: 'session-fixture',
    project: 'fixture',
    description: 'Chose an explicit indexing receipt; unresolved release installation.',
  }, { FAKE_GATE_SCORE: '0.99' });

  assert.equal(result.status, 0);
  const value = receipt(result);
  assert.equal(value.outcome, 'indexed');
  assert.equal(value.source, 'milestones');
  const calls = fs.readFileSync(h.calls, 'utf8');
  assert.doesNotMatch(calls, /points\/search/);
  const payload = JSON.parse(fs.readFileSync(h.stored, 'utf8'));
  assert.equal(payload.points[0].payload.source, 'milestones');
  assert.equal(payload.points[0].payload.salience, 0.9);
});

test('service failures stay retryable and name the failed stage', () => {
  const h = harness();
  const result = h.run({
    event_id: 'evt-service-failure',
    type: 'tool_bash',
    summary: 'cannot reach qdrant',
  }, { FAKE_FAIL_STAGE: 'qdrant_health' });

  assert.equal(result.status, 75);
  const value = receipt(result);
  assert.equal(value.outcome, 'service_failed');
  assert.equal(value.stage, 'qdrant_unavailable');
  const [failure] = readJsonl(path.join(h.dev, '.carto', 'index-errors.jsonl'));
  assert.equal(failure.stage, 'qdrant_unavailable');
});

test('a mismatched readback is a failure rather than a false indexed receipt', () => {
  const h = harness();
  const result = h.run({
    event_id: 'evt-verify-mismatch',
    type: 'tool_bash',
    summary: 'verify exact identity',
  }, { FAKE_VERIFY_MISMATCH: '1' });

  assert.equal(result.status, 75);
  const value = receipt(result);
  assert.equal(value.outcome, 'service_failed');
  assert.equal(value.stage, 'qdrant_verify_mismatch');
});

test('record-wrapup separates durable logging from verified indexing', () => {
  const h = harness();
  const event = {
    event_id: 'evt-record-wrapup',
    timestamp: '2026-08-30T12:00:00Z',
    milestone: 'session_wrapup',
    session_id: 'session-record-wrapup',
    project: 'fixture',
    description: 'Recorded one durable synthesis and verified its semantic point.',
  };

  const first = h.runWrapup(event);
  assert.equal(first.status, 0);
  const firstReceipt = JSON.parse(first.stdout);
  assert.equal(firstReceipt.log_outcome, 'written');
  assert.equal(firstReceipt.index.outcome, 'indexed');
  assert.equal(firstReceipt.index.verified, true);

  const second = h.runWrapup(event);
  assert.equal(second.status, 0);
  assert.equal(JSON.parse(second.stdout).log_outcome, 'already_present');
  assert.equal(readJsonl(path.join(h.dev, 'session-milestones.jsonl')).length, 1);
});

test('record-wrapup retains the JSONL milestone when indexing is unavailable', () => {
  const h = harness();
  const event = {
    event_id: 'evt-record-offline',
    milestone: 'session_wrapup',
    session_id: 'session-record-offline',
    description: 'The durable log survives an unavailable semantic service.',
  };
  const result = h.runWrapup(event, { FAKE_FAIL_STAGE: 'qdrant_health' });

  assert.equal(result.status, 75);
  const value = JSON.parse(result.stdout);
  assert.equal(value.log_outcome, 'written');
  assert.equal(value.index.outcome, 'service_failed');
  assert.equal(value.index.stage, 'qdrant_unavailable');
  assert.equal(readJsonl(path.join(h.dev, 'session-milestones.jsonl'))[0].event_id, 'evt-record-offline');
});

test('record-wrapup refuses an event-id collision with different content', () => {
  const h = harness();
  const event = {
    event_id: 'evt-record-conflict',
    milestone: 'session_wrapup',
    session_id: 'session-record-conflict',
    description: 'Original synthesis.',
  };
  assert.equal(h.runWrapup(event).status, 0);
  const conflict = h.runWrapup({ ...event, description: 'Conflicting synthesis.' });
  assert.equal(conflict.status, 65);
  assert.equal(JSON.parse(conflict.stdout).index.stage, 'event_id_conflict');
  assert.equal(readJsonl(path.join(h.dev, 'session-milestones.jsonl')).length, 1);
});

test('wrapup skill consumes the receipt and verifies by configured event id', () => {
  const skill = fs.readFileSync(WRAPUP_SKILL, 'utf8');
  assert.match(skill, /record-wrapup\.sh/);
  assert.match(skill, /\.index\.outcome/);
  assert.match(skill, /CARTOGRAPHER_QDRANT_URL/);
  assert.match(skill, /VERIFIED_EVENT_ID.*EVENT_ID/);
  assert.doesNotMatch(skill, /NOT INDEXED/);
  assert.doesNotMatch(skill, /\| bash "\$ROOT\/scripts\/index-event\.sh"/);
});
