// Every Qdrant client sends the `api-key` header when a key is configured, and
// none sends one when no key is.
//
// Turning Qdrant's CORS off stops a web page reading :6333, not writing to it:
// Qdrant 1.12.1 parses a preflight-free `text/plain` POST as JSON, and with
// CORS off such a POST to /points/delete returned 200 and removed the point
// (measured 2026-10-16). `service.api_key` closes that, but only if every
// client then carries the key. A client that does not fails against a keyed
// Qdrant without erroring: the CLI's semantic leg quietly drops out, the
// indexer records an outage, and recall still "returns results". So these
// tests assert on what arrived at the server — which routes, carrying which
// header — not on what a client printed.
//
// The recorder stands in for both Qdrant and the embedder and answers 200 to
// everything, so each client walks its whole request path in every mode and
// the "no key" runs cover the same requests as the keyed ones. Clients run
// asynchronously: a spawnSync would block this process's event loop and the
// recorder could never answer. Both service URLs point at the recorder before
// anything is imported, so no run can reach a live Qdrant.
//
// Not covered here because it needs no key: codex-loopback-setup.js probes
// only /healthz, which Qdrant serves without one. Turbo reaches Qdrant only
// through explorer/server/search.js and scripts/qdrant-collection.js, both
// below.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const COLLECTION = 'fixture-collection';
const ENV_KEY = 'envkey-5f1c0e7a9b3d';
const FILE_KEY = 'filekey-8e2a6c4d0f1b';
const TERM = 'wombatkey';

for (const name of [
  'CARTOGRAPHER_SESSION_ID', 'CLAUDE_SESSION_ID', 'CLAUDE_CODE_SESSION_ID', 'CODEX_SESSION_ID',
  // The semantic leg has to run for its requests to be observed; the URLs
  // below keep it on the recorder.
  'CARTOGRAPHER_SEMANTIC', 'CARTOGRAPHER_SEARCH_BACKEND',
  // A developer's own key settings must not decide which mode a run is in.
  'CARTOGRAPHER_QDRANT_API_KEY', 'CARTOGRAPHER_QDRANT_API_KEY_FILE', 'CARTOGRAPHER_QDRANT_STORAGE',
]) delete process.env[name];

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-qdrant-key-'));
const dev = path.join(tmp, 'dev');
const transcripts = path.join(tmp, 'transcripts');
const storage = path.join(tmp, 'qdrant-storage');
for (const dir of [dev, transcripts, storage]) fs.mkdirSync(dir);
fs.writeFileSync(path.join(storage, 'api-key'), `${FILE_KEY}\n`, { mode: 0o600 });
const NO_KEY_FILE = path.join(tmp, 'no-such-key-file');

// Filler keeps the term's df under half the corpus, so BM25 scores the target
// and the CLI answers with rows (an empty answer that names nothing known would
// otherwise send a knowledge-gap event to the indexer, adding requests here).
const events = [
  { event_id: 'evt-target', summary: `Ran: echo ${TERM} into the fixture` },
  ...Array.from({ length: 12 }, (_, i) => ({ event_id: `evt-filler-${i}`, summary: `Ran: routine filler ${i}` })),
].map((e) => JSON.stringify({ ...e, timestamp: '2026-10-16T12:00:00Z', project: 'fixtureproject', type: 'tool_bash', session_id: 'sid-fixture' }));
fs.writeFileSync(path.join(dev, 'changelog.jsonl'), `${events.join('\n')}\n`);
for (const log of ['research-log', 'session-milestones', 'tool-use-log', 'prompt-history']) {
  fs.writeFileSync(path.join(dev, `${log}.jsonl`), '');
}

// ── The recorder ──
const requests = [];
const schema = { project: { data_type: 'keyword' }, timestamp: { data_type: 'datetime' } };
let collectionSchema = { ...schema };
let lastUpsertEventId = null;

