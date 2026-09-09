// Real browser + managed controller, isolated from the user's config/corpus.
// Run: node tests/browser/memory-entry.cjs
const { chromium } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn, execFileSync } = require('node:child_process');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..');
const wait = ms => new Promise(r => setTimeout(r, ms));
async function port() {
  const server = net.createServer();
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const value = server.address().port;
  await new Promise(r => server.close(r));
  return value;
}
(async () => {
  const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'carto-memory-browser-')));
  const artifacts = path.join(os.tmpdir(), 'carto-memory-browser-artifacts');
  fs.mkdirSync(artifacts, { recursive: true });
  const corpus = path.join(work, 'corpus');
  fs.mkdirSync(corpus);
  const apiPort = await port(), uiPort = await port();
  const config = path.join(work, 'config.json');
  fs.writeFileSync(config, JSON.stringify({ turbo: { enabled: false, url: `http://127.0.0.1:${apiPort}` } }));
  // A developer's telemetry paths, spool-only setting, or demo mode must not
  // change the fixture or send its reads/writes to the real corpus.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !key.startsWith('CARTOGRAPHER_') && !['CLAUDE_SESSION_ID', 'CLAUDE_CODE_SESSION_ID', 'CODEX_SESSION_ID', 'VITE_DEMO'].includes(key)));
  Object.assign(env, {
    CARTOGRAPHER_DEV_DIR: corpus,
    CARTOGRAPHER_CONFIG: config,
    CARTOGRAPHER_TURBO_STATE_DIR: path.join(work, 'turbo'),
    CARTOGRAPHER_TURBO_URL: `http://127.0.0.1:${apiPort}`,
    CARTOGRAPHER_SEMANTIC: '0',
    CARTOGRAPHER_QDRANT_URL: 'http://127.0.0.1:1',
    CARTOGRAPHER_CODEX_TRANSCRIPTS_DIR: path.join(work, 'codex-sessions'),
    CARTOGRAPHER_CODEX_ARCHIVED_DIR: path.join(work, 'codex-archives'),
  });
  const transcriptRoot = path.join(work, 'transcripts');
  fs.mkdirSync(transcriptRoot);
  env.CARTOGRAPHER_CLAUDE_TRANSCRIPTS_DIR = transcriptRoot;
  const transcript = path.join(transcriptRoot, 'session-0.jsonl');
  const now = Date.now();
  fs.writeFileSync(transcript, [
    { type: 'user', sessionId: 'session-0', timestamp: new Date(now-2000).toISOString(), message: { role: 'user', content: 'Turbo facts' } },
    { type: 'assistant', sessionId: 'session-0', timestamp: new Date(now-1000).toISOString(), message: { id: 'fixture-usage', role: 'assistant', usage: { input_tokens: 80, cache_read_input_tokens: 20, output_tokens: 12000 }, content: [] } },
  ].map(JSON.stringify).join('\n')+'\n');
  const log = path.join(corpus, 'changelog.jsonl');
  const labels = ['Turbo facts', 'Library facets', 'Waveforms', 'Canvas discovery', 'Recall scope', 'Menus', 'Room lights', 'Reading depth'];
  const projects = ['cartographer', 'player', 'player', 'canvas', 'cartographer', 'player', 'lights', 'research'];
  const events = [];
  const target = path.join(corpus, 'field.js');
  fs.writeFileSync(target, '// recorded file\nexport const live = true;\n');
  for (let s = 0; s < labels.length; s++) {
    for (let e = 0; e < 38; e++) events.push({ event_id: `session-${s}-${e}`, session_id: `session-${s}`, session_title: labels[s], ...(s === 0 ? { transcript_path: transcript } : {}), project: projects[s], timestamp: now - 1000 - (37-e)*40000 - s*100000, type: s === 0 ? 'tool_file_edit' : 'tool_bash', summary: s === 0 ? `Modified: ${target}` : 'Working on the project', cwd: corpus });
  }
  fs.writeFileSync(log, events.map(e => JSON.stringify(e)).join('\n')+'\n');
  fs.appendFileSync(log, JSON.stringify({ event_id: 'archived-edit', session_id: 'archived-session', session_title: 'Earlier session', timestamp: now - 3 * 86400000, project: projects[0], type: 'tool_file_edit', file_path: target })+'\n');
  fs.writeFileSync(path.join(corpus, 'served-log.jsonl'), JSON.stringify({ event_id: 'fixture-result', call_id: 'fixture-call', timestamp: now, purpose: 'remember', rank: 1, project: 'fixture', source: 'changelog' })+'\n');
  const vite = spawn(process.execPath, [path.join(root, 'explorer/node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(uiPort), '--strictPort'], { cwd: path.join(root, 'explorer'), env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  vite.stdout.on('data', c => output += c);
  vite.stderr.on('data', c => output += c);
  let browser;
  try {
    const origin = `http://127.0.0.1:${uiPort}`;
    for (let i = 0; ; i++) {
      try { if ((await fetch(origin)).ok) break; } catch {}
      if (i > 80) throw new Error(output);
      await wait(100);
    }
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1200, height: 880 }, reducedMotion: 'reduce' });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(origin + '/memory');
    await page.getByRole('button', { name: 'Enable Turbo', exact: true }).waitFor();
    assert.equal(fs.existsSync(path.join(work, 'turbo')), false, 'Read-only entry started Turbo');
    const coldLink = await browser.newPage();
    await coldLink.goto(origin+'/memory?session=session-0');
    await coldLink.getByRole('button', {name:'Enable Turbo', exact:true}).waitFor();
    assert.equal(new URL(coldLink.url()).searchParams.get('session'), 'session-0');
    const coldInternals = await page.request.get(origin+'/api/internals');
    assert.equal(coldInternals.status(), 200);
    assert.equal((await coldInternals.json()).utility.calls, 1);
    assert.equal(fs.existsSync(path.join(work, 'turbo')), false, 'Internals started Turbo');
    await page.screenshot({ path: path.join(artifacts, 'carto-memory-entry.png') });
    await page.route('**/api/turbo/start', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Test startup failure. Try again.' }) }), { times: 1 });
    await page.getByRole('button', { name: 'Enable Turbo', exact: true }).click();
    await page.getByRole('alert').getByText('Test startup failure. Try again.').waitFor();
    await wait(5500);
    assert.equal(await page.getByRole('alert').isVisible(), true, 'Startup failure vanished during status polling');
    await page.getByRole('button', { name: 'Enable Turbo', exact: true }).click();
    await page.getByRole('button', { name: 'Field', exact: true }).waitFor({ timeout: 20000 });
    await coldLink.getByRole('heading', {name:'Logged activity', exact:true}).waitFor({timeout:15000});
    await coldLink.close();
    assert.equal(JSON.parse(fs.readFileSync(config, 'utf8')).turbo.enabled, true);
    await page.screenshot({ path: path.join(artifacts, 'carto-memory-live.png') });
    await page.getByRole('button', { name: 'Compare', exact: true }).click();
    await page.getByLabel('Vertical dimension').selectOption('edit');
    await page.getByLabel('Horizontal dimension').selectOption('activeMs');
    await page.screenshot({ path: path.join(artifacts, 'carto-memory-compare.png') });
    await page.getByLabel('Vertical dimension').selectOption('output');
    await page.getByRole('link', { name: 'Explore Turbo facts', exact: true }).focus();
    await page.getByText('12K generated tokens', { exact: false }).waitFor();
    await page.getByRole('button', { name: 'Field', exact: true }).click();
    await page.getByRole('button', { name: 'internals', exact: true }).click();
    await page.getByText('Current snapshot', { exact: true }).waitFor({ timeout: 15000 });
    assert.equal(await page.locator('.internals-error').count(), 0);
    const internals = await (await page.request.get(origin+'/api/internals?window=7d')).json();
    assert.equal(internals.utility.calls, 1);
    await page.getByRole('button', { name: 'memory', exact: true }).click();
    await page.getByRole('link', { name: 'Explore Turbo facts', exact: true }).focus();
    await page.keyboard.press('Enter');
    fs.appendFileSync(log, JSON.stringify({ event_id: 'live-detail-edit', timestamp: Date.now(), session_id: 'session-0', session_title: 'Turbo facts', project: projects[0], transcript_path: transcript, type: 'tool_file_edit', summary: `Modified: ${target}`, cwd: corpus })+'\n');
    await page.getByText('39 observations', {exact:true}).waitFor({timeout:15000});
    await page.getByRole('link', { name: `Inspect ${target}`, exact: true }).click();
    await page.getByRole('link', { name: 'Review', exact: true }).click();
    await page.getByText('export const live = true;', { exact: false }).waitFor();
    const reviewURL = page.url();
    assert.equal(new URL(reviewURL).searchParams.get('session'), 'session-0');
    assert.equal(new URL(reviewURL).searchParams.get('file'), target);
    assert.equal(new URL(reviewURL).searchParams.get('review'), 'file');
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], {origin});
    await page.getByRole('button', {name:'Copy link', exact:true}).click();
    assert.equal(await page.evaluate(()=>navigator.clipboard.readText()), reviewURL);
    await page.reload();
    await page.getByText('export const live = true;', {exact:false}).waitFor();
    await page.goBack();
    await page.getByRole('link', {name:`Inspect ${target}`,exact:true}).waitFor().catch(async error => {
      console.error('Back restoration failed', {url:page.url(), state:await page.evaluate(()=>history.state), text:await page.locator('.memory-view').innerText(), errors});
      throw error;
    });
    assert.equal(await page.getByRole('link', {name:`Inspect ${target}`,exact:true}).getAttribute('aria-current'),'true');
    await page.goForward();
    await page.getByText('export const live = true;', {exact:false}).waitFor();
    await page.screenshot({ path: path.join(artifacts, 'carto-memory-review.png') });
    await page.keyboard.press('Escape');
    await page.getByRole('region', { name: 'File review' }).waitFor({state:'hidden'});
    assert.equal(await page.getByRole('region', { name: 'File review' }).count(), 0);
    await page.getByRole('button', { name: 'Back to all sessions' }).click();
    assert.equal(await page.getByRole('link', {name:'Explore Turbo facts', exact:true}).evaluate(e=>document.activeElement===e),true);
    await page.getByRole('button', { name: 'Wake', exact: true }).click();
    await page.screenshot({ path: path.join(artifacts, 'carto-memory-wake.png') });
    await page.getByRole('link', { name: 'Explore Turbo facts', exact: true }).focus();
    await page.keyboard.press('Enter');
    await page.getByRole('button', { name: 'Back to all sessions' }).click();
    await page.getByRole('button', { name: 'Field', exact: true }).click();
    await page.getByRole('link', { name: 'Explore Library facets', exact: true }).focus();
    await page.keyboard.press('Enter');
    await page.screenshot({ path: path.join(artifacts, 'carto-memory-empty-files.png') });
    assert.equal(await page.getByRole('button', { name: 'Back to all sessions' }).count(), 1);
    assert.ok((await page.locator('.memory-session').innerText()).includes('38 observations'));
    assert.ok((await page.locator('.memory-session').innerText()).includes('No file edits were recorded'));
    await page.getByRole('button', { name: 'Back to all sessions' }).click();
    fs.appendFileSync(log, JSON.stringify({ event_id: 'new-session-event', timestamp: Date.now(), session_id: 'new-live-session', session_title: 'Fresh session', project: 'new-project', summary: 'A new event', type: 'tool_bash' })+'\n');
    await page.getByRole('link', { name: 'Explore Fresh session', exact: true }).waitFor({ timeout: 15000 });
    await page.getByRole('button', { name: 'Replay', exact: true }).click();
    assert.equal(await page.getByRole('button', { name: 'Live', exact: true }).getAttribute('aria-pressed'), 'false');
    await page.getByRole('button', { name: 'Live', exact: true }).click();
    assert.equal(await page.getByRole('button', { name: 'Live', exact: true }).getAttribute('aria-pressed'), 'true');
    execFileSync(process.execPath, [path.join(root, 'scripts/cartographer-turbo.js'), 'stop'], { env });
    await page.getByRole('button', { name: 'Start Turbo', exact: true }).waitFor({ timeout: 15000 });
    await page.screenshot({ path: path.join(artifacts, 'carto-memory-offline.png') });
    await page.getByRole('button', { name: 'Start Turbo', exact: true }).click();
    await page.getByRole('button', { name: 'Live', exact: true }).waitFor({ timeout: 15000 });
    await page.setViewportSize({ width: 360, height: 800 });
    await wait(100);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    assert.equal(overflow, false, 'Mobile layout overflows');
    await page.screenshot({ path: path.join(artifacts, 'carto-memory-mobile.png') });
    await page.getByRole('button', { name: 'Compare', exact: true }).click();
    await page.screenshot({ path: path.join(artifacts, 'carto-memory-compare-mobile.png') });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'Mobile comparison overflows');
    await page.getByRole('link', { name: 'Explore Turbo facts', exact: true }).focus();
    await page.keyboard.press('Enter');
    await page.screenshot({ path: path.join(artifacts, 'carto-memory-mobile-files.png') });
    await page.getByRole('button', { name: 'Back to all sessions' }).click();
    await page.getByRole('button', { name: 'search', exact: true }).click();
    await page.goBack();
    await page.getByRole('button', { name: 'Field', exact: true }).waitFor();
    assert.equal(new URL(page.url()).pathname, '/memory');

    // A fresh document restores axes, pinned time, session and exact file.
    const linked = await browser.newPage({viewport:{width:1100,height:850}});
    linked.on('pageerror', e=>errors.push(e.message));
    await linked.goto(origin+'/memory?view=compare&x=activeMs&y=edit');
    await linked.getByLabel('Vertical dimension').waitFor();
    assert.equal(await linked.getByLabel('Horizontal dimension').inputValue(),'activeMs');
    assert.equal(await linked.getByLabel('Vertical dimension').inputValue(),'edit');
    await linked.getByRole('slider').evaluate(el=>{el.value='1430';el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));});
    await linked.waitForURL(url=>url.searchParams.has('at') && url.searchParams.has('end'));
    const pinned = linked.url();
    await linked.reload();
    await linked.getByLabel('Vertical dimension').waitFor();
    assert.equal(await linked.getByLabel('Vertical dimension').inputValue(),'edit');
    assert.equal(await linked.getByRole('button',{name:'Live',exact:true}).getAttribute('aria-pressed'),'false');
    assert.equal(linked.url(),pinned);
    const sessionHref = await linked.getByRole('link',{name:'Explore Turbo facts',exact:true}).getAttribute('href');
    await linked.goto(new URL(sessionHref,origin).href);
    await linked.getByRole('heading',{name:'Logged activity'}).waitFor();
    assert.equal(new URL(linked.url()).searchParams.get('at'),new URL(pinned).searchParams.get('at'));
    await linked.getByRole('button',{name:'Back to all sessions'}).click();
    await linked.getByLabel('Vertical dimension').waitFor();
    assert.equal(await linked.getByLabel('Vertical dimension').inputValue(),'edit');
    await linked.goto(reviewURL);
    await linked.getByText('export const live = true;',{exact:false}).waitFor();
    await linked.goto(origin+`/memory?session=archived-session&file=${encodeURIComponent(target)}&review=file`);
    await linked.getByText('export const live = true;',{exact:false}).waitFor();
    await linked.getByRole('button',{name:'Close file review'}).click();
    await linked.getByRole('heading',{name:'Earlier session',exact:true}).waitFor();
    await linked.getByText('Last recorded window',{exact:false}).waitFor();
    await linked.goto(origin+'/memory?session=missing-session');
    await linked.getByText('This session has no recorded activity in the selected window.',{exact:true}).waitFor();
    await linked.close();
    assert.deepEqual(errors, []);
    console.log('PASS: cold deep link, managed launch, live drill-down, session/file permalinks, copy link, reload, Back/Forward, replay window/axes, archived session, missing session, Internals, mobile, no page errors.');
  } finally {
    if (browser) await browser.close();
    try { execFileSync(process.execPath, [path.join(root, 'scripts/cartographer-turbo.js'), 'stop'], { env, stdio: 'ignore' }); } catch {}
    vite.kill('SIGTERM');
    fs.rmSync(work, { recursive: true, force: true });
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
