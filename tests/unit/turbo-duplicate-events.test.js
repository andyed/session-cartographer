// The corpus overlaps by design: the hooks append one event to its domain log
// (tool-use-log.jsonl here) and again to changelog.jsonl, and each copy carries
// fields the other lacks. changelog has `session_id` and `related_ids`; the
// tool-use copy has `tool` and `session`. At load, readAllEvents folds the pair
// with mergeDuplicateEvent and labels the result with the domain source.
//
// Turbo's watcher dropped the second copy by id instead of folding it, so an
// event dual-logged while the service ran kept only the first-arriving copy's
// fields and `_source` until the next restart. Recall results spread the
// stored event, and census counts `_source`, so a live service and a freshly
// restarted one gave different answers about the same corpus. The Explorer's
// watcher already folds (watcher-duplicate-events.test.js); this drives the
// real Turbo service.
//
// Both arrival orders are exercised, because each loses different fields. The
// hooks write the domain log first; a changelog watcher whose debounce is
// already running can still deliver its copy first.
//
// Hermetic: temp corpus, state dir, and config; the session-id chain is
// cleared per CLAUDE.md; the service is stopped by the case that started it.

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

// The two copies log-tool-use.sh writes for one Bash call, reduced to the
// fields that differ between them plus what recall needs to find the row.
const changelogRow = (id, word) => `${JSON.stringify({
  event_id: id, timestamp: '2026-09-26T12:00:00Z', type: 'tool_bash', provider: 'claude',
  session_id: 's-1', project: 'demo', summary: `Ran: echo ${word}`, related_ids: [], salience: 0.2,
})}\n`;
const toolUseRow = (id, word) => `${JSON.stringify({
  event_id: id, timestamp: '2026-09-26T12:00:00Z', type: 'tool_bash', provider: 'claude',
  tool: 'Bash', session: 's-1', project: 'demo', summary: `Ran: echo ${word}`, salience: 0.2,
})}\n`;
const seedRow = (id, summary) =>
  `${JSON.stringify({ event_id: id, timestamp: '2026-09-25T12:00:00Z', project: 'demo', summary })}\n`;

// Each dual-logged event, keyed by a word only its summary contains.
const DUAL = {
  'evt-domain-first': 'lanternfish',
  'evt-changelog-first': 'quillwort',
};

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-turbo-dupe-'));
  const dev = path.join(root, 'dev');
  fs.mkdirSync(dev);
  const logs = {
    changelog: path.join(dev, 'changelog.jsonl'),
    'tool-use': path.join(dev, 'tool-use-log.jsonl'),
    milestones: path.join(dev, 'session-milestones.jsonl'),
  };
  // Padding keeps each query word's document frequency low enough to score.
  fs.writeFileSync(logs.changelog, seedRow('evt-c1', 'seed change') + seedRow('evt-c2', 'second change'));
  fs.writeFileSync(logs['tool-use'], seedRow('evt-t1', 'seed tool use'));
  fs.writeFileSync(logs.milestones, seedRow('evt-m1', 'seed milestone'));
  const env = {
    ...process.env,
    ...OFFLINE_INDEX_ENV,
    CARTOGRAPHER_DEV_DIR: dev,
    CARTOGRAPHER_CONFIG: path.join(root, 'config.json'),
    CARTOGRAPHER_TURBO_STATE_DIR: path.join(root, 'state'),
  };
  return { root, logs, env, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
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
 * What the service says about each dual-logged event, through the two
 * endpoints that read the stored copy: recall (which returns the event's
 * fields) and census (which counts its `_source`).
 */
async function snapshot(base) {
  const recalled = {};
  for (const [id, word] of Object.entries(DUAL)) {
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
    const { _source, tool, session, session_id, related_ids } = hits[0];
    recalled[id] = { _source, tool, session, session_id, related_ids };
  }
  const census = await post(base, '/api/facts', {
    contract_version: FACTS_CONTRACT_VERSION,
    verb: 'census',
    call_id: 'call-census',
    sample: 0,
  });
  const health = await (await fetch(`${base}/api/recall/health`)).json();
  return {
    recalled,
    by_source: Object.fromEntries(census.facts.by_source.map((b) => [b.name, b.count])),
    events: health.events,
  };
}

test('turbo: an event dual-logged while the service runs matches what a restart loads', async () => {
  const f = fixture();
  const env = { ...f.env, CARTOGRAPHER_TURBO_URL: `http://127.0.0.1:${await freePort()}` };
  const base = env.CARTOGRAPHER_TURBO_URL;
  try {
    await startService(env);

    // The hooks' own order: domain log, then changelog.
    fs.appendFileSync(f.logs['tool-use'], toolUseRow('evt-domain-first', DUAL['evt-domain-first']));
    await settle();
    fs.appendFileSync(f.logs.changelog, changelogRow('evt-domain-first', DUAL['evt-domain-first']));
    await settle();
    // The reverse, which a changelog debounce already in flight produces.
    fs.appendFileSync(f.logs.changelog, changelogRow('evt-changelog-first', DUAL['evt-changelog-first']));
    await settle();
    fs.appendFileSync(f.logs['tool-use'], toolUseRow('evt-changelog-first', DUAL['evt-changelog-first']));
    await settle();

    const live = await snapshot(base);

    await run(process.execPath, [CONTROL, 'stop'], { env });
    await startService(env);
    const restarted = await snapshot(base);

    // Without this, a restart that also lost fields would agree with a live
    // service that lost the same ones, and the comparison below would pass.
    const merged = { _source: 'tool-use', tool: 'Bash', session: 's-1', session_id: 's-1', related_ids: [] };
    for (const id of Object.keys(DUAL)) {
      assert.deepEqual(restarted.recalled[id], merged,
        `the restarted service must hold ${id} with both copies' fields`);
    }
    assert.equal(restarted.events, 6, '4 seed rows and 2 dual-logged events, each counted once');

    assert.deepEqual(live.recalled, restarted.recalled,
      'a copy arriving second must fold into the stored event, not be dropped');
    assert.deepEqual(live.by_source, restarted.by_source,
      'census must count a dual-logged event under the domain source, as the load does');
    assert.equal(live.events, restarted.events, 'the second copy must not be stored as a new event');
  } finally {
    try { await run(process.execPath, [CONTROL, 'stop'], { env }); } catch {}
    f.cleanup();
  }
});
