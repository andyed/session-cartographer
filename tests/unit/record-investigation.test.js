/**
 * tests/unit/record-investigation.test.js
 *
 * /investigate used to carry its write as an inline jq block, and agents
 * paraphrased it into four record shapes, 64 of them in a directory nothing
 * searched. The recorder is now one script; this pins its shape, its
 * validation, and the id link between a hypothesis and its outcome.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OFFLINE_INDEX_ENV } from './helpers/offline-index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = path.join(ROOT, 'scripts', 'record-investigation.sh');

function fixture({ indexerExit = 0 } = {}) {
  const dev = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-investigate-'));
  const indexer = path.join(dev, 'indexer.sh');
  fs.writeFileSync(indexer, `cat >/dev/null; echo '{"outcome":"${indexerExit ? 'failed' : 'indexed'}"}'; exit ${indexerExit}\n`);
  const run = (request) => {
    const res = spawnSync('bash', [SCRIPT], {
      input: JSON.stringify(request), encoding: 'utf-8',
      env: { ...process.env, ...OFFLINE_INDEX_ENV, CARTOGRAPHER_DEV_DIR: dev, CARTOGRAPHER_INDEXER: indexer,
             CARTOGRAPHER_SESSION_ID: 'session-fixture', CARTOGRAPHER_PROVIDER: 'codex', HOME: dev },
    });
    return { status: res.status, receipt: JSON.parse(res.stdout.trim()) };
  };
  const events = () => fs.readFileSync(path.join(dev, 'changelog.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  return { run, events };
}

test('open and close write one linked pair to the searched log', () => {
  const { run, events } = fixture();
  const opened = run({ kind: 'open', symptom: 'toast\nnever shows', hypothesis: 'gate reads a stale flag',
                       layer: 'state', files: ['js/toast.js'] });
  assert.equal(opened.status, 0);
  assert.equal(opened.receipt.log_outcome, 'written');
  assert.equal(opened.receipt.index.outcome, 'indexed');

  const closed = run({ kind: 'close', resolves: opened.receipt.event_id, outcome: 'refuted',
                      evidence: 'flag was fresh in the trace' });
  assert.equal(closed.status, 0);

  const [hyp, out] = events();
  assert.equal(hyp.type, 'investigation');
  assert.equal(hyp.event_id, opened.receipt.event_id);
  assert.equal(hyp.summary, 'Investigated: toast never shows — gate reads a stale flag', 'summary is one line');
  assert.equal(hyp.root_cause_layer, 'state');
  assert.deepEqual(hyp.files, ['js/toast.js']);
  assert.equal(hyp.session_id, 'session-fixture');

  assert.equal(out.type, 'investigation_outcome');
  assert.equal(out.resolves, hyp.event_id);
  assert.equal(out.outcome, 'refuted');
  assert.ok(out.summary.includes(hyp.event_id), 'a search for the original id must find the outcome');
});

test('invalid requests are refused before anything is written', () => {
  const { run } = fixture();
  for (const [request, stage] of [
    [{ kind: 'open', hypothesis: 'x' }, 'missing_symptom'],
    [{ kind: 'close', resolves: 'evt-abc', outcome: 'maybe', evidence: 'x' }, 'invalid_outcome'],
    [{ kind: 'close', resolves: 'not-an-id', outcome: 'confirmed', evidence: 'x' }, 'missing_resolves'],
    [{ kind: 'guess' }, 'invalid_kind'],
  ]) {
    const { status, receipt } = run(request);
    assert.notEqual(status, 0);
    assert.equal(receipt.log_outcome, 'not_written');
    assert.equal(receipt.index.stage, stage);
  }
});

test('an indexing failure keeps the durable record and says so', () => {
  const { run, events } = fixture({ indexerExit: 1 });
  const { status, receipt } = run({ kind: 'open', symptom: 's', hypothesis: 'h' });
  assert.notEqual(status, 0);
  assert.equal(receipt.log_outcome, 'written');
  assert.equal(receipt.index.outcome, 'failed');
  assert.equal(events().length, 1);
});
