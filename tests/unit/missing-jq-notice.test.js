import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// The hooks degrade silently without jq by design: a missing dependency must
// never block a tool call. warn-missing-jq-on-start.sh is the one hook that
// says so, once per session start, and the capture hooks must stay quiet
// rather than erroring on every turn. jq cannot be shadowed for this test,
// `command -v` finds the next one down the PATH, so the hooks run under a
// PATH with no jq on it at all, built per platform below.

const ROOT = path.resolve(import.meta.dirname, '../..');
const HOOKS = path.join(ROOT, 'plugins/session-cartographer/hooks');
const WIN = process.platform === 'win32';
const PATH_KEY = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
const PATH_DIRS = (process.env[PATH_KEY] ?? '').split(path.delimiter).filter(Boolean);
const TRANSCRIPT = '/Users/test/.claude/projects/-Users-test-nojq/nojq.jsonl';

function sh(script, env = process.env) {
  return spawnSync('bash', ['-c', script], { encoding: 'utf8', env });
}

// bash by absolute path, so it still starts once PATH has lost directories.
const BASH = (() => {
  const r = sh(WIN ? 'cygpath -m "$(command -v bash)"' : 'command -v bash');
  return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : 'bash';
})();
const HAVE_JQ = sh('command -v jq >/dev/null 2>&1').status === 0;

function holdsJq(dir) {
  return (WIN ? ['jq.exe', 'jq', 'jq.cmd', 'jq.bat'] : ['jq'])
    .some((name) => fs.existsSync(path.join(dir, name)));
}

// A PATH with no jq. On Windows jq lives in a directory of its own (winget
// Links, chocolatey bin), so dropping the directories that hold it keeps Git
// Bash's coreutils. On a merged-/usr Linux it shares /usr/bin with cat and
// git, so there one directory of symlinks to everything on PATH except jq
// stands in for the whole PATH; the first directory to supply a name wins,
// which preserves PATH precedence.
function pathWithoutJq(tmp) {
  if (WIN) return PATH_DIRS.filter((dir) => !holdsJq(dir)).join(path.delimiter);
  const bin = path.join(tmp, 'bin');
  fs.mkdirSync(bin);
  for (const dir of PATH_DIRS) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const name of names) {
      if (name === 'jq') continue;
      try { fs.symlinkSync(path.join(dir, name), path.join(bin, name)); } catch { /* first wins */ }
    }
  }
  return bin;
}

function runHook(name, { input = '', args = [], env = {} } = {}) {
  return spawnSync(BASH, [path.join(HOOKS, name), ...args], {
    cwd: ROOT, input, encoding: 'utf8', env: { ...process.env, ...env },
  });
}

// Runs fn with an env whose PATH holds no jq and a throwaway corpus dir, or
// skips the test when such a PATH cannot be built here.
function withoutJq(t, fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-nojq-'));
  try {
    const dev = path.join(tmp, 'dev');
    fs.mkdirSync(dev);
    const env = { ...process.env, [PATH_KEY]: pathWithoutJq(tmp), CARTOGRAPHER_DEV_DIR: dev };
    const probe = spawnSync(BASH, ['-c', 'command -v jq'], { encoding: 'utf8', env });
    if (probe.status === 0) { t.skip(`could not build a PATH without jq (found ${probe.stdout.trim()})`); return; }
    fn(env, dev);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

const START = JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup', session_id: 'nojq', transcript_path: TRANSCRIPT, cwd: ROOT });

test('session start without jq prints one notice naming the install commands', (t) => {
  withoutJq(t, (env) => {
    const r = runHook('warn-missing-jq-on-start.sh', { input: START, env });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stderr, '');
    const lines = r.stdout.trim().split('\n');
    assert.equal(lines.length, 1, `one line expected, got: ${r.stdout}`);
    const out = JSON.parse(lines[0]);
    assert.match(out.systemMessage, /^session-cartographer: jq not found\./);
    assert.match(out.systemMessage, /will not capture anything/);
    for (const cmd of ['winget install jqlang.jq', 'brew install jq', 'apt install jq']) {
      assert.ok(out.systemMessage.includes(cmd), `notice should name: ${cmd}`);
    }
    assert.equal(out.hookSpecificOutput.hookEventName, 'SessionStart');
    assert.equal(out.hookSpecificOutput.additionalContext, out.systemMessage);
  });
});

test('session start with jq present prints nothing', (t) => {
  if (!HAVE_JQ) { t.skip('jq is not installed here'); return; }
  const r = runHook('warn-missing-jq-on-start.sh', { input: START });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '');
  assert.equal(r.stderr, '');
});

test('the notice is registered once per session start in both hook configs', () => {
  for (const file of ['hooks.json', 'codex-hooks.json']) {
    const config = JSON.parse(fs.readFileSync(path.join(HOOKS, file), 'utf8'));
    const groups = config.hooks.SessionStart.filter((g) =>
      JSON.stringify(g.hooks).includes('warn-missing-jq-on-start.sh'));
    assert.equal(groups.length, 1, `${file}: one SessionStart group should carry the notice`);
    assert.equal(groups[0].matcher, 'startup|resume|clear', `${file}: not on compact`);
    const hits = groups[0].hooks.filter((h) => h.command.endsWith('/hooks/warn-missing-jq-on-start.sh'));
    assert.equal(hits.length, 1, `${file}: registered once`);
    for (const event of Object.keys(config.hooks)) {
      if (event === 'SessionStart') continue;
      assert.doesNotMatch(JSON.stringify(config.hooks[event]), /warn-missing-jq/, `${file}: ${event} must not carry the notice`);
    }
  }
});

// Payloads that would each write a row with jq present.
const CAPTURE_HOOKS = [
  ['log-session-milestones.sh', {
    input: JSON.stringify({ hook_event_name: 'SessionEnd', reason: 'exit', session_id: 'nojq', transcript_path: TRANSCRIPT, cwd: ROOT }),
  }],
  ['log-tool-use.sh', {
    input: JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'Bash', session_id: 'nojq', transcript_path: TRANSCRIPT, cwd: ROOT, tool_use_id: 'toolu_nojq', tool_input: { command: 'echo hi' }, tool_response: { stdout: 'hi' } }),
    env: { CARTOGRAPHER_LOG_TOOL_USE: 'true' },
  }],
  ['log-research.sh', {
    input: JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'WebFetch', session_id: 'nojq', transcript_path: TRANSCRIPT, cwd: ROOT, tool_input: { url: 'https://example.com/paper', prompt: 'summarize' }, tool_response: 'ok' }),
  }],
  ['log-compact-summary.sh', {
    input: JSON.stringify({ hook_event_name: 'PostCompact', trigger: 'auto', session_id: 'nojq', transcript_path: TRANSCRIPT, cwd: ROOT, compact_summary: 'A summary that would otherwise be logged.' }),
  }],
  ['log-knowledge-gap.sh', {
    args: ['--query', 'phantom entity', '--entities', 'evt-nojq000000'],
  }],
];

for (const [hook, opts] of CAPTURE_HOOKS) {
  test(`${hook} without jq exits 0, prints nothing, writes nothing`, (t) => {
    withoutJq(t, (env, dev) => {
      const r = runHook(hook, { ...opts, env: { ...env, ...(opts.env ?? {}) } });
      assert.equal(r.status, 0, `exit ${r.status}: ${r.stderr}`);
      assert.equal(r.stdout, '');
      assert.equal(r.stderr, '');
      assert.deepEqual(fs.readdirSync(dev), [], 'no row may be written without jq');
    });
  });
}
