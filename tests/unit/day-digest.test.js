/**
 * tests/unit/day-digest.test.js
 *
 * The day digest claims that every commit on it is in git. That claim fails
 * silently in four ways, and each assertion here fails against a digest that
 * quotes the log instead of asking git:
 *
 *   - an amended commit is logged under a sha no branch reaches; quoting the
 *     log lists a commit that does not exist, and a naive git check calls it
 *     "rewritten" and then counts its successor again as git-only;
 *   - a commit made in a plain terminal was never logged at all;
 *   - a rebase of last week's work carries today's committer date and would
 *     read as a day of new commits;
 *   - a hook false positive parses a sha out of test output.
 *
 * The fixture proves it exercises each one: it asserts the amended sha really
 * is unreachable and the rebased commit really is committed inside the day,
 * so a later edit that quietly defuses the fixture fails here too.
 *
 * Day bounds are local midnights. TZ is pinned so the boundary rows sit one
 * second either side of them, and one row carries a UTC offset.
 *
 * Run with: node --test tests/unit/day-digest.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = path.join(ROOT, 'scripts', 'session-digest.js');
const TZ = 'America/Los_Angeles';
const DAY = '2026-09-26'; // PDT: 2026-09-26T07:00:00Z → 2026-09-27T07:00:00Z
const ME = 'me@example.com';

function makeRepo(dir) {
  const run = (argv, env = {}) => execFileSync('git', argv, {
    cwd: dir, encoding: 'utf8', env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  fs.mkdirSync(dir, { recursive: true });
  run(['init', '-q', '-b', 'main']);
  run(['config', 'user.email', ME]);
  run(['config', 'user.name', 'Me']);
  run(['config', 'commit.gpgsign', 'false']);
  const commit = (subject, authored, committed, email = ME) => {
    fs.appendFileSync(path.join(dir, 'log.txt'), `${subject}\n`);
    run(['add', 'log.txt']);
    run(['commit', '-q', '-m', subject], {
      GIT_AUTHOR_DATE: authored, GIT_COMMITTER_DATE: committed || authored,
      GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_EMAIL: email,
    });
    return run(['rev-parse', 'HEAD']);
  };
  const a = commit('feat(core): logged and landed', '2026-09-26T10:00:00-07:00');
  const b = commit('fix(core): amended later', '2026-09-26T11:00:00-07:00');
  run(['commit', '-q', '--amend', '--no-edit'], { GIT_COMMITTER_DATE: '2026-09-26T11:30:00-07:00' });
  const b2 = run(['rev-parse', 'HEAD']);
  const c = commit('docs(core): made in a plain terminal', '2026-09-26T12:00:00-07:00');
  const d = commit('chore(core): rebased from last week', '2026-09-23T10:00:00-07:00', '2026-09-26T13:00:00-07:00');
  const other = commit("feat(core): someone else's", '2026-09-26T14:00:00-07:00', null, 'other@example.com');
  return { run, a, b, b2, c, d, other };
}

function fixture() {
  const dev = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'carto-day-')));
  const repoDir = path.join(dev, 'fixture');
  const repo = makeRepo(repoDir);
  const MISSING = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
  const base = { session_id: 's1', project: 'fixture', cwd: repoDir, provider: 'claude' };
  const commitRow = (id, ts, sha, subject) => ({
    ...base, event_id: id, timestamp: ts, type: 'git_commit', summary: `[feature] Commit ${sha}: ${subject}`,
  });
  const rowA = commitRow('evt-a', '2026-09-26T17:00:05Z', repo.a, 'feat(core): logged and landed');
  const rows = [
    { ...base, event_id: 'evt-before', timestamp: '2026-09-26T06:59:59Z', type: 'tool_bash', summary: 'ls' },
    { ...base, event_id: 'evt-open', timestamp: '2026-09-26T07:00:00Z', type: 'tool_bash', summary: 'ls' },
    rowA,
    rowA, // the same event twice: counted once, reported as a duplicate
    commitRow('evt-b', '2026-09-26T18:00:00Z', repo.b, 'fix(core): amended later'),
    commitRow('evt-m', '2026-09-26T18:30:00Z', MISSING, 'rows 2 git_commit 0'),
    { ...base, event_id: 'evt-offset', timestamp: '2026-09-26T23:59:59-07:00', type: 'tool_bash', summary: 'ls' },
    { ...base, event_id: 'evt-after', timestamp: '2026-09-27T07:00:00Z', type: 'tool_bash', summary: 'ls' },
    { ...base, event_id: 'evt-else', timestamp: '2026-09-26T19:00:00Z', project: 'elsewhere', session_id: 's2', type: 'tool_bash', summary: 'ls' },
    { ...base, event_id: 'evt-noproj', timestamp: '2026-09-26T19:05:00Z', project: 'unknown', type: 'tool_bash', summary: 'ls' },
    // Epoch stamps, milliseconds and seconds: no date string for a prefilter to find.
    { ...base, event_id: 'evt-epoch-ms', timestamp: Date.parse('2026-09-26T20:00:00Z'), type: 'tool_bash', summary: 'ls' },
    { ...base, event_id: 'evt-epoch-s', timestamp: Date.parse('2026-09-26T20:30:00Z') / 1000, type: 'tool_bash', summary: 'ls' },
  ];
  const changelog = path.join(dev, 'changelog.jsonl');
  fs.writeFileSync(changelog, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return { dev, changelog, repo, MISSING };
}

function digest(f, extra) {
  const env = { ...process.env, TZ, CARTOGRAPHER_DEV_DIR: f.dev, CARTOGRAPHER_CHANGELOG: f.changelog };
  for (const key of ['CLAUDE_SESSION_ID', 'CLAUDE_CODE_SESSION_ID', 'CODEX_SESSION_ID', 'CARTOGRAPHER_SESSION_ID']) delete env[key];
  return spawnSync('node', [SCRIPT, '--day', DAY, ...extra], { encoding: 'utf8', env });
}

const f = fixture();
test.after(() => fs.rmSync(f.dev, { recursive: true, force: true }));

test('the fixture exercises every failure it claims to', () => {
  // The amended sha exists but no ref reaches it.
  assert.equal(f.repo.run(['cat-file', '-t', f.repo.b]), 'commit');
  assert.equal(f.repo.run(['for-each-ref', '--contains', f.repo.b, 'refs/heads']), '');
  // The rebased commit is committed inside the day, so only its author date keeps it out.
  const [at, ct] = f.repo.run(['log', '-1', '--format=%at %ct', f.repo.d]).split(' ').map(Number);
  assert.ok(ct * 1000 >= Date.parse('2026-09-26T07:00:00Z') && ct * 1000 < Date.parse('2026-09-27T07:00:00Z'));
  assert.ok(at * 1000 < Date.parse('2026-09-26T07:00:00Z'));
});

test('window, scope, and dedup are counted, not guessed', () => {
  const run = digest(f, ['--projects', 'fixture', '--json']);
  assert.equal(run.status, 0, run.stderr);
  const out = JSON.parse(run.stdout);
  assert.equal(out.schema, 'carto.day-digest/1');
  assert.equal(out.day, DAY);
  // evt-open, evt-a, evt-b, evt-m, evt-offset, both epoch rows; never evt-before or evt-after.
  assert.equal(out.totals.events, 7);
  assert.equal(out.duplicates_dropped, 1);
  assert.deepEqual(out.scope.out_of_scope, { events: 1, projects: 1 });
  assert.equal(out.unattributed.project, 1);
  // A report that names what it skipped is itself the disclosure.
  assert.ok(!run.stdout.includes('elsewhere'));
});

test('every logged commit is checked against git', () => {
  const out = JSON.parse(digest(f, ['--projects', 'fixture', '--json']).stdout);
  const p = out.projects.find((x) => x.name === 'fixture');
  const bySha = Object.fromEntries(p.commits.map((c) => [c.sha, c]));
  assert.equal(bySha[f.repo.a].status, 'landed');
  assert.equal(bySha[f.repo.b].status, 'landed', 'an amended commit landed under its new sha');
  assert.equal(bySha[f.repo.b].landed_as, f.repo.b2);
  assert.equal(bySha[f.MISSING].status, 'missing');
  // Git-only is the plain-terminal commit and nothing else: not the amend's
  // successor, not last week's rebase, not another author.
  assert.deepEqual(p.git_only_commits.map((c) => c.sha), [f.repo.c]);
  assert.equal(out.totals.commits_moved, 1);
  assert.equal(out.totals.commits_git_only, 1);
});

test('the receipt lists only what git has', () => {
  const run = digest(f, ['--projects', 'fixture', '--md']);
  assert.equal(run.status, 0, run.stderr);
  const md = run.stdout;
  assert.match(md, /3 commits across 1 project/);
  assert.ok(md.includes('feat(core): logged and landed'));
  assert.ok(md.includes(`fix(core): amended later \`${f.repo.b2.slice(0, 7)}\``), 'listed under the sha that landed');
  assert.ok(md.includes('docs(core): made in a plain terminal'));
  for (const absent of ['deadbee', 'rebased from last week', "someone else's", f.repo.b.slice(0, 7)]) {
    assert.ok(!md.includes(absent), `receipt claims ${absent}`);
  }
  assert.match(md, /1 logged commit not found in git/);
});

test('the panel header counts what the git line confirms', () => {
  const run = digest(f, ['--projects', 'fixture']);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /━━ fixture · 3 commits ·/);
  assert.match(run.stdout, /✗deadbee/, 'the false positive is shown for audit');
});

test('a DST day is as long as it was, and a bad day spec is refused', () => {
  const env = { ...process.env, TZ, CARTOGRAPHER_DEV_DIR: f.dev, CARTOGRAPHER_CHANGELOG: f.changelog };
  const fallBack = JSON.parse(spawnSync('node', [SCRIPT, '--day', '2026-11-01', '--json', '--no-git'], { encoding: 'utf8', env }).stdout);
  assert.equal(Date.parse(fallBack.end) - Date.parse(fallBack.start), 25 * 3600000);
  const bad = spawnSync('node', [SCRIPT, '--day', '2026-02-31'], { encoding: 'utf8', env });
  assert.equal(bad.status, 2);
});

test('a missing log is an outage, not a quiet day', () => {
  const env = { ...process.env, TZ, CARTOGRAPHER_DEV_DIR: f.dev, CARTOGRAPHER_CHANGELOG: path.join(f.dev, 'absent.jsonl') };
  const run = spawnSync('node', [SCRIPT, '--day', DAY], { encoding: 'utf8', env });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /outage, not a quiet day/);
});
