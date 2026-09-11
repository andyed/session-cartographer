// Real browser + managed controller, isolated from the user's config/corpus.
// Run: node tests/browser/memory-entry.cjs
// After an Explorer build: node tests/browser/memory-entry.cjs --preview
const { chromium } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn, execFileSync } = require('node:child_process');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..');
const preview = process.argv.includes('--preview');
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
    CARTOGRAPHER_EMBED_URL: 'http://127.0.0.1:1/v1/embeddings',
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
  // Keep legacy Explorer evidence in its own session so the existing memory
  // assertions still measure exactly 38/39 observations in their sessions.
  const explorerProject = 'explorer-fixture';
  const explorerSession = 'explorer-fixture-session';
  const explorerTranscript = path.join(transcriptRoot, `${explorerSession}.jsonl`);
  const explorerPrompt = 'Explain the Aurora calibration decision.';
  const explorerAnswer = 'Aurora calibration preserves the measured signal.';
  fs.writeFileSync(explorerTranscript, [
    { type: 'user', uuid: 'explorer-user-1', sessionId: explorerSession, timestamp: new Date(now - 300000).toISOString(), message: { role: 'user', content: explorerPrompt } },
    { type: 'assistant', uuid: 'explorer-assistant-1', sessionId: explorerSession, timestamp: new Date(now - 240000).toISOString(), message: { id: 'explorer-response-1', role: 'assistant', model: 'fixture-model', usage: { input_tokens: 240, cache_read_input_tokens: 40, output_tokens: 32 }, content: [{ type: 'text', text: explorerAnswer }] } },
  ].map(JSON.stringify).join('\n') + '\n');
  const explorerSummaries = [
    'Aurora calibration approved for release',
    'Aurora calibration research completed',
    'Aurora calibration session preserved',
  ];
  explorerSummaries.forEach((summary, i) => events.push({
    event_id: `explorer-event-${i}`, session_id: explorerSession,
    session_title: 'Aurora calibration', project: explorerProject,
    timestamp: new Date(now - 300000 + i * 60000).toISOString(),
    type: ['git_commit', 'research_search', 'milestone_session_end'][i],
    summary, transcript_path: explorerTranscript, cwd: corpus,
  }));
  const controlSummary = 'Aurora control belongs to another project';
  events.push({ event_id: 'explorer-control', session_id: 'explorer-control-session', project: 'explorer-control', timestamp: new Date(now - 210000).toISOString(), type: 'git_commit', summary: controlSummary });
  const document = path.join(corpus, 'handoff.md');
  const docSession = '12345678-1234-1234-1234-123456789abc';
  fs.writeFileSync(document, '# Return briefing\n\nThe original plan.\n');
  const git = args => execFileSync('git', ['-C', corpus, ...args], { stdio: 'ignore' });
  git(['init']);
  git(['add', 'handoff.md']);
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'Initial briefing']);
  fs.writeFileSync(document, '# Return briefing\n\nThe revised **plan**.\n\n| Work | State |\n| --- | --- |\n| Reader | Ready |\n\n<script>window.artifactExecuted = true</script>\n');
  events.push({ event_id: 'document-edit', session_id: docSession, session_title: 'Review the handoff', project: 'writing', provider: 'codex', timestamp: now - 500, type: 'tool_file_edit', file_path: document, summary: `Modified: ${document}`, cwd: corpus });
  fs.writeFileSync(log, events.map(e => JSON.stringify(e)).join('\n')+'\n');
  fs.appendFileSync(log, JSON.stringify({ event_id: 'archived-edit', session_id: 'archived-session', session_title: 'Earlier session', timestamp: now - 3 * 86400000, project: projects[0], type: 'tool_file_edit', file_path: target })+'\n');
  fs.writeFileSync(path.join(corpus, 'served-log.jsonl'), JSON.stringify({ event_id: 'fixture-result', call_id: 'fixture-call', timestamp: now, purpose: 'remember', rank: 1, project: 'fixture', source: 'changelog' })+'\n');
  const vite = spawn(process.execPath, [path.join(root, 'explorer/node_modules/vite/bin/vite.js'), ...(preview ? ['preview'] : []), '--host', '127.0.0.1', '--port', String(uiPort), '--strictPort'], { cwd: path.join(root, 'explorer'), env, stdio: ['ignore', 'pipe', 'pipe'] });
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
    async function apiJSON(endpoint) {
      const response = await page.request.get(origin + endpoint);
      assert.equal(response.status(), 200, `${endpoint}: expected the UI host to serve Explorer data, received ${response.status()}`);
      return response.json();
    }
    async function assertOverviewFits(targetPage, name) {
      // Check both document overflow and clipped content: hiding overflow alone
      // must not let a missing page of work masquerade as a bounded overview.
      await targetPage.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const layout = await targetPage.evaluate(() => {
        const visible = element => element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden';
        const rect = element => { const r = element.getBoundingClientRect(); return {left:r.left, top:r.top, right:r.right, bottom:r.bottom, width:r.width, height:r.height}; };
        const containers = [...document.querySelectorAll('.md-page, .md-instruments')].filter(visible);
        const rows = [...document.querySelectorAll('.md-page .md-thread, .md-page .md-artifact, .md-page .md-outcome, .md-page .md-project-summary')].filter(visible);
        return {
          width:innerWidth, height:innerHeight,
          scrollWidth:document.documentElement.scrollWidth, scrollHeight:document.documentElement.scrollHeight,
          containers:containers.map(element => ({name:element.className, ...rect(element), clipped:element.scrollHeight > element.clientHeight + 2})),
          rows:rows.map(rect),
          charts:[...document.querySelectorAll('.mw-stage')].filter(visible).map(rect),
        };
      });
      assert.ok(layout.scrollWidth <= layout.width + 1, `${name}: document overflows horizontally`);
      assert.ok(layout.scrollHeight <= layout.height + 1, `${name}: overview requires vertical scrolling`);
      for (const box of [...layout.containers, ...layout.rows]) {
        assert.ok(box.left >= -1 && box.right <= layout.width + 1 && box.top >= -1 && box.bottom <= layout.height + 1,
          `${name}: content outside viewport: ${JSON.stringify(box)}`);
      }
      for (const box of layout.containers) assert.equal(box.clipped, false, `${name}: ${box.name} hides or scrolls content`);
      for (let i = 1; i < layout.rows.length; i++) assert.ok(layout.rows[i - 1].bottom <= layout.rows[i].top + 1, `${name}: work rows overlap`);
      for (let i = 1; i < layout.charts.length; i++) assert.ok(layout.charts[i - 1].bottom <= layout.charts[i].top + 1, `${name}: charts overlap`);
    }
    async function verifyExplorer(phase) {
      const legacy = await browser.newPage({ viewport: { width: 1200, height: 880 }, reducedMotion: 'reduce' });
      legacy.on('pageerror', e => errors.push(`${phase}: ${e.message}`));
      try {
        await legacy.goto(origin + '/memory');
        await legacy.getByRole(phase === 'cold' ? 'button' : 'heading', { name: phase === 'cold' ? 'Enable Turbo' : 'Field', exact: true }).waitFor();
        // Verify route bodies and fixture identities: a 200 SPA fallback or an
        // unrelated service's response must not count as an API pass.
        const health = await apiJSON('/api/health');
        assert.equal(health.status, 'ok');
        assert.equal(health.files.changelog, true);
        const listed = await apiJSON('/api/events?limit=500');
        assert.ok(listed.events.some(event => event.event_id === 'explorer-event-0'));
        const filtered = await apiJSON(`/api/events?project=${explorerProject}`);
        assert.equal(filtered.events.length, 3);
        assert.ok(filtered.events.every(event => event.project === explorerProject));
        const projectList = await apiJSON('/api/projects');
        assert.ok(projectList.projects.includes(explorerProject));
        assert.ok(projectList.projects.includes('explorer-control'));
        const search = await apiJSON(`/api/search?q=aurora&project=${explorerProject}`);
        assert.ok(search.results.some(event => event.event_id === 'explorer-event-0'));
        assert.ok(search.results.every(event => event.project === explorerProject));
        assert.ok(search.meta.keyword_count > 0);
        const browse = await apiJSON(`/api/search?project=${explorerProject}`);
        assert.equal(browse.results.length, 3);
        assert.ok(browse.results.every(event => event.project === explorerProject));
        assert.deepEqual((await apiJSON('/api/search?q=aurora&project=missing-project')).results, []);
        assert.ok((await apiJSON('/api/autocomplete?prefix=auro')).suggestions.includes('aurora'));
        assert.ok((await apiJSON('/api/coterms?term=aurora')).terms.includes('calibration'));
        const session = (await apiJSON('/api/sessions?days=7')).sessions.find(item => item.session_id === explorerSession);
        assert.ok(session, 'Session timeline omitted the fixture session');
        assert.equal(session.event_count, 3);
        assert.equal(session.transcript_path, explorerTranscript);
        const transcriptQuery = `?path=${encodeURIComponent(explorerTranscript)}`;
        const recorded = await apiJSON('/api/transcript' + transcriptQuery);
        assert.equal(recorded.total, 2);
        assert.deepEqual(recorded.messages.map(message => message.content), [explorerPrompt, explorerAnswer]);
        const analysis = await apiJSON('/api/transcript/analysis' + transcriptQuery);
        assert.ok(analysis.summary?.totalTurns > 0, 'Transcript analysis fell back to missing enrichment');
        assert.ok(analysis.summary.totalTokens > 0, 'Transcript analysis omitted recorded token usage');

        const streaming = legacy.waitForResponse(response => new URL(response.url()).pathname === '/api/stream' && response.status() === 200, { timeout: 15000 });
        await legacy.getByRole('button', { name: 'timeline', exact: true }).click();
        await legacy.getByText(explorerSummaries[0], { exact: true }).waitFor();
        const streamResponse = await streaming;
        assert.match(streamResponse.headers()['content-type'], /^text\/event-stream/);
        const streamedSummary = `Explorer ${phase} stream arrived without a reload`;
        // Distinct projects prevent the two phases' events from collapsing
        // into one timeline group, which would hide the newly streamed text.
        fs.appendFileSync(log, JSON.stringify({ event_id: `explorer-stream-${phase}`, session_id: `explorer-stream-${phase}`, project: `explorer-stream-${phase}`, timestamp: new Date().toISOString(), type: 'research_search', summary: streamedSummary }) + '\n');
        await legacy.getByText(streamedSummary, { exact: true }).waitFor({ timeout: 15000 });
        await legacy.getByTitle(`Filter by ${explorerProject}`, { exact: true }).first().click();
        await legacy.getByText(explorerSummaries[0], { exact: true }).waitFor();
        await legacy.getByText(controlSummary, { exact: true }).waitFor({ state: 'hidden' });
        await legacy.getByText(streamedSummary, { exact: true }).waitFor({ state: 'hidden' });
        await legacy.getByRole('button', { name: 'Sessions', exact: true }).click();
        await legacy.getByTitle(explorerSession, { exact: true }).waitFor();
        await legacy.getByRole('button', { name: '▼ View Session Events', exact: true }).click();
        await legacy.getByTitle('Open transcript', { exact: true }).first().click();
        await legacy.getByPlaceholder('Search in transcript...').waitFor();
        await legacy.getByText(explorerAnswer, { exact: true }).waitFor();
        assert.ok(new URL(legacy.url()).pathname.startsWith('/session/'));
        await legacy.screenshot({ path: path.join(artifacts, `carto-explorer-${phase}-transcript.png`) });

        await legacy.goto(origin + '/?view=concurrent');
        await legacy.getByText(/\d+ sessions · \d+ overlaps/).waitFor();
        const lane = legacy.getByTitle(new RegExp(`^${explorerProject}\\n`)).first();
        await lane.waitFor();
        await legacy.screenshot({ path: path.join(artifacts, `carto-explorer-${phase}-sessions.png`) });
        await lane.click();
        await legacy.getByText(explorerAnswer, { exact: true }).waitFor();

        await legacy.goto(origin + `/?q=aurora&project=${explorerProject}`);
        await legacy.getByText(explorerSummaries[0], { exact: true }).waitFor();
        assert.equal(await legacy.getByText(controlSummary, { exact: true }).count(), 0);
        const searchInput = legacy.getByRole('combobox');
        await searchInput.fill('auro');
        await legacy.getByRole('option', { name: 'aurora', exact: true }).waitFor();
        const selectedSearch = legacy.waitForResponse(response => {
          const url = new URL(response.url());
          return url.pathname === '/api/search' && url.searchParams.get('q')?.trim() === 'aurora' && url.searchParams.get('project') === explorerProject;
        });
        await legacy.getByRole('option', { name: 'aurora', exact: true }).click();
        assert.equal((await selectedSearch).status(), 200);
        await legacy.getByText(explorerSummaries[0], { exact: true }).waitFor();
        await legacy.screenshot({ path: path.join(artifacts, `carto-explorer-${phase}-search.png`) });
        await legacy.goto(origin + `/?project=${explorerProject}`);
        await legacy.getByText(explorerSummaries[0], { exact: true }).waitFor();
        assert.equal(await legacy.getByText(controlSummary, { exact: true }).count(), 0);
        if (phase === 'cold') {
          assert.equal(fs.existsSync(path.join(work, 'turbo')), false, 'Legacy Explorer browsing started Turbo');
          assert.equal(JSON.parse(fs.readFileSync(config, 'utf8')).turbo.enabled, false, 'Legacy Explorer browsing enabled Turbo');
        }
      } finally {
        await legacy.close();
      }
    }
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
    await verifyExplorer('cold');
    await page.screenshot({ path: path.join(artifacts, 'carto-memory-entry.png') });
    await page.route('**/api/turbo/start', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Test startup failure. Try again.' }) }), { times: 1 });
    await page.getByRole('button', { name: 'Enable Turbo', exact: true }).click();
    await page.getByRole('alert').getByText('Test startup failure. Try again.').waitFor();
    await wait(5500);
    assert.equal(await page.getByRole('alert').isVisible(), true, 'Startup failure vanished during status polling');
    await page.getByRole('button', { name: 'Enable Turbo', exact: true }).click();
    await page.getByRole('heading', { name: 'Field', exact: true }).waitFor({ timeout: 20000 });
    await coldLink.getByRole('heading', {name:'Logged activity', exact:true}).waitFor({timeout:15000});
    await coldLink.close();
    assert.equal(JSON.parse(fs.readFileSync(config, 'utf8')).turbo.enabled, true);
    await verifyExplorer('warm');
    await page.screenshot({ path: path.join(artifacts, 'carto-memory-live.png') });
    // The work desk must preserve a return point across documents and reloads,
    // with new evidence appearing only after that exact boundary.
    const deskPage = await browser.newPage({ viewport: { width: 1280, height: 920 } });
    deskPage.on('pageerror', e => errors.push(e.message));
    await deskPage.goto(origin + '/memory');
    await deskPage.getByRole('region', { name: 'Work desk', exact: true }).waitFor();
    await deskPage.keyboard.press('/');
    assert.equal(await deskPage.getByLabel('Find sessions or artifacts').evaluate(el => document.activeElement === el), true);
    await deskPage.locator('.md-return summary').click();
    await deskPage.getByRole('button', { name: 'Set return point', exact: true }).click();
    await deskPage.locator('.md-return summary').click();
    const savedPoint = await deskPage.evaluate(() => localStorage.getItem('cartographer.return-point.v1'));
    assert.ok(Number(savedPoint) > now);
    fs.appendFileSync(log, JSON.stringify({ event_id: 'after-return', session_id: docSession, session_title: 'Review the handoff', provider: 'codex', project: 'writing', timestamp: Date.now() + 2, type: 'git_commit', summary: 'Commit abcdef1: clarify the return briefing', cwd: corpus }) + '\n');
    await deskPage.getByRole('button', { name: 'Landed', exact: true }).click();
    await deskPage.getByRole('link', { name: 'Commit abcdef1: clarify the return briefing' }).waitFor({ timeout: 15000 });
    await deskPage.reload();
    assert.equal(await deskPage.evaluate(() => localStorage.getItem('cartographer.return-point.v1')), savedPoint);
    await deskPage.getByRole('button', { name: 'All threads', exact: true }).click();
    await deskPage.getByRole('button', { name: 'Zoom to artifacts', exact: true }).click();
    await deskPage.getByRole('button', { name: /MD handoff.md/ }).click();
    await deskPage.getByRole('heading', { name: 'Return briefing', exact: true }).waitFor();
    assert.equal(await deskPage.getByRole('link', { name: 'Open in Codex' }).getAttribute('href'), `codex://threads/${docSession}`);
    assert.equal(await deskPage.evaluate(() => window.artifactExecuted), undefined);
    await deskPage.getByRole('cell', { name: 'Ready', exact: true }).waitFor();
    await deskPage.screenshot({ path: path.join(artifacts, 'carto-memory-markdown.png') });
    await deskPage.getByRole('button', { name: 'Source', exact: true }).click();
    assert.ok((await deskPage.getByLabel('File source').innerText()).includes('# Return briefing'));
    await deskPage.getByRole('button', { name: 'Current changes', exact: true }).click();
    await deskPage.getByRole('region', { name: 'Unified diff' }).waitFor();
    assert.ok((await deskPage.locator('.memory-artifact-diff-deletion').innerText()).includes('The original plan.'));
    assert.equal(await deskPage.locator('.memory-artifact-diff-addition').count(), 7);
    await deskPage.screenshot({ path: path.join(artifacts, 'carto-memory-diff.png') });
    await deskPage.getByLabel('Switch thread').selectOption('session-0');
    await deskPage.getByRole('heading', { name: 'Turbo facts', exact: true }).waitFor();
    await deskPage.getByRole('button', { name: 'Back to all sessions' }).click();
    await deskPage.getByRole('button', {name:'Zoom to artifacts',exact:true}).click();
    await deskPage.getByLabel('Find sessions or artifacts').fill('not-a-real-file');
    await deskPage.getByText('No artifacts match this view. Clear find or selection, or try All threads.', { exact: true }).waitFor();
    await deskPage.getByLabel('Find sessions or artifacts').fill('');
    await deskPage.getByRole('button', { name: 'All threads', exact: true }).click();
    await deskPage.getByRole('button', { name: 'Zoom to threads', exact: true }).click();
    await deskPage.setViewportSize({ width: 390, height: 844 });
    await deskPage.screenshot({ path: path.join(artifacts, 'carto-memory-desk-mobile.png') });
    assert.equal(await deskPage.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await deskPage.close();
    // The overview must expose the whole corpus through pages, with each page
    // fitting the window at readable row height rather than hiding overflow.
    const bounded = await browser.newPage({viewport:{width:1200,height:720},reducedMotion:'reduce'});
    bounded.on('pageerror', e => errors.push(e.message));
    await bounded.goto(origin + '/memory');
    await bounded.getByRole('region', {name:'Work desk',exact:true}).waitFor();
    const pageSize = Number(await bounded.locator('.memory-desk').getAttribute('data-page-size'));
    assert.ok(pageSize > 0 && pageSize < labels.length, `short laptop must exercise multiple pages, got page size ${pageSize}`);
    const seen = new Set();
    let pageCount = 0;
    for (;;) {
      await assertOverviewFits(bounded, `laptop page ${++pageCount}`);
      const names = await bounded.locator('.md-thread-title').allTextContents();
      assert.ok(names.length > 0 && names.length <= pageSize, 'page exceeds its visible capacity');
      for (const name of names) { assert.ok(!seen.has(name), `pagination repeated ${name}`); seen.add(name); }
      const next = bounded.getByRole('button',{name:'Next page',exact:true});
      if (await next.isDisabled()) break;
      assert.ok(pageCount < 20, 'pagination failed to reach its end');
      await next.click();
    }
    assert.ok(pageCount > 1, 'fixture did not exercise pagination');
    for (const name of [...labels, 'Review the handoff']) assert.ok(seen.has(name), `pagination omitted ${name}`);
    await bounded.getByRole('button',{name:'Previous page',exact:true}).click();
    await assertOverviewFits(bounded, 'previous page');
    await bounded.getByLabel('Find sessions or artifacts').fill('Waveforms');
    assert.deepEqual(await bounded.locator('.md-thread-title').allTextContents(), ['Waveforms'], 'filtering from a later page failed to reset pagination');
    await bounded.getByLabel('Find sessions or artifacts').fill('');
    for (const viewport of [{width:390,height:844},{width:1200,height:800},{width:1680,height:1000}]) {
      await bounded.setViewportSize(viewport);
      await wait(100);
      await assertOverviewFits(bounded, `${viewport.width}×${viewport.height}`);
      await bounded.screenshot({path:path.join(artifacts,`carto-bounded-${viewport.width}.png`)});
    }
    const chartHeights = () => bounded.locator('.mw-stage').evaluateAll(elements => Object.fromEntries(elements.map(element => [element.dataset.panel, element.getBoundingClientRect().height])));
    await bounded.setViewportSize({width:1440,height:800});
    await wait(100);
    const shortCharts = await chartHeights();
    await bounded.setViewportSize({width:1440,height:1100});
    await wait(100);
    const tallCharts = await chartHeights();
    assert.ok(tallCharts.field - shortCharts.field >= 250, `Field did not absorb window height: ${JSON.stringify({shortCharts,tallCharts})}`);
    assert.ok(Math.abs(tallCharts.wake - shortCharts.wake) <= 2, 'Wake grew with the desktop window');
    assert.ok(Math.abs(tallCharts.compare - shortCharts.compare) <= 2, 'Compare grew with the desktop window');
    await assertOverviewFits(bounded, 'tall desktop');
    await bounded.close();
    const brushed = await browser.newPage({ viewport: { width: 1360, height: 1000 }, reducedMotion: 'reduce' });
    brushed.on('pageerror', e => errors.push(e.message));
    await brushed.goto(origin + '/memory');
    await brushed.getByRole('heading', { name: 'Field', exact: true }).waitFor();
    assert.equal(await brushed.locator('.mw-stage').count(), 3, 'compact views must coexist');
    // A row and every chart share an identity. Focusing a mark reveals labels
    // without requiring pointer hover or muting any other thread's text.
    await brushed.getByRole('link', { name: 'Explore Turbo facts', exact: true }).focus();
    await brushed.locator('.mw-brush-label strong').getByText('Turbo facts', { exact: true }).waitFor();
    assert.equal(await brushed.locator('.md-thread[data-brushed=true] .md-thread-title').innerText(), 'Turbo facts');
    await brushed.keyboard.press('Space');
    await brushed.waitForURL(url => url.searchParams.get('brush') === 'session-0');
    assert.equal(await brushed.locator('.md-thread').count(), 1);
    const brushURL = brushed.url();
    await brushed.reload();
    await brushed.getByRole('button', { name: 'Clear selection', exact: true }).waitFor();
    assert.equal(brushed.url(), brushURL);
    assert.equal(await brushed.locator('.md-thread').count(), 1);
    await brushed.getByRole('button', { name: 'Zoom to artifacts', exact: true }).click();
    await brushed.locator('.md-artifact').waitFor();
    assert.ok((await brushed.locator('.md-artifact').innerText()).includes('field.js'));
    assert.equal(new URL(brushed.url()).searchParams.get('brush'), 'session-0', 'zoom lost the selected cohort');
    await brushed.screenshot({ path: path.join(artifacts, 'carto-brushed-artifacts.png') });
    await brushed.getByRole('button', { name: 'Zoom to projects', exact: true }).click();
    await brushed.locator('.md-project-summary').waitFor();
    await brushed.locator('.md-project-summary button').click();
    await brushed.locator('.md-thread').waitFor();
    assert.equal(new URL(brushed.url()).searchParams.get('brush'), 'session-0', 'project expansion lost the selected cohort');
    await brushed.keyboard.press('Escape');
    await brushed.waitForURL(url => !url.searchParams.has('brush'));
    // Brush one exact row across time. This selects its events, rather than
    // selecting an unrelated row solely by the last event's X coordinate.
    const wakeStage = brushed.locator('.mw-stage[data-panel=wake]');
    const wakeBox = await wakeStage.boundingBox();
    const targetY = await wakeStage.locator('[data-session="session-0"]').evaluate(el => parseFloat(el.style.top));
    await brushed.mouse.move(wakeBox.x + 13, wakeBox.y + targetY - .5);
    await brushed.mouse.down();
    await brushed.mouse.move(wakeBox.x + wakeBox.width - 13, wakeBox.y + targetY + .5, { steps: 12 });
    await brushed.mouse.up();
    await brushed.waitForURL(url => url.searchParams.get('brush') === 'session-0');
    assert.equal(await brushed.locator('.md-thread').count(), 1);
    await brushed.screenshot({ path: path.join(artifacts, 'carto-brushed-wake.png') });
    await brushed.keyboard.press('Escape');
    await brushed.waitForURL(url => !url.searchParams.has('brush'));
    await brushed.getByRole('button', { name: 'Brush', exact: true }).click();
    const fieldBox = await brushed.locator('.mw-stage[data-panel=field]').boundingBox();
    await brushed.mouse.move(fieldBox.x + 5, fieldBox.y + 45);
    await brushed.mouse.down();
    await brushed.mouse.move(fieldBox.x + 100, fieldBox.y + 120, {steps:5});
    await brushed.locator('.mw-stage[data-panel=field]').dispatchEvent('pointercancel', {pointerId:1});
    await brushed.mouse.up();
    assert.equal(new URL(brushed.url()).searchParams.has('brush'), false, 'cancelled brush committed a cohort');
    await brushed.close();
    const touch = await browser.newPage({ viewport: {width:390,height:844}, hasTouch:true, isMobile:true });
    touch.on('pageerror', e => errors.push(e.message));
    await touch.goto(origin + '/memory');
    await touch.getByRole('button', {name:'Charts', exact:true}).click();
    const touchWake = touch.locator('.mw-stage[data-panel=wake]');
    await touchWake.waitFor();
    await assertOverviewFits(touch, 'phone charts');
    const touchBox = await touchWake.boundingBox();
    const touchPoint = await touchWake.locator('[data-session="session-0"]').evaluate(el => ({x:parseFloat(el.style.left),y:parseFloat(el.style.top)}));
    await touch.touchscreen.tap(touchBox.x+touchPoint.x, touchBox.y+touchPoint.y);
    await touch.waitForURL(url => url.searchParams.get('brush') === 'session-0');
    assert.equal(new URL(touch.url()).searchParams.has('session'), false, 'touch inspection unexpectedly navigated into a thread');
    assert.equal(await touch.locator('.md-thread').count(), 1);
    await touch.getByRole('button', {name:'Overview', exact:true}).click();
    await assertOverviewFits(touch, 'phone brushed overview');
    await touch.screenshot({path:path.join(artifacts,'carto-brushed-mobile.png')});
    assert.equal(await touch.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    await touch.close();

    await page.getByRole('heading', { name: 'Compare', exact: true }).waitFor();
    await page.getByLabel('Comparison axes', {exact:true}).click();
    await page.getByLabel('Vertical dimension').selectOption('edit');
    await page.getByLabel('Horizontal dimension').selectOption('activeMs');
    await page.screenshot({ path: path.join(artifacts, 'carto-memory-compare.png') });
    await page.getByLabel('Vertical dimension').selectOption('output');
    await page.getByRole('link', { name: 'Explore Turbo facts', exact: true }).focus();
    await page.getByText('12K generated tokens', { exact: false }).waitFor();
    await page.getByRole('heading', { name: 'Field', exact: true }).waitFor();
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
    await page.getByRole('heading', { name: 'Wake', exact: true }).waitFor();
    await page.screenshot({ path: path.join(artifacts, 'carto-memory-wake.png') });
    await page.getByRole('link', { name: 'Brush Turbo facts in wake', exact: true }).focus();
    await page.keyboard.press('Enter');
    await page.getByRole('button', { name: 'Back to all sessions' }).click();
    await page.getByRole('heading', { name: 'Field', exact: true }).waitFor();
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
    await page.getByRole('button', {name:'Overview', exact:true}).waitFor();
    await assertOverviewFits(page, 'small phone overview');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    assert.equal(overflow, false, 'Mobile layout overflows');
    await page.screenshot({ path: path.join(artifacts, 'carto-memory-mobile.png') });
    await page.getByRole('button', {name:'Charts', exact:true}).click();
    await page.getByRole('heading', { name: 'Compare', exact: true }).waitFor();
    await page.getByLabel('Comparison axes', {exact:true}).click();
    await page.screenshot({ path: path.join(artifacts, 'carto-memory-compare-mobile.png') });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'Mobile comparison overflows');
    await page.getByRole('link', { name: 'Explore Turbo facts', exact: true }).focus();
    await page.keyboard.press('Enter');
    await page.screenshot({ path: path.join(artifacts, 'carto-memory-mobile-files.png') });
    await page.getByRole('button', { name: 'Back to all sessions' }).click();
    await page.getByRole('button', { name: 'search', exact: true }).click();
    await page.goBack();
    await page.getByRole('region', { name: 'Work desk', exact: true, includeHidden: true }).waitFor({state:'attached'});
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
    console.log('PASS: viewport-paged work desk, responsive Overview/Charts, Field height allocation, linked keyboard/region/touch brushing, semantic zoom, persisted return point, recorded outcomes, Markdown preview/source and safe HTML, numbered diff, native Codex link, thread switching; Explorer APIs, timeline, project filters, search/autocomplete, session views, transcript/enrichment, SSE with Turbo off/on; cold deep link, managed launch, live drill-down, session/file permalinks, copy link, reload, Back/Forward, replay window/axes, archived session, missing session, Internals, mobile, no page errors.');
  } catch (error) {
    if (output.trim()) console.error('Explorer server output:\n' + output);
    throw error;
  } finally {
    if (browser) await browser.close();
    try { execFileSync(process.execPath, [path.join(root, 'scripts/cartographer-turbo.js'), 'stop'], { env, stdio: 'ignore' }); } catch {}
    vite.kill('SIGTERM');
    fs.rmSync(work, { recursive: true, force: true });
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
