/**
 * tests/unit/log-tool-use-git-commit.test.js
 *
 * Three defects that make a real commit invisible to the corpus. None errors.
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
 * 3. `git -C <repo> commit` holds no literal "git commit" (2026-09-26, 9e3d014
 *    lost). The tests at the bottom cover detection past global options and
 *    reading the repo that `-C` names instead of the hook's cwd.
 *
 * 4. Detection read the command cut to 500 chars, so a long commit message
 *    written to a file first put `git commit` past the cut.
 *
 * 5. A leading `cat` made the whole command noise unless it wrote a path the
 *    write filter keeps, and scratch paths are filtered: c29a684 (session
 *    979b81b0, 2026-09-26) was lost to `cat > <scratchpad>/commit-msg.txt
 *    <<EOF … EOF` followed by `git commit -F`.
 *
 * 6. The repo came from the payload cwd plus the invocation's own -C, never
 *    from a `cd` hop in the same command, and a commit the repo could not
 *    confirm fell back to the first hex run anywhere in stdout. Measured
 *    2026-09-26: 42 git_commit rows since 2026-09-01 filed under `dev` with no
 *    files, and six phantoms scraped from stdout: `feedbac` out of
 *    "feedback", a session-id prefix, a worktree name, a sha256, and two
 *    shas out of printed JSON.
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

function fire(ws, command, stdout, { cwd = ws.repo, env = {} } = {}) {
  const payload = {
    tool_name: 'Bash', session_id: 'testsess', cwd,
    transcript_path: '/tmp/t.jsonl', tool_input: { command },
  };
  if (stdout !== undefined) payload.tool_response = { stdout };
  spawnSync('bash', [HOOK], {
    input: JSON.stringify(payload),
    // The hook backgrounds index-event.sh, which otherwise embeds these fixture
    // rows into the live Qdrant: 18 `session: testsess` points were found there.
    env: {
      ...process.env, CARTOGRAPHER_LOG_TOOL_USE: 'true', CARTOGRAPHER_DEV_DIR: ws.dev,
      CARTOGRAPHER_QDRANT_URL: 'http://127.0.0.1:1', CARTOGRAPHER_EMBED_URL: 'http://127.0.0.1:1',
      ...env,
    },
  });
  const log = path.join(ws.dev, 'changelog.jsonl');
  if (!fs.existsSync(log)) return [];
  return fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
}

/** Make a real commit so HEAD carries what the hook should be reading. */
function commit(ws, file, message, extraArgs = []) {
  return commitIn(ws.repo, file, message, extraArgs);
}

function commitIn(repo, file, message, extraArgs = []) {
  fs.writeFileSync(path.join(repo, file), `// ${message}\n`);
  spawnSync('git', ['add', '-A'], { cwd: repo });
  return spawnSync('git', [...AUTHOR, 'commit', ...extraArgs, '-m', message],
    { cwd: repo, encoding: 'utf8' }).stdout;
}

/** A second repository in the workspace, named so `project` can tell them apart. */
function makeRepo(ws, name) {
  const repo = path.join(ws.dir, name);
  fs.mkdirSync(repo, { recursive: true });
  spawnSync('git', ['init', '-q', '.'], { cwd: repo });
  return repo;
}

const headOf = (repo) =>
  spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).stdout.trim();
const isRepo = (dir) =>
  spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: dir }).status === 0;

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

// ── Global options between `git` and the subcommand ──────────────────────────
// `git -C <repo> commit` is how an agent avoids a leading `cd`, and it contains
// no literal "git commit". The substring detector logged it as tool_bash:
// 9e3d014 (session 49614682, 2026-09-26) never became a git_commit row, and
// /wrapup's digest printed no commits block. The repo also has to come from
// `-C`, not from the hook's cwd, or the freshness check reads the wrong HEAD.

