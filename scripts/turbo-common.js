import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function turboConfigPath(env = process.env) {
  if (env.CARTOGRAPHER_CONFIG) return path.resolve(env.CARTOGRAPHER_CONFIG);
  const configRoot = env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(configRoot, 'session-cartographer', 'config.json');
}

export function turboDevDir(env = process.env) {
  return path.resolve(env.CARTOGRAPHER_DEV_DIR || path.join(os.homedir(), 'Documents', 'dev'));
}

export function turboStateDir(env = process.env) {
  return path.resolve(
    env.CARTOGRAPHER_TURBO_STATE_DIR || path.join(turboDevDir(env), '.carto', 'turbo'),
  );
}

export function turboPaths(env = process.env) {
  const state = turboStateDir(env);
  return {
    state,
    requests: path.join(state, 'requests'),
    pid: path.join(state, 'server.json'),
    ready: path.join(state, 'ready.json'),
    log: path.join(state, 'server.log'),
  };
}

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function writeJsonAtomic(file, value, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode });
  fs.renameSync(temporary, file);
  try { fs.chmodSync(file, mode); } catch {}
}

export function validateTurboUrl(raw) {
  let parsed;
  try {
    parsed = new URL(raw || 'http://127.0.0.1:2526');
  } catch {
    throw new Error(`invalid Turbo URL: ${raw}`);
  }
  const loopback = new Set(['127.0.0.1', 'localhost', '[::1]']);
  if (parsed.protocol !== 'http:' || !loopback.has(parsed.hostname)) {
    throw new Error('Turbo URL must be an http:// loopback address');
  }
  if (parsed.username || parsed.password || (parsed.pathname !== '/' && parsed.pathname !== '')) {
    throw new Error('Turbo URL must contain only a loopback origin');
  }
  return parsed.origin;
}

export function readTurboConfig(env = process.env) {
  const file = turboConfigPath(env);
  const config = readJson(file, {});
  const turbo = config && typeof config.turbo === 'object' ? config.turbo : {};
  const timeout = Number(turbo.timeout_ms ?? 1500);
  return {
    file,
    config,
    enabled: turbo.enabled === true,
    autoStart: turbo.auto_start !== false,
    url: validateTurboUrl(turbo.url || 'http://127.0.0.1:2526'),
    timeoutMs: Number.isFinite(timeout) && timeout >= 100 && timeout <= 30000 ? timeout : 1500,
  };
}

export function effectiveTurboSettings(env = process.env) {
  const configured = readTurboConfig(env);
  const envTimeout = Number(env.CARTOGRAPHER_TURBO_TIMEOUT_MS || configured.timeoutMs);
  return {
    ...configured,
    url: validateTurboUrl(env.CARTOGRAPHER_TURBO_URL || configured.url),
    timeoutMs: Number.isFinite(envTimeout) && envTimeout >= 100 && envTimeout <= 30000
      ? envTimeout
      : configured.timeoutMs,
  };
}

export function updateTurboConfig(changes, env = process.env) {
  const current = readTurboConfig(env);
  const next = {
    ...(current.config && typeof current.config === 'object' ? current.config : {}),
    version: 1,
    turbo: {
      ...(current.config?.turbo && typeof current.config.turbo === 'object'
        ? current.config.turbo
        : {}),
      ...changes,
    },
  };
  writeJsonAtomic(current.file, next);
  return readTurboConfig(env);
}

export function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // Sandboxed Codex callers can see the host process but cannot signal it;
    // kill(pid, 0) reports EPERM in that case, which is positive existence
    // evidence rather than a dead process.
    if (error?.code === 'EPERM') return true;
    return false;
  }
}
