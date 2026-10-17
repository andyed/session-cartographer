// Every Cartographer listener binds 127.0.0.1, and binding is not enough. A
// DNS-rebinding page points its own hostname at 127.0.0.1, so the browser
// connects to the loopback port while sending `Host: rebind.attacker.example`
// and treats the response as same-origin with the attacker's page. The bind
// decides who can connect; only the Host header says which name the browser
// thinks it reached. The UI host (:2527) checked this from the start. The API
// and Turbo port (:2526) serves the same corpus and did not: a forged Host got
// 200 and 1.7 MB of /api/memory/state, and /api/memory/file?download=1 hands out
// edited files (architecture review, 2026-10-16). So the check lives here, once,
// and every listener calls it before routing.
//
// Origin must equal the origin the Host names. Cartographer's own Node clients
// (the recall client, the MCP server, the UI host's proxy) send no Origin, and
// a browser sends none on a same-origin GET. The Vite `/api` proxy fallback
// rewrites Host to the API port (changeOrigin), so a browser POST through it
// would carry the UI's Origin and be refused; the UI host serves every path the
// UI calls itself, so nothing takes that route today.

export const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

export class LoopbackGuardError extends Error {
  constructor(message) {
    super(message);
    this.status = 403;
  }
}

/**
 * Throws a LoopbackGuardError unless the request names a loopback host, carries
 * no Origin other than that host's, and is not marked cross-site. With
 * `requireOrigin`, a missing Origin is refused too: for requests that change
 * state, where a header-less client must not be taken for the UI.
 */
export function assertLoopbackRequest(req, { requireOrigin = false } = {}) {
  let origin;
  try {
    const url = new URL(`http://${req.headers.host}`);
    if (!LOOPBACK_HOSTS.has(url.hostname) || url.username || url.password || url.pathname !== '/') throw new Error();
    origin = url.origin;
  } catch {
    throw new LoopbackGuardError('Cartographer is available only on a loopback host');
  }
  const requestOrigin = req.headers.origin;
  if ((requestOrigin && requestOrigin !== origin) || (requireOrigin && requestOrigin !== origin)) {
    throw new LoopbackGuardError('Cartographer requires a same-origin request');
  }
  if (req.headers['sec-fetch-site'] === 'cross-site') {
    throw new LoopbackGuardError('Cross-site requests are not allowed');
  }
}

/**
 * For a bare node:http handler. Answers 403 and returns true when the request
 * is refused; returns false, having written nothing, when it may proceed.
 */
export function refuseNonLoopback(req, res) {
  try {
    assertLoopbackRequest(req);
    return false;
  } catch (error) {
    res.writeHead(error.status || 403, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(JSON.stringify({ error: error.message }));
    return true;
  }
}

/** Connect/Express middleware form of refuseNonLoopback. */
export function guardLoopback(req, res, next) {
  if (!refuseNonLoopback(req, res)) next();
}