function respond(req, body) {
  const url = new URL(req.url, 'http://recorder');
  const route = `${req.method} ${url.pathname}`;
  const base = `/collections/${COLLECTION}`;
  if (route === 'POST /v1/embeddings') {
    const inputs = Array.isArray(body?.input) ? body.input : [body?.input];
    return { data: inputs.map(() => ({ embedding: [0.1, 0.2, 0.3] })) };
  }
  if (route === 'GET /health') return { status: 'ok' };
  if (route === 'GET /') return { title: 'qdrant - vector search engine', version: '1.12.1' };
  if (route === `GET ${base}`) return { result: { status: 'green', payload_schema: collectionSchema } };
  if (route === `PUT ${base}`) { collectionSchema = {}; return { result: true }; }
  if (route === `DELETE ${base}`) { collectionSchema = {}; return { result: true }; }
  if (route === `PUT ${base}/index`) {
    collectionSchema[body.field_name] = { data_type: body.field_schema };
    return { result: { status: 'acknowledged' } };
  }
  if (route === `POST ${base}/points/search`) {
    // 0.5 clears both novelty gates (0.85 reject, 0.70 refine), so the
    // indexers go on to upsert.
    return { result: [{ id: 1, score: 0.5, payload: { event_id: 'evt-target', summary: `semantic ${TERM}`, timestamp: '2026-10-16T12:00:00Z', project: 'fixtureproject', source: 'changelog' } }] };
  }
  if (route === `POST ${base}/points/scroll`) {
    const wantsTurns = body?.filter?.must?.some((c) => c.key === 'source' && c.match?.value === 'transcript');
    return { result: { points: wantsTurns ? [{ id: 7, payload: { event_id: 'turn-sid-fixture-1' } }] : [], next_page_offset: null } };
  }
  if (route === `PUT ${base}/points`) {
    lastUpsertEventId = body?.points?.[0]?.payload?.event_id ?? null;
    return { result: { status: 'completed' } };
  }
  if (route === `POST ${base}/points`) return { result: [] };
  if (route.startsWith(`GET ${base}/points/`)) return { result: { payload: { event_id: lastUpsertEventId } } };
  return null;
}

