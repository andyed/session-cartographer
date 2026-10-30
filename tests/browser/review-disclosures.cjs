// Built UI proof for disclosure access, native targets and ranked Recall context.
// All API data is deterministic browser interception; no live corpus is read.
// Run: node tests/browser/review-disclosures.cjs (Playwright headless Chromium).
const { chromium } = require('@playwright/test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '../..');
const dist = path.join(root, 'explorer/dist');
const artifacts = path.join(os.tmpdir(), 'carto-review-disclosure-artifacts');
const HOUR = 3600000;

(async () => {
  fs.mkdirSync(artifacts, { recursive: true });
  const { projectMemory } = await import(pathToFileURL(path.join(root, 'explorer/server/memory.js')));
  const through = Math.floor(Date.now() / HOUR) * HOUR - HOUR, from = through - 6 * HOUR;
  const iso = value => new Date(value).toISOString();
  const scope = new URLSearchParams({ from: iso(from), through: iso(through), mode: 'fixed' }).toString();
  const events = Array.from({ length: 5 }, (_, index) => ({ event_id: `outcome-${index + 1}`, session_id: 'alpha-task', session_title: 'Alpha disclosure task', provider: 'codex', project: 'alpha', type: 'wrapup', timestamp: iso(through - (index + 1) * HOUR), summary: `Outcome ${index + 1}: recovered decision`, cwd: '/fixture/alpha' }));
  const snapshot = projectMemory(events, { now: through, hours: 24, corpusRoot: '/fixture' });
  assert.equal(snapshot.sessions[0].outcomes.length, 5, 'fixture must exceed the old three-outcome cap');
  const files = Object.fromEntries(Array.from({ length: 7 }, (_, i) => [`/fixture/alpha/reports/file-${i + 1}.md`, 1]));
  const day = {
    schema: 'carto.day-digest/1', tz: Intl.DateTimeFormat().resolvedOptions().timeZone, tz_abbrev: 'local', complete: false, start: iso(from), log_newest: iso(through),
    totals: { events: 12, commits_landed: 1, commits_moved: 0, commits_rewritten: 0, commits_missing: 0, commits_unverified: 0, commits_git_only: 1, active_minutes: 35, sessions: 1, projects: 1, pushes: 0 },
    agents: { codex: 1 }, hours: Array.from({ length: 24 }, (_, i) => i === 12 ? 12 : 0), scope: {}, unattributed: { project: 0 },
    projects: [{ name: 'alpha', kind: 'repo', active_minutes: 35, members: ['alpha'], files, files_unresolved: 0, investigations: [], investigation_outcomes: [],
      repo: { branch: 'main', dirty: 0, unpushed: '0' }, sessions: [{ id: 'alpha-task', provider: 'codex', first: iso(from), last: iso(through) }],
      commits: [{ sha: 'abc1234', hash: 'abc1234', subject: 'Recover disclosure access', status: 'landed', session_id: 'alpha-task', at: iso(through - HOUR), added: 3, removed: 1 }],
      git_only_commits: [{ sha: 'def5678', subject: 'Git-only destination control', at: iso(through - 2 * HOUR), added: 1, removed: 0 }],
    }],
  };
  const calls = ['shared', 'mixed'].map((id, i) => ({ call_id: id, query: `${id} context query`, session_id: 'alpha-task', provider: 'codex', timestamp: through - i * 60000, purpose: 'review', backend: 'fixture', served: 2, used: 1, fetched: 1, deepest_used_rank: 12, stray_marks: 0 }));
  const listing = { calls, totals: { calls: 2, attributed: 2, sessions: 1, unattributed: 0, served: 4, used: 2, fetched: 2 }, unplaced: { total: 0, by_status: {}, marks: [] }, purposes: { review: 2 }, truncated: 0 };
  function recallRows(id) {
    return [1, 12].map((rank, index) => ({ event_id: `${id}-result-${rank}`, rank, summary: `${id} source at served rank ${rank}`, resolution: 'corpus', source: id === 'mixed' && index ? 'transcript' : 'changelog',
      session_id: id === 'mixed' && index ? 'beta-task' : 'alpha-task', session_title: id === 'mixed' && index ? 'Beta exception task' : 'Alpha disclosure task',
      provider: id === 'mixed' && index ? 'claude' : 'codex', event_project: id === 'mixed' && index ? 'beta' : 'alpha',
      event_timestamp: through - (index + 2) * HOUR, session_range: { from, through }, used: index ? [{ attribution_status: 'explicit' }] : [], fetched: index ? [] : [{ at: through }],
    }));
  }
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname.startsWith('/api/')) { res.writeHead(503); res.end('API was not intercepted'); return; }
    const candidate = path.resolve(dist, `.${pathname}`);
    const file = candidate.startsWith(dist + path.sep) && fs.existsSync(candidate) && fs.statSync(candidate).isFile() ? candidate : path.join(dist, 'index.html');
    res.setHeader('Content-Type', file.endsWith('.js') ? 'application/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html');
    res.end(fs.readFileSync(file));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let browser, page;
  const errors = [], unexpected = [];
  try {
    const served = await (await fetch(origin)).text();
    const asset = served.match(/src="([^" ]+\.js)"/)?.[1];
    assert.ok(asset, 'isolated server must serve the checked-out built app');
    assert.match(await (await fetch(origin + asset)).text(), /Shared result context/);
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage({ viewport: { width: 1100, height: 1000 }, reducedMotion: 'reduce' });
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/api/**', async route => {
      const url = new URL(route.request().url());
      let body;
      if (url.pathname === '/api/turbo/status') body = { ready: true };
      else if (url.pathname === '/api/memory/state' || url.pathname === '/api/memory/session') body = snapshot;
      else if (url.pathname === '/api/activity-scope') body = { context: snapshot };
      else if (url.pathname === '/api/memory/day') body = day;
      else if (url.pathname === '/api/memory/recall/call') body = { rows: recallRows(url.searchParams.get('call')), stray_marks: [], resolution: { unresolved: 0, index_status: 'not-needed' } };
      else if (url.pathname === '/api/memory/recall') body = url.searchParams.has('session') ? { ...listing, calls: [], totals: { ...listing.totals, calls: 0 } } : listing;
      else if (url.pathname === '/api/session/artifacts') body = { artifacts: [], documents: [], commits: [] };
      else if (url.pathname === '/api/stream') return route.fulfill({ contentType: 'text/event-stream', body: 'retry: 60000\n\n' });
      else { unexpected.push(url.pathname); body = {}; }
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
    });

    await page.goto(`${origin}/memory?${scope}&session=alpha-task`);
    const outcomes = page.getByRole('region', { name: 'Recorded outcomes' });
    await outcomes.waitFor();
    assert.equal(await outcomes.locator('.ms-outcome:visible').count(), 3);
    assert.equal(await outcomes.getByText('Outcome 4: recovered decision', { exact: true }).isVisible(), false);
    await outcomes.locator('.ms-more-outcomes > summary').focus();
    await page.keyboard.press('Enter');
    await outcomes.getByText('Outcome 4: recovered decision', { exact: true }).waitFor();
    assert.equal(await outcomes.locator('.ms-outcome:visible').count(), 5);
    await page.screenshot({ path: path.join(artifacts, 'outcomes-expanded.png'), fullPage: true });

    await page.goto(`${origin}/memory?${scope}&surface=day`);
    const project = page.getByRole('region', { name: 'alpha', exact: true });
    await project.waitFor();
    assert.equal(await project.locator('.dd-path:visible').count(), 5);
    assert.equal(await project.getByText('file-6.md', { exact: true }).isVisible(), false);
    await project.locator('.dd-more-files > summary').click();
    await project.getByText('file-6.md', { exact: true }).waitFor();
    assert.equal(await project.locator('.dd-path:visible').count(), 7);
    assert.equal(await project.locator('.dd-path').first().textContent(), 'file-1.md');
    await project.locator('.path-context > summary').click();
    await project.locator('.path-context code').waitFor();
    assert.equal(await project.locator('.path-context code').textContent(), '/fixture/alpha/reports/');
    const commit = project.getByRole('link', { name: 'Open session for Recover disclosure access', exact: true });
    assert.equal(await commit.evaluate(el => el.tagName), 'A');
    assert.equal(new URL(await commit.getAttribute('href'), origin).searchParams.get('session'), 'alpha-task');
    assert.equal(await project.locator('.dd-commit[data-status="git_only"] a').count(), 0);
    const target = await commit.boundingBox(), row = await commit.locator('..').boundingBox();
    assert.ok(target.width >= row.width - 1 && target.height >= 44, 'the native anchor must own the row width and touch height');
    await page.screenshot({ path: path.join(artifacts, 'day-files-expanded.png'), fullPage: true });
    await commit.focus(); await page.keyboard.press('Enter');
    await page.waitForFunction(() => new URL(location.href).searchParams.get('session') === 'alpha-task');

    await page.goto(`${origin}/memory?${scope}&surface=recall&call=shared`);
    const shared = page.locator('[data-call="shared"]');
    await shared.getByRole('group', { name: 'Shared result context' }).waitFor();
    assert.equal(await shared.locator('[data-shared-session]').getAttribute('data-shared-session'), 'alpha-task');
    assert.equal(await shared.locator('[data-shared-project]').textContent(), 'alpha');
    assert.equal(await shared.locator('.rc-result .agent-badge').count(), 0, 'shared provider belongs once in result context');
    assert.deepEqual(await shared.locator('.rc-result').evaluateAll(nodes => nodes.map(node => [node.dataset.eventId, node.querySelector('.rc-rank').textContent])), [['shared-result-1', '1'], ['shared-result-12', '12']]);
    const time = shared.locator('.rc-result-time').first();
    assert.equal(await shared.getByText('Time from search', { exact: true }).count(), 1);
    assert.equal(await time.locator('summary').textContent(), '−2h');
    assert.match(await time.locator('summary').getAttribute('aria-label'), /2h before call/);
    await time.locator('summary').focus(); await page.keyboard.press('Enter');
    assert.equal(await time.locator('time').getAttribute('datetime'), iso(through - 2 * HOUR));
    assert.match(await time.locator('time').textContent(), new RegExp(String(new Date(through).getFullYear())));
    assert.equal(await shared.locator('.rc-result-destination .rc-markers').count(), 0, 'attribution and time controls must stay outside the episode link');
    await page.screenshot({ path: path.join(artifacts, 'recall-shared-exact-time.png'), fullPage: true });

    await page.locator('[data-call="mixed"] > .rc-call-toggle').click();
    const mixed = page.locator('[data-call="mixed"]');
    await mixed.locator('.rc-result').first().waitFor();
    assert.equal(await mixed.getByRole('group', { name: 'Shared result context' }).count(), 0);
    assert.deepEqual(await mixed.locator('.rc-result').evaluateAll(nodes => nodes.map(node => [node.dataset.sessionId, node.dataset.source, node.querySelector('.rc-rank').textContent])), [['alpha-task', 'changelog', '1'], ['beta-task', 'transcript', '12']]);
    await mixed.locator('.rc-result').nth(1).getByText('Beta exception task', { exact: true }).waitFor();
    assert.equal(await mixed.locator('.rc-result .agent-badge').count(), 2);
    assert.match(await mixed.locator('[data-used] .rc-used').textContent(), /rank 12/);
    await page.screenshot({ path: path.join(artifacts, 'recall-mixed-ranked.png'), fullPage: true });
    assert.deepEqual(errors, []);
    assert.deepEqual(unexpected, []);
    console.log(`PASS: built review disclosures, native targets and ranked context; ${asset}; artifacts: ${artifacts}`);
  } catch (error) {
    if (page) await page.screenshot({ path: path.join(artifacts, 'failure.png'), fullPage: true }).catch(() => {});
    throw error;
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
