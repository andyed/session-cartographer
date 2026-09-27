// Isolated acceptance harness for the exact focus workspace.
// Run: node tests/browser/focus-workspace.cjs
// Built preview: node tests/browser/focus-workspace.cjs --preview
const { chromium } = require('@playwright/test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const { createFocusWorkspaceFixture } = require('./fixtures/focus-workspace.cjs');

const root = path.resolve(__dirname, '../..');
const preview = process.argv.includes('--preview');
const viewportProof = process.argv.includes('--viewport-proof');
const pointerProof = process.argv.includes('--pointer-proof');
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function unusedPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const value = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return value;
}

function isolatedEnvironment(work, corpus, apiPort, config) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !key.startsWith('CARTOGRAPHER_')
    && !['CLAUDE_SESSION_ID', 'CLAUDE_CODE_SESSION_ID', 'CODEX_SESSION_ID', 'VITE_DEMO'].includes(key)));
  return {
    ...env,
    CARTOGRAPHER_DEV_DIR: corpus,
    CARTOGRAPHER_CONFIG: config,
    CARTOGRAPHER_TURBO_STATE_DIR: path.join(work, 'turbo'),
    CARTOGRAPHER_TURBO_URL: `http://127.0.0.1:${apiPort}`,
    CARTOGRAPHER_SEMANTIC: '0',
    CARTOGRAPHER_QDRANT_URL: 'http://127.0.0.1:1',
    CARTOGRAPHER_EMBED_URL: 'http://127.0.0.1:1/v1/embeddings',
    CARTOGRAPHER_CLAUDE_TRANSCRIPTS_DIR: path.join(work, 'claude-transcripts'),
    CARTOGRAPHER_CODEX_TRANSCRIPTS_DIR: path.join(work, 'codex-transcripts'),
    CARTOGRAPHER_CODEX_ARCHIVED_DIR: path.join(work, 'codex-archives'),
  };
}

async function ensureWorkspace(page, { results = true } = {}) {
  const ready = page.getByRole('button', { name: 'Edit time range', exact: true });
  const action = page.getByRole('button', { name: /^(Enable|Start|Refresh) Turbo$/ }).first();
  await ready.or(action).first().waitFor({ timeout: 60_000 });
  if (await action.isVisible().catch(() => false)) await action.click();
  await ready.waitFor({ timeout: 60_000 });
  if (results) await page.getByRole('region', { name: 'Work results' }).waitFor({ timeout: 60_000 });
}

// Withholds the page's animation-frame callbacks until the returned release
// runs, as a loaded CI runner does when the next frame is late. A step checked
// under it cannot pass by finishing before a deferred focus call runs.
async function holdAnimationFrames(page) {
  await page.evaluate(() => {
    const request = window.requestAnimationFrame, cancel = window.cancelAnimationFrame;
    const held = new Map();
    let next = -1;
    window.requestAnimationFrame = callback => { held.set(next, callback); return next--; };
    window.cancelAnimationFrame = id => { if (!held.delete(id)) cancel.call(window, id); };
    window.__releaseAnimationFrames = () => {
      window.requestAnimationFrame = request; window.cancelAnimationFrame = cancel;
      for (const callback of held.values()) request.call(window, callback);
      held.clear();
    };
  });
  return () => page.evaluate(() => window.__releaseAnimationFrames());
}

async function noHorizontalOverflow(page, label) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const layout = await page.evaluate(() => {
    const root = document.documentElement;
    const controls = [...document.querySelectorAll('button, input, select, summary')]
      .filter(element => element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden')
      .map(element => {
        const box = element.getBoundingClientRect();
        return { label: element.getAttribute('aria-label') || element.textContent.trim().slice(0, 40), left: box.left, right: box.right };
      });
    return { width: innerWidth, scrollWidth: root.scrollWidth, controls };
  });
  assert.ok(layout.scrollWidth <= layout.width + 1, `${label}: document horizontally overflows ${layout.scrollWidth}px in ${layout.width}px`);
  for (const control of layout.controls) {
    assert.ok(control.left >= -1 && control.right <= layout.width + 1,
      `${label}: visible control leaves the viewport: ${JSON.stringify(control)}`);
  }
}

