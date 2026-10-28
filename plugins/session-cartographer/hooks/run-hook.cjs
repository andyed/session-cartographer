/* Never ask Windows to open a .sh file. Always exec an explicit Bash binary. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn, execFile } = require('node:child_process');
const HOOKS = new Set(['check-edit-collision.sh', 'log-compact-summary.sh', 'log-research.sh',
  'log-session-milestones.sh', 'log-tool-use.sh', 'start-transcript-catch-up.sh',
  'surface-focus-on-start.sh', 'surface-turbo-on-start.sh', 'warn-missing-jq-on-start.sh']);
const MAX_ACTIVE = 8;
const COOLDOWN_MS = 30000;
function resolveBash(platform = process.platform, env = process.env, exists = fs.existsSync) {
  const candidates = platform === 'win32'
    ? [env.CARTOGRAPHER_BASH, ...[env.ProgramW6432, env.ProgramFiles, env['ProgramFiles(x86)'], 'C:/Program Files']
      .filter(Boolean).map(root => path.win32.join(root, 'Git', 'bin', 'bash.exe')),
      env.LOCALAPPDATA && path.win32.join(env.LOCALAPPDATA, 'Programs', 'Git', 'bin', 'bash.exe')]
    : [env.CARTOGRAPHER_BASH, '/bin/bash', '/usr/bin/bash'];
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const found = candidates.find(file => file && paths.isAbsolute(file) && exists(file));
  if (!found) throw new Error('Bash not found; install Git for Windows or set CARTOGRAPHER_BASH to its absolute executable path');
  return found;
}
function acquireSlot(dir, pid = process.pid, limit = MAX_ACTIVE) {
  fs.mkdirSync(dir, { recursive: true });
  for (let slot = 0; slot < limit; slot++) {
    const file = path.join(dir, slot + '.lock');
    try {
      const fd = fs.openSync(file, 'wx', 0o600);
      fs.writeFileSync(fd, String(pid));
      fs.closeSync(fd);
      return () => { try { fs.unlinkSync(file); } catch {} };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      // Reclaim dead owners only. An incomplete/live lock is never stolen.
      try {
        const owner = Number(fs.readFileSync(file, 'utf8'));
        if (Number.isInteger(owner) && owner > 0) {
          try { process.kill(owner, 0); } catch (e) {
            if (e.code === 'ESRCH') fs.unlinkSync(file);
          }
        }
      } catch {}
    }
  }
  return null; // No retry, queue, or unbounded fan-out.
}
function launchHook(script, { bash = resolveBash(), timeoutMs = 10000, env = process.env,
                             stdio = 'inherit', spawnImpl = spawn } = {}) {
  return new Promise(resolve => {
    const childEnv = { ...env, CARTOGRAPHER_HOOK_ACTIVE: '1' };
    delete childEnv.BASH_ENV; // Hook invocation must not run shell startup hooks.
    delete childEnv.ENV;
    const child = spawnImpl(bash, ['--noprofile', '--norc', script.replace(/\\/g, '/')], {
      shell: false, windowsHide: true, detached: process.platform !== 'win32',
      env: childEnv, stdio,
    });
    let finished = false, timingOut = false;
    const finish = result => { if (!finished) { finished = true; clearTimeout(timer); resolve(result); } };
    const timer = setTimeout(() => {
      timingOut = true;
      // Kill the exact child tree, not every Bash/Node process on the machine.
      if (process.platform === 'win32' && child.pid) {
        const taskkill = path.join(env.SystemRoot || 'C:/Windows', 'System32', 'taskkill.exe');
        execFile(taskkill, ['/PID', String(child.pid), '/T', '/F'],
          { windowsHide: true, shell: false, timeout: Math.min(3000, timeoutMs) }, error => {
            if (error) child.kill();
            finish({ code: 1, fault: 'hook timed out; child tree termination requested' });
          });
      } else {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill(); }
        finish({ code: 1, fault: 'hook timed out; child process group terminated' });
      }
    }, timeoutMs);
    child.once('error', error => finish({ code: 1, fault: 'cannot start Bash: ' + error.message }));
    child.once('exit', (code, signal) => {
      if (!timingOut) finish({ code: code > 255 ? 1 : (code ?? 1),
        fault: code > 255 ? 'Bash failed to initialize (status ' + code + ')' : signal ? 'Bash terminated: ' + signal : null });
    });
  });
}
async function main(args = process.argv.slice(2)) {
  if (process.env.CARTOGRAPHER_HOOK_ACTIVE === '1') return 0;
  const [name, budget = '10000'] = args;
  const timeoutMs = Number(budget);
  if (args.length > 2 || !HOOKS.has(name) || !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 10000) {
    process.stderr.write('[cartographer hook] Invalid hook name or timeout\n');
    return 1;
  }
  const state = path.join(os.tmpdir(), 'cartographer-hook-launcher-' + os.userInfo().username.replace(/[^a-z0-9_-]/gi, '_'));
  const breaker = path.join(state, 'failed-at');
  let release;
  try {
    try { if (Date.now() - Number(fs.readFileSync(breaker, 'utf8')) < COOLDOWN_MS) return 0; } catch {}
    release = acquireSlot(state);
    if (!release) { process.stderr.write('[cartographer hook] Concurrent hook limit reached; skipped\n'); return 0; }
    const result = await launchHook(path.join(__dirname, name), { timeoutMs });
    if (result.fault) {
      fs.writeFileSync(breaker, String(Date.now()));
      process.stderr.write('[cartographer hook] ' + result.fault + '; hooks paused for 30 seconds\n');
    }
    return result.code;
  } catch (error) {
    try { fs.writeFileSync(breaker, String(Date.now())); } catch {}
    process.stderr.write('[cartographer hook] ' + error.message + '; no retry\n');
    return 1;
  } finally { if (release) release(); }
}
module.exports = { resolveBash, acquireSlot, launchHook, main, HOOKS };
if (require.main === module) main().then(code => { process.exitCode = code; });
