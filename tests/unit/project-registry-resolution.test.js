/**
 * tests/unit/project-registry-resolution.test.js
 *
 * `project-registry.json` ships in a PUBLIC plugin carrying the maintainer's ten
 * aliases, so every adopter installs a description of someone else's machine.
 * The failure is silent: an alias the registry does not define falls through as
 * a literal project name rather than erroring, so `--project devtools` returns
 * zero results for a scope the caller believes they set. And the shipped
 * `frakbot` alias expands to `openclaw`, which this project treats as
 * deprecated archive material that is never a valid source.
 *
 * The fix is a user-level registry that REPLACES the shipped one. "Replaces" is
 * the load-bearing word and the reason for the second test below: merging the
 * layers would leave `frakbot -> openclaw` reachable in an adopter's install
 * forever, and an alias a user deliberately deleted would keep resolving.
 *
 * Two resolvers exist — bash for the shell consumers, JS for build-profile.js.
 * The last test asserts they agree, because two spellings of one rule is exactly
 * the divergence CLAUDE.md's sentinel rule forbids.
 *
 * Hermetic: CARTOGRAPHER_DEV_DIR and CARTOGRAPHER_CONFIG point at temp dirs and
 * the session-id chain is cleared, per CLAUDE.md — a harness that inherits a
 * live session id changes what the code under test does.
 *
 * Run with: node --test tests/unit/project-registry-resolution.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

for (const name of [
  'CARTOGRAPHER_SESSION_ID',
  'CLAUDE_SESSION_ID',
  'CLAUDE_CODE_SESSION_ID',
  'CODEX_SESSION_ID',
  'CARTOGRAPHER_PROJECT_REGISTRY',
  'CARTOGRAPHER_CONFIG',
]) delete process.env[name];

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SHELL_RESOLVER = path.join(ROOT, 'scripts', 'project-registry.sh');
const BOOTSTRAP = path.join(ROOT, 'scripts', 'bootstrap-project-registry.js');
const SHIPPED = path.join(ROOT, 'project-registry.json');

const {
  resolveProjectRegistryPath,
  expandProjectAlias,
  userRegistryPath,
  ProjectRegistryError,
} = await import('../../scripts/project-registry.js');

const FIXTURE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-registry-'));
process.on('exit', () => { try { fs.rmSync(FIXTURE_DIR, { recursive: true, force: true }); } catch {} });

let caseCounter = 0;
/** An isolated HOME/config/dev triple, plus the env that points every resolver at it. */
function workspace() {
  caseCounter += 1;
  const dir = path.join(FIXTURE_DIR, `case-${caseCounter}`);
  const configDir = path.join(dir, 'config');
  const devDir = path.join(dir, 'dev');
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(devDir, { recursive: true });
  return {
    dir,
    configDir,
    devDir,
    userRegistry: path.join(configDir, 'project-registry.json'),
    env: {
      ...process.env,
      HOME: dir,
      XDG_CONFIG_HOME: path.join(dir, 'xdg'),
      CARTOGRAPHER_CONFIG: path.join(configDir, 'config.json'),
      CARTOGRAPHER_DEV_DIR: devDir,
      CARTOGRAPHER_SESSION_ID: '',
      CLAUDE_SESSION_ID: '',
      CLAUDE_CODE_SESSION_ID: '',
      CODEX_SESSION_ID: '',
    },
  };
}

/** Strip the emptied session vars — bash `set -u` is fine with them, but they must not read as set. */
function shellEnv(env) {
  const out = { ...env };
  for (const k of ['CARTOGRAPHER_SESSION_ID', 'CLAUDE_SESSION_ID', 'CLAUDE_CODE_SESSION_ID', 'CODEX_SESSION_ID']) {
    delete out[k];
  }
  return out;
}

const sh = (env, ...args) =>
  spawnSync('bash', [SHELL_RESOLVER, ...args], { encoding: 'utf8', env: shellEnv(env) });

const writeRegistry = (file, aliases) =>
  fs.writeFileSync(file, `${JSON.stringify({ aliases }, null, 2)}\n`);

// --------------------------------------------------------------------------
// resolution order
// --------------------------------------------------------------------------

test('an explicit CARTOGRAPHER_PROJECT_REGISTRY outranks both the user and shipped registries', () => {
  const w = workspace();
  writeRegistry(w.userRegistry, { devtools: ['user-one'] });
  const explicit = path.join(w.dir, 'explicit-registry.json');
  writeRegistry(explicit, { devtools: ['explicit-one'] });
  const env = { ...w.env, CARTOGRAPHER_PROJECT_REGISTRY: explicit };

  assert.equal(resolveProjectRegistryPath(env), explicit);
  assert.deepEqual(expandProjectAlias('devtools', env), ['explicit-one']);
  assert.equal(sh(env, '--path').stdout.trim(), explicit);
  assert.equal(sh(env, '--expand', 'devtools').stdout.trim(), 'explicit-one');
});