test('git -C <repo> commit from outside any repo is recorded against that repo', () => {
  const ws = makeWorkspace();
  try {
    commit(ws, 'h.js', 'fix(watcher): re-arm on rename', ['-q']);
    const cmd = `git -C ${ws.repo} commit -q -m "fix(watcher): re-arm on rename"`;
    // Without these two, the test passes against the substring detector, or
    // passes because the cwd supplied the repo instead of `-C`.
    assert.ok(!cmd.includes('git commit'), 'the fixture must not contain the old literal');
    assert.ok(!isRepo(ws.dev), 'the hook cwd must not be a repo');
    // Quiet: stdout carries no hash, so only the repo named by -C can supply one.
    const recs = fire(ws, cmd, '', { cwd: ws.dev });
    assert.equal(commits(recs).length, 1, 'git -C … commit produced no git_commit row');
    assert.match(last(recs).summary, new RegExp(`Commit ${headOf(ws.repo)}:`));
    assert.match(last(recs).summary, /re-arm on rename/);
    assert.equal(last(recs).commit_type, 'fix');
    assert.equal(last(recs).project, 'repo', 'project must come from -C, not the hook cwd');
  } finally { fs.rmSync(ws.dir, { recursive: true, force: true }); }
});

test('git -C names the repo even when the hook cwd is another repo with a fresh commit', () => {
  const ws = makeWorkspace();
  try {
    // The bystander's HEAD is seconds old and unlogged, so the freshness guard
    // would accept it: reading the cwd's repo here files the wrong commit.
    const bystander = makeRepo(ws, 'bystander');
    commitIn(bystander, 'b.js', 'feat: bystander work', ['-q']);
    commit(ws, 'i.js', 'docs: the real commit', ['-q']);
    // An earlier `git -C <other> …` in the same command must not lend its path.
    const recs = fire(ws,
      `git -C ${bystander} status --short && git -C ${ws.repo} commit -q -m 'docs: the real commit'`,
      '', { cwd: bystander });
    assert.equal(commits(recs).length, 1);
    assert.match(last(recs).summary, new RegExp(`Commit ${headOf(ws.repo)}:`));
    assert.doesNotMatch(last(recs).summary, /bystander/);
    assert.equal(last(recs).project, 'repo');
  } finally { fs.rmSync(ws.dir, { recursive: true, force: true }); }
});

test('a -C path written with ~, $HOME, or quotes around spaces resolves', () => {
  const ws = makeWorkspace();
  try {
    const spaced = makeRepo(ws, 'my repo');
    const cases = [
      [ws.repo, 'tilde', `git -C ~/repo commit -q -m 'chore: tilde'`],
      [spaced, 'home', `git -C "$HOME/my repo" commit -q -m 'chore: home'`],
      [spaced, 'quoted', `git -C '${spaced}' commit -q -m 'chore: quoted'`],
    ];
    for (const [repo, tag, cmd] of cases) {
      commitIn(repo, `${tag}.js`, `chore: ${tag}`, ['-q']);
      const recs = fire(ws, cmd, '', { cwd: ws.dev, env: { HOME: ws.dir } });
      assert.match(last(recs).summary, new RegExp(`Commit ${headOf(repo)}: chore: ${tag}`), cmd);
      assert.equal(last(recs).project, path.basename(repo), cmd);
    }
  } finally { fs.rmSync(ws.dir, { recursive: true, force: true }); }
});

test('git -c k=v commit is recorded', () => {
  const ws = makeWorkspace();
  try {
    // The fixture's own commit() uses exactly this shape to set an identity.
    const out = commit(ws, 'j.js', 'feat: configured author');
    const cmd = `git -c user.name=x -c user.email=x@x commit -m 'feat: configured author'`;
    assert.ok(!cmd.includes('git commit'), 'the fixture must not contain the old literal');
    const recs = fire(ws, cmd, out);
    assert.equal(commits(recs).length, 1, 'git -c … commit produced no git_commit row');
    assert.equal(last(recs).commit_type, 'feature');
    assert.match(last(recs).summary, new RegExp(`Commit ${headOf(ws.repo)}:`));
  } finally { fs.rmSync(ws.dir, { recursive: true, force: true }); }
});

