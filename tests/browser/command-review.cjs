// Built UI proof with synthetic command records. Commands are display fixtures:
// none are executed, and no live corpus, API service or external site is read.
const { chromium, expect } = require('@playwright/test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { captureCopy, writeCopyReport } = require('./helpers/repeated-copy.cjs');

const root = path.resolve(__dirname, '../..');
const dist = path.join(root, 'explorer/dist');
const outputDir = path.join(os.tmpdir(), 'carto-command-review-browser-artifacts');
const sourcePath = '/synthetic/command-review.jsonl';
const cwd = '/work/review/worktrees/renderer-comparison-with-a-deliberately-long-checkout-directory';
const commands = [
  `cd '${cwd}' && sed -n '125,280p' Sources/Rendering/ShowRenderer.swift && grep -n -E 'fps|forK' Sources/Rendering/ShowRenderer.swift`,
  `cd '${cwd}' && grep -rn -E 'film=original|film=|solverAB|potential dispatches' --include=*.swift . | head -80; git status --short`,
  "rg -n 'solverAB|dispatchCount' Sources/Rendering/SolverComparison.swift",
];
const baseline = Date.parse('2026-10-29T12:00:00Z');
const request = (uuid, callId, name, input, seconds) => ({ type: 'assistant', uuid, sessionId: 'command-review-session', cwd, timestamp: new Date(baseline + seconds * 1000).toISOString(), message: { role: 'assistant', content: [{ type: 'tool_use', id: callId, name, input }] } });
const response = (uuid, callId, content, seconds) => ({ type: 'user', uuid, sessionId: 'command-review-session', timestamp: new Date(baseline + seconds * 1000).toISOString(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: callId, content }] } });
const wrappedInput = `const results = await Promise.allSettled([tools.exec_command(${JSON.stringify({ cmd: commands[2], workdir: cwd, max_output_tokens: 2000 })})]); for (const result of results) text(result);`;
const records = [
  { type: 'user', uuid: 'prompt', sessionId: 'command-review-session', cwd, timestamp: new Date(baseline).toISOString(), message: { role: 'user', content: 'Compare the renderer checks and retain their recorded command evidence.' } },
  request('renderer-call', 'renderer', 'Bash', { command: commands[0], description: 'Inspect renderer timing' }, 1),
  response('renderer-result', 'renderer', 'Renderer timing references recorded.', 2),
  request('solver-call', 'solver', 'Bash', { command: commands[1] }, 3),
  response('solver-result', 'solver', 'Comparison references recorded.', 4),
  request('wrapped-call', 'wrapped', 'functions.exec', wrappedInput, 5),
  response('wrapped-result', 'wrapped', 'Additional comparison references recorded.', 6),
];

