/**
 * tests/unit/search-min-score.test.js
 *
 * --min-score drops results under a fused-score floor inside the search, before
 * anything is shown, served, or added to the session's delta-serving list.
 *
 * Why inside the search and not in the caller: the prompt-cue hook acts only on
 * a confident hit. Filtering its output afterwards would leave served rows for
 * results the agent never saw (skewing hit rate by rank for the prompt-cue
 * purpose) and, worse, put those unseen ids on the session's delta-serving list,
 * so the agent's next /remember would silently suppress them. Both are the
 * failure this codebase keeps meeting: a well-formed answer, quietly wrong.
 *
 * Both writers are driven: the portable awk fusion and the Turbo client behind a
 * fake /api/recall. Each must emit `score` on jsonl rows, honour the floor, and
 * record min_score / top_score / below_min_score on its call row.
 *
 * Run with: node --test tests/unit/search-min-score.test.js
 */
process.env.CARTOGRAPHER_SEMANTIC = '0';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { OFFLINE_INDEX_ENV } from './helpers/offline-index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SEARCH = path.join(ROOT, 'scripts', 'cartographer-search.sh');
const runAsync = promisify(execFile);
const QUERY = 'zzfloorqq';
const IDENTITY_VARS = ['CARTOGRAPHER_SESSION_ID', 'CLAUDE_SESSION_ID', 'CLAUDE_CODE_SESSION_ID',
  'CODEX_SESSION_ID', 'CARTOGRAPHER_PROVIDER', 'CODEX_THREAD_ID', 'CODEX_HOME', 'HERMES_SESSION_ID'];

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

/**
 * Three hits that share the query token and differ in salience, so their fused
 * scores differ by a known order (0.9 > 0.5 > 0.2), plus filler so BM25 does not
 * clamp the token to zero as a majority term. Timestamps are an hour old, so the
 * decay factor is ~1 and does not reorder anything.
 */
function makeCorpus() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-min-score-'));
  const ts = new Date(Date.now() - 3600e3).toISOString().replace(/\.\d+Z$/, 'Z');
  const event = (id, salience, summary) => JSON.stringify({
    event_id: id, timestamp: ts, type: 'tool_bash', project: 'floorproject', salience, summary,
  });
  const rows = [
    event('evt-floorhigh', 0.9, `Ran: ${QUERY} high salience hit`),
    event('evt-floormid', 0.5, `Ran: ${QUERY} middle salience hit`),
    event('evt-floorlow', 0.2, `Ran: ${QUERY} low salience hit`),
    ...Array.from({ length: 9 }, (_, i) => event(`evt-floorfill${i}`, 0.5, `Ran: unrelated filler ${i}`)),
  ];
  fs.writeFileSync(path.join(dir, 'changelog.jsonl'), `${rows.join('\n')}\n`);
  for (const name of ['session-milestones.jsonl', 'research-log.jsonl', 'tool-use-log.jsonl']) {
    fs.writeFileSync(path.join(dir, name), '');
  }
  return {
    dir,
    served: path.join(dir, 'served-log.jsonl'),
    calls: path.join(dir, 'search-calls.jsonl'),
    lists: path.join(dir, 'cartographer-served'),
  };
}

function env(corpus, overrides = {}) {
  const base = { ...process.env };
  for (const key of IDENTITY_VARS) delete base[key];
  return {
    ...base,
    ...OFFLINE_INDEX_ENV,
    CARTOGRAPHER_DEV_DIR: corpus.dir,
    CARTOGRAPHER_SERVED_LOG: corpus.served,
    CARTOGRAPHER_SEARCH_CALL_LOG: corpus.calls,
    CARTOGRAPHER_ACCESS_LEDGER: path.join(corpus.dir, 'access-ledger.jsonl'),
    CARTOGRAPHER_TRANSCRIPTS_DIR: path.join(corpus.dir, 'none'),
    CARTOGRAPHER_CODEX_TRANSCRIPTS_DIR: path.join(corpus.dir, 'none'),
    CARTOGRAPHER_CODEX_ARCHIVED_DIR: path.join(corpus.dir, 'none'),
    CARTOGRAPHER_CONFIG: path.join(corpus.dir, 'no-config.json'),
    CARTOGRAPHER_SEMANTIC: '0',
    CARTOGRAPHER_TURBO: '0',
    TMPDIR_BASE: corpus.dir,
    ...overrides,
  };
}

function portable(corpus, callId, extra = [], overrides = {}) {
  const res = spawnSync('bash', [SEARCH, QUERY, '--limit', '3', '--format', 'jsonl', '--call-id', callId, ...extra], {
    encoding: 'utf8', env: env(corpus, overrides),
  });
  return {
    status: res.status,
    stderr: res.stderr,
    rows: res.stdout.split('\n').filter(Boolean).map((line) => JSON.parse(line)),
    served: readJsonl(corpus.served).filter((row) => row.call_id === callId),
    call: readJsonl(corpus.calls).find((row) => row.call_id === callId),
  };
}

test('portable jsonl rows carry the fused score, in ranking order', () => {
  const corpus = makeCorpus();
  try {
    const run = portable(corpus, 'call-floor-scores');
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(run.rows.map((r) => r.event_id), ['evt-floorhigh', 'evt-floormid', 'evt-floorlow']);
    for (const row of run.rows) assert.equal(typeof row.score, 'number');
    assert.ok(run.rows[0].score > run.rows[1].score && run.rows[1].score > run.rows[2].score);
    // Without a floor the call row still reports the top score, and says no floor ran.
    assert.equal(run.call.min_score, null);
    assert.equal(run.call.below_min_score, 0);
    assert.ok(Math.abs(run.call.top_score - run.rows[0].score) < 1e-6);
  } finally {
    fs.rmSync(corpus.dir, { recursive: true, force: true });
  }
});