test('git --git-dir=… --work-tree=… commit resolves the repo from the options', () => {
  const ws = makeWorkspace();
  try {
    commit(ws, 'k.js', 'refactor: split', ['-q']);
    for (const cmd of [
      `git --git-dir=${ws.repo}/.git --work-tree=${ws.repo} commit -q -m 'refactor: split'`,
      `git --no-pager --git-dir ${ws.repo}/.git commit -q -m 'refactor: split'`,
    ]) {
      const dev = fs.mkdtempSync(path.join(ws.dir, 'dev-'));
      const recs = fire({ ...ws, dev }, cmd, '', { cwd: dev });
      assert.equal(commits(recs).length, 1, cmd);
      assert.match(last(recs).summary, new RegExp(`Commit ${headOf(ws.repo)}:`), cmd);
      assert.equal(last(recs).project, 'repo', cmd);
    }
  } finally { fs.rmSync(ws.dir, { recursive: true, force: true }); }
});

test('commit as an argument, not the subcommand, is not a commit', () => {
  const ws = makeWorkspace();
  try {
    // HEAD is fresh and unlogged, so the freshness guard would pass it: only
    // the matcher holding `commit` to the subcommand position stops a phantom.
    const out = commit(ws, 'l.js', 'feat: fresh and unlogged');
    for (const cmd of [
      `git -C ${ws.repo} log -1 --grep commit`,
      `git -C ${ws.repo} show --format=commit HEAD`,
      `git -C ${ws.repo} commit-tree HEAD^{tree} -m x`,
    ]) {
      const recs = fire(ws, cmd, out, { cwd: ws.dev });
      assert.equal(commits(recs).length, 0, `phantom git_commit for: ${cmd}`);
    }
  } finally { fs.rmSync(ws.dir, { recursive: true, force: true }); }
});

test('a git -C commit that made no commit does not log the previous one', () => {
  const ws = makeWorkspace();
  try {
    commit(ws, 'm.js', 'feat: real work');
    const aged = spawnSync('git', [...AUTHOR, 'commit', '--amend', '--no-edit'],
      { cwd: ws.repo, env: { ...process.env, GIT_COMMITTER_DATE: '2020-01-01T00:00:00' } });
    assert.equal(aged.status, 0, 'fixture must actually age HEAD past the freshness window');
    const failed = spawnSync('git', [...AUTHOR, 'commit', '-m', 'nothing to do'],
      { cwd: ws.repo, encoding: 'utf8' });
    assert.notEqual(failed.status, 0, 'fixture must actually fail to commit');
    const recs = fire(ws, `git -C ${ws.repo} commit -m 'nothing to do'`, failed.stdout || '',
      { cwd: ws.dev });
    assert.equal(commits(recs).length, 0, 'a failed git -C commit logged a phantom row');
  } finally { fs.rmSync(ws.dir, { recursive: true, force: true }); }
});

test('git -C <repo> push is a push, attributed to that repo', () => {
  const ws = makeWorkspace();
  try {
    const cmd = `git -C ${ws.repo} push -u origin main`;
    assert.ok(!cmd.includes('git push'), 'the fixture must not contain the old literal');
    const recs = fire(ws, cmd, '', { cwd: ws.dev });
    assert.equal(recs.length, 1);
    assert.equal(last(recs).type, 'git_push');
    assert.equal(last(recs).project, 'repo');
  } finally { fs.rmSync(ws.dir, { recursive: true, force: true }); }
});

// ── Commits past char 500, and behind a leading cat ──────────────────────────
// Both found replaying synthetic payloads through the installed 0.7.9 hook on
// 2026-09-26. Detection now reads the whole command minus heredoc bodies, and
// the noise verdict judges every `&&` / `;` / newline segment, not the first.

