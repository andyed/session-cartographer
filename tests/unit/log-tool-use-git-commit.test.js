/**
 * tests/unit/log-tool-use-git-commit.test.js
 *
 * Two defects that make a real commit invisible to the corpus. Neither errors.
 *
 * 1. `bash_is_noise()` strips `cd X && Y` hops — the 2026-08-28 fix — but only
 *    the `&&` form. `COMMAND` is newline-flattened before the filter runs, so
 *    `cd repo\ngit commit …` arrives as `cd repo git commit …`, the `cd\ *`
 *    pattern in the final case matches the whole thing, and the hook exits 0.
 *    The commit, and any test run or push after the same `cd`, are dropped.
 *
 * 2. The hash and subject are scraped from the Bash tool's stdout. `git commit
 *    -q` prints nothing, so `COMMIT_MSG` is empty and the conventional-commit
 *    classifier falls through to `other`; and because `TYPE="git_commit"` is
 *    gated on a non-empty `COMMIT_HASH`, a quiet commit with no hash anywhere
 *    in stdout produces no commit row at all. The repo knows both facts for
 *    free — `rev-parse HEAD` and `log -1 --format=%s`.
 *
 * Measured 2026-09-13: commits f1f7a5a and db9b934 on feat/carto-codex-port are
 * absent from changelog.jsonl, so `cartographer-standup.js --commit db9b934`
 * cannot attribute the commit that shipped it.
 *
 * The guard tests matter as much as the recovery ones: reading HEAD instead of
 * stdout means a `git commit` that FAILED would otherwise log the previous
 * commit as if it had just been made.
 *
 * Run with: node --test tests/unit/log-tool-use-git-commit.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const HOOK = path.join(ROOT, 'plugins', 'session-cartographer', 'hooks', 'log-tool-use.sh');
const AUTHOR = ['-c', 'user.email=t@t', '-c', 'user.name=t'];

function makeWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-commit-'));
  const repo = path.join(dir, 'repo');
  const dev = path.join(dir, 'dev');
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(dev, { recursive: true });
  spawnSync('git', ['init', '-q', '.'], { cwd: repo });
  return { dir, repo, dev };
}

function fire(ws, command, stdout) {
  const payload = {
    tool_name: 'Bash', session_id: 'testsess', cwd: ws.repo,
    transcript_path: '/tmp/t.jsonl', tool_input: { command },
  };
  if (stdout !== undefined) payload.tool_response = { stdout };
  spawnSync('bash', [HOOK], {
    input: JSON.stringify(payload),
    env: { ...process.env, CARTOGRAPHER_LOG_TOOL_USE: 'true', CARTOGRAPHER_DEV_DIR: ws.dev },
  });
  const log = path.join(ws.dev, 'changelog.jsonl');
  if (!fs.existsSync(log)) return [];
  return fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
}

/** Make a real commit so HEAD carries what the hook should be reading. */
function commit(ws, file, message, extraArgs = []) {
  fs.writeFileSync(path.join(ws.repo, file), `// ${message}\n`);
  spawnSync('git', ['add', '-A'], { cwd: ws.repo });
  return spawnSync('git', [...AUTHOR, 'commit', ...extraArgs, '-m', message],
    { cwd: ws.repo, encoding: 'utf8' }).stdout;
}

const last = (recs) => recs[recs.length - 1];
const commits = (recs) => recs.filter((r) => r.type === 'git_commit');

test('a commit after a newline-separated cd hop is recorded', () => {
  const ws = makeWorkspace();
  try {
    const out = commit(ws, 'a.js', 'feat(core): land the thing');
    // Exactly the shape the harness writes constantly, flattened by the hook
    // to `cd <repo> git commit …` with no separator left to mark the boundary.
    const recs = fire(ws, `cd ${ws.repo}\ngit commit -m 'feat(core): land the thing'`, out);
    assert.equal(commits(recs).length, 1, 'the cd swallowed the commit');
    assert.equal(last(recs).commit_type, 'feature');
    assert.match(last(recs).summary, /land the thing/);
  } finally { fs.rmSync(ws.dir, { recursive: true, force: true }); }
});

test('a commit after a semicolon-separated cd hop is recorded', () => {
  const ws = makeWorkspace();
  try {
    const out = commit(ws, 'b.js', 'fix(api): stop the leak');
    const recs = fire(ws, `cd ${ws.repo}; git commit -m 'fix(api): stop the leak'`, out);
    assert.equal(commits(recs).length, 1);
    assert.equal(last(recs).commit_type, 'fix');
  } finally { fs.rmSync(ws.dir, { recursive: true, force: true }); }
});

test('work after a newline cd hop is not noise either', () => {
  const ws = makeWorkspace();
  try {
    const recs = fire(ws, `cd ${ws.repo}\nnode --test tests/unit/x.test.js`);
    assert.equal(recs.length, 1, 'a test run behind a cd was dropped as noise');
    assert.equal(last(recs).type, 'tool_bash');
  } finally { fs.rmSync(ws.dir, { recursive: true, force: true }); }
});

