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
 *
 * 0.7.6 closes the other half. The hooks were fixed in 0.7; the three SKILLS that
 * write to session-milestones.jsonl kept the old derivation, and skills are
 * markdown — they cannot source a shell library, so they had each spelled it
 * again. Measured 2026-09-10, four months of clean hook logs (newest
 * worktree-named event in changelog/tool-use-log: 2026-08) against milestones
 * still arriving wrong in September, one of which contradicted itself: project
 * "confident-yalow-e1cdc6" beside a digest reading {psychodeli-webgl-port: 118},
 * because the digest is built from hook events and the project field was not.
 * scripts/cartographer-project.sh is the command-line face of the same function
 * so the skills call the definition instead of copying it.
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

/**
 * The CLI face of the same function. Skills shell out to this; hooks keep
 * sourcing the function directly, because they run on every tool call and a
 * fork per event is not free.
 */
const SCRIPT = path.join(ROOT, 'scripts', 'cartographer-project.sh');
const SKILLS = path.join(ROOT, 'plugins', 'session-cartographer', 'skills');

test('the CLI wrapper agrees with the function it wraps', () => {
  const wt = path.join(tmp, 'myproject', '.claude', 'worktrees', 'brave-thompson-40e495');
  const r = spawnSync('bash', [SCRIPT, wt], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), resolveProject(wt));
  assert.equal(r.stdout.trim(), 'myproject');
});

test('no answer is distinguishable from an answer', () => {
  // Copied where common.sh cannot be reached: exit non-zero and print nothing,
  // so a caller falls back deliberately instead of recording a guess. A wrapper
  // that re-implemented the derivation as its own fallback would be the fourth
  // copy of it, which is the defect this file exists for.
  const orphan = fs.mkdtempSync(path.join(tmp, 'orphan-'));
  const copy = path.join(orphan, 'cartographer-project.sh');
  fs.copyFileSync(SCRIPT, copy);
  const r = spawnSync('bash', [copy, tmp], { encoding: 'utf8' });
  assert.notEqual(r.status, 0);
  assert.equal(r.stdout.trim(), '');
});

test('no skill records a project it derived from its own toplevel', () => {
  // The write sites are markdown, so this is the only place the regression shows.
  // A cwd-basename fallback is legitimate, but only AFTER the shared script has
  // been tried — so assert on order, not on absence.
  for (const skill of ['wrapup', 'investigate', 'trustmap']) {
    const lines = fs.readFileSync(path.join(SKILLS, skill, 'SKILL.md'), 'utf8')
      .split('\n').filter(l => !/^\s*#/.test(l));
    const shared = lines.findIndex(l => l.includes('cartographer-project.sh'));
    assert.notEqual(shared, -1,
      `${skill} never calls cartographer-project.sh — it is deriving the project itself`);
    const bare = lines.findIndex(l => /project/i.test(l)
      && /--show-toplevel|GIT_REPO:-/.test(l)
      && !l.includes('cartographer-project.sh'));
    assert.ok(bare === -1 || bare > shared,
      `${skill} derives the recorded project from its own toplevel before trying the shared script`);
  }
});