const LONG_BODY = 'The body explains why the change was needed. '.repeat(40);
// Text only: the hook never reads the file, it reads HEAD. What matters is that
// the write filter drops the path, as it drops every real scratchpad.
const SCRATCH_MSG = '/private/tmp/claude-501/-Users-x/0000abcd/scratchpad/commit-msg.txt';

test('a commit behind a heredoc longer than 500 chars is recorded', () => {
  const ws = makeWorkspace();
  try {
    commit(ws, 'n.js', 'fix(hooks): a long message', ['-q']);
    const cmd = `cat > msg.txt <<'EOF'\nfix(hooks): a long message\n\n${LONG_BODY}\nEOF\n`
      + `git add n.js && git commit -q -F msg.txt`;
    assert.ok(cmd.indexOf('git commit') > 500, 'the commit must sit past the old 500-char cut');
    const recs = fire(ws, cmd, '');
    assert.equal(commits(recs).length, 1, 'a commit past char 500 produced no git_commit row');
    assert.match(last(recs).summary, new RegExp(`Commit ${headOf(ws.repo)}: fix\\(hooks\\): a long message`));
  } finally { fs.rmSync(ws.dir, { recursive: true, force: true }); }
});

test('a commit behind any long prefix is recorded, heredoc or not', () => {
  const ws = makeWorkspace();
  try {
    // Stripping heredoc bodies alone would shorten the case above and pass it;
    // this prefix is shell, not a body, so only reading past char 500 does.
    commit(ws, 'o.js', 'feat: after a long printf', ['-q']);
    const cmd = `printf '%s' '${LONG_BODY}' >/dev/null && git add o.js && git commit -q -m 'feat: after a long printf'`;
    assert.ok(cmd.indexOf('git commit') > 500);
    const recs = fire(ws, cmd, '');
    assert.equal(commits(recs).length, 1);
    assert.equal(last(recs).commit_type, 'feature');
  } finally { fs.rmSync(ws.dir, { recursive: true, force: true }); }
});

test('a commit after `cat > <scratch path> <<EOF` is recorded', () => {
  const ws = makeWorkspace();
  try {
    commit(ws, 'p.js', 'fix(turbo): let status report a stale index', ['-q']);
    const heredoc = `cat > ${SCRATCH_MSG} <<'EOF'\nfix(turbo): let status report a stale index\nEOF`;
    // Without the commit the command must be noise: proof that the path is
    // filtered from the writes, so nothing but the commit can keep this row.
    assert.equal(fire(ws, heredoc, '').length, 0, 'the scratch write must be filtered');
    const recs = fire(ws, `${heredoc}\ngit add p.js && git commit -q -F ${SCRATCH_MSG}`, '');
    assert.equal(commits(recs).length, 1, 'a leading cat dropped the commit as noise');
    assert.match(last(recs).summary, /let status report a stale index/);
  } finally { fs.rmSync(ws.dir, { recursive: true, force: true }); }
});

test('a commit fed through a pipe from cat is recorded', () => {
  const ws = makeWorkspace();
  try {
    // One segment starting with `cat`: the per-segment verdict alone calls it
    // noise, so a detected commit has to outrank the filter.
    commit(ws, 'q.js', 'docs: piped message', ['-q']);
    const recs = fire(ws, `cat ${SCRATCH_MSG} | git commit -q -F -`, '');
    assert.equal(commits(recs).length, 1);
  } finally { fs.rmSync(ws.dir, { recursive: true, force: true }); }
});

