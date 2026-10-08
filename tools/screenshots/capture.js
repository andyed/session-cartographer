#!/usr/bin/env node
// Read one snapshot, obfuscate before rendering, and drive the real Explorer.
// No raw snapshot or name mapping is written to the output directory.
import { chromium } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { obfuscateSnapshot } from './obfuscate.js';
import { projectMemoryScope, activityFromMemory } from '../../explorer/shared/activity-scope.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const args = process.argv.slice(2);
const allowed = new Set(['--input', '--api', '--hours', '--seed', '--out', '--replacements']);
const options = {};
for (let i = 0; i < args.length; i += 2) {
  if (args[i] === '--help') {
    console.log('Usage: node tools/screenshots/capture.js [--api http://127.0.0.1:2526] [--hours 24] [--input snapshot.json] [--seed NAME] [--out DIRECTORY] [--replacements private.json]');
    process.exit(0);
  }
  if (!allowed.has(args[i]) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Unknown option or missing value: ${args[i]}`);
  options[args[i].slice(2)] = args[i + 1];
}
const api = new URL(options.api || 'http://127.0.0.1:2526');
if (api.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(api.hostname)) throw new Error('--api must be a loopback HTTP service.');
const hours = Number(options.hours || 24);
if (!Number.isInteger(hours) || hours < 1 || hours > 2160) throw new Error('--hours must be 1–2160.');
const out = path.resolve(options.out || path.join(root, '.carto/screenshots'));
const replacements = options.replacements ? JSON.parse(fs.readFileSync(options.replacements, 'utf8')) : {};
const input = options.input ? JSON.parse(fs.readFileSync(options.input, 'utf8')) : await (async () => {
  const response = await fetch(new URL(`/api/memory/state?hours=${hours}`, api), { signal: AbortSignal.timeout(90000), redirect: 'error' });
  if (!response.ok) throw new Error(`Memory snapshot returned ${response.status}; start a compatible Turbo service first.`);
  return response.json();
})();
const result = obfuscateSnapshot(input, { seed: options.seed, replacements: replacements.replacements || replacements });
const snapshot = result.snapshot;
assert.ok(snapshot.sessions.length, 'No recorded sessions in this window; choose a wider --hours range.');
const fullScope = { from: snapshot.start, through: snapshot.end };
assert.deepEqual(projectMemoryScope(snapshot, fullScope).counts, projectMemoryScope(input, fullScope).counts, 'Name replacement changed activity composition');
assert.deepEqual(snapshot.sessions.map(s => s.provider), input.sessions.map(s => s.provider), 'Name replacement changed provider labels');
assert.deepEqual(snapshot.evidenceIndex.map(e => [e.id, e.t, e.type, e.category]), input.evidenceIndex.map(e => [e.id, e.t, e.type, e.category]), 'Name replacement changed event identity or type');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-capture-'));
fs.mkdirSync(out, { recursive: true });
const socket = net.createServer();
await new Promise((resolve, reject) => socket.once('error', reject).listen(0, '127.0.0.1', resolve));
const port = socket.address().port;
await new Promise(resolve => socket.close(resolve));
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('CARTOGRAPHER_') && !['VITE_DEMO', 'CLAUDE_SESSION_ID', 'CLAUDE_CODE_SESSION_ID', 'CODEX_SESSION_ID'].includes(key)));
Object.assign(env, {
  CARTOGRAPHER_DEV_DIR: work, CARTOGRAPHER_CONFIG: path.join(work, 'config.json'),
  CARTOGRAPHER_TURBO_STATE_DIR: path.join(work, 'turbo'), CARTOGRAPHER_TURBO: '0',
  CARTOGRAPHER_SEMANTIC: '0', CARTOGRAPHER_QDRANT_URL: 'http://127.0.0.1:1',
  CARTOGRAPHER_EMBED_URL: 'http://127.0.0.1:1/v1/embeddings',
  CARTOGRAPHER_SERVED_LOG: path.join(work, 'served.jsonl'), CARTOGRAPHER_ACCESS_LEDGER: path.join(work, 'access.jsonl'), CARTOGRAPHER_SEARCH_CALL_LOG: path.join(work, 'calls.jsonl'),
});
const vite = spawn(process.execPath, [path.join(root, 'explorer/node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: path.join(root, 'explorer'), env, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '', browser;
vite.stdout.on('data', chunk => log += chunk);
vite.stderr.on('data', chunk => log += chunk);
const origin = `http://127.0.0.1:${port}`;
const errors = [], unexpected = [], captures = [];
try {
  for (let attempt = 0; ; attempt++) {
    try { if ((await fetch(origin)).ok) break; } catch {}
    if (attempt >= 150 || vite.exitCode !== null) throw new Error(`Screenshot UI failed to start: ${log}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1200 }, deviceScaleFactor: 1, reducedMotion: 'reduce', timezoneId: 'UTC', serviceWorkers: 'block' });
  // All API responses come from the frozen copy, including canvas data. Unknown
  // routes fail closed instead of reaching the real corpus or service controls.
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) { unexpected.push('external resource'); return route.abort(); }
    if (!url.pathname.startsWith('/api/')) return route.continue();
    let body;
    if (route.request().method() !== 'GET') { unexpected.push('non-GET request'); return route.abort(); }
    if (url.pathname === '/api/turbo/status') body = { ready: true, action: null };
    else if (url.pathname === '/api/memory/state') body = snapshot;
    else if (url.pathname === '/api/projects') body = { projects: snapshot.groups };
    else if (url.pathname === '/api/activity-scope') {
      const scoped = projectMemoryScope(snapshot, Object.fromEntries(url.searchParams));
      body = { context: scoped, focused: scoped, source: scoped.source, coverage: scoped.coverage, activity: { ...activityFromMemory(scoped), nextCursor: null } };
    // Only the heartbeat comes from the isolated host's EMPTY corpus. A
    // fulfilled (closed) SSE response would flash "Reconnecting" in captures.
    } else if (url.pathname === '/api/stream') return route.continue();
    else { unexpected.push(url.pathname); return route.fulfill({ status: 404, json: { error: 'Not included in screenshot snapshot.' } }); }
    return route.fulfill({ json: body });
  });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  const scope = new URLSearchParams({ from: new Date(snapshot.start).toISOString(), through: new Date(snapshot.end).toISOString(), mode: 'fixed' });
  async function capture(name, route, selector, viewport = { width: 1440, height: 1200 }) {
    await page.setViewportSize(viewport);
    // Timeline has a persistent SSE connection; readiness is the rendered
    // instrument, not the absence of network traffic.
    await page.goto(`${origin}${route}`, { waitUntil: 'domcontentloaded' });
    await page.locator(selector).first().waitFor({ timeout: 30000 });
    await page.evaluate(() => document.fonts.ready);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.ok(await page.locator(selector).count(), `${name} is empty`);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
    assert.equal(overflow, false, `${name} overflows horizontally`);
    assert.deepEqual(errors, [], 'Browser runtime errors');
    assert.deepEqual(unexpected, [], 'Unexpected network requests');
    if (name === 'timeline') {
      const labels = await page.locator('.concurrent-lane-headings > div').allTextContents();
      const expected = [...new Set(activityFromMemory(projectMemoryScope(snapshot, fullScope)).sessions.map(s => s.project))];
      assert.deepEqual([...labels].sort(), expected.sort(), 'Timeline project lanes disagree with the snapshot');
    }
    const filename = `${name}.png`;
    await page.screenshot({ path: path.join(out, filename), animations: 'disabled' });
    captures.push({ file: filename, ...viewport });
    console.log(`Captured ${filename}`);
  }
  await capture('memory-tasks', `/memory?${scope}`, '[aria-label="Task results"] [role="listitem"]');
  if (Object.values(snapshot.files || {}).some(files => files.length)) await capture('memory-files', `/memory?${scope}&result=files`, '[aria-label="File results"] [role="listitem"]');
  await capture('memory-activity', `/memory?${scope}&surface=activity`, '#memory-weather canvas');
  const painted = await page.locator('#memory-weather canvas').evaluateAll(canvases => canvases.some(canvas => {
    const { data } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
    for (let i = 4; i < data.length; i += 4) if (data[i] !== data[0] || data[i + 1] !== data[1] || data[i + 2] !== data[2]) return true;
    return false;
  }));
  assert.ok(painted, 'Activity screenshot has no plotted data');
  await capture('timeline', `/timeline?${scope}&view=concurrent&days=1`, '.concurrent-chart', { width: 1440, height: 900 });
  await capture('memory-mobile', `/memory?${scope}`, '[aria-label="Task results"] [role="listitem"]', { width: 390, height: 844 });
  fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify({ seed: result.seed, counts: result.counts, window: { from: snapshot.start, through: snapshot.end }, captures, note: 'Names obfuscated; free-form prose retained. Review before publishing. No raw snapshot or mapping saved.' }, null, 2) + '\n');
  fs.writeFileSync(path.join(out, 'index.html'), `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Cartographer screenshots</title><style>body{margin:32px auto;padding:0 20px;max-width:1100px;background:#101319;color:#edf0f5;font:16px/1.6 system-ui}a{color:#72e6ef}img{display:block;max-width:100%;height:auto;border:1px solid #3b4658}figure{margin:32px 0}figcaption{margin:8px 0}</style><h1>Cartographer screenshots</h1><p>Real recorded activity. Project and file names are replaced; free-form prose is retained.</p>${captures.map(({ file }) => `<figure><figcaption>${file.replace('.png', '').replaceAll('-', ' ')}</figcaption><a href="${file}"><img src="${file}" alt="${file.replace('.png', '').replaceAll('-', ' ')}" loading="lazy"></a></figure>`).join('')}</html>`);
  console.log(`Saved ${captures.length} screenshots to ${out}; seed ${result.seed}`);
} finally {
  if (browser) await browser.close();
  vite.kill('SIGTERM');
  await new Promise(resolve => { if (vite.exitCode !== null) resolve(); else vite.once('exit', resolve); });
  fs.rmSync(work, { recursive: true, force: true });
}
