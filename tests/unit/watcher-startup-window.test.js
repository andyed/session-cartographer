// Loading the corpus and building the index take about a second at 157k
// events. Both servers used to read the logs first and only then arm the
// watchers, which baseline each log at its size at that later moment ("don't
// replay history"). An event appended during the load was in neither: the read
// had passed it, and the watcher started after it. It stayed missing until the
// next restart, and since the watcher's offset matched the disk, status read
// "live" throughout.
//
// The race is made deterministic without a seam in the servers: a preload
// wraps fs.readFileSync so that, when the load reads research-log.jsonl (the
// second log), one row is appended to changelog.jsonl, which the load has
// already read, and one to session-milestones.jsonl, which it has yet to read.
// The first can only reach the index through the watcher. The second reaches
// it through the load, and through a watcher armed before the load as well, so
// it also checks that a row read twice is kept once.
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
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

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
const row = (id, summary) =>
  `${JSON.stringify({ event_id: id, timestamp: '2026-09-26T12:00:00Z', summary })}\n`;

const DURING_LOAD = {
  changelog: row('evt-c-late', 'appended to changelog after the load read it'),
  milestones: row('evt-m-early', 'appended to milestones before the load read it'),
};

function fixture(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const dev = path.join(root, 'dev');
  fs.mkdirSync(dev);
  const logs = {
    changelog: path.join(dev, 'changelog.jsonl'),
    research: path.join(dev, 'research-log.jsonl'),
    milestones: path.join(dev, 'session-milestones.jsonl'),
    'tool-use': path.join(dev, 'tool-use-log.jsonl'),
  };
  fs.writeFileSync(logs.changelog, row('evt-c1', 'seed change') + row('evt-c2', 'second change'));
  fs.writeFileSync(logs.research, row('evt-r1', 'seed research'));
  fs.writeFileSync(logs.milestones, row('evt-m1', 'seed milestone'));
  fs.writeFileSync(logs['tool-use'], row('evt-t1', 'seed tool use'));
  return { root, dev, logs, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

// The same interception for both servers: the preload carries this function's
// source, and the in-process case calls it directly. `marker` records the bytes
// each log held when the append happened, so a test can prove the rows landed
// after the read of changelog and before the read of milestones.
function intercept({ trigger, marker, targets, rows }) {
  let fired = false;
  const original = fs.readFileSync;
  fs.readFileSync = function readFileSyncDuringLoad(file, ...rest) {
    const content = original.call(this, file, ...rest);
    if (!fired && String(file) === trigger) {
      fired = true;
      const before = {};
      for (const [source, line] of Object.entries(rows)) {
        before[source] = fs.statSync(targets[source]).size;
        fs.appendFileSync(targets[source], line);
      }
      fs.writeFileSync(marker, JSON.stringify(before));
    }
    return content;
  };
  // Rebind the named imports (jsonl.js imports { readFileSync } from 'fs').
  syncBuiltinESMExports();
  return () => {
    fs.readFileSync = original;
    syncBuiltinESMExports();
  };
}

function interceptOptions(f) {
  return {
    trigger: f.logs.research,
    marker: path.join(f.root, 'appended.json'),
    targets: { changelog: f.logs.changelog, milestones: f.logs.milestones },
    rows: DURING_LOAD,
  };
}

function writePreload(f) {
  const preload = path.join(f.root, 'append-during-load.mjs');
  fs.writeFileSync(preload, `
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
// Only the server loads the corpus; the controller shares NODE_OPTIONS.
if (process.argv[1] && process.argv[1].endsWith('turbo-server.js')) {
  (${intercept.toString()})(${JSON.stringify(interceptOptions(f))});
}
`);
  return preload;
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

function assertAppendedDuringLoad(marker) {
  // Without this, the rows could have landed before the load or after the
  // watchers armed, and the test would pass against the unfixed servers.
  const before = JSON.parse(fs.readFileSync(marker, 'utf8'));
  assert.equal(before.changelog, Buffer.byteLength(row('evt-c1', 'seed change') + row('evt-c2', 'second change')),
    'the changelog row must land after the load read changelog');
  assert.equal(before.milestones, Buffer.byteLength(row('evt-m1', 'seed milestone')),
    'the milestones row must land before the load read milestones');
}

const recall = (query) => ({
  contract_version: 1,
  call_id: 'call-startup-window',
  query,
  project: '',
  since: '',
  before: '',
  limit: 10,
  purpose: 'remember',
  session_id: 'session-test',
  provider: 'claude',
  excluded_event_ids: [],
});

test('turbo: an event appended while the corpus loads is indexed, once', async () => {
  const f = fixture('carto-startup-turbo-');
  const preload = writePreload(f);
  const env = {
    ...process.env,
    CARTOGRAPHER_DEV_DIR: f.dev,
    CARTOGRAPHER_CONFIG: path.join(f.root, 'config.json'),
    CARTOGRAPHER_TURBO_STATE_DIR: path.join(f.root, 'state'),
    CARTOGRAPHER_TURBO_URL: `http://127.0.0.1:${await freePort()}`,
    CARTOGRAPHER_QDRANT_URL: 'http://127.0.0.1:1',
    CARTOGRAPHER_EMBED_URL: 'http://127.0.0.1:1/v1/embeddings',
  };
  const base = env.CARTOGRAPHER_TURBO_URL;
  try {
    await run(process.execPath, [CONTROL, 'start'], {
      env: { ...env, NODE_OPTIONS: `--import=${preload}` },
    });
    const readyFile = path.join(env.CARTOGRAPHER_TURBO_STATE_DIR, 'ready.json');
    for (let i = 0; i < 100; i += 1) {
      try { if (JSON.parse(fs.readFileSync(readyFile, 'utf8')).http === 'listening') break; } catch {}
      await settle(50);
    }
    await settle();

    assertAppendedDuringLoad(interceptOptions(f).marker);

    const health = await (await fetch(`${base}/api/recall/health`)).json();
    // 5 seed rows, the row only the watcher can deliver, and the row both see.
    assert.equal(health.events, 7,
      'the row appended to an already-read log must be indexed, and the row read twice kept once');

    const response = await fetch(`${base}/api/recall`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(recall('appended')),
    });
    const ids = (await response.json()).results.map((r) => r.event_id).sort();
    assert.deepEqual(ids, ['evt-c-late', 'evt-m-early'],
      'both rows appended during the load must be recallable');

    // Status compared bytes throughout and read "live" before the fix, so it
    // is not what failed here; it must still read live after it.
    const { stdout } = await run(process.execPath, [CONTROL, 'status'], { env });
    const service = JSON.parse(stdout).service;
    assert.equal(service.index_freshness, 'live');
    assert.equal(service.watch.changelog.consumed_bytes, fs.statSync(f.logs.changelog).size);
  } finally {
    try { await run(process.execPath, [CONTROL, 'stop'], { env }); } catch {}
    f.cleanup();
  }
});

test('explorer: an event appended while the corpus loads reaches the feed, once', async () => {
  const f = fixture('carto-startup-explorer-');
  // DEV_DIR is captured when jsonl.js is first evaluated.
  process.env.CARTOGRAPHER_DEV_DIR = f.dev;
  const { createExplorerApp } = await import('../../explorer/server/app.js');

  const restore = intercept(interceptOptions(f));
  let created;
  try {
    created = createExplorerApp();
  } finally {
    restore();
  }
  const { app, close } = created;
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    await settle();
    assertAppendedDuringLoad(interceptOptions(f).marker);

    const body = await (await fetch(`${base}/api/events?limit=50`)).json();
    const ids = (body.events || body).map((e) => e.event_id);
    assert.equal(ids.filter((id) => id === 'evt-c-late').length, 1,
      'the row appended to an already-read log must reach the feed');
    assert.equal(ids.filter((id) => id === 'evt-m-early').length, 1,
      'a row read by the load and delivered by the watcher must appear once');
    assert.equal(new Set(ids).size, ids.length, 'the feed must not repeat any event_id');
    assert.equal(ids.length, 7);
  } finally {
    close();
    await new Promise((r) => server.close(r));
    f.cleanup();
  }
});