test('git named inside a heredoc body is data, not a commit or a push', () => {
  const ws = makeWorkspace();
  try {
    // HEAD is fresh and unlogged, so the freshness guard would accept it: only
    // reading around the body keeps this edit from becoming a phantom commit.
    commit(ws, 'r.js', 'feat: fresh and unlogged', ['-q']);
    const cmd = `cat >> CHANGELOG.md <<'EOF'\n### fix(hooks)\n`
      + `Write the message, then git commit -F - and git push origin main.\nEOF`;
    const recs = fire(ws, cmd, '');
    assert.equal(recs.length, 1);
    assert.equal(last(recs).type, 'tool_file_edit', 'a heredoc edit was misread as git work');
    assert.match(last(recs).summary, /CHANGELOG\.md/);
  } finally { fs.rmSync(ws.dir, { recursive: true, force: true }); }
});

test('work after a leading cat or echo is logged', () => {
  const ws = makeWorkspace();
  try {
    for (const cmd of [
      `echo "=== run ==="; node --test tests/unit/x.test.js`,
      `cat package.json && npm test`,
      `cd ${ws.repo} && ls && node scripts/build.js`,
    ]) {
      const dev = fs.mkdtempSync(path.join(ws.dir, 'dev-'));
      const recs = fire({ ...ws, dev }, cmd);
      assert.equal(recs.length, 1, `dropped as noise: ${cmd}`);
      assert.equal(last(recs).type, 'tool_bash');
    }
  } finally { fs.rmSync(ws.dir, { recursive: true, force: true }); }
});

test('plain reads, and scratch or stdout heredocs, are still noise', () => {
  const ws = makeWorkspace();
  try {
    for (const cmd of [
      'cat src/app.js',
      'cat src/app.js | head -20',
      `echo "=== state ==="; ls -la; pwd`,
      `ls \\\n  -la`,
      `cat > ${SCRATCH_MSG} <<'EOF'\nnotes\nEOF`,
      // The body names a push; a heredoc to stdout runs nothing.
      `cat <<'EOF'\nNext: git push origin main\nEOF`,
    ]) {
      assert.equal(fire(ws, cmd).length, 0, `expected no event for: ${JSON.stringify(cmd)}`);
    }
  } finally { fs.rmSync(ws.dir, { recursive: true, force: true }); }
});

// ── cd hops ahead of the invocation, and what stdout may claim ───────────────
// The repo came from the payload cwd plus the invocation's own -C. Claude
// Code's payload cwd follows a `cd` the shell keeps, until one leaves the
// project and the harness resets it; Codex always reports the session's cwd.
// Either way `cd <repo> && git commit -q` from a non-repo resolved no repo,
// and with -q there was nothing to scrape, so the commit left no row.

const toolRows = (ws) => {
  const log = path.join(ws.dev, 'tool-use-log.jsonl');
  if (!fs.existsSync(log)) return [];
  return fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
};

/** A repo with an origin, so a commit URL built from the wrong repo shows. */
function makeRemoteRepo(ws, name) {
  const repo = makeRepo(ws, name);
  spawnSync('git', ['remote', 'add', 'origin', `git@github.com:x/${name}.git`], { cwd: repo });
  return repo;
}

/** Age HEAD past the freshness window, so only stdout can name a commit. */
function ageHead(repo) {
  const aged = spawnSync('git', [...AUTHOR, 'commit', '--amend', '--no-edit', '-q'],
    { cwd: repo, env: { ...process.env, GIT_COMMITTER_DATE: '2020-01-01T00:00:00' } });
  assert.equal(aged.status, 0, 'fixture must actually age HEAD');
}

