// CARTOGRAPHER_SEMANTIC=0 was read only by explorer/server/search.js. The
// portable CLI ignored it, so a test that spawned cartographer-search.sh with
// the flag set still ran the semantic leg against whatever Qdrant answered.
// Measured 2026-09-25: a flag-set, Turbo-off query for "abandonware" returned
// 30 rows, every one `source: semantic`, from the live corpus. Nothing errored.
//
// The recorder below stands in for Qdrant and the embed server and logs every
// request it receives. The CLI runs asynchronously: a spawnSync would block
// this process's event loop, the recorder could never answer, and the curl
// probe would hang instead of being counted.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const SEARCH = join(ROOT, 'scripts', 'cartographer-search.sh');
const COLLECTION = 'fixture-collection';
const TERM = 'quokkaflag';

let dir;
let server;
let recorderUrl;
const requests = [];

test.before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'carto-semantic-flag-'));
  mkdirSync(join(dir, 'transcripts'));
  // Filler keeps the term's df well under half the corpus, so BM25 scores the
  // target above zero and the keyword assertion below means something.
  const events = [
    { event_id: 'evt-target', summary: `Ran: echo ${TERM} into the fixture` },
    ...Array.from({ length: 30 }, (_, i) => ({
      event_id: `evt-filler-${i}`, summary: `Ran: routine filler command number ${i}`,
    })),
  ].map((e, i) => JSON.stringify({
    ...e,
    timestamp: `2026-09-${String(10 + (i % 15)).padStart(2, '0')}T12:00:00Z`,
    project: 'fixtureproject',
    type: 'tool_bash',
    session_id: 'sid-fixture',
  }));
  writeFileSync(join(dir, 'changelog.jsonl'), `${events.join('\n')}\n`);
  for (const log of ['research-log', 'session-milestones', 'tool-use-log', 'prompt-history']) {
    writeFileSync(join(dir, `${log}.jsonl`), '');
  }

  // 404 for everything: the leg's first probe fails and it stops there, so a
  // contacted recorder shows exactly one request.
  server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    req.resume();
    res.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  recorderUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  rmSync(dir, { recursive: true, force: true });
});

function cliEnv(semantic) {
  const env = { ...process.env };
  for (const key of [
    'CARTOGRAPHER_SESSION_ID', 'CLAUDE_SESSION_ID', 'CLAUDE_CODE_SESSION_ID', 'CODEX_SESSION_ID',
    'CARTOGRAPHER_SEMANTIC', 'CARTOGRAPHER_SEARCH_BACKEND',
  ]) delete env[key];
  if (semantic !== undefined) env.CARTOGRAPHER_SEMANTIC = semantic;
  return {
    ...env,
    CARTOGRAPHER_DEV_DIR: dir,
    CARTOGRAPHER_TURBO: '0',
    CARTOGRAPHER_QDRANT_URL: recorderUrl,
    CARTOGRAPHER_EMBED_URL: `${recorderUrl}/v1/embeddings`,
    CARTOGRAPHER_COLLECTION: COLLECTION,
    CARTOGRAPHER_CLAUDE_TRANSCRIPTS_DIR: join(dir, 'transcripts'),
    CARTOGRAPHER_CODEX_TRANSCRIPTS_DIR: join(dir, 'transcripts'),
    CARTOGRAPHER_CODEX_ARCHIVED_DIR: join(dir, 'transcripts'),
    CARTOGRAPHER_SERVED_LOG: join(dir, 'served-log.jsonl'),
    CARTOGRAPHER_ACCESS_LEDGER: join(dir, 'access-ledger.jsonl'),
    CARTOGRAPHER_SEARCH_CALL_LOG: join(dir, 'search-calls.jsonl'),
  };
}

function runCli(semantic, extra = []) {
  requests.length = 0;
  return new Promise((resolve) => {
    execFile('bash', [SEARCH, TERM, '--limit', '10', '--format', 'jsonl', '--all', '--no-turbo', ...extra],
      { encoding: 'utf8', env: cliEnv(semantic), timeout: 30000 },
      (error, stdout, stderr) => {
        const rows = stdout.split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l));
        resolve({ status: error ? error.code : 0, rows, stderr, requests: [...requests] });
      });
  });
}

test('the recorder sees the semantic leg when the flag is unset', async () => {
  // Without this, the zero-request assertion below also passes against a
  // fixture whose recorder the CLI never reaches.
  const r = await runCli(undefined);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.requests, [`GET /collections/${COLLECTION}`]);
  assert.deepEqual(r.rows.map((row) => row.event_id), ['evt-target']);
});

test('CARTOGRAPHER_SEMANTIC=0 keeps the CLI off Qdrant and the embed server', async () => {
  const r = await runCli('0');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.requests, [], 'the semantic leg ran with the flag set');
  // The keyword leg still answers, so the flag disabled one ladder, not the search.
  assert.deepEqual(r.rows.map((row) => [row.event_id, row.source]), [['evt-target', 'changelog']]);
});

test('--intent refuses to run with the semantic leg disabled', async () => {
  // --intent is semantic-only, so an empty result would read as an answer.
  const r = await runCli('0', ['--intent', 'testing-verification']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /CARTOGRAPHER_SEMANTIC=0/);
  assert.deepEqual(r.requests, []);
  assert.deepEqual(r.rows, []);
});