test('portable --min-score shows, serves and delta-lists only what clears the floor', () => {
  const corpus = makeCorpus();
  try {
    const baseline = portable(corpus, 'call-floor-baseline').rows;
    // The guard on the guard: the floor must fall between real scores, or the
    // test passes against a search that ignores it.
    const floor = ((baseline[0].score + baseline[1].score) / 2).toFixed(6);
    const sid = 'sess-floor-delta';
    const floored = portable(corpus, 'call-floor-on', ['--min-score', floor], { CARTOGRAPHER_SESSION_ID: sid });
    assert.equal(floored.status, 0, floored.stderr);
    assert.deepEqual(floored.rows.map((r) => r.event_id), ['evt-floorhigh']);
    assert.deepEqual(floored.served.map((r) => r.event_id), ['evt-floorhigh'], 'served rows are what was shown');
    assert.equal(floored.call.min_score, Number(floor));
    assert.equal(floored.call.below_min_score, 2, 'the limit admitted three; the floor emptied two');
    assert.equal(floored.call.result_count, 1);

    const list = fs.readFileSync(path.join(corpus.lists, `${sid}.txt`), 'utf8').split('\n').filter(Boolean);
    assert.deepEqual(list, ['evt-floorhigh'], 'unseen results stay off the delta-serving list');

    // So the session's next unfloored search still gets the two it never saw.
    const next = portable(corpus, 'call-floor-next', [], { CARTOGRAPHER_SESSION_ID: sid });
    assert.deepEqual(next.rows.map((r) => r.event_id), ['evt-floormid', 'evt-floorlow']);
  } finally {
    fs.rmSync(corpus.dir, { recursive: true, force: true });
  }
});

test('portable --min-score above every result returns nothing and says what it dropped', () => {
  const corpus = makeCorpus();
  try {
    const run = portable(corpus, 'call-floor-all', ['--min-score', '0.5']);
    assert.equal(run.rows.length, 0);
    assert.equal(run.served.length, 0);
    assert.equal(run.call.result_count, 0);
    assert.equal(run.call.below_min_score, 3);
    assert.ok(run.call.top_score > 0 && run.call.top_score < 0.5, 'the pre-floor top score is kept for retuning');
  } finally {
    fs.rmSync(corpus.dir, { recursive: true, force: true });
  }
});

test('a malformed --min-score is rejected, not read as zero', () => {
  const corpus = makeCorpus();
  try {
    for (const bad of ['abc', '1.2.3', '-1', '.']) {
      const run = portable(corpus, 'call-floor-bad', ['--min-score', bad]);
      assert.equal(run.status, 2, `--min-score ${bad} must fail`);
    }
  } finally {
    fs.rmSync(corpus.dir, { recursive: true, force: true });
  }
});

// ─── Turbo ───────────────────────────────────────────────────────────────────

function fakeTurbo(results) {
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        contract_version: 1, backend: 'explorer', call_id: body.call_id, semantic_status: 'disabled',
        index_generation: 'fixture', stages_ms: { total: 1 }, results,
      }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }));
  });
}

test('Turbo --min-score drops low and unscored results before serving, with the same call-row fields', async () => {
  const corpus = makeCorpus();
  const hit = (id, score) => ({
    event_id: id, timestamp: '2026-10-15T00:00:00Z', project: 'floorproject', summary: `${id} summary`,
    _sources: 'changelog+semantic', ...(score === undefined ? {} : { _score: score }),
  });
  const turbo = await fakeTurbo([hit('evt-t-high', 0.02), hit('evt-t-mid', 0.012), hit('evt-t-low', 0.004), hit('evt-t-unscored')]);
  try {
    const config = path.join(corpus.dir, 'turbo-config.json');
    fs.writeFileSync(config, JSON.stringify({ turbo: { enabled: true, auto_start: false, url: turbo.url } }));
    const { stdout } = await runAsync('bash', [SEARCH, QUERY, '--limit', '4', '--format', 'jsonl',
      '--call-id', 'call-floor-turbo', '--min-score', '0.01'], {
      env: env(corpus, {
        CARTOGRAPHER_CONFIG: config, CARTOGRAPHER_TURBO: '1', CARTOGRAPHER_TURBO_URL: turbo.url,
        CARTOGRAPHER_TURBO_STATE_DIR: path.join(corpus.dir, 'turbo-state'),
      }),
    });
    const rows = stdout.split('\n').filter(Boolean).map((line) => JSON.parse(line));
    assert.deepEqual(rows.map((r) => r.event_id), ['evt-t-high', 'evt-t-mid']);
    assert.deepEqual(rows.map((r) => r.score), [0.02, 0.012]);

    const served = readJsonl(corpus.served).filter((r) => r.call_id === 'call-floor-turbo');
    // Composition: the rows must come from the Turbo writer, or this proves nothing about it.
    assert.ok(served.length > 0 && served.every((r) => r.backend === 'explorer'), JSON.stringify(served));
    assert.deepEqual(served.map((r) => r.event_id), ['evt-t-high', 'evt-t-mid']);

    const call = readJsonl(corpus.calls).find((r) => r.call_id === 'call-floor-turbo');
    assert.equal(call.selected_backend, 'explorer');
    assert.equal(call.min_score, 0.01);
    assert.equal(call.top_score, 0.02);
    assert.equal(call.below_min_score, 2, 'the low hit and the unscored one');
    assert.equal(call.result_count, 2);
  } finally {
    turbo.server.close();
    fs.rmSync(corpus.dir, { recursive: true, force: true });
  }
});
