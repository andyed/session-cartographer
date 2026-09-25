import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '../..');
const HOOK = path.join(ROOT, 'plugins/session-cartographer/hooks/check-edit-collision.sh');

const SELF = 'self-0000-aaaa-bbbb-cccc';
const PEER = 'peer-1111-dddd-eeee-ffff';

function workspace() {
  const dev = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'carto-collision-')));
  const repo = path.join(dev, 'widget');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src/app.js'), 'x\n');
  fs.writeFileSync(path.join(repo, 'src/other.js'), 'y\n');
  fs.mkdirSync(path.join(dev, '.carto'), { recursive: true });
  return { dev, repo };
}

function ago(min) { return new Date(Date.now() - min * 60e3).toISOString(); }

function writeLog(dev, rows) {
  fs.writeFileSync(path.join(dev, 'changelog.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

function edit(session, file, min, extra = {}) {
  return { type: 'tool_file_edit', session_id: session, provider: 'claude', project: 'widget', timestamp: ago(min), summary: `Modified: ${file}`, ...extra };
}

function runHook(dev, payload, env = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-collision-state-'));
  const result = spawnSync('bash', [HOOK], {
    cwd: ROOT,
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, CARTOGRAPHER_DEV_DIR: dev, CARTOGRAPHER_ROOT: ROOT, TMPDIR: tmp, ...env },
  });
  return { ...result, tmp };
}

function payload(file, session = SELF, tool = 'Edit') {
  return { hook_event_name: 'PreToolUse', session_id: session, tool_name: tool, tool_input: { file_path: file }, cwd: path.dirname(file) };
}

test('a peer edit of the same file in the same checkout produces a non-blocking note', () => {
  const { dev, repo } = workspace();
  const file = path.join(repo, 'src/app.js');
  writeLog(dev, [edit(PEER, file, 6)]);
  const r = runHook(dev, payload(file));
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal('permissionDecision' in out.hookSpecificOutput, false, 'the hook informs; it never decides');
  const ctx = out.hookSpecificOutput.additionalContext;
  assert.match(ctx, /peer-111/);
  assert.match(ctx, /in this checkout/);
  assert.match(ctx, /git diff -- app\.js/);
  const log = fs.readFileSync(path.join(dev, '.carto/collision-warnings.jsonl'), 'utf8').trim().split('\n');
  assert.equal(log.length, 1);
  assert.equal(JSON.parse(log[0]).split, false);
});

test('silent for own edits, other files, stale touches, and when disabled', () => {
  const { dev, repo } = workspace();
  const file = path.join(repo, 'src/app.js');
  writeLog(dev, [
    edit(SELF, file, 2),
    edit(PEER, path.join(repo, 'src/other.js'), 2),
    edit(PEER, file, 120),
    edit('unknown', file, 1),
  ]);
  assert.equal(runHook(dev, payload(file)).stdout, '');
  writeLog(dev, [edit(PEER, file, 2)]);
  assert.equal(runHook(dev, payload(file), { CARTOGRAPHER_COLLISION_CHECK: '0' }).stdout, '');
});

test('relative bash-edit summaries resolve against the event cwd', () => {
  const { dev, repo } = workspace();
  const file = path.join(repo, 'src/app.js');
  writeLog(dev, [edit(PEER, 'src/app.js,src/other.js (via bash)', 3, { cwd: repo })]);
  const r = runHook(dev, payload(file));
  assert.match(JSON.parse(r.stdout).hookSpecificOutput.additionalContext, /edited it 3m ago/);
});

test('a peer edit in a Claude worktree of the same repo is reported as a separate-worktree split', () => {
  const { dev, repo } = workspace();
  const file = path.join(repo, 'src/app.js');
  const wt = path.join(repo, '.claude/worktrees/lane-b/src/app.js');
  fs.mkdirSync(path.dirname(wt), { recursive: true });
  fs.writeFileSync(wt, 'x\n');
  writeLog(dev, [edit(PEER, wt, 4)]);
  const ctx = JSON.parse(runHook(dev, payload(file)).stdout).hookSpecificOutput.additionalContext;
  assert.match(ctx, /separate worktree/);
  assert.match(ctx, /conflict at merge/);
});

test('peer commits naming the file count, and repeats are suppressed until the peer touches it again', () => {
  const { dev, repo } = workspace();
  const file = path.join(repo, 'src/app.js');
  const commit = { type: 'git_commit', session_id: PEER, provider: 'codex', project: 'widget', cwd: repo, timestamp: ago(5), summary: 'Commit abc1234: fix thing | files: src/app.js' };
  writeLog(dev, [commit]);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-collision-state-'));
  const env = { TMPDIR: tmp };
  const first = runHook(dev, payload(file), env);
  assert.match(JSON.parse(first.stdout).hookSpecificOutput.additionalContext, /committed it in abc1234/);
  assert.equal(runHook(dev, payload(file), env).stdout, '', 'same touch, second edit: no repeat');
  writeLog(dev, [commit, edit(PEER, file, 1)]);
  assert.match(runHook(dev, payload(file), env).stdout, /edited it 1m ago/, 'a newer peer touch warns again');
});

test('Codex apply_patch targets are read from patch headers', () => {
  const { dev, repo } = workspace();
  const file = path.join(repo, 'src/app.js');
  writeLog(dev, [edit(PEER, file, 2)]);
  const r = runHook(dev, {
    hook_event_name: 'PreToolUse', session_id: SELF, tool_name: 'apply_patch', cwd: repo,
    tool_input: { input: '*** Begin Patch\n*** Update File: src/app.js\n@@\n-x\n+z\n*** End Patch\n' },
  });
  assert.match(JSON.parse(r.stdout).hookSpecificOutput.additionalContext, /app\.js/);
});

test('malformed input fails open', () => {
  const { dev } = workspace();
  const r = spawnSync('bash', [HOOK], { cwd: ROOT, input: 'not json', encoding: 'utf8', env: { ...process.env, CARTOGRAPHER_DEV_DIR: dev, CARTOGRAPHER_ROOT: ROOT } });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
});
