// The image wall against an isolated corpus: one session that wrote three
// images and read a fourth it did not write. Checks the server's choice of
// images, that Wunderkammer accepts the document, that the embedded wall loads
// every cover without calling a wunderkammer server, and the narrow layout.
// `--preview` runs against the built Explorer, as CI does.
const { chromium } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function port() { const server = net.createServer(); await new Promise(r => server.listen(0, '127.0.0.1', r)); const value = server.address().port; await new Promise(r => server.close(r)); return value; }
const lum = c => { const [r, g, b] = c.match(/[\d.]+/g).slice(0, 3).map(Number).map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

(async () => {
  const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'carto-image-wall-')));
  const artifacts = path.join(os.tmpdir(), 'carto-image-wall-browser-artifacts'); fs.mkdirSync(artifacts, { recursive: true });
  const corpus = path.join(work, 'corpus'), outputs = path.join(work, 'outputs'), transcripts = path.join(work, 'transcripts');
  for (const dir of [corpus, outputs, transcripts]) fs.mkdirSync(dir);
  const sid = 'image-wall-session';
  const start = new Date(Date.now() - 10 * 60 * 1000), end = new Date();
  const at = offset => new Date(start.getTime() + offset * 60 * 1000).toISOString();
  const svg = (fill, w, h) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="${fill}"/><script>window.artifactRan=true;fetch('/__unexpected_svg_request')</script></svg>`;
  const written = [['#7a2e3b', 400, 200], ['#1f5c4a', 200, 300], ['#2a3f7a', 240, 240]].map(([fill, w, h], i) => {
    const file = path.join(outputs, `render-${i}.svg`); fs.writeFileSync(file, svg(fill, w, h)); return file;
  });
  const reference = path.join(outputs, 'reference.svg'); fs.writeFileSync(reference, svg('#555555', 300, 200));
  const old = start.getTime() / 1000 - 3 * 24 * 60 * 60; fs.utimesSync(reference, old, old);
  const rows = [
    { type: 'user', uuid: 'prompt', sessionId: sid, cwd: corpus, timestamp: at(0), message: { role: 'user', content: 'Render the variants' } },
    { type: 'assistant', uuid: 'call', sessionId: sid, timestamp: at(1), message: { role: 'assistant', content: [{ type: 'tool_use', id: 'render', name: 'Bash', input: { command: 'node render.mjs' } }, { type: 'tool_use', id: 'look', name: 'Read', input: { file_path: reference } }] } },
    { type: 'user', uuid: 'result', sessionId: sid, timestamp: at(2), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'render', content: written.map(file => `wrote ${file}`).join('\n') }] } },
    { type: 'assistant', uuid: 'done', sessionId: sid, timestamp: end.toISOString(), message: { role: 'assistant', content: 'Three variants rendered.' } },
  ];
  const transcript = path.join(transcripts, `${sid}.jsonl`);
  fs.writeFileSync(transcript, rows.map(JSON.stringify).join('\n') + '\n');
  fs.writeFileSync(path.join(corpus, 'changelog.jsonl'), JSON.stringify({ event_id: 'wall-end', session_id: sid, session_title: 'Render the variants', provider: 'claude', project: 'graphics', cwd: corpus, transcript_path: transcript, timestamp: end.toISOString(), type: 'milestone_session_end', summary: 'Session ended' }) + '\n');

  const uiPort = await port(), apiPort = await port();
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('CARTOGRAPHER_') && !['CLAUDE_SESSION_ID', 'CLAUDE_CODE_SESSION_ID', 'CODEX_SESSION_ID', 'VITE_DEMO'].includes(key)));
  const config = path.join(work, 'config.json'); fs.writeFileSync(config, JSON.stringify({ turbo: { enabled: false, url: `http://127.0.0.1:${apiPort}` } }));
  Object.assign(env, { CARTOGRAPHER_DEV_DIR: corpus, CARTOGRAPHER_CONFIG: config, CARTOGRAPHER_TURBO_STATE_DIR: path.join(work, 'turbo'), CARTOGRAPHER_TURBO_URL: `http://127.0.0.1:${apiPort}`, CARTOGRAPHER_SEMANTIC: '0', CARTOGRAPHER_QDRANT_URL: 'http://127.0.0.1:1', CARTOGRAPHER_API_PORT: String(apiPort), CARTOGRAPHER_EMBED_URL: 'http://127.0.0.1:1/v1/embeddings', CARTOGRAPHER_CLAUDE_TRANSCRIPTS_DIR: transcripts, CARTOGRAPHER_CODEX_TRANSCRIPTS_DIR: path.join(work, 'codex'), CARTOGRAPHER_CODEX_ARCHIVED_DIR: path.join(work, 'archives'), CARTOGRAPHER_THUMBNAIL_DIR: path.join(work, 'thumbnails') });
  const vite = spawn(process.execPath, [path.join(root, 'explorer/node_modules/vite/bin/vite.js'), ...(process.argv.includes('--preview') ? ['preview'] : []), '--host', '127.0.0.1', '--port', String(uiPort), '--strictPort'], { cwd: path.join(root, 'explorer'), env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', browser;
  vite.stdout.on('data', d => { output += d; }); vite.stderr.on('data', d => { output += d; });
  try {
    const origin = `http://127.0.0.1:${uiPort}`;
    for (let i = 0; ; i++) { try { if ((await fetch(origin)).ok) break; } catch {} if (i > 100) throw Error(output); await pause(100); }

    // The server's choice: written images in, the read-only reference only under scope=named.
    const changed = await (await fetch(`${origin}/api/images/collection?days=1`)).json();
    // One hook event only, like many Codex sessions: the wall must still read its transcript.
    assert.equal(changed.stats.shown, 3, JSON.stringify(changed.stats));
    assert.equal(changed.stats.namedOnly, 1);
    assert.deepEqual(changed.collection.clips.map(c => c.title).sort(), ['render-0.svg', 'render-1.svg', 'render-2.svg']);
    const named = await (await fetch(`${origin}/api/images/collection?days=7&scope=named`)).json();
    assert.equal(named.collection.clips.find(c => c.title === 'reference.svg').props.written, 'outside sessions');
    const doc = await (await fetch(`${origin}/api/images/collection?days=7&document=1`)).json();
    const { validateCollection } = await import(pathToFileURL(path.join(root, 'explorer/node_modules/wunderkammer/wall/collection.mjs')).href);
    assert.equal(validateCollection(doc, { baseUrl: `${origin}/images` }).collection.clips.length, 3);
    const unnamed = await fetch(`${origin}/api/images/file?path=${encodeURIComponent(transcript)}&id=${'f'.repeat(24)}`);
    assert.equal(unnamed.status, 404, 'only images the transcript names are served');
    assert.equal((await fetch(`${origin}/wunderkammer/serve.mjs`)).status, 404, 'the package server is not exposed');

    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1200, height: 900 }, reducedMotion: 'reduce' });
    const errors = [], unwanted = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('request', r => {
      const url = new URL(r.url());
      if (url.pathname.includes('__unexpected_svg_request') || /^\/api\/(?:clips|view-state|permalinks|proxy)/.test(url.pathname)) unwanted.push(url.pathname);
    });
    await page.goto(`${origin}/images`);
    await page.waitForFunction(() => /^3 images written in sessions/.test(document.querySelector('.image-wall-status strong')?.textContent || ''));
    await page.waitForSelector('.image-wall-stage iframe');
    const frame = page.frames().find(f => f.url().includes('/wunderkammer/'));
    await frame.waitForFunction(() => [...document.querySelectorAll('img')].filter(i => i.complete && i.naturalWidth > 0).length >= 3, null, { timeout: 30000 });
    assert.equal(await frame.title(), doc.ui.title);
    assert.equal(await frame.evaluate(() => window.artifactRan), undefined, 'SVG covers never execute');
    for (const el of await page.$$('.image-wall-bar strong, .image-wall-bar span:not(.iw-short), .image-wall-bar button, .image-wall-bar a')) {
      const [fg, bg] = await el.evaluate(node => { let n = node, bg = 'rgba(0, 0, 0, 0)'; while (n && /rgba\(0, 0, 0, 0\)|transparent/.test(bg)) { bg = getComputedStyle(n).backgroundColor; n = n.parentElement; } return [getComputedStyle(node).color, bg]; });
      assert.ok(contrast(fg, bg) >= 8, `${await el.innerText()}: ${fg} on ${bg}`);
    }
    await page.screenshot({ path: path.join(artifacts, 'image-wall-1200.png') });

    await page.getByRole('button', { name: 'Any a session named', exact: true }).click();
    await page.waitForFunction(() => /^4 images named by sessions/.test(document.querySelector('.image-wall-status strong')?.textContent || ''));
    assert.equal(new URL(page.url()).searchParams.get('scope'), 'named');

    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(100);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'no horizontal scroll at 390');
    const navRows = await page.$$eval('header nav button, header .flex-wrap > button', buttons => new Set(buttons.map(b => Math.round(b.getBoundingClientRect().top))).size);
    assert.equal(navRows, 1, 'the five tabs stay on one row at 390');
    await page.screenshot({ path: path.join(artifacts, 'image-wall-390.png') });

    assert.deepEqual(errors, []);
    assert.deepEqual(unwanted, []);
    console.log('image wall browser check passed');
  } finally {
    await browser?.close();
    vite.kill();
    fs.rmSync(work, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exit(1); });