async function verifyViewportUnion(page, origin, fixture) {
  const sevenDayFrom = fixture.through - 7 * 24 * 60 * 60 * 1000;
  const sevenDayScope = `from=${encodeURIComponent(new Date(sevenDayFrom).toISOString())}&through=${encodeURIComponent(fixture.isoThrough)}&project=alpha&view=concurrent`;
  await page.goto(`${origin}/timeline?${sevenDayScope}`);
  const counts = page.locator('.concurrent-counts');
  await counts.waitFor({ timeout: 60_000 });
  const focusedBeforeFrame = await counts.locator('strong').nth(1).textContent();
  const sevenDayHeight = Number(await page.locator('.concurrent-chart').evaluate(node => parseFloat(node.style.height)));
  assert.ok(sevenDayHeight > 3000, `seven-day visual frame should exceed 3000px, got ${sevenDayHeight}`);
  const unionResponse = page.waitForResponse(response => {
    const url = new URL(response.url());
    return url.pathname === '/api/activity-scope' && url.searchParams.get('shape') === 'context'
      && Date.parse(url.searchParams.get('from')) <= sevenDayFrom
      && Date.parse(url.searchParams.get('through')) >= fixture.through;
  });
  await page.getByRole('group', { name: 'Context frame' }).getByRole('button', { name: '1d', exact: true }).click();
  await unionResponse;
  await page.waitForFunction(() => parseFloat(document.querySelector('.concurrent-chart')?.style.height || '0') <= 500);
  assert.equal(await counts.locator('strong').nth(1).textContent(), focusedBeforeFrame, 'one-day framing must preserve seven-day focused counts');
  const oneDayHeight = Number(await page.locator('.concurrent-chart').evaluate(node => parseFloat(node.style.height)));
  assert.ok(oneDayHeight >= 479 && oneDayHeight <= 500, `one-day visual frame should be 480px, got ${oneDayHeight}`);
}

function urlRange(page) {
  const url = new URL(page.url());
  return { from: Date.parse(url.searchParams.get('from')), through: Date.parse(url.searchParams.get('through')) };
}

async function committedPointerDrag(page, control, visualSelector, delta, changedEdges) {
  const box = await control.boundingBox();
  assert.ok(box, `pointer control is not rendered: ${await control.getAttribute('aria-label')}`);
  const origin = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const beforeURL = page.url(), beforeRange = urlRange(page);
  const beforeHistory = await page.evaluate(() => history.length);
  const beforeVisual = await page.locator(visualSelector).getAttribute('style');
  await page.mouse.move(origin.x, origin.y);
  await page.mouse.down();
  await page.mouse.move(origin.x + delta.x, origin.y + delta.y, { steps: 4 });
  await page.waitForFunction(({ selector, before }) => document.querySelector(selector)?.getAttribute('style') !== before,
    { selector: visualSelector, before: beforeVisual });
  assert.equal(page.url(), beforeURL, 'pointer preview must not write history before release');
  await page.mouse.up();
  await page.waitForFunction(before => location.href !== before, beforeURL);
  const afterRange = urlRange(page);
  for (const edge of ['from', 'through']) {
    assert.equal(afterRange[edge] !== beforeRange[edge], changedEdges.includes(edge),
      `${edge} ${changedEdges.includes(edge) ? 'did not change' : 'changed unexpectedly'} after pointer commit`);
  }
  assert.equal(await page.evaluate(() => history.length), beforeHistory + 1,
    'one completed pointer drag must create exactly one history entry');
  return { beforeRange, afterRange };
}

async function cancelledPointerDrag(page, control, visualSelector, delta, cancel) {
  const box = await control.boundingBox();
  assert.ok(box, `pointer control is not rendered: ${await control.getAttribute('aria-label')}`);
  const origin = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const beforeURL = page.url();
  const beforeHistory = await page.evaluate(() => history.length);
  const beforeVisual = await page.locator(visualSelector).getAttribute('style');
  const controlName = await control.getAttribute('aria-label');
  const beforeValue = await control.getAttribute('aria-valuenow');
  await page.mouse.move(origin.x, origin.y);
  await page.mouse.down();
  await page.mouse.move(origin.x + delta.x, origin.y + delta.y, { steps: 3 });
  await page.waitForFunction(({ selector, before }) => document.querySelector(selector)?.getAttribute('style') !== before,
    { selector: visualSelector, before: beforeVisual });
  await cancel(control, { x: origin.x + delta.x, y: origin.y + delta.y });
  await page.waitForFunction(({ name, before }) => [...document.querySelectorAll('[role="slider"]')]
    .find(element => element.getAttribute('aria-label') === name)?.getAttribute('aria-valuenow') === before,
  { name: controlName, before: beforeValue }, { timeout: 5000 });
  await page.mouse.up();
  assert.equal(page.url(), beforeURL, 'cancelled pointer drag changed the URL');
  assert.equal(await page.evaluate(() => history.length), beforeHistory, 'cancelled pointer drag wrote history');
}

