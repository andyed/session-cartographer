#!/usr/bin/env node
// Capture the README gallery from the running Explorer over the real corpus.
//
// Privacy comes from three layers, and no PNG is written unless all hold:
//  1. Names are remapped where they render. page-remap.js rewrites every text
//     node, visible attribute and canvas string in every frame, from one
//     dictionary: seeded aliases for project and file names, the private
//     demo-sanitize.json replacements, and real names only for repositories
//     the private config lists as public.
//  2. Images are filtered before the page sees them. Image lists are cut to
//     projects the config allows; any other image request gets a placeholder.
//  3. Each frame is audited before capture. An original name, a denied term
//     or a real home directory anywhere in the DOM, attributes or canvas text
//     fails that shot.
// Remapping replaces names, not meaning: a transcript or diff still says what
// it is about, so the review, transcript and search targets are chosen in the
// config, and every PNG is still read by a person before it ships.
//
// Usage: node tools/screenshots/gallery.js [--ui http://127.0.0.1:2527]
//          [--config ~/.config/session-cartographer/screenshots.json]
//          [--out .carto/screenshots/gallery] [--seed NAME] [--only a,b]
import { chromium } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildDictionary } from './obfuscate.js';
import { pageRemapScript } from './page-remap.js';
import { createReplacer } from './remap-core.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const HOME = os.homedir();
const DEV = process.env.CARTOGRAPHER_DEV_DIR || path.join(HOME, 'Documents', 'dev');
const CONFIG_DIR = path.join(HOME, '.config', 'session-cartographer');

const args = process.argv.slice(2);
const options = {};
for (let i = 0; i < args.length; i += 2) {
  if (!['--ui', '--config', '--out', '--seed', '--only', '--ocr'].includes(args[i]) || !args[i + 1]) throw new Error(`Unknown option or missing value: ${args[i]}`);
  options[args[i].slice(2)] = args[i + 1];
}
const ui = new URL(options.ui || 'http://127.0.0.1:2527');
if (ui.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(ui.hostname)) throw new Error('--ui must be a loopback Explorer.');
const config = JSON.parse(fs.readFileSync(options.config || path.join(CONFIG_DIR, 'screenshots.json'), 'utf8'));
const sanitizeFile = process.env.CARTOGRAPHER_DEMO_SANITIZE || path.join(CONFIG_DIR, 'demo-sanitize.json');
const sanitize = fs.existsSync(sanitizeFile) ? JSON.parse(fs.readFileSync(sanitizeFile, 'utf8')) : {};
// The demo map first; the gallery config's own replacements win.
const replacements = { ...(sanitize.replacements || sanitize), ...(config.replacements || {}) };
const out = path.resolve(options.out || path.join(root, '.carto/screenshots/gallery'));
const only = options.only ? new Set(options.only.split(',')) : null;
const seed = options.seed || 'gallery';

async function getJSON(pathname) {
  const response = await fetch(new URL(pathname, ui), { signal: AbortSignal.timeout(120000), redirect: 'error' });
  if (!response.ok) throw new Error(`${pathname} returned ${response.status}`);
  return response.json();
}

// ── The dictionary ──────────────────────────────────────────────────────────
// Project names that are also Explorer vocabulary would rename the app's own
// tabs and labels, and a few corpus "projects" are directories, not projects.
const UI_WORDS = new Set(['memory', 'timeline', 'search', 'images', 'internals', 'sessions', 'session', 'events', 'explorer', 'tasks', 'files', 'activity', 'day', 'recall', 'dev', 'docs', 'scripts', 'tools', 'tests', 'worktrees', 'documents', 'claude', 'codex', 'hermes', 'unattributed', 'desktop', 'downloads', 'home', 'global',
  'sources', 'apps', 'briefs', 'config', 'extension', 'output', 'outputs', 'specs', 'tvos', 'pencil', 'jupyter']);
