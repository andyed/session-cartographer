// readAllEvents normalizes every loaded event after folding duplicates:
// `session_id` from `sessionId` or `session`, `summary` from `display`, and
// `type` from `_source`. The watchers' rows skipped that step, in Turbo and in
// the Explorer alike, so a row appended while a server ran kept its raw shape
// until the next restart. Recall returns the stored event's fields and census
// counts its `type`, so a live server and a restarted one gave different
// answers about the same corpus.
//
// The rows that reach this are the ones no changelog copy fills in. Measured on
// the live corpus 2026-09-26: 1,921 milestone-only rows with no `type`
// (session_wrapup, hermes_*, agent_*), still written today, and 1,628
// research-only rows with `session` and no `session_id` (newest in March).
//
// Normalizing on delivery must not change how a later copy folds in. The load
// normalizes after every fold, so a value it derives never competes with a real
// one. Derived on delivery and then kept by mergeDuplicateEvent's longer-wins
// rule, `type: "milestones"` would shadow a twin's shorter real type, and a
// changelog copy's `type: "changelog"` would survive the domain log claiming
// the source. The fold cases pin both orders.
//
// Hermetic: temp corpus, state dir, and config; the session-id chain is
// cleared per CLAUDE.md; each case stops what it started.

process.env.CARTOGRAPHER_SEMANTIC = '0';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { FACTS_CONTRACT_VERSION } from '../../explorer/server/facts-contract.js';
import { OFFLINE_INDEX_ENV } from './helpers/offline-index.js';

for (const name of [
  'CARTOGRAPHER_SESSION_ID',
  'CLAUDE_SESSION_ID',
  'CLAUDE_CODE_SESSION_ID',
  'CODEX_SESSION_ID',
]) delete process.env[name];

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CONTROL = path.join(ROOT, 'scripts', 'cartographer-turbo.js');

// fs.watch needs a moment to arm, and the watcher debounces 100 ms.
const settle = (ms = 900) => new Promise((resolve) => setTimeout(resolve, ms));
const line = (row) => `${JSON.stringify(row)}\n`;
const TS = '2026-09-26T12:00:00Z';

// Each appended event, keyed by a word only its searchable text contains.
const WORDS = {
  'evt-research-only': 'wombatfern',
  'evt-milestone-only': 'gravelpine',
  'evt-prompt-legacy': 'marshwren',
  'evt-fold-domain-first': 'lanternfish',
  'evt-fold-changelog-first': 'quillwort',
};

// Domain-only rows, shaped as their writers shape them.
const DOMAIN_ONLY = [
  // log-research.sh: `session`, never `session_id`.
  ['research', {
    event_id: 'evt-research-only', timestamp: TS, type: 'fetch', provider: 'claude',
    session: 's-research', project: 'demo', url: 'https://example.com/a',
    summary: `Fetched: ${WORDS['evt-research-only']}`,
  }],
  // /wrapup and hermes-source.js: `milestone`, no `type`.
  ['milestones', {
    event_id: 'evt-milestone-only', timestamp: TS, milestone: 'session_wrapup', provider: 'claude',
    session_id: 's-wrapup', project: 'demo', summary: `Wrapup: ${WORDS['evt-milestone-only']}`,
  }],
  // The legacy history shape: `sessionId` and `display`, no `summary`.
  ['prompts', {
    event_id: 'evt-prompt-legacy', timestamp: TS, type: 'prompt', provider: 'claude',
    sessionId: 's-legacy', project: 'demo', display: `Prompt: ${WORDS['evt-prompt-legacy']}`,
  }],
];

