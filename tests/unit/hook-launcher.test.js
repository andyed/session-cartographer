import test from 'node:test';
import { OFFLINE_INDEX_ENV } from './helpers/offline-index.js';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const HOOK_DIR = path.join(ROOT, 'plugins/session-cartographer/hooks');
const LAUNCHER = path.join(HOOK_DIR, 'run-hook.cjs');
const { resolveBash, acquireSlot, launchHook, HOOKS } = require(LAUNCHER);
function scratch(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carto hooks spaces é-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
test('both providers explicitly launch Node for every hook, including archive/SessionEnd', () => {
  for (const file of ['hooks.json', 'codex-hooks.json']) {
    const config = JSON.parse(fs.readFileSync(path.join(HOOK_DIR, file), 'utf8'));
    assert.ok(config.hooks.SessionEnd);
    for (const [event, groups] of Object.entries(config.hooks)) for (const group of groups) for (const hook of group.hooks) {
      assert.match(hook.command, /^node "\$\{CLAUDE_PLUGIN_ROOT\}\/hooks\/run-hook\.cjs" [a-z-]+\.sh \d+$/);
      assert.ok(HOOKS.has(hook.command.split(' ').at(-2)), 'every registered hook must be allowed by the launcher');
      const budget = Number(hook.command.split(' ').at(-1));
      if (event === 'SessionEnd') {
        assert.equal(hook.timeout, 3, 'Codex caps SessionEnd at three seconds');
        assert.equal(budget, 1000, 'leave time for child cleanup and runtime startup');
      } else assert.ok(hook.timeout >= budget / 1000 + 5, 'host gives launcher time to kill its child tree');
    }
  }
});
test('Windows resolves an explicit executable and never falls through to a .sh association', () => {
  const bash = 'C:\\Program Files\\Git\\bin\\bash.exe';
  assert.equal(resolveBash('win32', { ProgramFiles: 'C:\\Program Files' }, p => p === bash), bash);
  assert.throws(() => resolveBash('win32', {}, () => false), /Bash not found/);
});
test('spawn is hidden, shell-free, preserves one script argument, and passes exit status', async () => {
  let observed;
  const result = await launchHook('C:\\space dir\\é\\event.sh', { bash: 'C:\\Git\\bash.exe',
    env: { BASH_ENV: 'unwanted-startup.sh' }, spawnImpl: (exe, args, opts) => {
      observed = { exe, args, opts };
      const child = new EventEmitter();
      queueMicrotask(() => child.emit('exit', 7, null));
      return child;
    } });
  assert.equal(result.code, 7);
  assert.equal(observed.exe, 'C:\\Git\\bash.exe');
  assert.deepEqual(observed.args, ['--noprofile', '--norc', 'C:/space dir/é/event.sh']);
  assert.equal(observed.opts.shell, false);
  assert.equal(observed.opts.windowsHide, true);
  assert.equal(observed.opts.env.CARTOGRAPHER_HOOK_ACTIVE, '1');
  assert.equal(observed.opts.env.BASH_ENV, undefined);
});
test('finite shared slots cap concurrent hooks and release on completion', t => {
  const dir = scratch(t);
  const first = acquireSlot(dir, process.pid, 2), second = acquireSlot(dir, process.pid, 2);
  assert.ok(first && second);
  assert.equal(acquireSlot(dir, process.pid, 2), null);
  first(); second();
  assert.equal(fs.readdirSync(dir).length, 0);
});
test('nested hook launch is suppressed before resolving an interpreter', () => {
  const output = execFileSync(process.execPath, [LAUNCHER, 'invalid.sh'], {
    windowsHide: true, timeout: 3000, env: { ...process.env, CARTOGRAPHER_HOOK_ACTIVE: '1' }, encoding: 'utf8',
  });
  assert.equal(output, '');
});
test('Bash runs paths with spaces and Unicode and receives stdin unchanged', async t => {
  const dir = scratch(t), script = path.join(dir, 'event.sh');
  fs.writeFileSync(script, 'IFS= read -r payload\nprintf "%s\\n" "$payload"\nexit 7\n');
  let child, output = '';
  const result = await launchHook(script, { timeoutMs: 3000, stdio: ['pipe', 'pipe', 'pipe'],
    spawnImpl: (...args) => {
      child = spawn(...args);
      child.stdout.on('data', chunk => { output += chunk; });
      child.stdin.end('{"text":"spaces and é; $unchanged"}\n');
      return child;
    } });
  assert.equal(result.code, 7);
  assert.equal(output, '{"text":"spaces and é; $unchanged"}\n');
});
test('timeout terminates the launched process tree and returns without retry', async t => {
  const dir = scratch(t), script = path.join(dir, 'hang.sh'), pidFile = path.join(dir, 'child.pid');
  fs.writeFileSync(script, '"$CARTOGRAPHER_TEST_NODE" -e \'require("fs").writeFileSync(process.env.CARTOGRAPHER_TEST_PID, String(process.pid)); setInterval(()=>{},1000)\' &\nwait\n');
  const started = Date.now();
  const result = await launchHook(script, { timeoutMs: 1000, stdio: 'ignore', env: {
    ...process.env, CARTOGRAPHER_TEST_NODE: process.execPath.replace(/\\/g, '/'), CARTOGRAPHER_TEST_PID: pidFile,
  } });
  assert.match(result.fault, /timed out/);
  assert.ok(Date.now() - started < 2500, 'cleanup must fit inside the three-second SessionEnd cap');
  assert.ok(fs.existsSync(pidFile), 'fixture must actually start a descendant');
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  let alive = true;
  for (let i = 0; i < 20 && alive; i++) {
    try { process.kill(pid, 0); await new Promise(resolve => setTimeout(resolve, 50)); }
    catch (e) { if (e.code === 'ESRCH') alive = false; else throw e; }
  }
  assert.equal(alive, false, 'timed-out descendant must not remain running');
});

test('registered SessionEnd records an archive event through PowerShell on Windows', t => {
  const dir = scratch(t), plugin = path.join(dir, 'plugin'), hooks = path.join(plugin, 'hooks');
  fs.mkdirSync(hooks, { recursive: true });
  fs.mkdirSync(path.join(plugin, 'scripts'));
  for (const name of ['run-hook.cjs', 'common.sh', 'log-session-milestones.sh']) fs.copyFileSync(path.join(HOOK_DIR, name), path.join(hooks, name));
  fs.writeFileSync(path.join(plugin, 'scripts/index-event.sh'), '#!/bin/bash\nexit 0\n', { mode: 0o755 });
  const transcript = path.join(dir, 'archive.jsonl').replace(/\\/g, '/');
  fs.writeFileSync(transcript, '{"fixture":true}\n');
  const payload = JSON.stringify({ hook_event_name: 'SessionEnd', session_id: 'launcher-archive-fixture',
    turn_id: 'fixture-turn', reason: 'other', cwd: dir.replace(/\\/g, '/'), transcript_path: transcript });
  const config = JSON.parse(fs.readFileSync(path.join(HOOK_DIR, 'codex-hooks.json'), 'utf8'));
  const definition = config.hooks.SessionEnd[0].hooks[0].command;
  assert.match(definition, /^node "/, 'never execute an old bare-script command, even in a test');
  const command = definition.replaceAll('$' + '{CLAUDE_PLUGIN_ROOT}', plugin.replace(/\\/g, '/'));
  const env = { ...process.env, ...OFFLINE_INDEX_ENV, CARTOGRAPHER_ROOT: plugin.replace(/\\/g, '/'),
    CARTOGRAPHER_DEV_DIR: dir.replace(/\\/g, '/'), CARTOGRAPHER_HOOK_ACTIVE: '',
    CARTOGRAPHER_SEMANTIC: '0', CARTOGRAPHER_TURBO: '0', CARTOGRAPHER_AUTO_CATCHUP: '0' };
  for (const name of ['CLAUDE_SESSION_ID', 'CLAUDE_CODE_SESSION_ID', 'CODEX_SESSION_ID', 'CARTOGRAPHER_SESSION_ID']) delete env[name];
  const opts = { cwd: dir, env, windowsHide: true, timeout: 12000, encoding: 'utf8' };
  if (process.platform === 'win32') {
    const ps = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
    execFileSync(ps, ['-NoProfile', '-NonInteractive', '-Command', "$OutputEncoding = [System.Text.UTF8Encoding]::new($false); '" + payload.replaceAll("'", "''") + "' | " + command + '; exit $LASTEXITCODE'], opts);
  } else execFileSync('/bin/sh', ['-c', command], { ...opts, input: payload });
  const milestone = JSON.parse(fs.readFileSync(path.join(dir, 'session-milestones.jsonl'), 'utf8').trim());
  const change = JSON.parse(fs.readFileSync(path.join(dir, 'changelog.jsonl'), 'utf8').trim());
  assert.equal(milestone.session_id, 'launcher-archive-fixture');
  assert.equal(milestone.event, 'SessionEnd');
  assert.equal(milestone.provider, 'codex');
  assert.equal(milestone.transcript_verified, true);
  assert.equal(change.type, 'milestone_session_end_other');
  assert.equal(change.event_id, milestone.event_id);
});

test('Windows initialization failure is a launcher fault, not a successful hook exit', async () => {
  const result = await launchHook('event.sh', { bash: 'C:/Git/bash.exe', spawnImpl: () => {
    const child = new EventEmitter();
    queueMicrotask(() => child.emit('exit', 3221225794, null));
    return child;
  } });
  assert.equal(result.code, 1);
  assert.match(result.fault, /failed to initialize/);
});
