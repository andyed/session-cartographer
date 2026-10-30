// Built Explorer with synthetic, isolated transcript evidence. No live corpus,
// backend service, transcript, or external network is consulted.
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
const outputDir = path.join(os.tmpdir(), 'carto-evidence-review-browser-artifacts');
const sourcePath = '/synthetic/evidence-review.jsonl';
const alphaPath = '/work/review/alpha/report.md';
const betaPath = '/work/review/beta/report.md';
const baseline = Date.parse('2026-10-29T12:00:00Z');
const request = (uuid, callId, name, input, seconds) => ({ type: 'assistant', uuid, sessionId: 'evidence-review-session', cwd: '/work/review', timestamp: new Date(baseline + seconds * 1000).toISOString(), message: { role: 'assistant', content: [{ type: 'tool_use', id: callId, name, input }] } });
const response = (uuid, callId, content, seconds, is_error = false) => ({ type: 'user', uuid, sessionId: 'evidence-review-session', timestamp: new Date(baseline + seconds * 1000).toISOString(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: callId, content, is_error }] } });
const records = [
  { type: 'user', uuid: 'prompt', sessionId: 'evidence-review-session', cwd: '/work/review', timestamp: new Date(baseline).toISOString(), message: { role: 'user', content: 'Review the report edit attempts and their recorded results.' } },
  request('alpha-read', 'read-a', 'Read', { file_path: alphaPath }, 1),
  { ...response('alpha-read-results', 'read-a', 'ALPHA FIRST CHUNK', 2), message: { role: 'user', content: [
    { type: 'tool_result', tool_use_id: 'read-a', content: 'ALPHA FIRST CHUNK' },
    { type: 'tool_result', tool_use_id: 'read-a', content: 'ALPHA SECOND CHUNK' },
  ] } },
  response('alpha-read-tail', 'read-a', 'ALPHA THIRD CHUNK with Q7 marker', 3),
  request('alpha-failed-edit', 'edit-failed', 'Edit', { file_path: alphaPath, old_string: 'alpha old line', new_string: 'alpha proposed line', replace_all: false }, 10),
  response('alpha-failed-result', 'edit-failed', 'sensor disconnected', 11, true),
  request('alpha-returned-edit', 'edit-returned', 'Edit', { file_path: alphaPath, old_string: 'alpha old line', new_string: 'alpha revised line', replace_all: false }, 20),
  response('alpha-returned-result', 'edit-returned', 'Edit response recorded; review the requested replacement.', 21),
  request('beta-read', 'read-b', 'Read', { file_path: betaPath }, 30),
  response('beta-read-result', 'read-b', 'BETA INDEPENDENT CONTENT', 31),
];

