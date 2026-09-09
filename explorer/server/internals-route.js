import { performance } from 'node:perf_hooks';
import { getInternalsSnapshot, internalsSourcePaths, normalizeInternalsPurpose, normalizeInternalsWindow } from './internals.js';
import { effectiveTurboSettings } from '../../scripts/turbo-common.js';

const unavailableCounts = () => ({
  capturedEvents: null,
  keywordIndexedDocs: null,
  semanticIndexedDocs: null,
  semanticCoverageAvailable: false,
});

/** The same telemetry projection for Express and the independently running UI. */
export function createInternalsHandler({
  paths = internalsSourcePaths(),
  getExplorerCounts = unavailableCounts,
  getSnapshot = getInternalsSnapshot,
} = {}) {
  return async (req, res, next) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname !== '/api/internals') return next();
    const reply = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    if (req.method !== 'GET') return reply(405, { error: 'Method not allowed' });
    const window = normalizeInternalsWindow(url.searchParams.get('window') || '30d');
    const purpose = normalizeInternalsPurpose(url.searchParams.get('purpose') || 'remember');
    if (!window) return reply(400, { error: "window must be '7d', '30d', or 'all'" });
    if (!purpose) return reply(400, { error: 'purpose must contain only letters, numbers, underscores, or hyphens' });
    const started = performance.now();
    try {
      const [snapshot, explorer] = await Promise.all([
        getSnapshot({ window, purpose, paths, refresh: ['1', 'true'].includes(url.searchParams.get('refresh')) }),
        Promise.resolve().then(getExplorerCounts).catch(unavailableCounts),
      ]);
      res.setHeader('Server-Timing', `internals;dur=${(performance.now() - started).toFixed(1)}`);
      reply(200, { ...snapshot, operations: { ...snapshot.operations, explorer } });
    } catch (error) {
      console.error('[internals]', error.message);
      reply(500, { error: 'internals aggregation failed' });
    }
  };
}

async function warmCounts(env) {
  const { url } = effectiveTurboSettings(env);
  const response = await fetch(new URL('/api/recall/health', url), {
    signal: AbortSignal.timeout(1000), redirect: 'error',
  });
  if (!response.ok) return unavailableCounts();
  const health = await response.json();
  if (health.status !== 'ok' || health.backend !== 'explorer' || health.contract_version !== 1) return unavailableCounts();
  return {
    ...unavailableCounts(),
    capturedEvents: Number.isFinite(health.events) ? health.events : null,
    keywordIndexedDocs: Number.isFinite(health.indexed_docs) ? health.indexed_docs : null,
  };
}

export function internalsUiPlugin({ env = process.env } = {}) {
  const install = server => server.middlewares.use(createInternalsHandler({
    paths: internalsSourcePaths(env),
    getExplorerCounts: () => warmCounts(env),
  }));
  // Register before Vite's /api proxy. Telemetry needs no warm index, so this
  // route also works with headless Turbo, or when Turbo is stopped entirely.
  return {
    name: 'cartographer-internals',
    configureServer(server) { install(server); },
    configurePreviewServer(server) { install(server); },
  };
}
