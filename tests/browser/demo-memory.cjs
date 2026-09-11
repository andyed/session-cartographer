// The GH Pages demo, in a real browser, against the built bundle.
//
// memory-entry.cjs deliberately strips VITE_DEMO and exercises the live
// Explorer, so nothing covered the static path — which is precisely where the
// memory view was broken: it called routes the demo layer had never heard of,
// and every one of them 404'd against the hosting origin with no server there
// to notice.
//
// Run: npm run build --prefix explorer  (with VITE_DEMO=true), then
//      node tests/browser/demo-memory.cjs
const { chromium } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '../..');
const base = '/session-cartographer/';
const wait = ms => new Promise(r => setTimeout(r, ms));

async function port() {
  const server = net.createServer();
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const value = server.address().port;
  await new Promise(r => server.close(r));
  return value;
}

(async () => {
  const dist = path.join(root, 'explorer', 'dist');
  const built = path.join(dist, 'demo', 'demo', 'memory', 'state.json');
  if (!fs.existsSync(built)) throw new Error(`build first: VITE_DEMO=true npm run build --prefix explorer (missing ${built})`);
  const fixture = JSON.parse(fs.readFileSync(built, 'utf8'));

  const artifacts = path.join(os.tmpdir(), 'carto-demo-browser-artifacts');
  fs.mkdirSync(artifacts, { recursive: true });
  const uiPort = await port();
  // vite.config.js reads VITE_DEMO at config load and sets `base` from it, so
  // a preview host started without it serves the bundle at / while index.html
  // asks for /session-cartographer/ — the page loads, the script 404s, and the
  // app never boots. And a stray API server on the developer's machine must
  // not be able to answer for the demo: the static layer serves everything.
  const env = { ...process.env, VITE_DEMO: 'true', CARTOGRAPHER_API_PORT: String(await port()) };

  const vite = spawn(process.execPath,
    [path.join(root, 'explorer/node_modules/vite/bin/vite.js'), 'preview', '--host', '127.0.0.1', '--port', String(uiPort), '--strictPort'],
    { cwd: path.join(root, 'explorer'), env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  vite.stdout.on('data', c => output += c);
  vite.stderr.on('data', c => output += c);

  let browser;
  try {
    const origin = `http://127.0.0.1:${uiPort}`;
    for (let i = 0; ; i++) {
      try { if ((await fetch(origin + base)).ok) break; } catch {}
      if (i > 80) throw new Error(output);
      await wait(100);
    }
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
    const errors = [];
    const missed = [];
    page.on('pageerror', e => errors.push(String(e)));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    // Any /api/* that reaches the network at all is a hole in the static layer.
    page.on('request', r => { if (new URL(r.url()).pathname.includes('/api/')) missed.push(r.url()); });

    await page.goto(`${origin}${base}memory`, { waitUntil: 'networkidle' });
    await page.waitForSelector('#memory-weather canvas', { timeout: 15000 });

    const tabs = await page.$$eval('nav button, header button', els => els.map(e => e.textContent.trim().toLowerCase()));
    assert.ok(tabs.includes('memory'), `memory tab missing from ${JSON.stringify(tabs)}`);
    assert.ok(!tabs.includes('internals'), 'internals must stay out of the demo');

    // The field drew something, and it drew the fixture — not a default empty
    // state that happens to paint a background.
    const painted = await page.$$eval('#memory-weather canvas', canvases => canvases.some(c => {
      const ctx = c.getContext('2d');
      const { data } = ctx.getImageData(0, 0, c.width, c.height);
      const first = [data[0], data[1], data[2]];
      for (let i = 4; i < data.length; i += 4) {
        if (data[i] !== first[0] || data[i + 1] !== first[1] || data[i + 2] !== first[2]) return true;
      }
      return false;
    }));
    assert.ok(painted, 'the field canvas is a flat fill — nothing was drawn');

    // Tie the rendered output back to the fixture. A painted canvas only proves
    // something drew; the per-session hit targets prove it drew THIS field.
    // The all-panel layout draws field, wake and compare side by side, and each
    // panel writes its own hit targets, so the expected count is per panel.
    const panels = (await page.$$('#memory-weather canvas')).length;
    assert.ok(panels >= 1, 'no field panels rendered');
    const explorable = await page.$$eval('.mw-target', els => els.length);
    assert.equal(explorable, panels * fixture.field.sessions.length,
      `${panels} panels offer ${explorable} session targets; fixture carries ${fixture.field.sessions.length} sessions`);

    fs.writeFileSync(path.join(artifacts, 'demo-memory-field.png'), await page.screenshot());

    // Compare mode owns the axis select. Which panels the all-panel layout has
    // room for depends on the viewport, so pin the single compare panel by
    // permalink rather than clicking a button whose meaning changes with width.
    await page.goto(`${origin}${base}memory?view=compare&panels=compare`, { waitUntil: 'networkidle' });
    await page.getByRole('heading', {name:'Compare',exact:true}).waitFor({timeout:15000});
    await page.getByLabel('Vertical dimension').waitFor();
    const offered = await page.$$eval('[data-y] option', els => els.map(e => e.value));
    assert.deepEqual(offered, fixture.axes,
      `axis select offers ${JSON.stringify(offered)} but the fixture carries ${JSON.stringify(fixture.axes)}`);
    // render() writes state.y onto the select; an axis the fixture dropped
    // would leave no selection and the compare readout would throw.
    const selected = await page.$eval('[data-y]', el => el.selectedIndex);
    assert.ok(selected >= 0, 'the Y axis select has no selection');

    fs.writeFileSync(path.join(artifacts, 'demo-memory-compare.png'), await page.screenshot());

    // The memory fixture is written by the same step that mirrors demo/ into
    // explorer/public/, so a regression there takes the whole demo down, not
    // just this view. Prove the pre-existing tabs still have their data.
    await page.goto(`${origin}${base}`, { waitUntil: 'networkidle' });
    await page.waitForSelector('main, [class*="timeline"]', { timeout: 10000 });
    const timelineText = await page.textContent('body');
    assert.ok(/20\d\d|Mar |session/i.test(timelineText), 'the demo timeline rendered no recognisable content');

    assert.deepEqual(missed, [], `these API calls escaped the static layer: ${missed.join(', ')}`);
    assert.deepEqual(errors, [], `console errors: ${errors.join(' | ')}`);
    console.log(`demo memory OK — ${fixture.field.sessions.length} sessions, ${fixture.field.groups.length} groups, axes ${fixture.axes.join('/')}`);
    console.log(`screenshots: ${artifacts}`);
  } finally {
    if (browser) await browser.close();
    vite.kill('SIGTERM');
  }
})().catch(e => { console.error(e); process.exit(1); });