(async () => {
  assert.ok(fs.existsSync(path.join(dist, 'index.html')), 'Build Explorer before running this browser proof');
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
  let browser, page;
  const errors = [], unexpected = [], copyReports = [];
  const readerUrl = `${origin}/session/${encodeURIComponent(sourcePath)}?reader=conversation`;
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
    await page.getByRole('button', { name: 'Evidence', exact: true }).click();
    const index = page.locator('.tr-evidence-index');
    await index.waitFor();
    await expect(page.locator('.fw-inspector .ms-files')).toHaveCount(0);
    await expect(page.locator('.fw-inspector .ms-notes')).toHaveCount(0);
    await expect(page.locator('.fw-inspector .fw-activity-evidence')).toHaveCount(0);
    const alpha = index.locator(`.tr-file-evidence[data-file-path="${alphaPath}"]`);
    const beta = index.locator(`.tr-file-evidence[data-file-path="${betaPath}"]`);
    assert.equal(await index.locator('.tr-file-evidence').count(), 2, 'Same basenames in different worktrees retain separate file bundles');
    assert.equal(await index.locator('.path-context').count(), 1, 'The directory context is shared once');
    assert.match(await alpha.locator(':scope > summary').innerText(), /alpha\/report\.md/);
    assert.match(await beta.locator(':scope > summary').innerText(), /beta\/report\.md/);
    const assertReadableFilename = async () => {
      const geometry = await alpha.locator(':scope > summary > strong').evaluate(element => ({ width: element.getBoundingClientRect().width, height: element.getBoundingClientRect().height, lineHeight: parseFloat(getComputedStyle(element).lineHeight) }));
      assert.ok(geometry.width >= 100 && geometry.height <= geometry.lineHeight * 3, `Short filename must not collapse into a vertical column: ${JSON.stringify(geometry)}`);
    };
    await assertReadableFilename();
    assert.equal(await alpha.locator('.tr-file-operation').count(), 3, 'All read/edit attempts remain reachable');
    assert.equal(await beta.locator('.tr-file-operation').count(), 1);
    const failed = alpha.locator('[data-call-block-id="alpha-failed-edit--block-0"]');
    const returned = alpha.locator('[data-call-block-id="alpha-returned-edit--block-0"]');
    const read = alpha.locator('[data-call-block-id="alpha-read--block-0"]');
    await expect(failed).toHaveAttribute('open', '');
    await expect(failed.locator('.tr-requested-change del pre')).toHaveText('alpha old line');
    await expect(failed.locator('.tr-requested-change ins pre')).toHaveText('alpha proposed line');
    await expect(failed.getByRole('button', { name: 'sensor disconnected', exact: true })).toBeVisible();
    assert.equal(await failed.locator('.tr-operation-state').getAttribute('aria-label'), 'Recorded error');
    const returnedHeader = returned.locator(':scope > summary');
    await returnedHeader.focus(); await page.keyboard.press('Space');
    await expect(returned).toHaveAttribute('open', '');
    await expect(returned.locator('.tr-requested-change ins pre')).toHaveText('alpha revised line');
    assert.equal(await returned.locator('.tr-operation-state').getAttribute('aria-label'), 'Result recorded');
    assert.match(await alpha.locator(':scope > summary').innerText(), /1 recorded error/, 'A later response never erases the earlier failure');
    assert.doesNotMatch(await alpha.innerText(), /\b(?:resolved|successful|success)\b/i);
    const beforeDisclosure = page.url();
    const readHeader = read.locator(':scope > summary');
    const headerBox = await readHeader.boundingBox();
    await readHeader.click({ position: { x: headerBox.width - 10, y: headerBox.height / 2 } });
    await expect(read).toHaveAttribute('open', '');
    assert.equal(page.url(), beforeDisclosure, 'The row header reveals local evidence without a location jump');
    assert.equal(await read.locator('.tr-tool-result').count(), 3, 'One call can retain multiple results in one and several source messages');
    await expect(read.getByText('ALPHA FIRST CHUNK', { exact: true })).toBeVisible();
    await expect(read.getByText('ALPHA SECOND CHUNK', { exact: true })).toBeVisible();
    await expect(read.getByText('ALPHA THIRD CHUNK with Q7 marker', { exact: true })).toBeVisible();
    assert.equal(await alpha.getByText('BETA INDEPENDENT CONTENT', { exact: true }).count(), 0);
    await beta.locator(':scope > summary').click();
    await beta.locator('.tr-file-operation > summary').click();
    await expect(beta.getByText('BETA INDEPENDENT CONTENT', { exact: true })).toBeVisible();
    await beta.locator(':scope > summary').click();
    copyReports.push(await captureCopy(page, 'file-bundle-expanded'));
    // Frame the file identity and failed attempt together, rather than leaving
    // the inspector scrolled to the end of a long, fully expanded collection.
    await readHeader.click(); await returnedHeader.click();
    await index.locator('.path-context').evaluate(element => element.scrollIntoView({ block: 'start' }));
    await page.screenshot({ path: path.join(outputDir, 'file-bundle-1200.png'), fullPage: true });
    await readHeader.click();

    // Exact input source: the canonical request contains all its paired outputs.
    await read.getByRole('button', { name: `Locate Read request for ${alphaPath}`, exact: true }).click();
    await page.waitForURL(url => url.searchParams.get('uuid') === 'alpha-read' && url.searchParams.get('block') === 'alpha-read--block-0');
    const canonicalRead = page.locator('[id="alpha-read--block-0"]');
    await expect(canonicalRead).toHaveAttribute('open', '');
    assert.equal(await canonicalRead.locator('.tr-tool-result[id]').count(), 3);
    await expect(canonicalRead.getByText('ALPHA FIRST CHUNK', { exact: true })).toBeVisible();
    // Select the third response via the inspector. Its parent message differs
    // from the first two, proving resultMessageIds was not zipped by index.
    await read.getByRole('button', { name: 'Locate response: ALPHA THIRD CHUNK with Q7 marker', exact: true }).click();
    await page.waitForURL(url => url.searchParams.get('uuid') === 'alpha-read-tail' && url.searchParams.get('block') === 'alpha-read-tail--block-0');
    const canonicalTail = page.locator('[id="alpha-read-tail--block-0"]');
    await expect(canonicalTail).toHaveAttribute('open', '');
    await expect(canonicalRead).toHaveAttribute('open', '');
    assert.equal(await canonicalTail.evaluate(element => element.closest('.tr-tool')?.id), 'alpha-read--block-0');
    for (const id of ['alpha-read--block-0', 'alpha-read-results--block-0', 'alpha-read-results--block-1', 'alpha-read-tail--block-0']) assert.equal(await page.locator(`[id="${id}"]`).count(), 1, `Canonical source ${id} must occur exactly once`);
    assert.equal(await page.locator('[id="alpha-read-results"].tr-source-alias').count(), 1, 'Bundled result-only messages retain their UUID aliases');
    assert.deepEqual(await page.locator('[id]').evaluateAll(elements => {
      const counts = new Map(); for (const element of elements) counts.set(element.id, (counts.get(element.id) || 0) + 1);
      return [...counts].filter(([, count]) => count > 1).map(([id]) => id);
    }), [], 'Inspector copies and canonical result anchors never duplicate DOM IDs');
    await page.reload();
    await expect(page.locator('[id="alpha-read-tail--block-0"]')).toHaveAttribute('open', '');
    await expect(page.locator('[id="alpha-read--block-0"]')).toHaveAttribute('open', '');
    await page.getByRole('textbox', { name: 'Search in transcript', exact: true }).fill('Q7');
    await expect(page.locator('[id="alpha-read-tail--block-0"] mark')).toHaveText('Q7');
    await page.getByRole('textbox', { name: 'Search in transcript', exact: true }).press('Enter');
    await page.waitForURL(url => url.searchParams.get('block') === 'alpha-read-tail--block-0' && url.searchParams.get('highlight') === 'Q7');
    await page.getByRole('textbox', { name: 'Search in transcript', exact: true }).fill('');

    // Mobile keeps the same file identity; jumping to a source closes only the
    // inspector and reveals the corresponding inline result in the reader.
    await page.setViewportSize({ width: 390, height: 844 });
    const evidenceToggle = page.getByRole('button', { name: 'Evidence', exact: true });
    if (await evidenceToggle.getAttribute('aria-pressed') !== 'true') await evidenceToggle.click();
    await index.waitFor();
    await assertReadableFilename();
    await alpha.locator(':scope > summary').scrollIntoViewIfNeeded();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await page.screenshot({ path: path.join(outputDir, 'file-bundle-390.png'), fullPage: true });
    await failed.getByRole('button', { name: 'sensor disconnected', exact: true }).click();
    await page.waitForURL(url => url.searchParams.get('block') === 'alpha-failed-result--block-0');
    await expect(index).toHaveCount(0);
    await expect(page.locator('[id="alpha-failed-edit--block-0"]')).toHaveAttribute('open', '');
    await expect(page.locator('[id="alpha-failed-result--block-0"]')).toHaveAttribute('open', '');
    await expect(page.locator('[id="alpha-failed-result--block-0"]').getByText('sensor disconnected', { exact: true })).toBeVisible();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    copyReports.push(await captureCopy(page, 'mobile-exact-error-source'));
    await page.screenshot({ path: path.join(outputDir, 'error-source-390.png'), fullPage: true });
    writeCopyReport(path.join(outputDir, 'copy-audit.json'), copyReports);
    for (const report of copyReports) {
      assert.ok(report.boilerplatePercent <= 5, `${report.name}: ${report.boilerplatePercent}% repeated interface copy`);
      assert.deepEqual(report.glyphControls.filter(control => control.issue), [], report.name);
    }
    assert.deepEqual(unexpected, []); assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(outputDir, 'verification.json'), JSON.stringify({ build, checks: ['exact file bundles', 'worktree separation', 'readable short paths', 'empty fallback sections absent', 'requested old/new', 'historical error retained', 'pointer and keyboard disclosures', 'multiple paired outputs', 'exact request/result navigation', 'unique canonical IDs', 'source reload', 'short-query match', '390px source recovery'], copy: copyReports.map(({ name, boilerplatePercent }) => ({ name, boilerplatePercent })), errors }, null, 2) + '\n');
    console.log(`PASS: file-oriented evidence, paired source IDs, source recovery and 390px layout; artifacts: ${outputDir}`);
  } catch (error) {
    if (page) await page.screenshot({ path: path.join(outputDir, 'failure.png'), fullPage: true }).catch(() => {});
    throw error;
  } finally {
    await browser?.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
