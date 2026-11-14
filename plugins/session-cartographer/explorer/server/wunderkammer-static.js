import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateUiRequest } from './turbo-entry.js';

// The image wall is Wunderkammer's own page, pinned in package.json and served
// read-only from its package at /wunderkammer/. Same origin as the Explorer,
// so the wall reads covers from /api/images/file without CORS and the Explorer
// embeds it with wall/embed.mjs. Only the page and its wall/ directory are
// reachable; the package's server, adapters and examples are not.
export const WUNDERKAMMER_PREFIX = '/wunderkammer/';
const PACKAGE_DIR = fileURLToPath(new URL('../node_modules/wunderkammer/', import.meta.url));
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
};

/** Request path → a file inside the package's page or wall/, or null. */
export function resolveWunderkammerFile(urlPath, root = PACKAGE_DIR) {
  if (!urlPath.startsWith(WUNDERKAMMER_PREFIX)) return null;
  let rest;
  try { rest = decodeURIComponent(urlPath.slice(WUNDERKAMMER_PREFIX.length)); } catch { return null; }
  if (rest === '' || rest === 'index.html') rest = 'index.html';
  else if (!rest.startsWith('wall/')) return null;
  if (rest.includes('\0') || rest.split('/').some(part => part === '..' || part === '.')) return null;
  if (!TYPES[path.extname(rest)]) return null;
  let file, base;
  try { base = fs.realpathSync(root); file = fs.realpathSync(path.join(base, rest)); } catch { return null; }
  if (!file.startsWith(base + path.sep) || !fs.statSync(file).isFile()) return null;
  return file;
}

export function createWunderkammerMiddleware({ root = PACKAGE_DIR } = {}) {
  return (req, res, next) => {
    const urlPath = req.url?.split('?')[0] || '';
    if (urlPath === '/wunderkammer') { res.writeHead(301, { Location: `${WUNDERKAMMER_PREFIX}${req.url.slice(urlPath.length)}` }); return res.end(); }
    if (!urlPath.startsWith(WUNDERKAMMER_PREFIX)) return next();
    try { validateUiRequest(req, false); } catch (error) { res.writeHead(error.status || 403); return res.end(); }
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405, { Allow: 'GET, HEAD' }); return res.end(); }
    const file = resolveWunderkammerFile(urlPath, root);
    if (!file) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Not found'); }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file)], 'Content-Length': fs.statSync(file).size,
      'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff',
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  };
}
