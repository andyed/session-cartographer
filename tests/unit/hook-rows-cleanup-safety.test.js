import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const root = path.resolve(import.meta.dirname, '../..');
test('golden hook harness refuses unsafe scratch setup without deleting its cwd', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-cleanup-safety-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const marker = path.join(dir, 'keep.txt');
  fs.writeFileSync(marker, 'keep');
  const run = spawnSync('bash', [path.join(root, 'tests/fixtures/hook-rows/run.sh'),
    path.join(root, 'plugins/session-cartographer/hooks')], {
    cwd: dir, encoding: 'utf8', env: { ...process.env, HOME: '/tmp', TMPDIR: '/tmp', RUNNER_TEMP: '/tmp' },
  });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /No non-\/tmp scratch directory/);
  assert.equal(fs.readFileSync(marker, 'utf8'), 'keep');
});