test('cd <repo> && git commit -q from a non-repo cwd is recorded against that repo', () => {
  const ws = makeWorkspace();
  try {
    // Not the root commit: diff-tree lists no files for one without --root.
    commit(ws, 'seed.js', 'chore: seed', ['-q']);
    commit(ws, 's.js', 'fix(hooks): read the cd hop', ['-q']);
    assert.ok(!isRepo(ws.dev), 'the hook cwd must not be a repo');
    const cases = [
      `cd ${ws.repo} && git commit -q -m 'fix(hooks): read the cd hop'`,
      `cd ${ws.repo} && git commit -q -F - <<'EOF'\nfix(hooks): read the cd hop\nEOF`,
      `cd ${ws.repo}\ngit add s.js; git commit -q -m 'fix(hooks): read the cd hop'`,
    ];
    for (const cmd of cases) {
      const dev = fs.mkdtempSync(path.join(ws.dir, 'dev-'));
      // Quiet, so stdout names nothing: only the hop can supply the repo.
      const recs = fire({ ...ws, dev }, cmd, '', { cwd: dev });
      assert.equal(commits(recs).length, 1, `no git_commit row for: ${JSON.stringify(cmd)}`);
      assert.match(last(recs).summary, new RegExp(`Commit ${headOf(ws.repo)}: fix\\(hooks\\)`), cmd);
      assert.equal(last(recs).project, 'repo', cmd);
      assert.match(last(recs).summary, /\| files: s\.js$/, cmd);
    }
  } finally { fs.rmSync(ws.dir, { recursive: true, force: true }); }
});

test('a -C after a cd hop still names the repo, relative to the hop', () => {
  const ws = makeWorkspace();
  try {
    // repoA's HEAD is fresh and unlogged, so reading the hop's repo instead of
    // the one -C names would be accepted by the freshness guard.
    const repoA = makeRepo(ws, 'repo-a');
    commitIn(repoA, 'a.js', 'feat: bystander', ['-q']);
    commit(ws, 't.js', 'docs: named by -C', ['-q']);
    for (const cmd of [
      `cd ${repoA} && git -C ${ws.repo} commit -q -m 'docs: named by -C'`,
      `cd ${ws.dir} && git -C repo commit -q -m 'docs: named by -C'`,
    ]) {
      const dev = fs.mkdtempSync(path.join(ws.dir, 'dev-'));
      const recs = fire({ ...ws, dev }, cmd, '', { cwd: dev });
      assert.equal(commits(recs).length, 1, cmd);
      assert.match(last(recs).summary, new RegExp(`Commit ${headOf(ws.repo)}:`), cmd);
      assert.equal(last(recs).project, 'repo', cmd);
    }
  } finally { fs.rmSync(ws.dir, { recursive: true, force: true }); }
});

test('the last literal hop wins, and a relative hop reads from the one before', () => {
  const ws = makeWorkspace();
  try {
    const repoA = makeRepo(ws, 'repo-a');
    commitIn(repoA, 'a.js', 'feat: bystander', ['-q']);
    commit(ws, 'u.js', 'chore: last hop', ['-q']);
    const recs = fire(ws, `cd ${repoA} && cd ${ws.dir}; cd repo && git commit -q -m 'chore: last hop'`,
      '', { cwd: ws.dev });
    assert.equal(commits(recs).length, 1);
    assert.match(last(recs).summary, new RegExp(`Commit ${headOf(ws.repo)}:`));
    assert.equal(last(recs).project, 'repo');
  } finally { fs.rmSync(ws.dir, { recursive: true, force: true }); }
});

test('a relative hop the payload cwd already reflects does not double up', () => {
  const ws = makeWorkspace();
  try {
    // Claude Code reports the cwd AFTER the command, so `cd repo` arrives with
    // cwd already `…/repo`; read against it, the hop names `…/repo/repo`.
    commit(ws, 'v.js', 'fix: relative hop', ['-q']);
    assert.ok(!fs.existsSync(path.join(ws.repo, 'repo')), 'the doubled path must not exist');
    const recs = fire(ws, `cd repo && git commit -q -m 'fix: relative hop'`, '', { cwd: ws.repo });
    assert.equal(commits(recs).length, 1);
    assert.match(last(recs).summary, new RegExp(`Commit ${headOf(ws.repo)}:`));
  } finally { fs.rmSync(ws.dir, { recursive: true, force: true }); }
});

