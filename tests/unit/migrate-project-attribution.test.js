/**
 * tests/unit/migrate-project-attribution.test.js
 *
 * The 0.7 write-time fix stops NEW worktree misattribution but repairs nothing.
 * migrate-project-attribution.js is the other half: it asks git to resolve each
 * recorded cwd back to its parent repo and repoints `project` in place.
 *
 * Measured on the development corpus when this was written: 5,026 repointable
 * events across 36 phantom projects, plus 670 whose worktree had already been
 * pruned and are therefore unrecoverable — which is why the migration is
 * time-sensitive and must run before any `git worktree prune`.
 *
 * The two guards below are the ones that make it safe to run unattended:
 * an event whose project came from somewhere other than its cwd (log-tool-use's
 * FILE_REPO branch) must be left alone, and a second run must be a no-op.
 *
 * Run with: node --test tests/unit/migrate-project-attribution.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = path.join(ROOT, 'scripts', 'migrate-project-attribution.js');

const git = (cwd, ...args) => spawnSync('git', args, { cwd, encoding: 'utf8',
  env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t',
         GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });

const run = (dev, ...flags) => spawnSync('node', [SCRIPT, '--dev', dev, ...flags],
  { encoding: 'utf8' });

const readLog = (dev) => fs.readFileSync(path.join(dev, 'changelog.jsonl'), 'utf8')
  .split('\n').filter(l => l.trim()).map(l => { try { return JSON.parse(l); } catch { return l; } });

let tmp, dev, wt, repo;
test.beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-mig-'));
  repo = path.join(tmp, 'myproject');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '.');
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'init');
  fs.mkdirSync(path.join(repo, '.claude', 'worktrees'), { recursive: true });
  git(repo, 'worktree', 'add', '-q', '-b', 'throwaway', '.claude/worktrees/brave-thompson-40e495');
  wt = path.join(repo, '.claude', 'worktrees', 'brave-thompson-40e495');

  dev = path.join(tmp, 'dev');
  fs.mkdirSync(dev);
  const rows = [
    { event_id: 'evt-a1', project: 'brave-thompson-40e495', cwd: wt, summary: 'repoint me' },
    { event_id: 'evt-a2', project: 'deleted-9999', cwd: path.join(repo, '.claude/worktrees/deleted-9999'), summary: 'already orphaned' },
    { event_id: 'evt-a3', project: 'myproject', cwd: repo, summary: 'normal repo' },
    { event_id: 'evt-a4', project: 'some-other-repo', cwd: wt, summary: 'project came from FILE_REPO' },
  ];
  fs.writeFileSync(path.join(dev, 'changelog.jsonl'),
    rows.map(r => JSON.stringify(r)).join('\n') + '\nnot valid json\n');
});
test.afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('dry run reports without writing', () => {
  const before = fs.readFileSync(path.join(dev, 'changelog.jsonl'), 'utf8');
  const r = run(dev);
  assert.match(r.stdout, /would be repointed/);
  assert.equal(fs.readFileSync(path.join(dev, 'changelog.jsonl'), 'utf8'), before,
    'a dry run must not touch the log');
});

test('--apply repoints a worktree event to its parent repo', () => {
  run(dev, '--apply');
  const a1 = readLog(dev).find(e => e.event_id === 'evt-a1');
  assert.equal(a1.project, 'myproject');
  assert.equal(a1.project_repointed_from, 'brave-thompson-40e495');
  assert.equal(a1.cwd, wt, 'cwd is accurate history and must not be rewritten');
});

test('an event recorded in a SUBDIRECTORY of a worktree is still repointed', () => {
  // The buggy hook used --show-toplevel, which returns the worktree root however
  // deep the cwd was. Matching only basename(cwd) under-repairs those: measured at
  // 18 recoverable events missed on the development corpus by the 0.7.0 version.
  const deep = path.join(wt, 'apps', 'capacitor', 'android');
  fs.mkdirSync(deep, { recursive: true });
  fs.appendFileSync(path.join(dev, 'changelog.jsonl'),
    JSON.stringify({ event_id: 'evt-deep', project: 'brave-thompson-40e495',
                     cwd: deep, summary: 'recorded from a subdirectory' }) + '\n');
  run(dev, '--apply');
  const deepEv = readLog(dev).find(e => e.event_id === 'evt-deep');
  assert.equal(deepEv.project, 'myproject');
  assert.equal(deepEv.project_repointed_from, 'brave-thompson-40e495');
});

test('an event whose project did not come from its cwd is left alone', () => {
  // log-tool-use derives some events from FILE_REPO rather than cwd. Repointing
  // those would be collateral damage, so the signature check requires
  // project === basename(cwd).
  run(dev, '--apply');
  const a4 = readLog(dev).find(e => e.event_id === 'evt-a4');
  assert.equal(a4.project, 'some-other-repo');
  assert.equal(a4.project_repointed_from, undefined);
});

test('an already-pruned worktree is counted, not guessed at', () => {
  const r = run(dev);
  assert.match(r.stdout, /1 event\(s\) reference a worktree that no longer exists/);
  run(dev, '--apply');
  const a2 = readLog(dev).find(e => e.event_id === 'evt-a2');
  assert.equal(a2.project, 'deleted-9999', 'unrecoverable events stay as they are');
});

test('a second --apply is a no-op', () => {
  run(dev, '--apply');
  const after1 = fs.readFileSync(path.join(dev, 'changelog.jsonl'), 'utf8');
  const r = run(dev, '--apply');
  assert.match(r.stdout, /0 event\(s\) repointed/);
  assert.equal(fs.readFileSync(path.join(dev, 'changelog.jsonl'), 'utf8'), after1);
});

test('unparseable lines survive verbatim', () => {
  run(dev, '--apply');
  const raw = fs.readFileSync(path.join(dev, 'changelog.jsonl'), 'utf8');
  assert.ok(raw.includes('not valid json'), 'a bad line must never be dropped');
});

test('--apply leaves a backup', () => {
  run(dev, '--apply');
  const backups = fs.readdirSync(dev).filter(f => f.startsWith('changelog.jsonl.bak-'));
  assert.equal(backups.length, 1);
});