// Interface phrases that contain an aliased word ("resume" is a project
// directory here) map to themselves; the longer key wins the match.
const UI_PHRASES = ['resume command'];
const keep = config.keep || [];
const keepLower = keep.map(name => name.toLowerCase());
const keepFiles = new Set(keep.flatMap(repo => {
  try { return execFileSync('git', ['-C', path.join(DEV, repo), 'ls-files'], { encoding: 'utf8', maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'ignore'] }).split('\n').filter(Boolean).map(file => path.posix.basename(file)); }
  catch { return []; }
}));
const day = config.shots?.day || new Date(Date.now() - 86400000).toISOString().slice(0, 10);
// The activity endpoint refuses an end in the future, so a day still in
// progress ends a minute ago.
const from = new Date(`${day}T00:00:00`), through = new Date(Math.min(from.getTime() + 86400000, Date.now() - 60000));
const hours = Math.min(2160, Math.ceil((Date.now() - from.getTime()) / 3600000) + 24);
console.log(`Reading names: memory state for ${hours} h, every project directory…`);
const state = await getJSON(`/api/memory/state?hours=${hours}`);
// Every directory in the workspace and its worktrees, not only projects that
// events name: a worktree's own name reaches the screen through image paths
// even though its events file under the parent repository.
const directories = base => { try { return fs.readdirSync(base, { withFileTypes: true }).filter(entry => entry.isDirectory() && !entry.name.startsWith('.')).map(entry => entry.name); } catch { return []; } };
const projects = [...new Set([
  ...(await getJSON('/api/projects')).projects.filter(name => typeof name === 'string' && fs.existsSync(path.join(DEV, name))),
  ...directories(DEV),
  ...directories(path.join(DEV, 'worktrees')),
])].filter(name => name.length >= 4 && !name.startsWith('.') && !UI_WORDS.has(name.toLowerCase()));
const dictionary = buildDictionary({ ...state, groups: [...(state.groups || []), ...projects] }, { seed, replacements, keep, keepFile: file => keepFiles.has(file) });
// The home owner also appears inside tokens (`-Users-<name>-Documents-dev`,
// the encoded project folders agents write under), which the home-path rule
// does not see; it is replaced and watched like a private project name.
const owner = os.userInfo().username;
const entries = [
  // Dot folders (`.claude`, `.carto`) are tool paths, not projects.
  ...dictionary.entries.filter(([key]) => key.length >= 3 && !key.startsWith('.') && !UI_WORDS.has(key.toLowerCase()) && key !== owner),
  [owner, replacements[owner] || 'demo'],
  ...UI_PHRASES.map(phrase => [phrase, phrase]),
];
// Distinctive private project names are also watched as substrings, so one
// inside a longer token (`name_v2`) fails the audit instead of passing
// unreplaced. File names are not watched: aliasing them is cosmetic.
const projectNames = new Set([...(state.groups || []), ...projects]);
const watch = [owner, ...entries
  .filter(([key, value]) => key !== value && projectNames.has(key) && key.length >= 6 && /[-_0-9]|[a-z][A-Z]/.test(key) && !keepLower.some(name => name.includes(key.toLowerCase())))
  .map(([key]) => key)];
const deny = config.deny || [];
const remap = pageRemapScript({ entries, deny, watch });
console.log(`Dictionary: ${entries.length} names (${entries.filter(([a, b]) => a === b).length} kept), ${watch.length} watched, ${deny.length} denied.`);

