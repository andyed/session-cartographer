import { validateUiRequest } from './turbo-entry.js';

// These are the existing browser APIs. Headless Turbo deliberately serves a
// narrower contract, so forwarding these to its port returns 404. Mount the
// canonical Explorer application on the UI host instead of starting a second
// server on Turbo's port or copying its route implementations.
const EXPLORER_PATHS = new Set([
  '/api/health', '/api/events', '/api/autocomplete', '/api/coterms',
  '/api/search', '/api/projects', '/api/sessions', '/api/stream',
  '/api/transcript', '/api/transcript/analysis',
]);

async function loadExplorer() {
  const { createExplorerApp } = await import('./app.js');
  return createExplorerApp();
}

export function createExplorerUiMiddleware({ loadApp = loadExplorer } = {}) {
  let pending = null;
  let closed = false;

  const getApp = () => {
    if (closed) throw Object.assign(new Error('Explorer is closing'), { status: 503 });
    if (!pending) {
      pending = Promise.resolve().then(loadApp).then(instance => {
        if (closed) {
          instance.close();
          throw new Error('Explorer closed during startup');
        }
        return instance;
      }).catch(error => { pending = null; throw error; });
    }
    return pending;
  };

  const middleware = async (req, res, next) => {
    if (!EXPLORER_PATHS.has(req.url?.split('?')[0])) return next();
    try {
      validateUiRequest(req, false);
      if (!['GET', 'HEAD'].includes(req.method)) {
        throw Object.assign(new Error('Method not allowed'), { status: 405 });
      }
      const { app } = await getApp();
      app(req, res, next);
    } catch (error) {
      if (res.headersSent) return next(error);
      res.writeHead(error.status || 503, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(JSON.stringify({ error: error.message || 'Explorer is unavailable' }));
    }
  };

  middleware.close = async () => {
    if (closed) return;
    closed = true;
    const current = pending;
    pending = null;
    try { (await current)?.close(); } catch {}
  };
  return middleware;
}

export function explorerUiPlugin(options) {
  const hosts = new Set();
  const install = server => {
    const middleware = createExplorerUiMiddleware(options);
    hosts.add(middleware);
    server.middlewares.use(middleware);
    server.httpServer?.once('close', () => {
      hosts.delete(middleware);
      void middleware.close();
    });
  };
  return {
    name: 'cartographer-explorer-api',
    configureServer: install,
    configurePreviewServer: install,
    async closeBundle() {
      await Promise.all([...hosts].map(host => host.close()));
      hosts.clear();
    },
  };
}