async function runPointerProof(page, browser, origin, scope, pageErrors) {
  const active = '.focus-active-range';
  // The default focus fills its loaded window, so it must not advertise a pan
  // gesture that can only clamp back to the same interval.
  await page.goto(`${origin}/memory?project=alpha`);
  await ensureWorkspace(page);
  await page.waitForFunction(() => new URL(location.href).searchParams.has('from'));
  assert.equal(await page.getByRole('slider', { name: 'Move focus interval' }).count(), 0,
    'a full-window focus exposed a no-op pan control');

  // Dragging unused strip background creates a narrower focus and commits it
  // once; this is the primary pointer path from the default full window.
  const selection = await committedPointerDrag(page, page.locator('.focus-timeline-track'), active,
    { x: 180, y: 0 }, ['from', 'through']);
  assert.ok(selection.afterRange.from > selection.beforeRange.from);
  assert.ok(selection.afterRange.through < selection.beforeRange.through);

  const start = page.getByRole('slider', { name: 'Adjust focus start' });
  const end = page.getByRole('slider', { name: 'Adjust focus end' });
  const startResult = await committedPointerDrag(page, start, active, { x: -48, y: 0 }, ['from']);
  assert.ok(startResult.afterRange.from < startResult.beforeRange.from);
  const endResult = await committedPointerDrag(page, end, active, { x: -28, y: 0 }, ['through']);
  assert.ok(endResult.afterRange.through < endResult.beforeRange.through);

  const pan = page.getByRole('slider', { name: 'Move focus interval' });
  await pan.waitFor();
  const panResult = await committedPointerDrag(page, pan, active, { x: -36, y: 0 }, ['from', 'through']);
  assert.equal(panResult.afterRange.through - panResult.afterRange.from,
    panResult.beforeRange.through - panResult.beforeRange.from, 'pan changed focus duration');

  await cancelledPointerDrag(page, start, active, { x: 24, y: 0 }, async () => page.keyboard.press('Escape'));
  // Playwright's mouse API cannot directly initiate pointercancel, so dispatch
  // that event explicitly during an otherwise native drag.
  await cancelledPointerDrag(page, start, active, { x: 24, y: 0 }, async control =>
    control.dispatchEvent('pointercancel', { pointerId: 1, pointerType: 'mouse', bubbles: true }));
  await cancelledPointerDrag(page, start, active, { x: 24, y: 0 }, async (control, current) => {
    await control.evaluate(element => {
      if (!element.hasPointerCapture(1)) throw new Error('mouse drag did not acquire pointer capture');
      element.dataset.lostCaptureObserved = 'false';
      element.addEventListener('lostpointercapture', () => { element.dataset.lostCaptureObserved = 'true'; }, { once: true });
      element.releasePointerCapture(1);
    });
    // Pointer capture changes are processed at the next pointer event.
    await page.mouse.move(current.x + 1, current.y);
    assert.equal(await control.getAttribute('data-lost-capture-observed'), 'true',
      'Chromium did not dispatch lostpointercapture after native release');
  });

  const timeline = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  timeline.on('pageerror', error => pageErrors.push(`pointer timeline: ${error.message}`));
  await timeline.goto(`${origin}/timeline?view=concurrent&${scope}`);
  await ensureWorkspace(timeline, { results: false });
  const vertical = timeline.getByRole('button', { name: 'Adjust focus through time' });
  const verticalResult = await committedPointerDrag(timeline, vertical, '.focus-range-band', { x: 0, y: 30 }, ['through']);
  assert.ok(verticalResult.afterRange.through < verticalResult.beforeRange.through);
  await timeline.close();
}

