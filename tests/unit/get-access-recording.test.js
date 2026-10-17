/**
 * tests/unit/get-access-recording.test.js
 *
 * `--get` is the fetch the skill asks for, and its access row is the only
 * trace a hit-rate report has of it. Two ways lost that row while the agent did
 * everything right (docs/ABANDONMENT.md, measured 2026-10-17):
 *
 *   - `--get … | head` — the CLI printed the records and recorded the fetch
 *     afterwards, so a reader that closed the pipe early ended the script by
 *     SIGPIPE before the row was written. Three real calls passed --call-id
 *     and still left no row.
 *   - `--get turn-…` — conversation turns live only in the semantic index, so
 *     --get reported them missing and recorded nothing, even for a turn the
 *     named call had served. Turn ids are about a sixth of served rows.
 *
 * The first test makes the pipe failure deterministic rather than racy: a
 * record larger than a pipe buffer blocks the writer until `head` has read and
 * gone, so the next write always meets a closed pipe.
 *
 * Run with: node --test tests/unit/get-access-recording.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { OFFLINE_INDEX_ENV } from './helpers/offline-index.js';

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, '../..');
const SEARCH = path.join(ROOT, 'scripts/cartographer-search.sh');
const SID = 'get-recording-session';
const COLLECTION = 'get-recording-fixture';
const PIPE_BUFFER = 64 * 1024;
const TURN = 'turn-5f0c1e2a-7b3d-4e8f-9a6b-1c2d3e4f5a6b-12';
const TURN_TRANSCRIPT = '/tmp/get-recording/5f0c1e2a-7b3d-4e8f-9a6b-1c2d3e4f5a6b.jsonl';

const writeRows = (file, rows) => fs.writeFileSync(file, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
const readRows = (file) => (fs.existsSync(file)
  ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []);

// embed-events.js hashToInt() and index-event.sh cartographer_point_id().
const pointId = (eventId) => parseInt(createHash('sha256').update(eventId).digest('hex').slice(0, 13), 16);

function fixture(t, { qdrantUrl = OFFLINE_INDEX_ENV.CARTOGRAPHER_QDRANT_URL, extraEnv = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-get-recording-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const servedLog = path.join(dir, 'served.jsonl');
  const ledger = path.join(dir, 'access.jsonl');
  writeRows(servedLog, [
    { call_id: 'call-get-1', event_id: 'evt-big', session_id: SID, purpose: 'remember', timestamp: '2026-10-17T00:00:00Z', rank: 1 },
    { call_id: 'call-get-1', event_id: TURN, session_id: SID, purpose: 'remember', timestamp: '2026-10-17T00:00:00Z', rank: 2 },
    { call_id: 'call-get-1', event_id: 'evt-small', session_id: SID, purpose: 'remember', timestamp: '2026-10-17T00:00:00Z', rank: 3 },
  ]);
  writeRows(path.join(dir, 'changelog.jsonl'), [
    { event_id: 'evt-big', timestamp: '2026-10-16T00:00:00Z', project: 'fixture', summary: `long record ${'x'.repeat(200 * 1024)}` },
    { event_id: 'evt-small', timestamp: '2026-10-16T00:00:00Z', project: 'fixture', summary: 'short record' },
  ]);
  const env = {
    ...process.env,
    ...OFFLINE_INDEX_ENV,
    CARTOGRAPHER_QDRANT_URL: qdrantUrl,
    // No key file: nothing of the live install's reaches the stand-in.
    CARTOGRAPHER_QDRANT_API_KEY: '',
    CARTOGRAPHER_QDRANT_API_KEY_FILE: path.join(dir, 'no-key'),
    CARTOGRAPHER_COLLECTION: COLLECTION,
    CARTOGRAPHER_DEV_DIR: dir,
    CARTOGRAPHER_SERVED_LOG: servedLog,
    CARTOGRAPHER_ACCESS_LEDGER: ledger,
    CARTOGRAPHER_SEARCH_CALL_LOG: path.join(dir, 'calls.jsonl'),
    CARTOGRAPHER_SESSION_ID: SID,
    CARTOGRAPHER_PURPOSE: 'remember',
    CARTOGRAPHER_TURBO: '0',
    CARTOGRAPHER_CLAUDE_TRANSCRIPTS_DIR: path.join(dir, 'no-transcripts'),
    CARTOGRAPHER_CODEX_TRANSCRIPTS_DIR: path.join(dir, 'no-transcripts'),
    CARTOGRAPHER_CODEX_ARCHIVED_DIR: path.join(dir, 'no-transcripts'),
    CLAUDE_SESSION_ID: '', CLAUDE_CODE_SESSION_ID: '', CODEX_SESSION_ID: '',
    ...extraEnv,
  };
  // Async, so an in-process stand-in can answer while the CLI waits on it.
  const run = async (command) => {
    try {
      const { stdout, stderr } = await execFileAsync('bash', ['-c', command], {
        cwd: ROOT, env: { ...env, SEARCH }, encoding: 'utf8', timeout: 20000, maxBuffer: 8 * 1024 * 1024,
      });
      return { code: 0, stdout, stderr };
    } catch (error) {
      return { code: error.code, signal: error.signal, stdout: error.stdout || '', stderr: error.stderr || '' };
    }
  };
  return { dir, ledger, run, rows: () => readRows(ledger) };
}

/** A Qdrant that answers point retrieval from a fixed payload set and logs every request. */
async function standInQdrant(t, payloads) {
  const requests = [];
  const byPoint = new Map(payloads.map((payload) => [pointId(payload.event_id), payload]));
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, body: body ? JSON.parse(body) : null });
      res.setHeader('Content-Type', 'application/json');
      if (req.method === 'POST' && req.url === `/collections/${COLLECTION}/points`) {
        const ids = JSON.parse(body).ids || [];
        const result = ids.filter((id) => byPoint.has(id)).map((id) => ({ id, payload: byPoint.get(id) }));
        res.end(JSON.stringify({ result, status: 'ok' }));
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ status: { error: 'not found' } }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  return { url: `http://127.0.0.1:${server.address().port}`, requests };
}

