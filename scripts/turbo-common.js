import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LOG_FILE_NAMES } from '../explorer/server/jsonl.js';

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
    // null means "not chosen": the machine's memory plan picks at spawn time.
    idleMinutes: Number.isFinite(Number(turbo.idle_minutes)) && Number(turbo.idle_minutes) >= 0
      && turbo.idle_minutes !== null && turbo.idle_minutes !== ''
      ? Number(turbo.idle_minutes) : null,
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

// ─── Memory plan ─────────────────────────────────────────────────────────────
// Turbo holds the whole corpus resident, so whether it should run by default is
// a question about this machine's RAM. The estimate is per log ROW, because
// rows are what can be counted cheaply before Turbo runs; Turbo loads fewer
// events than rows (duplicates and id-less rows drop out). Measured 2026-09-23:
// a headless service held 674 MB RSS for 263,393 rows (149.8k loaded events),
// about 2.6 KB per row. That single point includes fixed startup overhead, so
// it overstates a large corpus and understates a tiny one.
export const TURBO_BYTES_PER_LOG_ROW = 2600;
// Machines with at least this much RAM get Turbo by default from /carto.
export const TURBO_AUTO_MIN_RAM_BYTES = 16 * 1024 ** 3;
// Even on those, a corpus whose estimate exceeds this share of RAM asks first.
export const TURBO_AUTO_MAX_RAM_SHARE = 0.08;
// Below the RAM floor, a service nobody configured otherwise exits when idle.
export const TURBO_SMALL_MACHINE_IDLE_MINUTES = 30;

/** Count rows without parsing them: one JSONL row per line, in the files Turbo loads. */
export function countCorpusRows(env = process.env) {
  const dev = turboDevDir(env);
  let rows = 0;
  for (const name of Object.values(LOG_FILE_NAMES)) {
    let fd;
    try { fd = fs.openSync(path.join(dev, name), 'r'); } catch { continue; }
    try {
      const buffer = Buffer.allocUnsafe(1 << 20);
      let bytes;
      while ((bytes = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
        for (let i = 0; i < bytes; i++) if (buffer[i] === 10) rows += 1;
      }
    } finally {
      fs.closeSync(fd);
    }
  }
  return rows;
}

/** Physical RAM; CARTOGRAPHER_TURBO_TOTAL_MEM_BYTES overrides it for tests. */
export function totalMemoryBytes(env = process.env) {
  const override = Number(env.CARTOGRAPHER_TURBO_TOTAL_MEM_BYTES);
  return Number.isFinite(override) && override > 0 ? override : os.totalmem();
}

/**
 * Decide whether Turbo should run by default on this machine.
 * `recommend` is true only with 16 GB+ RAM and an estimate within 8% of it.
 */
export function turboMemoryPlan({ totalMemBytes, logRows }) {
  const estimateBytes = Math.max(0, logRows) * TURBO_BYTES_PER_LOG_ROW;
  const share = totalMemBytes > 0 ? estimateBytes / totalMemBytes : 1;
  const largeMachine = totalMemBytes >= TURBO_AUTO_MIN_RAM_BYTES;
  const recommend = largeMachine && share <= TURBO_AUTO_MAX_RAM_SHARE;
  return {
    log_rows: logRows,
    estimate_mb: Math.round(estimateBytes / 1048576),
    total_ram_gb: Math.round((totalMemBytes / 1024 ** 3) * 10) / 10,
    share_of_ram: Math.round(share * 1000) / 1000,
    recommend,
    reason: !largeMachine ? 'under_16gb_ram' : recommend ? 'fits' : 'corpus_over_8pct_of_ram',
    default_idle_minutes: largeMachine ? 0 : TURBO_SMALL_MACHINE_IDLE_MINUTES,
  };
}

export function machineTurboPlan(env = process.env) {
  return turboMemoryPlan({ totalMemBytes: totalMemoryBytes(env), logRows: countCorpusRows(env) });
}