// ── Image policy ────────────────────────────────────────────────────────────
const imagePatterns = (config.imageProjects || []).map(source => new RegExp(source, 'i'));
// The gallery's own captures are images a session wrote too; showing them
// would put screenshots of the gallery inside the gallery.
const OWN_OUTPUT = /[/\\]\.carto[/\\]screenshots[/\\]/;
// A file path from a row (`~/…`), an absolute path, or a clip note naming one.
const pathOf = where => {
  const found = String(where || '').match(/(?:~|\/)[^\s·"]*\.(?:png|jpe?g|gif|webp|svg|avif|bmp|ico)\b/i)?.[0] || '';
  return found.startsWith('~') ? path.join(HOME, found.slice(1)) : found;
};
// A public repository's images must live in its own directory. A temporary
// file is filed under its session's project, and for this repository those
// are Explorer screenshots: test artifacts, review copies, captures made
// before any remapping. The image families' renders do land in /tmp, so
// they are matched by project alone.
function imageAllowed(project, where = '') {
  if (!project || OWN_OUTPUT.test(where)) return false;
  if (keepLower.includes(project.toLowerCase())) return projectOfPath(pathOf(where)).toLowerCase() === project.toLowerCase();
  return imagePatterns.some(re => re.test(project));
}
function projectOfPath(file = '') {
  for (const [base, depth] of [[path.join(DEV, 'worktrees'), 0], [path.join(HOME, '.codex', 'worktrees'), 1], [DEV, 0]]) {
    const parts = path.relative(base, file).split(path.sep);
    if (parts[0] && parts[0] !== '..' && !path.isAbsolute(parts[0]) && parts.length > depth + 1) return parts[depth];
  }
  return '';
}
const allowedFiles = new Set();
const fileKey = value => { try { const url = new URL(value, ui); return `${url.searchParams.get('path')}\0${url.searchParams.get('id')}`; } catch { return ''; } };
const allow = value => { if (value) allowedFiles.add(fileKey(value)); };
const PLACEHOLDER = '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200"><rect width="100%" height="100%" fill="#1b2230"/></svg>';

// ── Capture ─────────────────────────────────────────────────────────────────
fs.mkdirSync(out, { recursive: true });
const scope = new URLSearchParams({ from: from.toISOString(), through: through.toISOString(), mode: 'fixed', lower: 'closed' });
const browser = await chromium.launch({ headless: true });
const blocked = [], errors = [], failures = [], captures = [];
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2, reducedMotion: 'reduce', serviceWorkers: 'block' });
  await context.addInitScript({ content: remap });
  async function filterJSON(route, edit) {
    const response = await route.fetch();
    if (!response.ok()) return route.fulfill({ response });
    // Status and a fresh body only: the original Content-Length no longer fits.
    return route.fulfill({ status: response.status(), json: edit(await response.json()) });
  }
  await context.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== ui.origin) { blocked.push(`external ${url.host}`); return route.abort(); }
    // Read-only: no click or effect in a capture may write to the corpus.
    if (!['GET', 'HEAD'].includes(request.method())) { blocked.push(`${request.method()} ${url.pathname}`); return route.abort(); }
    if (url.pathname === '/api/images/window') return filterJSON(route, body => {
      body.images = (body.images || []).filter(image => imageAllowed(image.project, image.path));
      for (const image of body.images) { allow(image.thumb); allow(image.full); }
      return body;
    });
    if (url.pathname === '/api/images/collection') return filterJSON(route, body => {
      const doc = body.clips ? body : body.collection;
      if (doc?.clips) {
        // A clip's note carries its file path.
        doc.clips = doc.clips.filter(clip => imageAllowed(clip.props?.project, clip.note));
        for (const clip of doc.clips) { allow(clip.cover); allow(clip.detailCover); }
        if (body.stats) Object.assign(body.stats, { shown: doc.clips.length, blocked: 0, blockedRoots: [], blockedFiles: [], missing: 0 });
      }
      return body;
    });
    if (url.pathname === '/api/session/artifacts') return filterJSON(route, body => {
      body.artifacts = (body.artifacts || []).filter(artifact => imageAllowed(projectOfPath(artifact.path), artifact.path));
      for (const artifact of body.artifacts) allow(artifact.previewUrl);
      return body;
    });
    if (url.pathname === '/api/images/file' || url.pathname === '/api/session/artifact') {
      if (allowedFiles.has(fileKey(url.href))) return route.continue();
      return route.fulfill({ status: 200, contentType: 'image/svg+xml', body: PLACEHOLDER });
    }
    return route.continue();
  });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));

  async function settle() {
    // A focus ring left by a deep link or a click is not part of the view.
    await page.evaluate(() => document.activeElement?.blur?.());
    await page.evaluate(() => document.fonts.ready);
    for (const frame of page.frames()) {
      await frame.waitForFunction(() => [...document.images].every(image => image.complete), null, { timeout: 30000 }).catch(() => {});
    }
    await page.waitForTimeout(400);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  }
  async function shot(name, route, ready, { viewport = { width: 1440, height: 1000 }, before } = {}) {
    if (only && !only.has(name)) return;
    await page.setViewportSize(viewport);
    await page.goto(new URL(route, ui).href, { waitUntil: 'domcontentloaded' });
    try { await page.locator(ready).first().waitFor({ timeout: 90000 }); }
    catch { failures.push({ name, reason: `never showed ${ready}` }); console.error(`✖ ${name}: never showed ${ready}`); return; }
    if (before) await before(page);
    await settle();
    const leaks = [];
    let unpainted = 0;
    for (const frame of page.frames()) {
      const found = await frame.evaluate(() => (globalThis.__screenshotAudit ? globalThis.__screenshotAudit() : { painted: [{ where: 'frame', leak: 'remap not installed', context: location.href }], unpainted: 0 })).catch(() => ({ painted: [], unpainted: 0 }));
      leaks.push(...found.painted);
      unpainted += found.unpainted;
    }
    if (unpainted) console.log(`  ${name}: ${unpainted} unreplaced term${unpainted === 1 ? '' : 's'} offscreen or in attributes (not painted)`);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
    if (leaks.length || overflow) {
      failures.push({ name, leaks: leaks.length, overflow });
      console.error(`✖ ${name}: ${leaks.length} leak${leaks.length === 1 ? '' : 's'}${overflow ? ', horizontal overflow' : ''}`);
      // Printed here for the operator only; never written to the output folder.
      for (const leak of leaks.slice(0, 25)) console.error(`    ${leak.where}: "${leak.leak}" in "${leak.context}"`);
      return;
    }
    const file = `${name}.png`;
    await page.screenshot({ path: path.join(out, file), animations: 'disabled' });
    captures.push({ file, ...viewport });
    console.log(`✔ ${file}`);
  }

  const shots = config.shots || {};
  await shot('timeline-concurrent', `/timeline?${scope}&view=concurrent&days=1`, '.concurrent-chart');
  // Short enough that the overview strip, not the rows under it, is the shot.
  await shot('timeline-feed', `/timeline?${scope}&view=chronological`, '.image-overview img', { viewport: { width: 1440, height: 700 } });
  await shot('timeline-burst', `/timeline?${scope}&view=chronological`, '.image-overview button', {
    // The largest burst on the overview, after the jump scrolls it into view.
    before: async p => {
      const tiles = p.locator('.image-overview li');
      const counts = await tiles.locator('.image-moment-name').allTextContents();
      const largest = counts.map(text => Number(text.match(/(\d+) images?/)?.[1] || 0)).reduce((best, n, i, all) => (n > all[best] ? i : best), 0);
      await tiles.nth(largest).locator('button').click();
      await p.locator('.image-moment[data-arrived]').waitFor({ timeout: 30000 });
      await p.waitForTimeout(600);
      await p.locator('.image-moment[data-arrived]').evaluate(element => element.blur());
    },
  });
  await shot('memory-tasks', `/memory?${scope}`, '[aria-label="Task results"] [role="listitem"]');
  await shot('memory-activity', `/memory?${scope}&surface=activity`, '#memory-weather canvas');
  await shot('memory-day', `/memory?${scope}&surface=day&day=${day}`, '.dd-project');
  if (shots.review) await shot('session-review', `/memory?${scope}&${new URLSearchParams({ session: shots.review.session, file: shots.review.file, review: 'changes' })}`, '.memory-split-diff');
  if (shots.transcript) await shot('transcript', `/session/${encodeURIComponent(shots.transcript.path)}?${new URLSearchParams({ reader: 'conversation', uuid: shots.transcript.uuid })}`, '[data-active]');
  if (shots.query) await shot('search', `/?${new URLSearchParams({ q: shots.query })}`, '.result-list');
  await shot('image-wall', '/images?days=7', '.image-wall-stage iframe', {
    before: async p => {
      const frame = await (await p.waitForSelector('.image-wall-stage iframe')).contentFrame();
      // Covers load as they scroll into the wall's view; wait until most of
      // the ones laid out in view have painted, so the shot is not tiles.
      await frame.waitForFunction(() => {
        const shown = [...document.images].filter(image => { const r = image.getBoundingClientRect(); return r.width > 0 && r.bottom > 0 && r.top < innerHeight && r.left < innerWidth; });
        return shown.length >= 6 && shown.filter(image => image.complete && image.naturalWidth > 0).length >= shown.length * 0.9;
      }, null, { timeout: 90000, polling: 500 }).catch(() => {});
      await p.waitForTimeout(1500);
    },
  });
  await shot('timeline-feed-mobile', `/timeline?${scope}&view=chronological`, '.image-overview img', { viewport: { width: 390, height: 844 } });

  // Pixels: the DOM audit cannot see text inside images (a screenshot within
  // a render, a chart label). With --ocr, an OCR helper that prints
  // "<file>\t<line>" per recognized line reads every PNG, and one showing an
  // original name or a denied term is deleted, not kept for review.
  if (options.ocr) {
    const { leaks } = createReplacer(entries, { deny, watch });
    const files = captures.map(({ file }) => path.join(out, file));
    const lines = files.length ? execFileSync(options.ocr, files, { encoding: 'utf8', maxBuffer: 64 << 20 }).split('\n').filter(Boolean) : [];
    const flagged = new Map();
    for (const line of lines) {
      const [file, text = ''] = line.split('\t');
      const found = leaks(text);
      if (found.length) flagged.set(file, [...(flagged.get(file) || []), `${found.join(', ')} in "${text.slice(0, 120)}"`]);
    }
    for (const [file, notes] of flagged) {
      fs.rmSync(path.join(out, file), { force: true });
      captures.splice(captures.findIndex(capture => capture.file === file), 1);
      failures.push({ name: file.replace(/\.png$/, ''), reason: 'text in pixels' });
      console.error(`✖ ${file}: OCR found ${notes.length} line${notes.length === 1 ? '' : 's'}; deleted`);
      for (const note of notes.slice(0, 10)) console.error(`    ${note}`);
    }
    console.log(`OCR read ${lines.length} lines in ${files.length} images; ${flagged.size} deleted.`);
  }

  fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify({ seed, day, captures, failures: failures.map(({ name, reason, leaks, overflow }) => ({ name, reason, leaks, overflow })), note: 'Names remapped at render time and audited per frame; images limited to configured projects. Read every PNG before publishing.' }, null, 2) + '\n');
  fs.writeFileSync(path.join(out, 'index.html'), `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Gallery review</title><style>body{margin:32px auto;padding:0 20px;max-width:1200px;background:#101319;color:#edf0f5;font:16px/1.6 system-ui}img{display:block;max-width:100%;height:auto;border:1px solid #3b4658}figure{margin:32px 0}figcaption{margin:8px 0;color:#d4dae3}</style><h1>Gallery review</h1><p>Names remapped at render time; read every image before publishing.</p>${captures.map(({ file }) => `<figure><figcaption>${file}</figcaption><a href="${file}"><img src="${file}" alt="${file}" loading="lazy"></a></figure>`).join('')}</html>`);
  if (errors.length) console.error(`Page errors:\n  ${[...new Set(errors)].join('\n  ')}`);
  if (blocked.length) console.log(`Blocked: ${[...new Set(blocked)].join(', ')}`);
  console.log(`${captures.length} captured, ${failures.length} failed → ${out}`);
  if (failures.length) process.exitCode = 1;
} finally {
  await browser.close();
}
