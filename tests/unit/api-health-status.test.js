// /api/health hard-coded `status: 'ok'`. readJsonlFile answers [] for a log it
// cannot read, so a corpus missing a whole log looked healthy: the file exists,
// `files` says true, and every answer silently lacks its events. The status now
// follows the last read of each log.
//
// The unreadable log is a directory at the log's path. It stats like a file,
// which is what made the old status lie, and it fails to read with EISDIR for
// every user, root included, where a chmod would not.

process.env.CARTOGRAPHER_SEMANTIC = '0';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OFFLINE_INDEX_ENV } from './helpers/offline-index.js';

for (const name of [
  'CARTOGRAPHER_SESSION_ID',
  'CLAUDE_SESSION_ID',
  'CLAUDE_CODE_SESSION_ID',
  'CODEX_SESSION_ID',
]) delete process.env[name];

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-health-'));
fs.writeFileSync(path.join(dir, 'changelog.jsonl'), `${JSON.stringify({
  event_id: 'evt-health', timestamp: '2026-10-16T12:00:00Z', project: 'health', summary: 'loaded row',
})}\n`);
const research = path.join(dir, 'research-log.jsonl');
fs.mkdirSync(research);
// DEV_DIR is captured when jsonl.js is first evaluated; /api/health probes
// Qdrant and the embedder, which must not be the live ones.
Object.assign(process.env, { ...OFFLINE_INDEX_ENV, CARTOGRAPHER_DEV_DIR: dir });
const { createExplorerApp } = await import('../../explorer/server/app.js');
const { readJsonlFile } = await import('../../explorer/server/jsonl.js');

test('health reports degraded while a present log fails to load, and ok once it reads', async (t) => {
  const { app, close } = createExplorerApp();
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(async () => {
    close();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const health = async () => (await fetch(`http://127.0.0.1:${server.address().port}/api/health`)).json();

  const broken = await health();
  // The shape the old status hid: the log is present by stat, its events absent.
  assert.equal(broken.files.research, true, 'the unreadable log must still stat as present');
  assert.equal(broken.events, 1, 'only the changelog row loaded');
  assert.equal(broken.status, 'degraded');
  assert.deepEqual(broken.load_errors, { research: 'EISDIR' });
  // A log that is simply absent is a fresh install, not a failure.
  assert.equal(broken.files.prompts, false);

  fs.rmdirSync(research);
  fs.writeFileSync(research, `${JSON.stringify({ event_id: 'evt-research', timestamp: '2026-10-16T12:00:00Z', summary: 'research row' })}\n`);
  readJsonlFile(research);
  const repaired = await health();
  assert.equal(repaired.status, 'ok');
  assert.deepEqual(repaired.load_errors, {});
});