test('a quiet commit still gets its real subject and type', () => {
  const ws = makeWorkspace();
  try {
    // -q suppresses git's `[branch abc1234] subject` line entirely: the hook
    // sees empty stdout and must ask the repo instead of guessing "other".
    commit(ws, 'c.js', 'docs(readme): explain the window', ['-q']);
    const recs = fire(ws, `git commit -q -F - <<'MSG'\ndocs(readme): explain the window\nMSG`, '');
    assert.equal(commits(recs).length, 1, 'a -q commit produced no git_commit row');
    assert.equal(last(recs).commit_type, 'docs');
    assert.match(last(recs).summary, /explain the window/);
    assert.doesNotMatch(last(recs).summary, /Commit\s*:/, 'the hash must be present');
  } finally { fs.rmSync(ws.dir, { recursive: true, force: true }); }
});

test('the recorded hash is the commit that HEAD actually points at', () => {
  const ws = makeWorkspace();
  try {
    commit(ws, 'd.js', 'chore: bump', ['-q']);
    const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ws.repo, encoding: 'utf8' }).stdout.trim();
    const recs = fire(ws, `cd ${ws.repo}\ngit commit -q -m 'chore: bump'`, '');
    assert.match(last(recs).summary, new RegExp(head.slice(0, 7)));
  } finally { fs.rmSync(ws.dir, { recursive: true, force: true }); }
});

test('a git commit that made no commit does not log the previous one', () => {
  const ws = makeWorkspace();
  try {
    commit(ws, 'e.js', 'feat: real work');
    // Nothing staged now. The command names `git commit` and fails; reading
    // HEAD blindly would report the earlier commit as freshly made.
    const failed = spawnSync('git', [...AUTHOR, 'commit', '-m', 'nothing to do'],
      { cwd: ws.repo, encoding: 'utf8' });
    assert.notEqual(failed.status, 0, 'fixture must actually fail to commit');
    // Age HEAD past the freshness window. `-c` is a git option, not a commit
    // option, so it has to precede the subcommand or the amend silently fails
    // and the fixture tests nothing.
    const aged = spawnSync('git', [...AUTHOR, 'commit', '--amend', '--no-edit'],
      { cwd: ws.repo, env: { ...process.env, GIT_COMMITTER_DATE: '2020-01-01T00:00:00' } });
    assert.equal(aged.status, 0, 'fixture must actually age HEAD');
    const age = Math.floor(Date.now() / 1000)
      - Number(spawnSync('git', ['log', '-1', '--format=%ct'], { cwd: ws.repo, encoding: 'utf8' }).stdout.trim());
    assert.ok(age > 120, `fixture must put HEAD outside the freshness window (age ${age}s)`);
    const recs = fire(ws, `cd ${ws.repo}\ngit commit -m 'nothing to do'`, failed.stdout || '');
    assert.equal(commits(recs).length, 0, 'a failed commit logged a phantom git_commit row');
  } finally { fs.rmSync(ws.dir, { recursive: true, force: true }); }
});

test('a bare cd and cd-then-noise are still noise', () => {
  const ws = makeWorkspace();
  try {
    for (const cmd of [`cd ${ws.repo}`, `cd ${ws.repo} && ls -la`, `cd ${ws.repo}\nls -la`, `cd ${ws.repo}; cat f.js`]) {
      assert.equal(fire(ws, cmd).length, 0, `expected no event for: ${JSON.stringify(cmd)}`);
    }
  } finally { fs.rmSync(ws.dir, { recursive: true, force: true }); }
});

test('a failed commit seconds after a real one logs no second row', () => {
  const ws = makeWorkspace();
  try {
    // Freshness alone cannot separate these: HEAD is genuinely seconds old in
    // both cases. Only "this sha is already in the log" can.
    const out = commit(ws, 'f.js', 'feat: the real one');
    const first = fire(ws, `cd ${ws.repo}\ngit commit -m 'feat: the real one'`, out);
    assert.equal(commits(first).length, 1, 'the real commit must be recorded');

    const failed = spawnSync('git', [...AUTHOR, 'commit', '-m', 'nothing staged'],
      { cwd: ws.repo, encoding: 'utf8' });
    assert.notEqual(failed.status, 0, 'fixture must actually fail to commit');
    const after = fire(ws, `cd ${ws.repo}\ngit commit -m 'nothing staged'`, failed.stdout || '');
    assert.equal(commits(after).length, 1, 'the failed retry duplicated the previous commit');
  } finally { fs.rmSync(ws.dir, { recursive: true, force: true }); }
});

test('an amend is a different commit and is recorded again', () => {
  const ws = makeWorkspace();
  try {
    const out = commit(ws, 'g.js', 'feat: first shape');
    fire(ws, `cd ${ws.repo}\ngit commit -m 'feat: first shape'`, out);
    spawnSync('git', [...AUTHOR, 'commit', '--amend', '-m', 'feat: better shape'], { cwd: ws.repo });
    const recs = fire(ws, `cd ${ws.repo}\ngit commit --amend -m 'feat: better shape'`, '');
    assert.equal(commits(recs).length, 2, 'the amended sha is new work and must be logged');
    assert.match(last(recs).summary, /better shape/);
  } finally { fs.rmSync(ws.dir, { recursive: true, force: true }); }
});