test('an explicit path that does not exist is an error, not a fallback', () => {
  // The caller named a file. Quietly answering from a different one is exactly
  // the silent-wrong-scope failure this whole layer removes.
  const w = workspace();
  const env = { ...w.env, CARTOGRAPHER_PROJECT_REGISTRY: path.join(w.dir, 'nope.json') };
  assert.throws(() => resolveProjectRegistryPath(env), ProjectRegistryError);
  const r = sh(env, '--path');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /does not exist/);
  assert.equal(r.stdout.trim(), '');
});

test('a user registry REPLACES the shipped one — shipped-only aliases stop resolving', () => {
  const w = workspace();
  // `frakbot` exists only in the maintainer's shipped registry and expands to
  // `openclaw`, deprecated archive material. If the layers merged, it would stay
  // reachable in every adopter install forever.
  const shipped = JSON.parse(fs.readFileSync(SHIPPED, 'utf8'));
  assert.ok(Array.isArray(shipped.aliases.frakbot), 'shipped registry no longer defines frakbot');
  assert.ok(shipped.aliases.frakbot.includes('openclaw'), 'shipped frakbot no longer names openclaw');

  writeRegistry(w.userRegistry, { mystuff: ['alpha', 'beta'] });

  assert.equal(resolveProjectRegistryPath(w.env), w.userRegistry);
  assert.deepEqual(expandProjectAlias('mystuff', w.env), ['alpha', 'beta']);
  // Not merged: the shipped alias is now an unknown name, which passes through
  // as a literal rather than expanding to the maintainer's repos.
  assert.deepEqual(expandProjectAlias('frakbot', w.env), ['frakbot']);
  assert.deepEqual(expandProjectAlias('psychodeli', w.env), ['psychodeli']);
  assert.equal(sh(w.env, '--expand', 'frakbot').stdout.trim(), 'frakbot');
  assert.equal(sh(w.env, '--aliases').stdout.trim(), 'mystuff');
});

test('no user registry falls back to the shipped default', () => {
  const w = workspace();
  assert.equal(fs.existsSync(w.userRegistry), false);
  assert.equal(resolveProjectRegistryPath(w.env), SHIPPED);
  assert.deepEqual(expandProjectAlias('devtools', w.env), [
    'session-cartographer', 'claude-code-session-bridge', 'claude-code-history-viewer',
  ]);
  assert.equal(sh(w.env, '--path').stdout.trim(), SHIPPED);
});

test('a malformed user registry is a loud error, not a silent fallback to the maintainer aliases', () => {
  const w = workspace();
  fs.writeFileSync(w.userRegistry, '{ "aliases": [ this is not json\n');

  assert.throws(() => resolveProjectRegistryPath(w.env), ProjectRegistryError);
  // The specific regression guarded: resolving to SHIPPED here would answer an
  // adopter's query with the maintainer's aliases and never say so.
  try {
    resolveProjectRegistryPath(w.env);
    assert.fail('malformed registry resolved instead of throwing');
  } catch (error) {
    assert.match(error.message, /project-registry/);
    assert.ok(!error.message.includes(SHIPPED), 'error should name the broken file, not the shipped one');
  }

  const r = sh(w.env, '--path');
  assert.notEqual(r.status, 0);
  assert.equal(r.stdout.trim(), '');
});

test('a user registry with a non-object "aliases" is rejected the same way', () => {
  const w = workspace();
  fs.writeFileSync(w.userRegistry, `${JSON.stringify({ aliases: ['devtools'] })}\n`);
  assert.throws(() => resolveProjectRegistryPath(w.env), ProjectRegistryError);
  assert.notEqual(sh(w.env, '--path').status, 0);
});

test('the bash and JS resolvers agree on every layer', () => {
  // Two implementations of one rule is the divergence CLAUDE.md forbids; this
  // is the tripwire that makes changing only one of them fail.
  const w = workspace();
  const cases = [];
  cases.push(['no user registry', { ...w.env }]);
  writeRegistry(w.userRegistry, { fam: ['one', 'two'] });
  cases.push(['user registry', { ...w.env }]);
  const explicit = path.join(w.dir, 'explicit.json');
  writeRegistry(explicit, { fam: ['three'] });
  cases.push(['explicit path', { ...w.env, CARTOGRAPHER_PROJECT_REGISTRY: explicit }]);

  for (const [label, env] of cases) {
    assert.equal(sh(env, '--path').stdout.trim(), resolveProjectRegistryPath(env), label);
    assert.equal(
      sh(env, '--expand', 'fam').stdout.trim().split('\n').filter(Boolean).join(','),
      expandProjectAlias('fam', env).join(','),
      label,
    );
  }
});

test('userRegistryPath follows the config-dir convention turbo-common.js already uses', () => {
  const w = workspace();
  assert.equal(userRegistryPath(w.env), w.userRegistry);
  assert.equal(sh(w.env, '--user-path').stdout.trim(), w.userRegistry);
  // Without CARTOGRAPHER_CONFIG it falls to $XDG_CONFIG_HOME/session-cartographer.
  const { CARTOGRAPHER_CONFIG, ...bare } = w.env;
  const expected = path.join(bare.XDG_CONFIG_HOME, 'session-cartographer', 'project-registry.json');
  assert.equal(userRegistryPath(bare), expected);
  assert.equal(sh(bare, '--user-path').stdout.trim(), expected);
});