const server = createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => { raw += chunk; });
  req.on('end', () => {
    let body = null;
    try { body = raw ? JSON.parse(raw) : null; } catch { body = null; }
    requests.push({ method: req.method, url: req.url, apiKey: req.headers['api-key'] });
    const answer = respond(req, body);
    if (!answer) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(answer));
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const RECORDER = `http://127.0.0.1:${server.address().port}`;
const isEmbedder = (r) => r.url.startsWith('/v1/embeddings') || r.url === '/health';

// Pinned before the in-process modules load: search.js reads the Qdrant URL
// at import, and jsonl.js captures the dev dir.
Object.assign(process.env, {
  CARTOGRAPHER_DEV_DIR: dev,
  CARTOGRAPHER_QDRANT_URL: RECORDER,
  CARTOGRAPHER_EMBED_URL: `${RECORDER}/v1/embeddings`,
  CARTOGRAPHER_COLLECTION: COLLECTION,
  CARTOGRAPHER_QDRANT_API_KEY_FILE: NO_KEY_FILE,
});
const { hybridSearch } = await import('../../explorer/server/search.js');
const { buildIndex } = await import('../../explorer/server/bm25.js');
const { fetchIndexedEvents } = await import('../../explorer/server/memory-recall.js');
const { createExplorerApp } = await import('../../explorer/server/app.js');
const { ensureCollection } = await import('../../scripts/qdrant-collection.js');

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ── Modes ──
// env:  CARTOGRAPHER_QDRANT_API_KEY set.
// file: nothing exported but the storage dir, where start-services.sh leaves
//       the key; the recorder is on 127.0.0.1, so the file key applies.
// none: no variable and no file, which must look exactly like before keys.
const MODES = {
  env: { vars: { CARTOGRAPHER_QDRANT_API_KEY: ENV_KEY, CARTOGRAPHER_QDRANT_API_KEY_FILE: NO_KEY_FILE }, expect: ENV_KEY },
  file: { vars: { CARTOGRAPHER_QDRANT_STORAGE: storage }, unset: ['CARTOGRAPHER_QDRANT_API_KEY_FILE'], expect: FILE_KEY },
  none: { vars: { CARTOGRAPHER_QDRANT_API_KEY_FILE: NO_KEY_FILE }, expect: undefined },
};

function childEnv(mode, extra = {}) {
  const env = { ...process.env, ...MODES[mode].vars, ...extra };
  for (const name of MODES[mode].unset || []) delete env[name];
  return {
    ...env,
    CARTOGRAPHER_QDRANT_URL: RECORDER,
    CARTOGRAPHER_EMBED_URL: `${RECORDER}/v1/embeddings`,
    CARTOGRAPHER_TURBO: '0',
    CARTOGRAPHER_CLAUDE_TRANSCRIPTS_DIR: transcripts,
    CARTOGRAPHER_CODEX_TRANSCRIPTS_DIR: transcripts,
    CARTOGRAPHER_CODEX_ARCHIVED_DIR: transcripts,
    CARTOGRAPHER_TRANSCRIPTS_DIR: transcripts,
    CARTOGRAPHER_SERVED_LOG: path.join(dev, 'served-log.jsonl'),
    CARTOGRAPHER_ACCESS_LEDGER: path.join(dev, 'access-ledger.jsonl'),
    CARTOGRAPHER_SEARCH_CALL_LOG: path.join(dev, 'search-calls.jsonl'),
  };
}

function run(command, args, { env, input = '' }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: tmp, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

// In-process clients read process.env at call time, as they do in the
// Explorer and Turbo; swap the mode's variables in around the call.
async function inProcess(mode, fn) {
  const saved = { ...process.env };
  Object.assign(process.env, MODES[mode].vars);
  for (const name of MODES[mode].unset || []) delete process.env[name];
  try {
    return { code: 0, stdout: JSON.stringify(await fn()), stderr: '' };
  } finally {
    for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name];
    Object.assign(process.env, saved);
  }
}

const node = (script, args = []) => (mode) => run(process.execPath, [path.join(ROOT, script), ...args], { env: childEnv(mode) });
const base = `/collections/${COLLECTION}`;

// Each client with the Qdrant requests it must have made: the proof that a run
// walked its path rather than stopping at the first refusal.
const CLIENTS = [
  {
    name: 'scripts/index-event.sh',
    run: (mode) => run('bash', [path.join(ROOT, 'scripts', 'index-event.sh')], {
      env: childEnv(mode, { CARTOGRAPHER_INDEX_RECEIPT: '1' }),
      input: JSON.stringify({ event_id: 'evt-indexed', summary: 'an event to index', project: 'fixtureproject', timestamp: '2026-10-16T12:00:00Z' }),
    }),
    routes: [`GET ${base}`, `POST ${base}/points/search`, `PUT ${base}/points?wait=true`, `GET ${base}/points/`],
  },
  {
    name: 'scripts/cartographer-search.sh',
    run: (mode) => run('bash', [path.join(ROOT, 'scripts', 'cartographer-search.sh'), TERM, '--no-turbo'], { env: childEnv(mode) }),
    routes: [`GET ${base}`, `POST ${base}/points/search`],
  },
  { name: 'scripts/semantic-search.js', run: node('scripts/semantic-search.js', [TERM]), routes: [`POST ${base}/points/search`] },
  {
    name: 'scripts/embed-events.js',
    run: node('scripts/embed-events.js'),
    routes: ['GET /', `GET ${base}`, `POST ${base}/points/scroll`, `POST ${base}/points/search`, `PUT ${base}/points`],
  },
  { name: 'scripts/backfill-prompt-intents.js', run: node('scripts/backfill-prompt-intents.js', ['--dry-run']), routes: [`POST ${base}/points/scroll`] },
  { name: 'scripts/migrate-point-ids.js', run: node('scripts/migrate-point-ids.js'), routes: [`POST ${base}/points/scroll`] },
  { name: 'scripts/repair-transcript-paths.js', run: node('scripts/repair-transcript-paths.js', ['--qdrant']), routes: [`POST ${base}/points/scroll`] },
  {
    name: 'scripts/qdrant-collection.js',
    // recreate walks every request the module can make: delete, create, read
    // the schema, then one index build per field.
    run: (mode) => inProcess(mode, () => ensureCollection({ recreate: true })),
    routes: [`DELETE ${base}`, `PUT ${base}`, `GET ${base}`, `PUT ${base}/index`],
  },
  {
    name: 'explorer/server/search.js',
    run: (mode) => inProcess(mode, () => hybridSearch(
      buildIndex([{ event_id: 'seed', timestamp: '2026-10-16T12:00:00Z', project: 'fixtureproject', summary: `seed ${TERM}` }]),
      TERM, { project: 'fixtureproject' },
    )),
    routes: [`POST ${base}/points/search`],
  },
  {
    name: 'explorer/server/memory-recall.js',
    run: (mode) => inProcess(mode, () => fetchIndexedEvents(['turn-sid-fixture-1'])),
    routes: [`POST ${base}/points`],
  },
  {
    name: 'explorer/server/app.js /api/health',
    run: (mode) => inProcess(mode, async () => {
      const { app, close } = createExplorerApp();
      const listener = app.listen(0, '127.0.0.1');
      await new Promise((resolve) => listener.once('listening', resolve));
      try {
        return await (await fetch(`http://127.0.0.1:${listener.address().port}/api/health`)).json();
      } finally {
        close();
        await new Promise((resolve) => listener.close(resolve));
      }
    }),
    routes: [`GET ${base}`],
  },
];

for (const client of CLIENTS) {
  for (const mode of Object.keys(MODES)) {
    test(`${client.name}: ${mode === 'none' ? 'no key configured, no api-key header' : `the ${mode} key rides on every Qdrant request`}`, async () => {
      requests.length = 0;
      collectionSchema = { ...schema };
      const result = await client.run(mode);
      const qdrant = requests.filter((r) => !isEmbedder(r));
      const seen = qdrant.map((r) => `${r.method} ${r.url}`);

      for (const route of client.routes) {
        assert.ok(seen.some((s) => s.startsWith(route)),
          `${client.name} never sent ${route}; it sent [${seen.join(', ')}] (exit ${result.code}: ${result.stderr.slice(0, 400)})`);
      }
      const expected = MODES[mode].expect;
      const wrong = qdrant.filter((r) => r.apiKey !== expected).map((r) => `${r.method} ${r.url} api-key=${r.apiKey ?? '(none)'}`);
      assert.deepEqual(wrong, [], `every Qdrant request must carry api-key=${expected ?? '(none)'}`);

      // The key goes to Qdrant only, and only as a header.
      assert.deepEqual(requests.filter((r) => isEmbedder(r) && r.apiKey !== undefined).map((r) => r.url), [],
        'the embedder must never receive the Qdrant key');
      for (const key of [ENV_KEY, FILE_KEY]) {
        assert.ok(!requests.some((r) => r.url.includes(key)), 'the key must never appear in a URL');
        assert.ok(!result.stdout.includes(key) && !result.stderr.includes(key), 'the key must never be printed');
      }
    });
  }
}

test('no log or event row in the dev dir holds a key after every client has run', () => {
  // Runs last: the clients above wrote served rows, search calls, index
  // receipts and errors under dev/. None of it may carry either key.
  const leaks = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if ([ENV_KEY, FILE_KEY].some((key) => fs.readFileSync(full, 'utf8').includes(key))) leaks.push(full);
    }
  };
  walk(dev);
  assert.deepEqual(leaks, []);
  // Without this the walk could pass over an empty directory.
  assert.ok(fs.readdirSync(dev).length > 5, 'the dev dir should hold the fixture logs and what the clients wrote');
});
