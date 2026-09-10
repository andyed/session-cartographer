import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { effectiveTurboSettings } from '../../scripts/turbo-common.js';

const exec = promisify(execFile);
const controllerPath = fileURLToPath(new URL('../../scripts/cartographer-turbo.js', import.meta.url));
const ACTIONS = new Set(['enable', 'start', 'refresh']);
const MEMORY_PATHS = new Set(['/api/memory/health', '/api/memory/state', '/api/memory/session', '/api/memory/file']);
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

function reply(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify(body));
}

function failure(status, message) {
  return Object.assign(new Error(message), { status });
}

// This runs on the UI host, which remains available while the warm backend is
// stopped. Keep all service/config ownership in the portable controller.
async function runManagedController(command, env) {
  if (!['status', 'enable', 'start', 'stop'].includes(command)) throw new Error('Unsupported Turbo command');
  try {
    const { stdout } = await exec(process.execPath, [controllerPath, command], {
      env, timeout: command === 'status' ? 5000 : 40000, maxBuffer: 65536,
    });
    return JSON.parse(stdout);
  } catch (error) {
    const detail = String(error.stderr || error.message || 'Unknown error').trim().slice(0, 500);
    throw new Error(`Turbo ${command} failed: ${detail}`);
  }
}

async function readResponseJson(response, limit = 8 * 1024 * 1024) {
  if (Number(response.headers.get('content-length')) > limit) throw new Error('Turbo response is too large');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Turbo returned an empty response');
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error('Turbo response is too large');
      chunks.push(Buffer.from(value));
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function memoryHealth(url, fetchImpl) {
  try {
    const response = await fetchImpl(new URL('/api/memory/health', url), {
      signal: AbortSignal.timeout(1000), redirect: 'error',
    });
    if (!response.ok) return null;
    const body = await readResponseJson(response, 65536);
    return body?.status === 'ok' && body?.contract_version === 1 ? body : null;
  } catch {
    return null;
  }
}

// UI middleware runs before Vite's own host guard, so every local API mounted
// there must validate its origin before serving private corpus data.
export function validateUiRequest(req, mutation) {
  let origin;
  try {
    const url = new URL(`http://${req.headers.host}`);
    if (!LOOPBACK_HOSTS.has(url.hostname) || url.username || url.password || url.pathname !== '/') throw new Error();
    origin = url.origin;
  } catch {
    throw failure(403, 'Cartographer is available only on the loopback UI host');
  }
  const requestOrigin = req.headers.origin;
  if ((requestOrigin && requestOrigin !== origin) || (mutation && requestOrigin !== origin)) {
    throw failure(403, 'Cartographer requires the same UI origin');
  }
  if (req.headers['sec-fetch-site'] === 'cross-site') throw failure(403, 'Cross-site Turbo requests are not allowed');
  if (mutation && (
    req.headers['x-cartographer-action'] !== 'start'
    || !/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')
  )) throw failure(403, 'Turbo start requires an explicit JSON action');
}

function readAction(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    let size = 0;
    let rejected = false;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 2048) {
        rejected = true;
        reject(failure(413, 'Turbo action is too large'));
      }
      if (!rejected) raw += chunk.toString('utf8');
    });
    req.on('error', reject);
    req.on('end', () => {
      if (rejected) return;
      try {
        const body = JSON.parse(raw);
        if (!body || Array.isArray(body) || Object.keys(body).length !== 1 || !ACTIONS.has(body.action)) throw new Error();
        resolve(body.action);
      } catch {
        reject(failure(400, 'Choose enable, start, or refresh from the current Turbo status'));
      }
    });
  });
}

export function createTurboEntryMiddleware({
  env = process.env,
  runController = runManagedController,
  fetchImpl = fetch,
  probeMemory = (url) => memoryHealth(url, fetchImpl),
  startupProbeMs = 3000,
} = {}) {
  let startup = null;

  async function status() {
    const settings = effectiveTurboSettings(env);
    const [control, memory] = await Promise.all([
      runController('status', env), probeMemory(settings.url),
    ]);
    const service = control.service || {};
    const ready = Boolean(memory);
    return {
      enabled: control.enabled === true,
      running: service.running === true || ready,
      ready,
      action: ready ? null : service.running ? 'refresh' : control.enabled ? 'start' : 'enable',
      url: settings.url,
      service: {
        managed: service.running === true,
        compatible: service.compatible === true,
        http: service.http || null,
        runtime_version: service.ready?.runtime_version || null,
      },
      memory,
    };
  }

  async function launch(action) {
    const before = await status();
    if (before.ready) return before;
    if (action !== before.action) throw failure(409, 'Turbo status changed. Review the current action and try again');
    if (action === 'refresh') await runController('stop', env);
    await runController(action === 'enable' ? 'enable' : 'start', env);
    const deadline = Date.now() + startupProbeMs;
    do {
      const after = await status();
      if (after.ready) return after;
      if (Date.now() >= deadline) break;
      await new Promise((resolve) => setTimeout(resolve, 150));
    } while (Date.now() < deadline);
    throw failure(503, 'Turbo started, but its working-memory API is unavailable. Check the configured port and update the running Cartographer installation');
  }

  return async function turboEntry(req, res, next) {
    const pathname = req.url?.split('?')[0];
    if (!['/api/turbo/status', '/api/turbo/start'].includes(pathname) && !MEMORY_PATHS.has(pathname)) return next();
    try {
      const mutation = pathname === '/api/turbo/start';
      validateUiRequest(req, mutation);
      if (req.method !== (mutation ? 'POST' : 'GET')) throw failure(405, 'Method not allowed');
      if (pathname === '/api/turbo/status') return reply(res, 200, await status());
      if (mutation) {
        const action = await readAction(req);
        if (!startup) {
          const pending = launch(action);
          startup = { action, pending };
          pending.finally(() => { if (startup?.pending === pending) startup = null; }).catch(() => {});
        } else if (startup.action !== action) {
          throw failure(409, 'Another Turbo action is already running');
        }
        return reply(res, 200, await startup.pending);
      }
      if (req.url.length > 4096) throw failure(400, 'Memory request URL is too long');
      const { url } = effectiveTurboSettings(env);
      const response = await fetchImpl(new URL(req.url, url), {
        signal: AbortSignal.timeout(10000), redirect: 'error', headers: { Accept: 'application/json' },
      });
      return reply(res, response.status, await readResponseJson(response));
    } catch (error) {
      if (!res.headersSent) reply(res, error.status || 503, { error: String(error.message || 'Turbo is unavailable').slice(0, 700) });
    }
  };
}

export function turboEntryPlugin(options) {
  return {
    name: 'cartographer-turbo-entry',
    configureServer(server) { server.middlewares.use(createTurboEntryMiddleware(options)); },
    configurePreviewServer(server) { server.middlewares.use(createTurboEntryMiddleware(options)); },
  };
}