const turnPayload = {
  event_id: TURN, source: 'transcript', timestamp: '2026-10-16T01:02:03Z', project: 'fixture',
  summary: 'the turn where the cache ttl was settled', session: '5f0c1e2a-7b3d-4e8f-9a6b-1c2d3e4f5a6b',
  provider: 'claude', transcript_path: TURN_TRANSCRIPT,
};

test('a fetch is recorded even when the reader closes the pipe before the record is printed', async (t) => {
  const f = fixture(t);
  // Without this, `head` could read everything before the writer finishes and
  // the test would pass against the code that loses the row.
  const whole = await f.run('bash "$SEARCH" _ --get evt-big --call-id call-get-1 2>/dev/null');
  assert.ok(whole.stdout.length > PIPE_BUFFER, `the record must outgrow a pipe buffer (got ${whole.stdout.length} bytes)`);
  fs.rmSync(f.ledger, { force: true });

  await f.run('bash "$SEARCH" _ --get evt-big --call-id call-get-1 | head -n 1 >/dev/null');
  const rows = f.rows();
  assert.equal(rows.length, 1, 'the fetch must reach the ledger whatever happens to stdout');
  assert.equal(rows[0].event_id, 'evt-big');
  assert.equal(rows[0].source, 'result_fetched');
  assert.equal(rows[0].call_id, 'call-get-1');
  assert.equal(rows[0].attribution_status, 'explicit');
});

test('a served conversation turn is fetched from the semantic index, printed and recorded in request order', async (t) => {
  const qdrant = await standInQdrant(t, [turnPayload]);
  const f = fixture(t, { qdrantUrl: qdrant.url });
  const result = await f.run(`bash "$SEARCH" _ --get ${TURN},evt-small --call-id call-get-1`);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`=== ${TURN} ===`));
  assert.match(result.stdout, /the turn where the cache ttl was settled/);
  assert.match(result.stdout, /\(2 fetched, 0 missing\)/);

  // One batched retrieval, by the point id every indexer writes.
  const retrievals = qdrant.requests.filter((request) => request.method === 'POST');
  assert.equal(retrievals.length, 1);
  assert.deepEqual(retrievals[0].body.ids, [pointId(TURN)]);
  assert.equal(retrievals[0].body.with_payload, true);

  const rows = f.rows();
  assert.deepEqual(rows.map((row) => [row.event_id, row.access_ordinal, row.call_id, row.attribution_status]), [
    [TURN, 1, 'call-get-1', 'explicit'],
    ['evt-small', 2, 'call-get-1', 'explicit'],
  ]);
});

test('with the semantic leg pinned off, a turn is missing, unrecorded, and Qdrant is never asked', async (t) => {
  const qdrant = await standInQdrant(t, [turnPayload]);
  const f = fixture(t, { qdrantUrl: qdrant.url, extraEnv: { CARTOGRAPHER_SEMANTIC: '0' } });
  const result = await f.run(`bash "$SEARCH" _ --get ${TURN} --call-id call-get-1`);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /\(0 fetched, 1 missing\)/);
  assert.deepEqual(qdrant.requests, []);
  assert.deepEqual(f.rows(), []);
});

test('a turn the index does not hold stays missing and unrecorded', async (t) => {
  const qdrant = await standInQdrant(t, []);
  const f = fixture(t, { qdrantUrl: qdrant.url });
  const result = await f.run(`bash "$SEARCH" _ --get ${TURN},evt-small --call-id call-get-1`);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /\(1 fetched, 1 missing\)/);
  assert.deepEqual(f.rows().map((row) => row.event_id), ['evt-small']);
});

test('an unreachable index leaves a turn missing without failing the fetch of the rest', async (t) => {
  const f = fixture(t); // OFFLINE_INDEX_ENV: port 1 refuses at once
  const result = await f.run(`bash "$SEARCH" _ --get ${TURN},evt-small --call-id call-get-1`);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /\(1 fetched, 1 missing\)/);
  assert.deepEqual(f.rows().map((row) => row.event_id), ['evt-small']);
});