test('a hop inside a subshell does not move the commit', () => {
  const ws = makeWorkspace();
  try {
    const repoA = makeRepo(ws, 'repo-a');
    commitIn(repoA, 'a.js', 'feat: bystander', ['-q']);
    commit(ws, 'w.js', 'refactor: scoped hop', ['-q']);
    for (const [cmd, cwd] of [
      [`(cd ${repoA} && git status --short) && git commit -q -m 'refactor: scoped hop'`, ws.repo],
      [`R=$(cd ${repoA} && pwd); git commit -q -m 'refactor: scoped hop'`, ws.repo],
      // The other direction: a hop in the commit's own subshell does apply,
      // so a walker that never reads `(cd` as a hop cannot pass the cases above
      // by not seeing them.
      [`(cd ${ws.repo} && git commit -q -m 'refactor: scoped hop')`, ws.dev],
    ]) {
      const dev = fs.mkdtempSync(path.join(ws.dir, 'dev-'));
      const recs = fire({ ...ws, dev }, cmd, '', { cwd });
      assert.equal(commits(recs).length, 1, cmd);
      assert.match(last(recs).summary, new RegExp(`Commit ${headOf(ws.repo)}:`), cmd);
      assert.equal(last(recs).project, 'repo', cmd);
    }
  } finally { fs.rmSync(ws.dir, { recursive: true, force: true }); }
});

test('a hop to a variable path is left unresolved, not guessed', () => {
  const ws = makeWorkspace();
  try {
    // The variable names a repo with a fresh, unlogged HEAD, so evaluating it
    // would pass the freshness guard. The text never runs.
    commit(ws, 'x.js', 'feat: behind a variable', ['-q']);
    const cmd = `W=${ws.repo}; cd "$W" && git commit -q -m 'feat: behind a variable'`;
    const quiet = fire(ws, cmd, '', { cwd: ws.dev });
    assert.equal(commits(quiet).length, 0, 'a variable hop was evaluated');

    const dev = fs.mkdtempSync(path.join(ws.dir, 'dev-'));
    const out = `[main ${headOf(ws.repo).slice(0, 7)}] feat: behind a variable\n 1 file changed`;
    const recs = fire({ ...ws, dev }, cmd, out, { cwd: dev });
    assert.equal(commits(recs).length, 1, "git's own line must still record the commit");
    assert.equal(last(recs).project, path.basename(dev), 'project must stay cwd-derived');
    assert.doesNotMatch(last(recs).summary, /\| files:/);
  } finally { fs.rmSync(ws.dir, { recursive: true, force: true }); }
});

test('cd <repo> && git push from a non-repo cwd is attributed to that repo', () => {
  const ws = makeWorkspace();
  try {
    const recs = fire(ws, `cd ${ws.repo} && git push -u origin main`, '', { cwd: ws.dev });
    assert.equal(recs.length, 1);
    assert.equal(last(recs).type, 'git_push');
    assert.equal(last(recs).project, 'repo');
  } finally { fs.rmSync(ws.dir, { recursive: true, force: true }); }
});

test('only git\'s own summary line counts as a commit in stdout', () => {
  const ws = makeWorkspace();
  try {
    // A replay whose stdout printed the hook's own rows (evt-73n3wvkhriho),
    // prose with a hex run in it (`feedbac`), a session id, a worktree name.
    const cmd = `S=/scratch; cd "$S/repo" && git commit -q -m 'fix: via -C'`;
    for (const out of [
      '{"summary":"[fix] Commit 047c8396f15ac5262e191b9a4ae878443a973cfc: fix: via -C"}',
      'wrote feedback to the log',
      'rows 2 for session 979b81b0 git_commit 0',
      'HEAD is now in .claude/worktrees/agent-a4743f118b236c7e0',
    ]) {
      const dev = fs.mkdtempSync(path.join(ws.dir, 'dev-'));
      const recs = fire({ ...ws, dev }, cmd, out, { cwd: dev });
      assert.equal(commits(recs).length, 0, `phantom git_commit from stdout: ${out}`);
      assert.equal(last(recs).type, 'tool_bash', out);
    }
  } finally { fs.rmSync(ws.dir, { recursive: true, force: true }); }
});

