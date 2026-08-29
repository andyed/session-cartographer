/**
 * tests/unit/worktree-project-attribution.test.js
 *
 * Every hook derived the project name as `basename $(git rev-parse
 * --show-toplevel)`. Inside a git worktree that basename is the WORKTREE
 * directory, not the repo — so a session run in
 *
 *     psychodeli-webgl-port/.claude/worktrees/brave-thompson-40e495
 *
 * was filed under the project `brave-thompson-40e495`. Agent worktrees are
 * routine here, so each throwaway directory became a phantom "project" that
 * owned real history and then evaporated when the worktree was pruned.
 *
 * Measured 2026-08-29 across the live corpus before the fix:
 *
 *     changelog.jsonl           2,854 of 87,524 events
 *     tool-use-log.jsonl        2,713 of 64,325 events
 *     session-milestones.jsonl    118 of 13,996 events
 *
 * ~5,700 events pointing at directories that no longer exist, none of which
 * surface under a /remember scoped to the real repo.
 *
 * `--git-common-dir` always resolves to the MAIN repo's .git, in a worktree and
 * in the main tree alike, so its parent is the real project root. The
 * assertions below are the ones the original bug would have failed, plus the
 * three no-regression cases and the bare-repo trap that a naive
 * dirname(common-dir) would fall into.
 *
 * Run with: node --test tests/unit/worktree-project-attribution.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const COMMON = path.join(ROOT, 'plugins', 'session-cartographer', 'hooks', 'common.sh');

const git = (cwd, ...args) =>
  spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env,
    GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t',
    GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });

/** Source common.sh and ask it to resolve one directory. */
function resolveProject(dir) {
  const r = spawnSync('bash', ['-c',
    `. "${COMMON}"; cartographer_project "${dir}"`], { encoding: 'utf8' });
  return r.stdout.trim();
}

let tmp;
test.before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-wt-'));

  // A repo with a worktree under the .claude/worktrees convention.
  const repo = path.join(tmp, 'myproject');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '.');
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'init');
  fs.mkdirSync(path.join(repo, '.claude', 'worktrees'), { recursive: true });
  git(repo, 'worktree', 'add', '-q', '-b', 'throwaway',
      '.claude/worktrees/brave-thompson-40e495');

  // A bare repo — dirname(--git-common-dir) would give the PARENT here, so the
  // resolver must reject a common dir that is not literally named ".git".
  git(tmp, 'clone', '-q', '--bare', repo, 'bare-repo.git');

  // A plain directory that is not a repo at all.
  fs.mkdirSync(path.join(tmp, 'notgit', 'sub'), { recursive: true });
});

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('a worktree resolves to its parent repo, not the worktree basename', () => {
  const wt = path.join(tmp, 'myproject', '.claude', 'worktrees', 'brave-thompson-40e495');
  assert.equal(path.basename(wt), 'brave-thompson-40e495',
    'fixture sanity: the worktree basename is the throwaway name');
  assert.equal(resolveProject(wt), 'myproject',
    'the bug: a worktree was filed under its own directory name');
});

test('the main worktree is unchanged', () => {
  assert.equal(resolveProject(path.join(tmp, 'myproject')), 'myproject');
});

test('a bare repo does not resolve to its parent directory', () => {
  // --git-common-dir is <tmp>/bare-repo.git; a naive dirname() would yield the
  // tmpdir's name. Only a common dir literally ending in /.git is trusted.
  assert.equal(resolveProject(path.join(tmp, 'bare-repo.git')), 'bare-repo.git');
});

test('a non-repo directory falls back to its own basename', () => {
  assert.equal(resolveProject(path.join(tmp, 'notgit', 'sub')), 'sub');
});

test('no hook still derives the project with a raw basename', () => {
  const hooks = path.join(ROOT, 'plugins', 'session-cartographer', 'hooks');
  const offenders = fs.readdirSync(hooks)
    .filter(f => f.endsWith('.sh'))
    .filter(f => {
      const src = fs.readFileSync(path.join(hooks, f), 'utf8');
      return /PROJECT=\$\(basename "\$(GIT_REPO|FILE_REPO)"\)/.test(src);
    });
  assert.deepEqual(offenders, [],
    `these hooks would refile worktree sessions under a throwaway name: ${offenders}`);
});
