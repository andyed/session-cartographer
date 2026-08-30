import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { processIsAlive } from '../../scripts/turbo-common.js';

const ROOT = path.resolve(import.meta.dirname, '../..');
const CONTROL = path.join(ROOT, 'scripts/cartographer-turbo.js');
const SEARCH = path.join(ROOT, 'scripts/cartographer-search.sh');

function writeJsonl(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
}

function run(command, args, env, timeout = 15000) {
  return spawnSync(command, args, {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    timeout,
  });
}

test('one persistent opt-in selects Turbo for Claude and Codex sessions', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cartographer-turbo-global-'));
  const dev = path.join(root, 'dev');
  const config = path.join(root, 'config.json');
  const state = path.join(root, 'state');
  const served = path.join(dev, 'served-log.jsonl');
  const url = 'http://127.0.0.1:45991';
  const runId = path.basename(root);

  writeJsonl(path.join(dev, 'changelog.jsonl'), [
    { event_id: 'evt-global-turbo', timestamp: '2026-08-30T12:00:00Z', type: 'milestone', provider: 'codex', project: 'shared', summary: 'globalturbo provider neutral recall' },
    { event_id: 'evt-noise-1', timestamp: '2026-08-29T12:00:00Z', project: 'noise', summary: 'amber glacier notebook' },
    { event_id: 'evt-noise-2', timestamp: '2026-08-28T12:00:00Z', project: 'noise', summary: 'copper meadow compass' },
    { event_id: 'evt-noise-3', timestamp: '2026-08-27T12:00:00Z', project: 'noise', summary: 'river lantern telescope' },
    { event_id: 'evt-noise-4', timestamp: '2026-08-26T12:00:00Z', project: 'noise', summary: 'violet harbor archive' },
  ]);
  fs.writeFileSync(config, `${JSON.stringify({
    version: 1,
    turbo: { enabled: true, auto_start: true, url, timeout_ms: 300 },
  }, null, 2)}\n`);

  const env = {
    ...process.env,
    HOME: root,
    CARTOGRAPHER_CONFIG: config,
    CARTOGRAPHER_DEV_DIR: dev,
    CARTOGRAPHER_TURBO_STATE_DIR: state,
    CARTOGRAPHER_TURBO_SPOOL_ONLY: '1',
    CARTOGRAPHER_QDRANT_URL: 'http://127.0.0.1:1',
    CARTOGRAPHER_EMBED_URL: 'http://127.0.0.1:1/v1/embeddings',
    CARTOGRAPHER_SERVED_LOG: served,
  };
  delete env.CARTOGRAPHER_TURBO;
  delete env.CARTOGRAPHER_SEARCH_BACKEND;

  const started = run(process.execPath, [CONTROL, 'start'], env);
  assert.equal(started.status, 0, started.stderr || started.stdout);
  t.after(() => run(process.execPath, [CONTROL, 'stop'], env));

  const claude = run('bash', [SEARCH, 'globalturbo', '--limit', '5'], {
    ...env,
    CLAUDE_CODE_SESSION_ID: `claude-${runId}`,
  });
  assert.equal(claude.status, 0, claude.stderr || claude.stdout);
  assert.match(claude.stdout, /turbo: warm Explorer via file/);
  assert.match(claude.stdout, /evt-global-turbo/);

  const codex = run('bash', [SEARCH, 'globalturbo', '--limit', '5'], {
    ...env,
    CODEX_SESSION_ID: `codex-${runId}`,
  });
  assert.equal(codex.status, 0, codex.stderr || codex.stdout);
  assert.match(codex.stdout, /turbo: warm Explorer via file/);
  assert.match(codex.stdout, /evt-global-turbo/);

  const servedRows = fs.readFileSync(served, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(servedRows.map((row) => row.provider), ['claude', 'codex']);
  assert.ok(servedRows.every((row) => row.backend === 'explorer'));

  const callRows = fs.readFileSync(path.join(dev, '.carto/search-calls.jsonl'), 'utf8')
    .trim().split('\n').map(JSON.parse);
  assert.deepEqual(callRows.map((row) => row.provider), ['claude', 'codex']);
  assert.ok(callRows.every((row) => row.selected_backend === 'explorer'));

  const stopped = run(process.execPath, [CONTROL, 'stop'], env);
  assert.equal(stopped.status, 0, stopped.stderr || stopped.stdout);
  assert.equal(JSON.parse(stopped.stdout).stopped, true);
});

test('enable and disable mutate one provider-neutral config', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cartographer-turbo-config-'));
  const config = path.join(root, 'config.json');
  const env = {
    ...process.env,
    HOME: root,
    CARTOGRAPHER_CONFIG: config,
    CARTOGRAPHER_DEV_DIR: path.join(root, 'dev'),
    CARTOGRAPHER_TURBO_STATE_DIR: path.join(root, 'state'),
  };

  const enabled = run(process.execPath, [CONTROL, 'enable', '--no-start'], env);
  assert.equal(enabled.status, 0, enabled.stderr || enabled.stdout);
  assert.equal(JSON.parse(fs.readFileSync(config, 'utf8')).turbo.enabled, true);

  const disabled = run(process.execPath, [CONTROL, 'disable'], env);
  assert.equal(disabled.status, 0, disabled.stderr || disabled.stdout);
  const stored = JSON.parse(fs.readFileSync(config, 'utf8'));
  assert.equal(stored.turbo.enabled, false);
  assert.equal(stored.turbo.auto_start, true);
});

test('sandbox EPERM from a zero-signal probe means the managed process exists', () => {
  const originalKill = process.kill;
  process.kill = () => {
    const error = new Error('operation not permitted');
    error.code = 'EPERM';
    throw error;
  };
  try {
    assert.equal(processIsAlive(4242), true);
  } finally {
    process.kill = originalKill;
  }
});