test('git\'s own line still records a commit made where the hook cannot see', () => {
  const ws = makeWorkspace();
  try {
    // Codex runs a bare `git commit` with the repo as the command's workdir and
    // sends only {command} as tool_input: stdout is all there is.
    for (const [line, sha, subject] of [
      ['[main 1a2b3c4] feat: from a workdir', '1a2b3c4', 'feat: from a workdir'],
      ['[feat/x-y (root-commit) 5d6e7f8] chore: first', '5d6e7f8', 'chore: first'],
      ['[detached HEAD 9a8b7c6] fix: mid-rebase', '9a8b7c6', 'fix: mid-rebase'],
    ]) {
      const dev = fs.mkdtempSync(path.join(ws.dir, 'dev-'));
      const out = `${line}\n 1 file changed, 2 insertions(+)`;
      const recs = fire({ ...ws, dev }, `git commit -m '${subject}'`, out, { cwd: dev });
      assert.equal(commits(recs).length, 1, line);
      assert.equal(last(recs).summary.replace(/^\[\w+\] /, ''), `Commit ${sha}: ${subject}`, line);
    }
  } finally { fs.rmSync(ws.dir, { recursive: true, force: true }); }
});

test('a commit the resolved repo does not hold takes nothing from that repo', () => {
  const ws = makeWorkspace();
  try {
    // The session cwd is a repo, the commit ran in another one (a Codex
    // workdir): five session-cartographer commits were filed under histospire.
    const bystander = makeRemoteRepo(ws, 'bystander');
    commitIn(bystander, 'b.js', 'feat: bystander', ['-q']);
    ageHead(bystander);
    commit(ws, 'y.js', 'docs: made elsewhere', ['-q']);
    const sha = headOf(ws.repo);
    const out = `[main ${sha.slice(0, 7)}] docs: made elsewhere\n 1 file changed`;
    const recs = fire(ws, `git commit -m 'docs: made elsewhere'`, out, { cwd: bystander });
    assert.equal(commits(recs).length, 1);
    assert.match(last(recs).summary, new RegExp(`Commit ${sha.slice(0, 7)}: docs: made elsewhere$`));
    assert.equal(last(toolRows(ws)).commit_url, undefined, 'a URL built from the wrong repo');
  } finally { fs.rmSync(ws.dir, { recursive: true, force: true }); }
});

test('a fresh HEAD in the wrong repo does not stand in for the commit git printed', () => {
  const ws = makeWorkspace();
  try {
    // The bystander's HEAD is seconds old and unlogged, so freshness alone
    // accepts it; git's own line names a sha the bystander does not hold.
    const bystander = makeRemoteRepo(ws, 'bystander');
    commitIn(bystander, 'b.js', 'feat: bystander work', ['-q']);
    commit(ws, 'z.js', 'fix: the real one', ['-q']);
    const sha = headOf(ws.repo);
    const out = `[main ${sha.slice(0, 7)}] fix: the real one\n 1 file changed`;
    const recs = fire(ws, `git commit -m 'fix: the real one'`, out, { cwd: bystander });
    assert.equal(commits(recs).length, 1);
    assert.match(last(recs).summary, new RegExp(`Commit ${sha.slice(0, 7)}: fix: the real one$`));
    assert.doesNotMatch(last(recs).summary, /bystander/);
    assert.doesNotMatch(last(recs).summary, new RegExp(headOf(bystander).slice(0, 7)));
  } finally { fs.rmSync(ws.dir, { recursive: true, force: true }); }
});
