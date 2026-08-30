#!/usr/bin/env node
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  effectiveTurboSettings,
  processIsAlive,
  readJson,
  readTurboConfig,
  turboPaths,
  updateTurboConfig,
  validateTurboUrl,
  writeJsonAtomic,
} from './turbo-common.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverScript = path.join(here, 'turbo-server.js');
const runtimeVersion = readJson(path.join(here, '..', 'package.json'), {}).version || 'unknown';

function usage() {
  console.error('Usage: cartographer-turbo.js enable|disable|start|stop|status|resolve [--url URL] [--timeout MS] [--no-start]');
}

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : '';
}

function managedServerRecord(env = process.env) {
  const paths = turboPaths(env);
  const record = readJson(paths.pid, null);
  const ready = readJson(paths.ready, null);
  const alive = Boolean(record && processIsAlive(Number(record.pid)));
  const compatible = Boolean(
    alive
    && ready
    && Number(ready.pid) === Number(record.pid)
    && ready.contract_version === 1
    && ready.runtime_version === runtimeVersion
    && typeof record.instance_token === 'string'
    && ready.instance_token === record.instance_token
  );
  return { paths, record, ready, alive, compatible };
}

async function waitForReady(pid, timeoutMs, env = process.env) {
  const paths = turboPaths(env);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ready = readJson(paths.ready, null);
    if (ready
        && Number(ready.pid) === pid
        && ready.contract_version === 1
        && ready.runtime_version === runtimeVersion) return ready;
    if (!processIsAlive(pid)) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return null;
}

async function ensureRunning(env = process.env) {
  const settings = effectiveTurboSettings(env);
  let current = managedServerRecord(env);
  if (current.compatible) return { started: false, pid: current.record.pid, ready: current.ready };

  if (current.alive) {
    if (!processLooksManaged(current.record, env)) {
      throw new Error(`pid ${current.record.pid} is alive but is not the managed Turbo server`);
    }
    await stopManaged(env);
    current = managedServerRecord(env);
  }

  fs.mkdirSync(current.paths.requests, { recursive: true, mode: 0o700 });
  for (const stale of [current.paths.pid, current.paths.ready]) {
    try { fs.unlinkSync(stale); } catch {}
  }

  const logFd = fs.openSync(current.paths.log, 'a', 0o600);
  const instanceToken = crypto.randomBytes(24).toString('hex');
  const child = spawn(process.execPath, [serverScript], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: {
      ...env,
      CARTOGRAPHER_TURBO_URL: settings.url,
      CARTOGRAPHER_TURBO_STATE_DIR: current.paths.state,
      CARTOGRAPHER_TURBO_INSTANCE_TOKEN: instanceToken,
    },
  });
  child.unref();
  fs.closeSync(logFd);

  writeJsonAtomic(current.paths.pid, {
    pid: child.pid,
    server_script: serverScript,
    started_at: new Date().toISOString(),
    url: settings.url,
    runtime_version: runtimeVersion,
    instance_token: instanceToken,
  });

  const ready = await waitForReady(child.pid, Math.max(5000, settings.timeoutMs), env);
  if (!ready) {
    throw new Error(`Turbo service did not become ready; see ${current.paths.log}`);
  }
  return { started: true, pid: child.pid, ready };
}

function processLooksManaged(record, env = process.env) {
  if (!record || !processIsAlive(Number(record.pid))) return false;
  const ready = readJson(turboPaths(env).ready, null);
  return Boolean(
    typeof record.instance_token === 'string'
    && record.instance_token.length >= 32
    && record.server_script === serverScript
    && ready
    && Number(ready.pid) === Number(record.pid)
    && ready.instance_token === record.instance_token,
  );
}

async function stopManaged(env = process.env) {
  const { paths, record } = managedServerRecord(env);
  if (!record || !processIsAlive(Number(record.pid))) {
    for (const stale of [paths.pid, paths.ready]) {
      try { fs.unlinkSync(stale); } catch {}
    }
    return { stopped: false, reason: 'not_running' };
  }
  if (!processLooksManaged(record, env)) {
    throw new Error(`refusing to stop pid ${record.pid}: it is not the managed Turbo server`);
  }
  process.kill(Number(record.pid), 'SIGTERM');
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline && processIsAlive(Number(record.pid))) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  for (const stale of [paths.pid, paths.ready]) {
    try { fs.unlinkSync(stale); } catch {}
  }
  return { stopped: true, pid: record.pid };
}

const command = process.argv[2];

try {
  if (command === 'resolve') {
    const settings = readTurboConfig();
    if (process.argv.includes('--json')) {
      console.log(JSON.stringify(settings));
    } else {
      console.log([
        settings.enabled ? '1' : '0',
        settings.autoStart ? '1' : '0',
        settings.url,
        String(settings.timeoutMs),
        settings.file,
      ].join('\t'));
    }
  } else if (command === 'enable') {
    const url = option('--url');
    const timeoutRaw = option('--timeout');
    const current = readTurboConfig();
    const timeout = timeoutRaw ? Number(timeoutRaw) : current.timeoutMs;
    if (!Number.isFinite(timeout) || timeout < 100 || timeout > 30000) {
      throw new Error('--timeout must be between 100 and 30000 milliseconds');
    }
    const settings = updateTurboConfig({
      enabled: true,
      auto_start: true,
      url: validateTurboUrl(url || current.url),
      timeout_ms: timeout,
    });
    let service = null;
    if (!process.argv.includes('--no-start')) service = await ensureRunning();
    console.log(JSON.stringify({ enabled: true, config: settings.file, service }, null, 2));
  } else if (command === 'disable') {
    const settings = updateTurboConfig({ enabled: false });
    const service = process.argv.includes('--keep-running') ? null : await stopManaged();
    console.log(JSON.stringify({ enabled: false, config: settings.file, service }, null, 2));
  } else if (command === 'start' || command === 'ensure') {
    console.log(JSON.stringify(await ensureRunning(), null, 2));
  } else if (command === 'stop') {
    console.log(JSON.stringify(await stopManaged(), null, 2));
  } else if (command === 'status') {
    const settings = effectiveTurboSettings();
    const service = managedServerRecord();
    console.log(JSON.stringify({
      enabled: settings.enabled,
      auto_start: settings.autoStart,
      url: settings.url,
      timeout_ms: settings.timeoutMs,
      config: settings.file,
      service: {
        running: service.alive,
        compatible: service.compatible,
        pid: service.record?.pid ?? null,
        ready: service.ready,
        log: service.paths.log,
      },
    }, null, 2));
  } else {
    usage();
    process.exitCode = 2;
  }
} catch (error) {
  console.error(`cartographer-turbo: ${error.message}`);
  process.exitCode = 1;
}