// Dual-logged pairs, in arrival order. The first pair's changelog type is
// shorter than the source name the domain copy would be given, so longer-wins
// would keep the derived one. In the second neither copy has a type, so the
// load types it by the domain log that claims the source; `research` is shorter
// than `changelog`, so longer-wins would keep the first copy's. Both are
// synthetic: every real changelog twin's type is longer than any source name.
const FOLDS = [
  ['milestones', {
    event_id: 'evt-fold-domain-first', timestamp: TS, milestone: 'session_wrapup', provider: 'claude',
    session_id: 's-fold', project: 'demo', summary: `Wrapup: ${WORDS['evt-fold-domain-first']}`,
  }],
  ['changelog', {
    event_id: 'evt-fold-domain-first', timestamp: TS, type: 'wrapup', provider: 'claude',
    session_id: 's-fold', project: 'demo', summary: `Wrapup: ${WORDS['evt-fold-domain-first']}`,
  }],
  ['changelog', {
    event_id: 'evt-fold-changelog-first', timestamp: TS, provider: 'claude', url: 'https://example.com/b',
    session_id: 's-fold', project: 'demo', summary: `Fetched: ${WORDS['evt-fold-changelog-first']}`,
  }],
  ['research', {
    event_id: 'evt-fold-changelog-first', timestamp: TS, provider: 'claude', url: 'https://example.com/b',
    session: 's-fold', project: 'demo', summary: `Fetched: ${WORDS['evt-fold-changelog-first']}`,
  }],
];

// What a load must produce. Asserted on the restarted server first, so a
// restart that lost the same fields cannot agree with a live server that lost
// them and pass the comparison.
const LOADED = {
  'evt-research-only': { _source: 'research', type: 'fetch', session_id: 's-research', summary: 'Fetched: wombatfern' },
  'evt-milestone-only': { _source: 'milestones', type: 'milestones', session_id: 's-wrapup', summary: 'Wrapup: gravelpine' },
  'evt-prompt-legacy': { _source: 'prompts', type: 'prompt', session_id: 's-legacy', summary: 'Prompt: marshwren' },
  'evt-fold-domain-first': { _source: 'milestones', type: 'wrapup', session_id: 's-fold', summary: 'Wrapup: lanternfish' },
  'evt-fold-changelog-first': { _source: 'research', type: 'research', session_id: 's-fold', summary: 'Fetched: quillwort' },
};