(async () => {
  assert.ok(fs.existsSync(path.join(dist, 'index.html')), 'Build Explorer before running this browser proof');
  assert.ok(commands[1].indexOf('solverAB') > 100, 'Fixture must hide the useful token beyond the old title prefix');
  fs.mkdirSync(outputDir, { recursive: true });
  const { normalizeTranscriptEntries } = await import(pathToFileURL(path.join(root, 'explorer/server/transcripts.js')).href);
  const transcript = { path: sourcePath, ...normalizeTranscriptEntries(records) };
  const build = fs.readFileSync(path.join(dist, 'index.html'), 'utf8').match(/assets\/index-[^" ]+\.js/)?.[0];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const requested = path.resolve(dist, '.' + url.pathname);
    if (requested !== dist && !requested.startsWith(dist + path.sep)) { res.writeHead(403); res.end(); return; }
    const file = fs.existsSync(requested) && fs.statSync(requested).isFile() ? requested : path.join(dist, 'index.html');
    res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html');
    res.end(fs.readFileSync(file));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const readerUrl = `${origin}/session/${encodeURIComponent(sourcePath)}?reader=conversation`;
  let browser, page;
  const errors = [], unexpected = [], copyReports = [];
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1200, height: 960 }, reducedMotion: 'reduce' });
    context.on('page', current => current.on('pageerror', error => errors.push(error.message)));
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) { unexpected.push(url.origin); await route.abort(); return; }
      if (!url.pathname.startsWith('/api/')) { await route.continue(); return; }
      const bodies = {
        '/api/transcript': transcript,
        '/api/transcript/analysis': {},
        '/api/memory/session': { sessions: [], files: {}, end: baseline + 60000 },
        '/api/session/artifacts': { path: sourcePath, identity: transcript.identity, artifacts: [], documents: [], commits: [] },
      };
      if (!(url.pathname in bodies)) { unexpected.push(url.pathname); await route.fulfill({ status: 501, contentType: 'application/json', body: '{"error":"Unexpected fixture API"}' }); return; }
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify(bodies[url.pathname]) });
    });
    page = await context.newPage();
    await page.goto(readerUrl);
    const callIds = ['renderer-call', 'solver-call', 'wrapped-call'];
    const call = id => page.locator(`[id="${id}--block-0"]`);
    await expect(call('renderer-call')).toBeVisible();

    async function assertCollapsedCues() {
      for (const id of callIds) {
        await expect(call(id)).not.toHaveAttribute('open', '');
        const summary = call(id).locator(':scope > summary');
        const text = await summary.innerText();
        assert.doesNotMatch(text, /\/work\/review|worktrees|\bcd\b|&&|--include|\| head|Promise|tools\.exec_command|max_output_tokens|functions\.exec/, `${id}: collapsed cues omit directory and transport plumbing`);
        assert.ok(await summary.locator('.tr-command-cues [data-kind]').count() > 0, `${id}: collapsed command provides meaningful cues`);
      }
      const first = call('renderer-call').locator(':scope > summary');
      await expect(first.locator('.tr-command-cues [data-kind="file"]').filter({ hasText: 'ShowRenderer.swift' })).toBeVisible();
      await expect(first.locator('.tr-command-cues [data-kind="term"]').filter({ hasText: 'fps' })).toBeVisible();
      await expect(first.locator('.tr-command-cues [data-kind="term"]').filter({ hasText: 'forK' })).toBeVisible();
      const second = call('solver-call').locator(':scope > summary');
      await expect(second.locator('.tr-command-cues [data-kind="term"]').filter({ hasText: 'solverAB' })).toBeVisible();
      await expect(second).toContainText('film=original');
      await expect(second).toContainText('potential dispatches');
      const wrapped = call('wrapped-call').locator(':scope > summary');
      await expect(wrapped).toContainText('solverAB');
      await expect(wrapped).toContainText('SolverComparison.swift');
    }
    await assertCollapsedCues();
    copyReports.push(await captureCopy(page, 'commands-collapsed-desktop'));
    await page.screenshot({ path: path.join(outputDir, 'collapsed-1200.png'), fullPage: true });

    // A useful preview is not a replacement for source. Both direct Bash and
    // safely unwrapped exec preserve the original command, including its flags.
    for (const [index, id] of callIds.entries()) {
      const header = call(id).locator(':scope > summary');
      await header.focus(); await page.keyboard.press('Space');
      await expect(call(id)).toHaveAttribute('open', '');
      assert.ok((await call(id).locator('pre').allTextContents()).includes(commands[index]), `${id}: expansion retains the exact command bytes`);
      await header.click();
    }

    // A token beyond the old raw-shell prefix must stay searchable at its exact
    // canonical call, not merely in the derived collapsed text.
    const search = page.getByRole('textbox', { name: 'Search in transcript', exact: true });
    await search.fill('solverAB');
    await search.press('Enter');
    await page.waitForURL(url => url.searchParams.get('uuid') === 'wrapped-call' && url.searchParams.get('block') === 'wrapped-call--block-0' && url.searchParams.get('highlight') === 'solverAB');
    await expect(call('wrapped-call')).toHaveAttribute('open', '');
    await search.press('Shift+Enter');
    await page.waitForURL(url => url.searchParams.get('uuid') === 'solver-call' && url.searchParams.get('block') === 'solver-call--block-0' && url.searchParams.get('highlight') === 'solverAB');
    await expect(call('solver-call')).toHaveAttribute('open', '');
    await expect(call('solver-call').locator('pre mark').filter({ hasText: 'solverAB' })).toHaveCount(1);
    assert.ok((await call('solver-call').locator('pre').allTextContents()).includes(commands[1]));
    await page.reload();
    await expect(call('solver-call')).toHaveAttribute('open', '');
    assert.ok((await call('solver-call').locator('pre').allTextContents()).includes(commands[1]));
    await call('solver-call').getByRole('button', { name: 'Locate response: Comparison references recorded.', exact: true }).click();
    await page.waitForURL(url => url.searchParams.get('uuid') === 'solver-result' && url.searchParams.get('block') === 'solver-result--block-0');
    await expect(page.locator('[id="solver-result--block-0"]')).toHaveAttribute('open', '');
    assert.equal(await page.locator('[id="solver-result--block-0"]').count(), 1);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(readerUrl);
    await assertCollapsedCues();
    for (const id of callIds) {
      const summary = call(id).locator(':scope > summary');
      const geometry = await summary.evaluate(element => {
        const bounds = element.getBoundingClientRect();
        return { width: bounds.width, height: bounds.height, overflow: element.scrollWidth > element.clientWidth + 1,
          clipped: [...element.querySelectorAll('.tr-command-cues [data-kind]')].some(cue => {
            const rect = cue.getBoundingClientRect();
            return rect.left < bounds.left - 1 || rect.right > bounds.right + 1 || rect.bottom > bounds.bottom + 1 || cue.scrollWidth > cue.clientWidth + 1;
          }) };
      });
      assert.ok(geometry.width >= 300 && geometry.height < 350 && !geometry.overflow && !geometry.clipped, `${id}: narrow cues remain readable without a giant shell row: ${JSON.stringify(geometry)}`);
    }
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    copyReports.push(await captureCopy(page, 'commands-collapsed-mobile'));
    await page.screenshot({ path: path.join(outputDir, 'collapsed-390.png'), fullPage: true });
    await call('solver-call').locator(':scope > summary').click();
    assert.ok((await call('solver-call').locator('pre').allTextContents()).includes(commands[1]));
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await page.screenshot({ path: path.join(outputDir, 'expanded-390.png'), fullPage: true });
    writeCopyReport(path.join(outputDir, 'copy-audit.json'), copyReports);
    for (const report of copyReports) {
      assert.ok(report.boilerplatePercent <= 5, `${report.name}: ${report.boilerplatePercent}% repeated interface copy`);
      assert.deepEqual(report.glyphControls.filter(control => control.issue), [], report.name);
    }
    assert.deepEqual(unexpected, []); assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(outputDir, 'verification.json'), JSON.stringify({ build, checks: ['meaningful lexical cues', 'wrapped exec extraction', 'no shell or transport in collapsed rows', 'exact expanded commands', 'keyboard and pointer disclosure', 'canonical search and reload', 'paired result source', '390px unclipped cues'], copy: copyReports.map(({ name, boilerplatePercent }) => ({ name, boilerplatePercent })), errors }, null, 2) + '\n');
    console.log(`PASS: meaningful command cues, full commands and source navigation; artifacts: ${outputDir}`);
  } catch (error) {
    if (page) await page.screenshot({ path: path.join(outputDir, 'failure.png'), fullPage: true }).catch(() => {});
    throw error;
  } finally {
    await browser?.close(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