// --------------------------------------------------------------------------
// bootstrap
// --------------------------------------------------------------------------

function seedLogs(devDir, projects) {
  const rows = [];
  let n = 0;
  for (const [project, count] of Object.entries(projects)) {
    for (let i = 0; i < count; i += 1) {
      n += 1;
      rows.push({
        event_id: `evt-${n}`,
        timestamp: '2026-09-01T12:00:00Z',
        project,
        type: 'tool_bash',
        summary: `work in ${project}`,
      });
    }
  }
  fs.writeFileSync(
    path.join(devDir, 'changelog.jsonl'),
    `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`,
  );
}

const bootstrap = (env, ...args) =>
  spawnSync('node', [BOOTSTRAP, ...args], { encoding: 'utf8', env: shellEnv(env) });

test('bootstrap refuses to overwrite an existing user registry without --force', () => {
  const w = workspace();
  seedLogs(w.devDir, { 'alpha-web': 5, 'alpha-cli': 5 });
  const hand = { aliases: { handwritten: ['kept'] } };
  fs.writeFileSync(w.userRegistry, `${JSON.stringify(hand, null, 2)}\n`);

  const refused = bootstrap(w.env);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /Refusing to overwrite/);
  assert.deepEqual(JSON.parse(fs.readFileSync(w.userRegistry, 'utf8')), hand);

  const forced = bootstrap(w.env, '--force');
  assert.equal(forced.status, 0, forced.stderr);
  const written = JSON.parse(fs.readFileSync(w.userRegistry, 'utf8'));
  assert.deepEqual(Object.keys(written.aliases), ['alpha']);
  assert.deepEqual([...written.aliases.alpha].sort(), ['alpha-cli', 'alpha-web']);
});

test('bootstrap --dry-run writes nothing', () => {
  const w = workspace();
  seedLogs(w.devDir, { 'alpha-web': 2, 'alpha-cli': 2 });
  const r = bootstrap(w.env, '--dry-run');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /would write/);
  assert.equal(fs.existsSync(w.userRegistry), false);
});

test('bootstrap excludes auto-named worktrees, the workspace root, and the home basename', () => {
  const w = workspace();
  // `dev` is the workspace-root basename and `brave-thompson-40e495` is a
  // Docker-style agent worktree: both are cwd-derived non-projects that owned
  // real event counts in the live corpus (42,511 and 382 respectively).
  seedLogs(w.devDir, {
    'brave-thompson-40e495': 40,
    'agent-a4b1610b7457c11f': 20,
    dev: 90,
    [path.basename(w.dir)]: 30,
    repo: 15,
    dist: 15,
    'alpha-web': 5,
    'alpha-cli': 5,
    // A real name that a hex-only worktree rule would have eaten: every letter
    // of "decade" is a hex digit. It must survive.
    'my-app-decade': 4,
  });
  const r = bootstrap(w.env, '--force');
  assert.equal(r.status, 0, r.stderr);
  const written = JSON.parse(fs.readFileSync(w.userRegistry, 'utf8'));
  const members = Object.values(written.aliases).flat();

  for (const junk of ['brave-thompson-40e495', 'agent-a4b1610b7457c11f', 'dev', path.basename(w.dir), 'repo', 'dist']) {
    assert.ok(!members.includes(junk), `${junk} leaked into the inferred registry`);
    assert.ok(!Object.keys(written.aliases).includes(junk), `${junk} became an alias key`);
  }
  assert.deepEqual([...written.aliases.alpha].sort(), ['alpha-cli', 'alpha-web']);
  assert.match(r.stdout, /my-app-decade/);
});

test('bootstrap emits no single-member aliases', () => {
  // A one-member alias resolves to exactly what the literal already resolved to
  // and adds a name to learn.
  const w = workspace();
  seedLogs(w.devDir, { solo: 10, 'pair-a': 3, 'pair-b': 3 });
  const r = bootstrap(w.env, '--force');
  assert.equal(r.status, 0, r.stderr);
  const written = JSON.parse(fs.readFileSync(w.userRegistry, 'utf8'));
  for (const [alias, members] of Object.entries(written.aliases)) {
    assert.ok(members.length >= 2, `${alias} is a single-member alias`);
  }
  assert.ok(!('solo' in written.aliases));
  assert.match(r.stdout, /Left ungrouped/);
});

test('the bootstrapped registry is immediately resolvable by both resolvers', () => {
  const w = workspace();
  seedLogs(w.devDir, { 'alpha-web': 5, 'alpha-cli': 5 });
  assert.equal(bootstrap(w.env, '--force').status, 0);
  assert.equal(resolveProjectRegistryPath(w.env), w.userRegistry);
  assert.deepEqual([...expandProjectAlias('alpha', w.env)].sort(), ['alpha-cli', 'alpha-web']);
  assert.equal(sh(w.env, '--path').stdout.trim(), w.userRegistry);
});