(async () => {
  const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'carto-focus-workspace-')));
  const artifacts = path.join(os.tmpdir(), 'carto-focus-workspace-artifacts');
  fs.mkdirSync(artifacts, { recursive: true });
  const fixture = createFocusWorkspaceFixture(work);
  const apiPort = await unusedPort();
  const uiPort = await unusedPort();
  const config = path.join(work, 'config.json');
  fs.writeFileSync(config, JSON.stringify({ turbo: { enabled: false, url: `http://127.0.0.1:${apiPort}` } }));
  const env = isolatedEnvironment(work, fixture.corpus, apiPort, config);
  for (const directory of [env.CARTOGRAPHER_CLAUDE_TRANSCRIPTS_DIR, env.CARTOGRAPHER_CODEX_TRANSCRIPTS_DIR, env.CARTOGRAPHER_CODEX_ARCHIVED_DIR]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  const viteArgs = [path.join(root, 'explorer/node_modules/vite/bin/vite.js'), ...(preview ? ['preview'] : []),
    '--host', '127.0.0.1', '--port', String(uiPort), '--strictPort'];
  const vite = spawn(process.execPath, viteArgs, { cwd: path.join(root, 'explorer'), env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  vite.stdout.on('data', chunk => output += chunk);
  vite.stderr.on('data', chunk => output += chunk);
  let browser;
  let page;
  try {
    const origin = `http://127.0.0.1:${uiPort}`;
    for (let attempt = 0; ; attempt++) {
      try { if ((await fetch(origin)).ok) break; } catch {}
      if (attempt >= 100) throw new Error(`Explorer did not start.\n${output}`);
      await pause(100);
    }
    const expectedCwd = fs.realpathSync(path.join(root, 'explorer'));
    const listenerCwd = execFileSync('lsof', ['-a', '-p', String(vite.pid), '-d', 'cwd', '-Fn'], { encoding: 'utf8' })
      .split('\n').find(line => line.startsWith('n'))?.slice(1);
    assert.equal(listenerCwd && fs.realpathSync(listenerCwd), expectedCwd, 'the UI listener must run from this worktree');
    if (preview) {
      const indexBody = await (await fetch(origin)).text();
      const assetPath = indexBody.match(/<script[^>]+src="([^"]+\.js)"/)?.[1];
      assert.ok(assetPath, 'built preview did not reference a JavaScript application asset');
      const assetResponse = await fetch(new URL(assetPath, origin));
      assert.equal(assetResponse.status, 200);
      assert.match(await assetResponse.text(), /Edit time range/,
        'built listener is not serving the redesigned Memory workspace asset');
    } else {
      const sourceResponse = await fetch(`${origin}/src/components/WorkingMemory.jsx`);
      assert.equal(sourceResponse.status, 200);
      const sourceBody = await sourceResponse.text();
      assert.match(sourceBody, /FocusToolbar/);
      assert.match(sourceBody, /useFocusWorkspace/);
    }
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    const scope = `from=${encodeURIComponent(fixture.isoFrom)}&through=${encodeURIComponent(fixture.isoThrough)}&project=alpha`;

    if (viewportProof) {
      await verifyViewportUnion(page, origin, fixture);
      assert.deepEqual(pageErrors, []);
      console.log('PASS: seven-day focus remains loaded under a one-day visual frame');
      return;
    }

    await page.goto(`${origin}/memory?${scope}`);
    await ensureWorkspace(page);

    await runPointerProof(page, browser, origin, scope, pageErrors);
    if (pointerProof) {
      assert.deepEqual(pageErrors, []);
      console.log('PASS: horizontal and vertical pointer focus gestures');
      return;
    }
    // Pointer proof intentionally commits several ranges. Reset the full
    // journey to its exact fixture URL without carrying those interactions.
    await page.goto(`${origin}/memory?${scope}`);
    await ensureWorkspace(page);

    // Independent contract proof: exact boundaries, task identity, project
    // exclusion, shared-file provenance, and evidence beyond the display tail.
    const response = await page.request.get(`${origin}/api/activity-scope?${scope}&limit=500`);
    const responseBody = await response.text();
    assert.equal(response.status(), 200, `activity scope failed: ${responseBody}`);
    const contract = JSON.parse(responseBody);
    const ids = new Set(contract.focused.evidenceIndex.map(record => record.id));
    assert.ok(ids.has('alpha-left-edge'));
    assert.ok(ids.has('alpha-right-edge'));
    assert.ok(ids.has('alpha-hidden-match'));
    assert.ok(ids.has('anonymous-legacy-event'));
    assert.ok(!ids.has('alpha-before'));
    assert.ok(!ids.has('alpha-after'));
    assert.ok(!ids.has('mixed-project'));
    assert.deepEqual(contract.focused.sessions.map(session => session.id).sort(),
      ['alpha-task', 'beta-task', 'missing-task', 'solo-task', 'unavailable-task', 'wide-task']);
    const sharedFile = contract.focused.fileIndex.find(file => file.path === fixture.shared);
    assert.deepEqual(sharedFile.contributors, ['alpha-task', 'beta-task']);
    assert.equal(sharedFile.contributorCount, 2);
    assert.ok(!contract.focused.fileIndex.some(file => file.path === fixture.missing),
      'a missing recorded file must not become reviewable workspace state');
    assert.equal(contract.focused.coverage.evidenceComplete, true);
    const missingReview = await page.request.get(`${origin}/api/memory/file?session=missing-task&path=${encodeURIComponent(fixture.missing)}&from=${encodeURIComponent(fixture.isoFrom)}&through=${encodeURIComponent(fixture.isoThrough)}`);
    assert.equal(missingReview.status(), 404);

    await page.getByText('Alpha focus boundary task', { exact: true }).waitFor();
    await page.getByText('Other project control', { exact: true }).waitFor({ state: 'hidden' });
    await page.getByText('6 tasks', { exact: true }).waitFor();
    await page.screenshot({ path: path.join(artifacts, 'focus-memory-1440.png'), fullPage: true });
    await noHorizontalOverflow(page, 'memory 1440');

    // Query matching must use complete evidence, even though the matching note
    // has been displaced beyond the latest-60 display preview.
    const find = page.getByRole('searchbox', { name: 'Find in this window' });
    await find.fill('buried-needle');
    await page.getByText('1 tasks', { exact: true }).waitFor();
    await page.getByText('Alpha focus boundary task', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Clear find' }).click();

    // One explicit save survives reload. Return restores immutable endpoints;
    // Since saved keeps the saved right edge as its open lower boundary.
    await page.getByRole('button', { name: 'Edit time range', exact: true }).click();
    await page.getByRole('button', { name: 'Use this window as return point', exact: true }).click();
    await page.getByRole('button', { name: 'Go to return point', exact: true }).waitFor();
    const saved = await page.evaluate(() => {
      const entries = [];
      for (let index = 0; index < localStorage.length; index++) {
        const key = localStorage.key(index);
        if (key?.startsWith('cartographer.saved-focus.v1:')) entries.push([key, localStorage.getItem(key)]);
      }
      return entries;
    });
    assert.equal(saved.length, 1);
    const savedEnvelope = JSON.parse(saved[0][1]);
    assert.equal(savedEnvelope.current.from, fixture.from);
    assert.equal(savedEnvelope.current.through, fixture.through);
    await page.reload();
    await ensureWorkspace(page);
    await page.getByRole('button', { name: 'Go to return point', exact: true }).waitFor();

    // An open range editor keeps the user's draft across a live poll, then
    // Cancel closes without mutating the committed URL.
    const beforeDraft = page.url();
    await page.getByRole('button', { name: 'Edit time range', exact: true }).click();
    const editor = page.getByRole('region', { name: 'Edit time range' });
    const exactFrom = editor.getByRole('textbox', { name: 'Exact focus from' });
    const originalField = await exactFrom.inputValue();
    const draftField = originalField.replace(/\d\d$/, value => value === '59' ? '58' : String(Number(value) + 1).padStart(2, '0'));
    await exactFrom.fill(draftField);
    const automaticPoll = page.waitForResponse(response =>
      response.url().includes('/api/memory/state') && response.status() === 200,
    { timeout: 35_000 });
    await automaticPoll;
    assert.equal(await exactFrom.inputValue(), draftField, 'source polling reset an in-progress exact-time draft');
    assert.equal(page.url(), beforeDraft);
    await editor.getByRole('button', { name: 'Cancel', exact: true }).click();
    await editor.waitFor({ state: 'hidden' });
    await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Edit time range');

    const horizontal = page.getByRole('slider', { name: 'Adjust focus start' });
    const beforeHorizontal = page.url();
    assert.equal(await horizontal.isEnabled(), true);
    await horizontal.focus();
    await page.keyboard.down('ArrowRight');
    await page.keyboard.up('ArrowRight');
    await page.waitForFunction(url => location.href !== url, beforeHorizontal);
    assert.notEqual(new URL(page.url()).searchParams.get('from'), fixture.isoFrom);
    await page.getByRole('button', { name: 'Go to return point', exact: true }).click();
    await page.waitForFunction(expected => new URL(location.href).searchParams.get('from') === expected, fixture.isoFrom);
    const beforeHorizontalCancel = page.url();
    await horizontal.focus();
    await page.keyboard.down('ArrowRight');
    await page.keyboard.press('Escape');
    await page.keyboard.up('ArrowRight');
    assert.equal(page.url(), beforeHorizontalCancel, 'Escape must cancel a horizontal draft without history');
    await page.getByRole('button', { name: 'Edit time range', exact: true }).click();
    await page.getByRole('button', { name: 'Since return point', exact: true }).click();
    await page.waitForFunction(expected => {
      const url = new URL(location.href);
      return url.searchParams.get('mode') === 'since-saved' && url.searchParams.get('lower') === 'open'
        && Date.parse(url.searchParams.get('from')) === expected;
    }, fixture.through);
    await page.getByRole('button', { name: 'Go to return point', exact: true }).click();

    // A slow query remains one history transaction regardless of pauses.
    await find.pressSequentially('needle', { delay: 800 });
    assert.equal(new URL(page.url()).searchParams.get('q'), 'needle');
    await page.goBack();
    await page.waitForFunction(() => !new URL(location.href).searchParams.has('q'));

    // Files retain contributing-task provenance and document mode in the URL.
    await page.getByRole('button', { name: 'Files', exact: true }).click();
    await page.getByText('shared-brief.md', { exact: true }).click();
    const contributor = page.getByRole('combobox', { name: 'Contributing task' });
    await contributor.waitFor();
    assert.deepEqual((await contributor.locator('option').allTextContents()).sort(),
      ['Alpha focus boundary task', 'Beta shared file task']);
    await page.getByRole('button', { name: 'Changes', exact: true }).click();
    await page.getByRole('region', { name: 'Artifact changes' }).waitFor();
    await page.getByText('Beta added provenance.', { exact: false }).waitFor();
    await page.getByRole('button', { name: 'Current file', exact: true }).click();
    await page.getByRole('button', { name: 'Preview', exact: true }).waitFor();
    await page.getByText('Beta added provenance.', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Source', exact: true }).click();
    assert.equal(new URL(page.url()).searchParams.get('doc'), 'source');
    await page.getByLabel('File source').getByText('Beta added provenance.', { exact: false }).waitFor();
    const selectedContributor = await contributor.inputValue();
    await contributor.selectOption(selectedContributor === 'alpha-task' ? 'beta-task' : 'alpha-task');
    assert.equal(new URL(page.url()).searchParams.get('contributor'),
      selectedContributor === 'alpha-task' ? 'beta-task' : 'alpha-task');

    // File → task → result list consumes two Escape presses and restores a
    // useful result target rather than BODY.
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Back to results' }).waitFor();
    assert.equal(new URL(page.url()).searchParams.has('review'), false);
    assert.equal(new URL(page.url()).searchParams.has('session'), true);
    await page.keyboard.press('Escape');
    await page.getByRole('region', { name: 'Work results' }).waitFor();
    await page.waitForFunction(expected => document.activeElement?.closest('[data-entry]')?.dataset.entry === expected, fixture.shared);
    assert.equal(new URL(page.url()).searchParams.has('session'), false);

    // A working-tree-only file still has explicit bounded provenance and a
    // separately labeled current workspace view.
    await page.getByText('unavailable-diff.txt', { exact: true }).click();
    await page.getByRole('region', { name: 'Artifact changes' }).waitFor();
    await page.getByText(/Alpha updates shared brief/).waitFor();
    await page.getByRole('button', { name: 'Current file', exact: true }).click();
    await page.getByLabel('File source').getByText('Current workspace state only.', { exact: false }).waitFor();
    // Closing the file removes the focused review control. Focus must be back
    // inside the inspector before any frame runs, or a quick second Escape
    // lands on BODY and never closes the task (release run 36275746146).
    const releaseFrames = await holdAnimationFrames(page);
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Back to results' }).waitFor();
    const focusAfterFileClose = await page.evaluate(() => {
      const active = document.activeElement;
      return { inInspector: Boolean(active?.closest('[aria-label="Evidence inspector"]')), label: active?.getAttribute('aria-label') || active?.tagName };
    });
    assert.ok(focusAfterFileClose.inInspector,
      `closing the file left focus outside the inspector until the next frame: ${focusAfterFileClose.label}`);
    await page.keyboard.press('Escape');
    await releaseFrames();
    await page.waitForFunction(() => !new URL(location.href).searchParams.has('session'));

    // Closing a file review returns focus to that file's row, including a row
    // past the task view's first eight. The inspector places focus in the
    // commit that closes the review, so the row has to exist on the task
    // view's first pass rather than after an effect widens the list.
    await page.getByRole('button', { name: 'Tasks', exact: true }).click();
    await page.locator('[data-entry="wide-task"] .fw-result-open').click();
    const inspector = page.locator('aside[aria-label="Evidence inspector"]');
    const fileRows = inspector.locator('a.ms-file');
    const deepFile = fixture.wide[0];
    const deepRow = inspector.locator(`a.ms-file[data-file-path="${deepFile}"]`);
    await fileRows.first().waitFor();
    // Without these, the focus checks below pass against a row the first
    // eight already include.
    assert.equal(await fileRows.count(), 8, 'the wide task should open showing its first eight file rows');
    assert.equal(await deepRow.count(), 0, 'the earliest-edited file should start beyond the first eight rows');
    await inspector.getByRole('button', { name: /^More files/ }).click();
    await deepRow.waitFor();
    const focusedFileRow = () => page.evaluate(() => {
      const active = document.activeElement;
      return active?.matches('a.ms-file') ? active.dataset.filePath : `${active?.tagName} ${active?.textContent.trim().slice(0, 60)}`;
    });
    for (const close of ['Escape', 'Back to task']) {
      await deepRow.click();
      await page.getByRole('region', { name: 'File review' }).waitFor();
      const releaseCloseFrames = await holdAnimationFrames(page);
      if (close === 'Escape') await page.keyboard.press('Escape');
      else await page.getByRole('button', { name: 'Back to task', exact: true }).click();
      await page.getByRole('button', { name: 'Back to results' }).waitFor();
      assert.equal(await focusedFileRow(), deepFile, `closing the review with ${close} did not focus the file's row`);
      await releaseCloseFrames();
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert.equal(await focusedFileRow(), deepFile, `focus left the file's row after closing the review with ${close}`);
    }
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !new URL(location.href).searchParams.has('session'));

    // Appends preserve fixed scope. The matching project gains one named task;
    // an unrelated project arrival never appears in the scoped results.
    await page.getByRole('button', { name: 'Tasks', exact: true }).click();
    fixture.append([fixture.newEvent('new-alpha-task'), fixture.newEvent('new-beta-task')]);
    await pause(2500);
    await page.locator('.fw-coverage > summary').click();
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await page.getByText('New alpha task in fixed focus', { exact: true }).waitFor({ timeout: 15_000 });
    await page.getByText('7 tasks', { exact: true }).waitFor();
    assert.equal(await page.getByText('Unrelated beta arrival', { exact: true }).count(), 0);
    assert.equal(new URL(page.url()).searchParams.get('from'), fixture.isoFrom);
    assert.equal(new URL(page.url()).searchParams.get('through'), fixture.isoThrough);

    // Root legacy concurrent and the explicit /timeline route share the exact
    // scope, vertical gesture reducer, and retained Event Feed/Sessions views.
    const timeline = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
    timeline.on('pageerror', error => pageErrors.push(`timeline: ${error.message}`));
    await timeline.goto(`${origin}/?view=concurrent&${scope}`);
    await timeline.getByRole('button', { name: 'Edit time range', exact: true }).waitFor({ timeout: 60_000 });

    // Context framing changes only the viewport. A one-day frame around a
    // seven-day focus must retain the seven-day focused projection and request
    // a loaded union wide enough to support it.
    await verifyViewportUnion(timeline, origin, fixture);
    console.log('PASS: seven-day focus remains loaded under a one-day visual frame');

    await timeline.getByRole('button', { name: 'Adjust focus through time' }).waitFor();
    const vertical = timeline.getByRole('button', { name: 'Adjust focus through time' });
    const beforeVertical = timeline.url();
    await vertical.press('ArrowDown');
    await timeline.waitForFunction(url => location.href !== url, beforeVertical);
    const beforeVerticalCancel = timeline.url();
    await vertical.focus();
    await timeline.keyboard.down('ArrowUp');
    await timeline.keyboard.press('Escape');
    await timeline.keyboard.up('ArrowUp');
    assert.equal(timeline.url(), beforeVerticalCancel, 'Escape must cancel a vertical draft without history');
    await timeline.getByRole('button', { name: 'Sessions', exact: true }).click();
    assert.equal(await timeline.getByRole('button', { name: 'Sessions', exact: true }).getAttribute('aria-pressed'), 'true');
    await timeline.locator('.timeline-session-result').getByTitle('alpha-task', { exact: true }).waitFor();
    const anonymous = timeline.getByText(/^Legacy Unattributed records · alpha · /);
    await anonymous.waitFor();
    const anonymousCard = anonymous.locator('xpath=ancestor::article[1]');
    assert.equal(await anonymousCard.getByRole('button', { name: 'Inspect evidence' }).count(), 0,
      'anonymous records must not create a fake inspectable task id');
    await anonymousCard.getByRole('button', { name: /View Session Events/ }).click();
    await anonymousCard.getByRole('button', { name: /tool_bash events/ }).click();
    await anonymousCard.getByText('Anonymous legacy observation remains reachable', { exact: true }).waitFor();
    await timeline.getByRole('button', { name: 'Event Feed', exact: true }).click();
    assert.equal(await timeline.getByRole('button', { name: 'Event Feed', exact: true }).getAttribute('aria-pressed'), 'true');
    const collapsedToolGroups = timeline.getByRole('button', { name: /tool_bash events/ });
    for (let index = 0, count = await collapsedToolGroups.count(); index < count; index++) {
      await collapsedToolGroups.nth(index).click();
    }
    await timeline.getByText('Alpha exact left boundary', { exact: true }).waitFor();
    await timeline.getByText('First same-time key-only legacy observation', { exact: true }).waitFor();
    await timeline.getByText('Second same-time key-only legacy observation', { exact: true }).waitFor();
    await timeline.screenshot({ path: path.join(artifacts, 'focus-timeline-1440.png'), fullPage: true });
    await noHorizontalOverflow(timeline, 'timeline 1440');
    await timeline.goto(`${origin}/timeline?${scope}&view=concurrent`);
    await timeline.getByRole('button', { name: 'Adjust focus through time' }).waitFor();
    assert.equal(new URL(timeline.url()).pathname, '/timeline');

    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: 'Edit time range', exact: true }).click();
    await page.getByRole('region', { name: 'Edit time range' }).waitFor();
    await noHorizontalOverflow(page, 'memory 390');
    await page.screenshot({ path: path.join(artifacts, 'focus-memory-390.png'), fullPage: true });
    await page.getByRole('region', { name: 'Edit time range' }).getByRole('button', { name: 'Cancel', exact: true }).click();

    const legacy = await browser.newPage({ viewport: { width: 1100, height: 850 }, reducedMotion: 'reduce' });
    await legacy.goto(`${origin}/memory?hours=1&at=${encodeURIComponent(fixture.isoThrough)}&end=${encodeURIComponent(fixture.isoThrough)}&catchup=hour&focus=charts&filter=landed`);
    await ensureWorkspace(legacy, { results: false });
    await legacy.getByRole('region', { name: 'Explore activity' }).waitFor();
    await legacy.getByRole('button', { name: 'Edit time range', exact: true }).click();
    await legacy.evaluate(() => { navigator.clipboard.writeText = async value => { window.__copiedFocusLink = value; }; });
    await legacy.getByRole('region', { name: 'Edit time range' }).getByRole('button', { name: 'Copy link to this window', exact: true }).click();
    const legacyURL = new URL(await legacy.evaluate(() => window.__copiedFocusLink));
    assert.equal(Date.parse(legacyURL.searchParams.get('through')) - Date.parse(legacyURL.searchParams.get('from')), 60 * 60 * 1000);
    assert.equal(legacyURL.searchParams.get('focus'), 'charts');
    assert.equal(legacyURL.searchParams.get('surface'), 'activity');
    assert.deepEqual(legacyURL.searchParams.get('evidence').split(',').sort(), ['commit', 'wrapup']);
    assert.equal(legacyURL.searchParams.has('filter'), false);
    await legacy.close();

    const deniedContext = await browser.newContext({ viewport: { width: 1100, height: 850 }, reducedMotion: 'reduce' });
    await deniedContext.addInitScript(() => {
      Storage.prototype.setItem = function deniedWrite() { throw new DOMException('denied', 'SecurityError'); };
    });
    const denied = await deniedContext.newPage();
    await denied.goto(`${origin}/memory?${scope}`);
    await ensureWorkspace(denied);
    await denied.getByRole('button', { name: 'Edit time range', exact: true }).click();
    await denied.getByRole('button', { name: 'Use this window as return point', exact: true }).click();
    await denied.getByText('This browser could not save the focus.', { exact: true }).waitFor();
    await deniedContext.close();

    assert.deepEqual(pageErrors, []);
    console.log(`PASS: exact focus workspace journeys; artifacts: ${artifacts}`);
  } catch (error) {
    try { if (page && !page.isClosed()) await page.screenshot({ path: path.join(artifacts, 'focus-workspace-failure.png'), fullPage: true }); } catch {}
    if (output.trim()) console.error(`Explorer output:\n${output}`);
    throw error;
  } finally {
    if (browser) await browser.close();
    try { execFileSync(process.execPath, [path.join(root, 'scripts/cartographer-turbo.js'), 'stop'], { env, stdio: 'ignore' }); } catch {}
    vite.kill('SIGTERM');
    fs.rmSync(work, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
