import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { isForeignInferred, detach } from '../../scripts/repair-foreign-commit-sessions.js';

const ROOT = path.resolve(import.meta.dirname, '../..');
const OWNERS = new Set(['Ada Lovelace', 'Claude', 'claude']);
const imported = (author, extra = {}) => ({ type: 'git_commit', event_id: `git-${author[0]}`, commit_hash: 'abc1234', author, url: 'u', session_id: 'sess-1', transcript_path: '/t.jsonl', ...extra });

test('only imported commits by non-owners with a session are selected', () => {
  assert.equal(isForeignInferred(imported('Grace Hopper'), OWNERS), true);
  assert.equal(isForeignInferred(imported('Ada Lovelace'), OWNERS), false, 'owner imports keep their session');
  assert.equal(isForeignInferred(imported('Claude'), OWNERS), false);
  assert.equal(isForeignInferred(imported('Grace Hopper', { cwd: '/repo' }), OWNERS), false, 'hook-recorded commits are never touched');
  assert.equal(isForeignInferred({ ...imported('Grace Hopper'), session_id: undefined }, OWNERS), false);
  assert.equal(isForeignInferred({ type: 'tool_file_edit', session_id: 's', author: 'Grace Hopper' }, OWNERS), false);
});

test('detach moves the session and transcript to visible, reversible fields', () => {
  const out = detach(imported('Grace Hopper'));
  assert.equal('session_id' in out, false);
  assert.equal('transcript_path' in out, false);
  assert.equal(out.session_detached_from, 'sess-1');
  assert.equal(out.transcript_detached_from, '/t.jsonl');
  assert.equal(out.commit_hash, 'abc1234', 'the commit itself stays');
});

test('dry run writes nothing; apply rewrites only the foreign rows and keeps a backup', () => {
  const dev = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-foreign-'));
  fs.mkdirSync(path.join(dev, '.carto'));
  const rows = [imported('Grace Hopper'), imported('Ada Lovelace'), { type: 'tool_bash', session_id: 's', summary: 'ls' }];
  const log = path.join(dev, 'changelog.jsonl');
  const original = rows.map((r) => JSON.stringify(r)).join('\n') + '\nnot json\n';
  fs.writeFileSync(log, original);
  const env = { ...process.env, CARTOGRAPHER_PROFILE_AUTHORS: 'Ada Lovelace' };
  const script = path.join(ROOT, 'scripts/repair-foreign-commit-sessions.js');
  const dry = spawnSync('node', [script, '--dev', dev], { encoding: 'utf8', env });
  assert.match(dry.stdout, /Foreign commits carrying an inferred session: 1/);
  assert.equal(fs.readFileSync(log, 'utf8'), original);
  spawnSync('node', [script, '--dev', dev, '--apply'], { encoding: 'utf8', env });
  const after = fs.readFileSync(log, 'utf8').split('\n');
  assert.equal(JSON.parse(after[0]).session_detached_from, 'sess-1');
  assert.equal(after[1], JSON.stringify(rows[1]), 'owner row byte-identical');
  assert.equal(after[2], JSON.stringify(rows[2]));
  assert.equal(after[3], 'not json', 'unparseable rows are preserved as-is');
  assert.equal(fs.readFileSync(`${log}.bak-foreign-sessions`, 'utf8'), original);
});