const seedRow = (id, summary) => line({ event_id: id, timestamp: '2026-09-25T12:00:00Z', project: 'demo', type: 'seed', summary });

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-normalize-'));
  const dev = path.join(root, 'dev');
  fs.mkdirSync(dev);
  const logs = {
    changelog: path.join(dev, 'changelog.jsonl'),
    research: path.join(dev, 'research-log.jsonl'),
    milestones: path.join(dev, 'session-milestones.jsonl'),
    'tool-use': path.join(dev, 'tool-use-log.jsonl'),
    prompts: path.join(dev, 'prompt-history.jsonl'),
  };
  // Padding keeps each query word's document frequency low enough to score.
  for (const [source, file] of Object.entries(logs)) {
    fs.writeFileSync(file, seedRow(`evt-seed-${source}-1`, `seed ${source} one`) + seedRow(`evt-seed-${source}-2`, `seed ${source} two`));
  }
  const env = {
    ...process.env,
    ...OFFLINE_INDEX_ENV,
    CARTOGRAPHER_DEV_DIR: dev,
    CARTOGRAPHER_CONFIG: path.join(root, 'config.json'),
    CARTOGRAPHER_TURBO_STATE_DIR: path.join(root, 'state'),
  };
  return { root, dev, logs, env, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

async function appendLive(logs) {
  for (const [source, row] of DOMAIN_ONLY) fs.appendFileSync(logs[source], line(row));
  await settle();
  // One copy per settle, so each pair arrives in the order listed.
  for (const [source, row] of FOLDS) {
    fs.appendFileSync(logs[source], line(row));
    await settle();
  }
}

async function post(base, route, body) {
  const response = await fetch(`${base}${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  assert.equal(response.status, 200, `${route} must answer`);
  return response.json();
}

/**
 * What a server says about each appended event, through the endpoints that
 * read the stored copy: recall returns its fields, census counts its type and
 * session.
 */
async function snapshot(base) {
  const recalled = {};
  for (const [id, word] of Object.entries(WORDS)) {
    const body = await post(base, '/api/recall', {
      contract_version: 1,
      call_id: `call-${word}`,
      query: word,
      project: '',
      since: '',
      before: '',
      limit: 10,
      purpose: 'remember',
      session_id: '',
      provider: 'claude',
      excluded_event_ids: [],
    });
    const hits = body.results.filter((r) => r.event_id === id);
    assert.equal(hits.length, 1, `${id} must be recalled exactly once`);
    const { _source, type, session_id, summary } = hits[0];
    recalled[id] = { _source, type, session_id, summary };
  }
  const census = await post(base, '/api/facts', {
    contract_version: FACTS_CONTRACT_VERSION,
    verb: 'census',
    call_id: 'call-census',
    sample: 0,
  });
  return {
    recalled,
    by_type: Object.fromEntries(census.facts.by_type.map((b) => [b.name, b.count])),
    unattributed: census.facts.unattributed,
    sessions: census.facts.sessions.resolved,
    events: census.facts.events,
  };
}

function assertMatchesLoad(live, loaded) {
  assert.deepEqual(loaded.recalled, LOADED, 'a load must normalize and fold every appended event');
  assert.equal(loaded.events, 15, '10 seed rows and 5 appended events, each counted once');
  assert.deepEqual(live.recalled, loaded.recalled,
    'a row delivered by the watcher must carry the fields a load gives it');
  assert.deepEqual(live.by_type, loaded.by_type, 'census must type a delivered row as a load does');
  assert.deepEqual(live.unattributed, loaded.unattributed, 'census must attribute a delivered row as a load does');
  assert.equal(live.sessions, loaded.sessions, 'census must count a delivered row\'s session as a load does');
  assert.equal(live.events, loaded.events, 'no copy may be stored as a second event');
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function startService(env) {
  const readyFile = path.join(env.CARTOGRAPHER_TURBO_STATE_DIR, 'ready.json');
  await run(process.execPath, [CONTROL, 'start'], { env });
  // `start` returns on the first ready publish; the listen lands just after.
  for (let i = 0; i < 100; i += 1) {
    try { if (JSON.parse(fs.readFileSync(readyFile, 'utf8')).http === 'listening') break; } catch {}
    await settle(50);
  }
  await settle(300); // let the service's watchers arm and finish the first pass
}

test('turbo: a row appended while the service runs is normalized as a restart loads it', async () => {
  const f = fixture();
  const env = { ...f.env, CARTOGRAPHER_TURBO_URL: `http://127.0.0.1:${await freePort()}` };
  const base = env.CARTOGRAPHER_TURBO_URL;
  try {
    await startService(env);
    await appendLive(f.logs);
    const live = await snapshot(base);

    await run(process.execPath, [CONTROL, 'stop'], { env });
    await startService(env);
    const restarted = await snapshot(base);

    assertMatchesLoad(live, restarted);
  } finally {
    try { await run(process.execPath, [CONTROL, 'stop'], { env }); } catch {}
    f.cleanup();
  }
});

test('explorer: a row appended while the app runs is normalized as a fresh app loads it', async () => {
  const f = fixture();
  // DEV_DIR is captured when jsonl.js is first evaluated; nothing above imports it.
  process.env.CARTOGRAPHER_DEV_DIR = f.dev;
  const { createExplorerApp } = await import('../../explorer/server/app.js');
  const listen = async () => {
    const created = createExplorerApp();
    const server = created.app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    return {
      base: `http://127.0.0.1:${server.address().port}`,
      stop: async () => { created.close(); await new Promise((resolve) => server.close(resolve)); },
    };
  };
  const running = [];
  try {
    const first = await listen();
    running.push(first);
    await settle(300); // let the watchers arm before touching the files
    await appendLive(f.logs);
    const live = await snapshot(first.base);

    const second = await listen();
    running.push(second);
    const loaded = await snapshot(second.base);

    assertMatchesLoad(live, loaded);
  } finally {
    for (const server of running) await server.stop();
    f.cleanup();
  }
});
