import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../../scripts/backfill-git-history.sh', import.meta.url));
const AUTHORS = ['Ada Lovelace', 'Ada Stranger', 'Other Lovelace', 'Grace Hopper', 'Claude'];
let fixture;
let env;

before(() => {
  fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-git-owners-'));
  env = { ...process.env };
  // Neither the real checkout nor the developer's Git configuration should
  // determine which authors the fixture admits or execute a commit hook.
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
  Object.assign(env, {
    GIT_CONFIG_GLOBAL: path.join(fixture, 'gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
    CARTOGRAPHER_DEV_DIR: fixture,
    CARTOGRAPHER_PROFILE_AUTHORS: 'Ada Lovelace',
  });
  fs.writeFileSync(env.GIT_CONFIG_GLOBAL, '[user]\nname = Ada Lovelace\nemail = fixture@example.invalid\n');
  const repo = path.join(fixture, 'project');
  function git(args) {
    const result = spawnSync('git', args, { cwd: fixture, env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  }
  git(['-c', 'init.templateDir=', 'init', '-q', repo]);
  for (const [index, author] of AUTHORS.entries()) {
    git(['-C', repo, '-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '--allow-empty',
      '--no-gpg-sign', '--author', `${author} <author${index}@example.invalid>`, '-m', `author-${index}`]);
  }
  assert.equal(Number(git(['-C', repo, 'rev-list', '--count', 'HEAD']).trim()), AUTHORS.length,
    'the fixture includes both partial-name collisions and independent contributors');
});

after(() => fs.rmSync(fixture, { recursive: true, force: true }));

function run(args = [], overrides = {}) {
  const result = spawnSync('bash', [SCRIPT, '--project', 'project', '--dry-run', '--no-files', ...args], {
    cwd: fixture,
    env: { ...env, ...overrides },
    encoding: 'utf8',
    timeout: 15_000,
  });
  assert.ifError(result.error);
  assert.equal(fs.existsSync(path.join(fixture, 'changelog.jsonl')), false,
    'every invocation is a dry run and must leave the corpus untouched');
  return result;
}

function assertAuthors(result, authors) {
  assert.equal(result.status, 0, result.stderr);
  const selected = [...result.stdout.matchAll(/Commit [a-f0-9]{7}: author-(\d+)/g)]
    .map((match) => AUTHORS[Number(match[1])]).sort();
  assert.deepEqual(selected, [...authors].sort());
  assert.match(result.stdout, new RegExp(`Done\\. ${authors.length} commits backfilled, 0 already existed\\.`));
}

test('default ownership keeps full names intact and includes configured agent authors', () => {
  assertAuthors(run(), ['Ada Lovelace', 'Claude']);
});

test('multiple configured owners do not admit contributors sharing only one name', () => {
  assertAuthors(run([], { CARTOGRAPHER_PROFILE_AUTHORS: ' Ada Lovelace, Grace Hopper ' }),
    ['Ada Lovelace', 'Grace Hopper', 'Claude']);
});

test('explicit author overrides the configured owner list with one full name', () => {
  assertAuthors(run(['--author', 'Ada Lovelace']), ['Ada Lovelace']);
});

test('explicit comma-separated owners trim whitespace and ignore empty entries', () => {
  assertAuthors(run(['--author', ', \tAda Lovelace , , Grace Hopper\t,']), ['Ada Lovelace', 'Grace Hopper']);
});

test('author patterns preserve Git regex matching without shell word splitting', () => {
  assertAuthors(run(['--author', '^Ada L.*']), ['Ada Lovelace']);
});

test('an explicit empty owner list fails closed instead of importing every contributor or falling back', () => {
  for (const value of ['', ' \t ', ', ,\t,']) {
    const result = run(['--author', value]);
    assert.equal(result.status, 2, `empty override ${JSON.stringify(value)} must be refused: ${result.stdout}`);
    assert.match(result.stderr, /author|owner/);
    assert.doesNotMatch(result.stdout, /Commit [a-f0-9]/);
  }
});

test('--author without a value exits with a usage error', () => {
  const result = run(['--author']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--author requires/);
});

test('--all-authors deliberately admits every contributor despite configured or explicit owners', () => {
  assertAuthors(run(['--all-authors']), AUTHORS);
  assertAuthors(run(['--author', 'Ada Lovelace', '--all-authors']), AUTHORS);
});

test('Git global identity still supplies the owner when the configured override is absent', () => {
  assertAuthors(run([], { CARTOGRAPHER_PROFILE_AUTHORS: '' }), ['Ada Lovelace', 'Claude']);
});
