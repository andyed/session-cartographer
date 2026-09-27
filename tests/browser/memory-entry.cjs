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
  // Past 500 characters a message truncates to "..." and an expand button;
  // the Markdown before the cut renders a heading, emphasis, a bullet, a
  // numbered item and a code block, each with a colour of its own.
  const explorerNotes = '## Calibration notes\nThe *measured* signal held across both runs.\n- Drift stayed inside the tolerance band.\n1. Re-run the sweep after the firmware update.\n```\ncalibrate --sweep\n```\n' + 'The sweep log is kept verbatim so the next run can be compared line by line. '.repeat(6);
  assert.ok(explorerNotes.length > 500, 'the notes must be long enough to truncate');
  const explorerTurn = (type, uuid, seconds, fields) => ({ type, uuid, sessionId: explorerSession, timestamp: new Date(now - seconds * 1000).toISOString(), ...fields });
  const explorerReply = (uuid, seconds, id, usage, content, fields = {}) => explorerTurn('assistant', uuid, seconds, { ...fields, message: { id, role: 'assistant', model: 'fixture-model', ...(usage ? { usage } : {}), content } });
  // Beyond the prompt and answer, one of everything the viewer draws in its
  // own colour: a slash command and a compaction summary, which collapse to
  // noise bars; the compaction banner, which needs input tokens before and
  // after the summary (1,200 then 300, so 1k → 300, −75%); three turns with
  // input tokens for the cache sparkline; a tool call for the summary card; a
  // sidechain agent's badge; and a progress row, shown under the system toggle.
  fs.writeFileSync(explorerTranscript, [
    explorerTurn('user', 'explorer-user-1', 300, { message: { role: 'user', content: explorerPrompt } }),
    explorerReply('explorer-assistant-1', 240, 'explorer-response-1', { input_tokens: 240, cache_read_input_tokens: 40, output_tokens: 32 }, [{ type: 'text', text: explorerAnswer }]),
    explorerTurn('user', 'explorer-command-1', 230, { message: { role: 'user', content: '<command-name>/calibrate</command-name>' } }),
    explorerReply('explorer-assistant-2', 220, 'explorer-response-2', { input_tokens: 300, cache_read_input_tokens: 900, output_tokens: 40 }, [{ type: 'text', text: explorerNotes }, { type: 'tool_use', id: 'toolu-fixture-1', name: 'Read', input: { file_path: 'calibration.md' } }]),
    explorerTurn('user', 'explorer-compact-1', 200, { isCompactSummary: true, message: { role: 'user', content: 'This session is being continued from a previous conversation that ran out of context.' } }),
    explorerReply('explorer-assistant-3', 180, 'explorer-response-3', { input_tokens: 150, cache_read_input_tokens: 150, output_tokens: 20 }, [{ type: 'text', text: 'Calibration resumed from the summary.' }]),
    explorerReply('explorer-agent-1', 170, 'explorer-agent-response-1', null, [{ type: 'text', text: 'The subagent checked the calibration table.' }], { isSidechain: true, agentId: 'fixture-agent' }),
    explorerTurn('progress', 'explorer-progress-1', 160, { data: { type: 'hook_progress' } }),
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
    summary, transcript_path: explorerTranscript, cwd: corpus, provider: 'claude',
    // The commit's hash renders in a card's detail, a colour of its own.
    ...(i === 0 ? { commit_hash: 'a1b2c3d4e5f60718' } : {}),
  }));
  // A second agent in the same window: the Explorer rendered a half-Codex
  // corpus as if it were one agent, so the fixture has to contain both or the
  // badge and the agent facet pass vacuously.
  const codexSummary = 'Aurora calibration reviewed from Codex';
  [0, 1].forEach(i => events.push({
    event_id: `explorer-codex-${i}`, session_id: 'explorer-codex-session',
    project: explorerProject, provider: 'codex',
    timestamp: new Date(now - 460000 + i * 60000).toISOString(),
    type: ['research_search', 'milestone_session_end'][i],
    summary: i === 0 ? codexSummary : 'Aurora calibration Codex session preserved',
  }));
  const controlSummary = 'Aurora control belongs to another project';
  events.push({ event_id: 'explorer-control', session_id: 'explorer-control-session', project: 'explorer-control', timestamp: new Date(now - 210000).toISOString(), type: 'git_commit', summary: controlSummary });
  const document = path.join(corpus, 'handoff.md');
  const largeFile = path.join(corpus, 'large-review.txt');
  const largeBaseline = Array.from({ length: 9000 }, (_, index) => `baseline ${String(index).padStart(5, '0')} ${'a'.repeat(32)}\n`).join('');
  const largeCurrent = Array.from({ length: 9000 }, (_, index) => `current ${String(index).padStart(5, '0')} ${'z'.repeat(34)}\n`).join('');
  assert.ok(Buffer.byteLength(largeCurrent) > 256 * 1024, 'large-file fixture must exceed the bounded preview limit');
  const docSession = '12345678-1234-1234-1234-123456789abc';
  fs.writeFileSync(document, '# Return briefing\n\nThe original plan.\n');
  fs.writeFileSync(largeFile, largeBaseline);
  const git = args => execFileSync('git', ['-C', corpus, ...args], { stdio: 'ignore' });
  git(['init']);
  git(['add', 'handoff.md', 'large-review.txt']);
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'Initial briefing']);
  fs.writeFileSync(document, '# Return briefing\n\nThe revised **plan**.\n\n| Work | State |\n| --- | --- |\n| Reader | Ready |\n\n<script>window.artifactExecuted = true</script>\n');
  fs.writeFileSync(largeFile, largeCurrent);
  events.push({ event_id: 'document-edit', session_id: docSession, session_title: 'Review the handoff', project: 'writing', provider: 'codex', timestamp: now + 1500, type: 'tool_file_edit', file_path: document, summary: `Modified: ${document}`, cwd: corpus });
  events.push({ event_id: 'large-document-edit', session_id: docSession, session_title: 'Review the handoff', project: 'writing', provider: 'codex', timestamp: now + 1400, type: 'tool_file_edit', file_path: largeFile, summary: `Modified: ${largeFile}`, cwd: corpus });
  fs.writeFileSync(log, events.map(e => JSON.stringify(e)).join('\n')+'\n');
  fs.appendFileSync(log, JSON.stringify({ event_id: 'archived-edit', session_id: 'archived-session', session_title: 'Earlier session', timestamp: now - 3 * 86400000, project: projects[0], type: 'tool_file_edit', file_path: target })+'\n');
  // Recall telemetry: one call with no session (the majority case on
  // 2026-09-26), and one attributed to session-0 whose only use mark sits at
  // rank 12. Rows cover the corpus, a transcript turn known only by its id, and
  // an id nothing resolves. A no_session mark names no call and must not be
  // credited to fixture-call even though that call served its event.
  const recallQuery = 'aurora calibration decision';
  const recallIds = ['explorer-event-0', 'session-1-3', 'session-2-5', 'turn-session-3-7', 'evt-gone-404', 'session-4-1', 'session-6-2', 'session-7-4', 'session-1-8', 'session-2-9', 'session-6-11', 'session-5-9'];
  fs.writeFileSync(path.join(corpus, 'served-log.jsonl'), [
    { event_id: 'fixture-result', call_id: 'fixture-call', timestamp: now, purpose: 'remember', rank: 1, project: 'fixture', source: 'changelog' },
    ...recallIds.map((event_id, i) => ({ event_id, call_id: 'recall-fixture-call', timestamp: new Date(now - 60000).toISOString(), purpose: 'remember', session_id: 'session-0', provider: 'claude', query: recallQuery, rank: i + 1, project: 'cartographer', source: i === 3 ? 'semantic' : 'changelog', backend: 'explorer' })),
  ].map(JSON.stringify).join('\n')+'\n');
  fs.writeFileSync(path.join(corpus, 'access-ledger.jsonl'), [
    { event_id: 'session-5-9', call_id: 'recall-fixture-call', requested_call_id: 'recall-fixture-call', timestamp: new Date(now - 30000).toISOString(), timestamp_ms: now - 30000, session_id: 'session-0', provider: 'claude', purpose: 'remember', source: 'result_used', access_batch_id: 'touch-fixture', access_ordinal: 1, attribution_status: 'explicit' },
    { event_id: 'fixture-result', timestamp: new Date(now - 20000).toISOString(), timestamp_ms: now - 20000, session_id: '', provider: 'unknown', purpose: 'remember', source: 'result_used', access_batch_id: 'touch-fixture-2', access_ordinal: 1, attribution_status: 'no_session' },
  ].map(JSON.stringify).join('\n')+'\n');
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
    async function refreshRecords(targetPage) {
      const coverage = targetPage.locator('.fw-coverage');
      if (await coverage.getAttribute('open') === null) await coverage.locator('summary').click();
      await coverage.getByRole('button', { name: 'Refresh', exact: true }).click();
    }
    async function assertOverviewFits(targetPage, name) {
      // Check both document overflow and clipped content: hiding overflow alone
      // must not let a missing page of work masquerade as a bounded overview.
      await targetPage.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const layout = await targetPage.evaluate(() => {
        const visible = element => element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden';
        const rect = element => { const r = element.getBoundingClientRect(); return {left:r.left, top:r.top, right:r.right, bottom:r.bottom, width:r.width, height:r.height}; };
        const containers = [...document.querySelectorAll('.md-page, .md-instruments')].filter(visible);
        const timeControls = [...document.querySelectorAll('[aria-label="Time window"], [aria-label="Expand time window"], [aria-label="Narrow time window"]')].filter(visible);
        const rows = [...document.querySelectorAll('.md-page .md-thread, .md-page .md-artifact, .md-page .md-outcome, .md-page .md-project-summary')].filter(visible);
        return {
          width:innerWidth, height:innerHeight,
          scrollWidth:document.documentElement.scrollWidth, scrollHeight:document.documentElement.scrollHeight,
          containers:containers.map(element => ({name:element.className, ...rect(element), clipped:element.scrollHeight > element.clientHeight + 2})),
          rows:rows.map(rect),
          timeControls:timeControls.map(rect),
          charts:[...document.querySelectorAll('.mw-stage')].filter(visible).map(rect),
        };
      });
      assert.ok(layout.scrollWidth <= layout.width + 1, `${name}: document overflows horizontally`);
      assert.ok(layout.scrollHeight <= layout.height + 1, `${name}: overview requires vertical scrolling`);
      for (const box of [...layout.containers, ...layout.rows, ...layout.timeControls]) {
        assert.ok(box.left >= -1 && box.right <= layout.width + 1 && box.top >= -1 && box.bottom <= layout.height + 1,
          `${name}: content outside viewport: ${JSON.stringify(box)}`);
      }
      for (const box of layout.containers) assert.equal(box.clipped, false, `${name}: ${box.name} hides or scrolls content`);
      for (let i = 1; i < layout.rows.length; i++) assert.ok(layout.rows[i - 1].bottom <= layout.rows[i].top + 1, `${name}: work rows overlap`);
      for (let i = 1; i < layout.charts.length; i++) assert.ok(layout.charts[i - 1].bottom <= layout.charts[i].top + 1, `${name}: charts overlap`);
    }
    async function chartGeometry(targetPage) {
      await targetPage.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      return targetPage.locator('.mw-stage').evaluateAll(stages => stages.map(stage => {
        const r = stage.getBoundingClientRect();
        return {panel:stage.dataset.panel,x:r.x,y:r.y,width:r.width,height:r.height,
          points:[...stage.querySelectorAll('.mw-target[data-session]')].map(el => {
            const p=el.getBoundingClientRect();
            return {id:el.dataset.session,hidden:el.hidden,x:p.x,y:p.y,width:p.width,height:p.height};
          })};
      }));
    }
    // WCAG contrast of every element that paints its own text under `scope`,
    // measured from computed styles against the ground it is painted on: each
    // ancestor's background composited from the canvas down, including a
    // translucent fill of the element's own, such as a badge tint. Each
    // colour's alpha is multiplied by the opacity above it. `placements` adds
    // hypothetical grounds for text that must stay legible wherever its row is
    // placed; layers inside the scope still composite over each one. `fixed`
    // names elements measured only where they render, because the caller
    // asserts they never move onto another ground. `exempt` names elements
    // measured and reported but never failed: a logotype or a decorative
    // glyph, which the page declares with data-contrast-exempt="<reason>" so
    // the exemption is visible in source review. Every measurement comes
    // back, so a caller can prove which ground it measured: a probe that finds
    // no text reports success on nothing. Running colour transitions settle
    // first: a classic card's selected background fades in, and a probe read
    // mid-fade measures a frame nobody reads. A text field paints its value,
    // or its placeholder while empty, and neither is a text node: the field
    // is measured for whichever it shows, the placeholder in the colour
    // getComputedStyle(field, '::placeholder') reports, labelled
    // `::placeholder`.
    async function textContrast(targetPage, scope, { placements = {}, fixed = null, exempt = null, floor = 8 } = {}) {
      await targetPage.evaluate(() => Promise.all(document.getAnimations()
        .filter(animation => animation instanceof CSSTransition)
        .map(animation => animation.finished.catch(() => {}))));
      return targetPage.evaluate(({ scope, placements, fixed, exempt, floor }) => {
        const channel = v => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
        const lum = ([r, g, b]) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
        const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
        const rgba = value => {
          if (!/^rgba?\(/.test(value)) throw new Error(`textContrast cannot measure the colour ${value}`);
          const [r, g, b, a = 1] = value.match(/[\d.]+/g).map(Number);
          return [r, g, b, a];
        };
        const opacities = new Map();
        const opacity = node => {
          if (!node) return 1;
          if (!opacities.has(node)) opacities.set(node, Number(getComputedStyle(node).opacity) * opacity(node.parentElement));
          return opacities.get(node);
        };
        const over = (ground, [r, g, b, a]) => [r, g, b].map((c, i) => c * a + ground[i] * (1 - a));
        // Painted backgrounds below `stop`, down to and including `element`, outermost first.
        const layers = (element, stop) => {
          const out = [];
          for (let node = element; node && node !== stop; node = node.parentElement) {
            const [r, g, b, a] = rgba(getComputedStyle(node).backgroundColor);
            if (a) out.unshift([r, g, b, a * opacity(node)]);
          }
          return out;
        };
        const hex = c => '#' + c.map(v => Math.round(v).toString(16).padStart(2, '0')).join('');
        const measured = [], failures = [], seen = new Set(), done = new Set();
        for (const root of document.querySelectorAll(scope)) {
          for (const element of [root, ...root.querySelectorAll('*')]) {
            if (done.has(element)) continue;
            done.add(element);
            if (!element.getClientRects().length || getComputedStyle(element).visibility === 'hidden') continue;
            const field = ['text', 'search', 'email', 'url', 'tel', 'number', 'password', 'textarea'].includes(element.type) && element.matches('input, textarea');
            const placeholder = field && element.matches(':placeholder-shown');
            const text = (field
              ? (placeholder ? element.placeholder : element.value)
              : [...element.childNodes].filter(node => node.nodeType === 3).map(node => node.textContent).join('')).trim();
            if (!text) continue;
            const [r, g, b, a] = rgba(getComputedStyle(element, placeholder ? '::placeholder' : null).color);
            const ink = [r, g, b, a * opacity(element)];
            const grounds = { actual: layers(element, null).reduce(over, [255, 255, 255]) };
            if (!(fixed && element.closest(fixed))) {
              const inner = layers(element, root);
              for (const [name, ground] of Object.entries(placements)) grounds[name] = inner.reduce(over, ground);
            }
            const label = (element.getAttribute('class') || element.tagName.toLowerCase()) + (placeholder ? '::placeholder' : '');
            const excused = Boolean(exempt && element.closest(exempt));
            for (const [on, ground] of Object.entries(grounds)) {
              const value = ratio(over(ground, ink), ground);
              measured.push({ element: label, text: text.slice(0, 40), color: hex(ink.slice(0, 3)), ground: hex(ground), on, ratio: Math.round(value * 100) / 100, ...(excused ? { exempt: element.closest(exempt).dataset.contrastExempt || 'selector' } : {}) });
              const key = `${label}|${hex(ink.slice(0, 3))}|${on}|${hex(ground)}`;
              if (value < floor && !excused && !seen.has(key)) {
                seen.add(key);
                failures.push(`${label} "${text.slice(0, 24)}" ${hex(ink.slice(0, 3))} ${value.toFixed(2)}:1 on ${on} ${hex(ground)}`);
              }
            }
          }
        }
        return { measured, failures };
      }, { scope, placements, fixed, exempt, floor });
    }
    // The row open in the inspector is painted --fw-selected (#153640), where
    // --fw-muted once measured 7.32:1. Measure every result row where it sits,
    // with the pointer off the list: a hovered row button is painted
    // --fw-surface over the selection, a ground nobody reads the row on.
    async function assertResultRowContrast(targetPage, selected, name) {
      await targetPage.mouse.move(1, 1);
      await targetPage.locator(selected).waitFor();
      const { measured, failures } = await textContrast(targetPage, '.fw-result-list');
      const onSelected = measured.filter(entry => entry.ground === '#153640');
      assert.ok(onSelected.length >= 3, `${name}: the probe must measure the selected row's text on #153640 (measured ${onSelected.length} of ${measured.length})`);
      assert.deepEqual(failures, [], `${name}: result text under 8:1`);
    }
    // The inspector's hand-off row (Open in Codex, Read conversation, Copy
    // resume command) holds 44px targets drawn with a focus ring. Each control
    // is left with Shift+Tab and re-entered with Tab so focus arrives from the
    // keyboard, and :focus-visible is asserted before the outline is read:
    // without it a present ring would read as missing.
    async function assertHandoffTargets(targetPage, name) {
      const inspector = targetPage.getByRole('complementary', { name: 'Evidence inspector' });
      // The inspector and its "Review in Memory" button draw before the task
      // arrives; until then it reads "Reading this task…" and has no hand-off
      // row. count() does not wait, so a slow runner counted 0 (CI, v0.8.0).
      // The task heading draws with the row, so wait for it first.
      await inspector.locator('.fw-inspector-identity h2').waitFor();
      const controls = inspector.locator('.md-handoff').locator('a, button');
      const count = await controls.count();
      assert.ok(count >= 2, `${name}: the fixture must render at least two hand-off controls (rendered ${count})`);
      const probes = [];
      for (let i = 0; i < count; i++) {
        const control = controls.nth(i);
        await control.focus();
        await targetPage.keyboard.press('Shift+Tab');
        await targetPage.keyboard.press('Tab');
        probes.push(await control.evaluate(el => {
          const style = getComputedStyle(el);
          return { label: el.textContent.trim(), focused: document.activeElement === el, visible: el.matches(':focus-visible'), height: el.getBoundingClientRect().height, outline: `${style.outlineStyle} ${style.outlineWidth} ${style.outlineColor}` };
        }));
      }
      assert.ok(probes.every(p => p.focused && p.visible), `${name}: Tab must reach every hand-off control with :focus-visible (${JSON.stringify(probes)})`);
      const failures = probes.flatMap(p => [
        ...(p.height < 44 ? [`${p.label}: ${p.height}px tall`] : []),
        ...(/^solid ([2-9]|\d{2,})(\.\d+)?px /.test(p.outline) ? [] : [`${p.label}: focus ring ${p.outline}`]),
      ]);
      assert.deepEqual(failures, [], `${name}: hand-off controls under 44px tall or without a 2px focus ring`);
    }
    async function verifyExplorer(phase) {
      const legacy = await browser.newPage({ viewport: { width: 1200, height: 880 }, reducedMotion: 'reduce' });
      legacy.on('pageerror', e => errors.push(`${phase}: ${e.message}`));
      // Every classic view is held to 8:1 on the ground its text sits on: the
      // page, a session card (#0d1019), an open session's event list
      // (#030712), the keyboard-active search result (#151a23), a hovered
      // group header, a selected facet pill's own fill, and the search
      // combobox: its placeholder on the field (#111827), its suggestion list
      // and co-term flyout (#1f2937) and their active rows (#374151). The
      // timeline's find field is measured empty on its own fill (#11151e). The
      // Transcript viewer is measured loading, then whole: its search field
      // empty on gray-900 (#111827), messages on the page and in the user's
      // bubble (#12161f), the summary card (#0e121d), the sidebar and
      // compaction banner (#030712) and a code block (#1f2937); then with the
      // system row shown and a message expanded, a sidebar category selected
      // (#1f2937), the sidebar collapsed, and a term entered, which tints a
      // matching message (#15120f) and marks each match. Failures collect
      // across the journey and fail once, so a regression names every element
      // at once. Each probe also proves it reached its ground: a probe that
      // measures nothing reports success. The pointer leaves the page first
      // unless the probe is measuring a hover. Exempt, and still reported:
      // what the page marks data-contrast-exempt, and the timeline pager's
      // disabled button (#a0a9b8 at 45% opacity, 2.53:1), an inactive control
      // WCAG 1.4.3 exempts. The pager is shared with no classic component and
      // its disabled style is the workspace's; that exemption is a flagged
      // decision, not a measured pass.
      const classicFailures = new Set(), classicMeasured = [];
      const classic = async (scope, view, { grounds = [], hover = false } = {}) => {
        if (!hover) await legacy.mouse.move(1, 1);
        const { measured, failures } = await textContrast(legacy, scope, { exempt: '[data-contrast-exempt], .timeline-focus-pages button:disabled' });
        for (const ground of grounds) assert.ok(measured.some(entry => entry.ground === ground && !entry.exempt), `${phase} ${view}: the probe measured no text on ${ground} (measured ${measured.length})`);
        failures.forEach(failure => classicFailures.add(`${view}: ${failure}`));
        classicMeasured.push(...measured.map(entry => ({ phase, view, ...entry })));
        return measured;
      };
      try {
        await legacy.goto(origin + '/memory');
        await legacy.getByRole('button', { name: phase === 'cold' ? 'Enable Turbo' : 'Edit time range', exact: true }).waitFor();
        // Verify route bodies and fixture identities: a 200 SPA fallback or an
        // unrelated service's response must not count as an API pass.
        const health = await apiJSON('/api/health');
        assert.equal(health.status, 'ok');
        assert.equal(health.files.changelog, true);
        const listed = await apiJSON('/api/events?limit=500');
        assert.ok(listed.events.some(event => event.event_id === 'explorer-event-0'));
        const filtered = await apiJSON(`/api/events?project=${explorerProject}`);
        // Three Claude events plus the two Codex ones in the same project.
        assert.equal(filtered.events.length, 5);
        assert.ok(filtered.events.every(event => event.project === explorerProject));
        const projectList = await apiJSON('/api/projects');
        assert.ok(projectList.projects.includes(explorerProject));
        assert.ok(projectList.projects.includes('explorer-control'));
        const search = await apiJSON(`/api/search?q=aurora&project=${explorerProject}`);
        assert.ok(search.results.some(event => event.event_id === 'explorer-event-0'));
        assert.ok(search.results.every(event => event.project === explorerProject));
        assert.ok(search.meta.keyword_count > 0);
        const browse = await apiJSON(`/api/search?project=${explorerProject}`);
        // Three Claude events plus the two Codex ones in the same project.
        assert.equal(browse.results.length, 5);
        assert.ok(browse.results.every(event => event.project === explorerProject));
        assert.deepEqual((await apiJSON('/api/search?q=aurora&project=missing-project')).results, []);
        assert.ok((await apiJSON('/api/autocomplete?prefix=auro')).suggestions.includes('aurora'));
        assert.ok((await apiJSON('/api/coterms?term=aurora')).terms.includes('calibration'));
        const session = (await apiJSON('/api/sessions?days=7')).sessions.find(item => item.session_id === explorerSession);
        assert.ok(session, 'Session timeline omitted the fixture session');
        assert.equal(session.event_count, 3);
        assert.equal(session.transcript_path, explorerTranscript);
        assert.equal(session.provider, 'claude', 'Session fold dropped the producing agent');
        const codexSession = (await apiJSON('/api/sessions?days=7')).sessions.find(item => item.session_id === 'explorer-codex-session');
        assert.equal(codexSession.provider, 'codex');
        // The old derivation could only ever build a ~/.claude/projects path,
        // so a Codex row must not carry one.
        assert.ok(!codexSession.transcript_path.includes('.claude/projects'), 'Codex session was handed a Claude transcript path');
        const agentFacets = (await apiJSON(`/api/search?project=${explorerProject}`)).facets.providers;
        assert.deepEqual(agentFacets.map(f => f.name).sort(), ['claude', 'codex'], 'Search facets omitted the agent dimension');
        const transcriptQuery = `?path=${encodeURIComponent(explorerTranscript)}`;
        const recorded = await apiJSON('/api/transcript' + transcriptQuery);
        assert.equal(recorded.total, 8);
        assert.deepEqual(recorded.messages.slice(0, 2).map(message => message.content), [explorerPrompt, explorerAnswer]);
        assert.deepEqual(recorded.messages.filter(message => message.noise).map(message => message.noise), ['slash-command', 'compaction-summary']);
        const analysis = await apiJSON('/api/transcript/analysis' + transcriptQuery);
        assert.ok(analysis.summary?.totalTurns > 0, 'Transcript analysis fell back to missing enrichment');
        assert.ok(analysis.summary.totalTokens > 0, 'Transcript analysis omitted recorded token usage');
        // The viewer draws a banner and a sparkline only from these.
        assert.deepEqual(analysis.compactionEvents, [{ uuid: 'explorer-compact-1', preTokens: 1200, postTokens: 300 }]);
        assert.equal(analysis.cacheTimeline.length, 3);
        assert.equal(analysis.isOngoing, false);

        const streaming = legacy.waitForResponse(response => new URL(response.url()).pathname === '/api/stream' && response.status() === 200, { timeout: 15000 });
        await legacy.getByRole('button', { name: 'timeline', exact: true }).click();
        await legacy.getByRole('button', { name: 'Event Feed', exact: true }).click();
        await legacy.getByRole('region', { name: 'Activity timeline' }).getByText(explorerSummaries[0], { exact: true }).waitFor();
        await classic('.timeline-focus-list', 'event feed', { grounds: ['#0a0a0f'] });
        // The find field is empty here, so it paints its placeholder, which
        // no rule coloured: it fell to Tailwind's preflight gray-400.
        const timelineFind = await classic('.focus-timeline-workspace .fw-find input', 'timeline find placeholder', { grounds: ['#11151e'] });
        assert.ok(timelineFind.some(entry => entry.element.endsWith('::placeholder') && entry.text === 'Find tasks, files, or recorded notes…'), `${phase}: the probe did not measure the timeline find placeholder (measured ${JSON.stringify(timelineFind)})`);
        // A group header paints a surface under the pointer; measure it there,
        // then open the group and measure the cards inside it.
        const groupHeader = legacy.locator('.timeline-focus-list .event-group > button').first();
        await groupHeader.hover();
        const hoveredGroup = await classic('.timeline-focus-list .event-group > button:hover', 'hovered group header', { hover: true });
        assert.ok(hoveredGroup.length >= 2 && hoveredGroup.every(entry => entry.ground !== '#0a0a0f'), `${phase}: the hovered group header painted no surface under its text`);
        await groupHeader.click();
        await classic('.timeline-focus-list .event-group', 'open event group', { grounds: ['#0a0a0f'] });
        const streamResponse = await streaming;
        assert.match(streamResponse.headers()['content-type'], /^text\/event-stream/);
        const streamedSummary = `Explorer ${phase} stream arrived without a reload`;
        // The exact focus stays fixed while the source stream remains live;
        // verify the append at the API boundary without widening that focus.
        fs.appendFileSync(log, JSON.stringify({ event_id: `explorer-stream-${phase}`, session_id: `explorer-stream-${phase}`, project: `explorer-stream-${phase}`, timestamp: new Date().toISOString(), type: 'research_search', summary: streamedSummary }) + '\n');
        await legacy.getByText('Live', { exact: true }).waitFor();
        await legacy.waitForFunction(async id => (await (await fetch('/api/events?limit=500')).json()).events.some(event => event.event_id === id), `explorer-stream-${phase}`);
        await legacy.getByTitle(`Filter by ${explorerProject}`, { exact: true }).first().click();
        await legacy.getByRole('region', { name: 'Activity timeline' }).getByText(explorerSummaries[0], { exact: true }).waitFor();
        await legacy.getByText(controlSummary, { exact: true }).waitFor({ state: 'hidden' });
        await legacy.getByRole('button', { name: 'Sessions', exact: true }).click();
        const explorerCard = legacy.getByTitle(explorerSession, { exact: true }).locator('xpath=ancestor::div[contains(@class,"border")][1]');
        await explorerCard.waitFor();
        await classic('.timeline-session-result', 'session cards', { grounds: ['#0d1019'] });
        // Select the fixture by session identity; newly streamed sessions can
        // legitimately sort ahead of it without changing transcript ownership.
        await explorerCard.getByRole('button', { name: '▼ View Session Events', exact: true }).click();
        await explorerCard.getByTitle('Open transcript', { exact: true }).first().waitFor();
        await classic('.timeline-session-result', 'open session', { grounds: ['#0d1019', '#030712'] });
        // Hold the transcript in flight to measure its loading line. The dev
        // host mounts the viewer twice and aborts the first request, whose
        // route is then already handled when it is released.
        let releaseTranscript;
        const heldTranscript = new Promise(resolve => { releaseTranscript = resolve; });
        const holdTranscript = url => url.pathname === '/api/transcript';
        await legacy.route(holdTranscript, async route => { await heldTranscript; await route.continue().catch(() => {}); });
        await explorerCard.getByTitle('Open transcript', { exact: true }).first().click();
        await legacy.getByText('Loading transcript...', { exact: true }).waitFor();
        await classic('#transcript-viewer', 'transcript loading', { grounds: ['#0a0a0f'] });
        releaseTranscript();
        await legacy.unroute(holdTranscript);
        const transcriptSearch = legacy.getByPlaceholder('Search in transcript...');
        await transcriptSearch.waitFor();
        await legacy.getByText(explorerAnswer, { exact: true }).waitFor();
        assert.ok(new URL(legacy.url()).pathname.startsWith('/session/'));
        // The summary card and the sidebar wait on the analysis.
        const attribution = legacy.locator('#transcript-attribution');
        await attribution.getByText('Token attribution', { exact: true }).waitFor();
        await legacy.screenshot({ path: path.join(artifacts, `carto-explorer-${phase}-transcript.png`) });
        // The empty search field shows its placeholder, read from the field's
        // ::placeholder style and measured on the field's own fill.
        const transcriptField = await classic('#transcript-toolbar input[type="text"]', 'transcript search placeholder', { grounds: ['#111827'] });
        assert.ok(transcriptField.some(entry => entry.element.endsWith('::placeholder') && entry.text === 'Search in transcript...'), `${phase}: the probe did not measure the transcript search placeholder (measured ${JSON.stringify(transcriptField)})`);
        // The whole viewer: messages on the page and in the user's bubble
        // (#12161f), the summary card (#0e121d), the sidebar and the
        // compaction banner (#030712), and a code block (#1f2937). Each entry
        // below is text the fixture renders in a colour of its own; the probe
        // must reach it on the ground it is read on.
        const reached = (entries, view, expected) => {
          for (const [text, ground] of expected) assert.ok(entries.some(entry => text.test(entry.text) && entry.ground === ground), `${phase} ${view}: the probe measured nothing matching ${text} on ${ground} (measured ${JSON.stringify(entries.map(entry => [entry.text, entry.ground]))})`);
        };
        const viewer = await classic('#transcript-viewer', 'transcript viewer', { grounds: ['#0a0a0f', '#12161f', '#0e121d', '#030712', '#1f2937'] });
        reached(viewer, 'transcript viewer', [
          [/^user$/, '#12161f'], [/^\d+m ago$/, '#12161f'], [/^fixture-model$/, '#0a0a0f'], [/^\d+m ago$/, '#0a0a0f'],
          [/^fixture-agent$/, '#0a0a0f'], [/^\/calibrate$/, '#0a0a0f'], [/^session continuation summary$/, '#0a0a0f'],
          [/^measured$/, '#0a0a0f'], [/^·$/, '#0a0a0f'], [/^1\.$/, '#0a0a0f'], [/^calibrate --sweep$/, '#1f2937'],
          [/^\.\.\.$/, '#0a0a0f'], [/^expand \(\d+ chars\)$/, '#0a0a0f'],
          [/^turns$/, '#0e121d'], [/^compactions$/, '#0e121d'], [/^cache$/, '#0e121d'], [/^\d+%$/, '#0e121d'],
          [/^⚡ compaction$/, '#030712'], [/^1k/, '#030712'], [/^→$/, '#030712'], [/^−75%$/, '#030712'],
          [/^▸$/, '#030712'], [/^Token attribution$/, '#030712'], [/^Thinking \/ text$/, '#030712'], [/^\d+%$/, '#030712'],
        ]);
        // The system toggle adds the progress row, labelled `system`, and an
        // expanded message relabels its button `collapse`.
        await legacy.locator('#transcript-toolbar').getByRole('checkbox', { name: 'system', exact: true }).check();
        await legacy.locator('#explorer-progress-1').waitFor();
        await legacy.locator('#explorer-assistant-2').getByRole('button', { name: /^expand/ }).click();
        const shown = await classic('#explorer-progress-1, #explorer-assistant-2', 'transcript system row and expanded message', { grounds: ['#0a0a0f'] });
        reached(shown, 'transcript system row and expanded message', [[/^system$/, '#0a0a0f'], [/^collapse$/, '#0a0a0f']]);
        await legacy.locator('#explorer-assistant-2').getByRole('button', { name: 'collapse', exact: true }).click();
        await legacy.locator('#transcript-toolbar').getByRole('checkbox', { name: 'system', exact: true }).uncheck();
        // A selected category is painted gray-800 and offers `clear filter`;
        // collapsed, the sidebar shows only its expand glyph.
        await attribution.getByRole('button', { name: /^Thinking \/ text/ }).click();
        await attribution.getByRole('button', { name: 'clear filter', exact: true }).waitFor();
        const selectedCategory = await classic('#transcript-attribution', 'selected attribution category', { grounds: ['#1f2937'] });
        reached(selectedCategory, 'selected attribution category', [[/^Thinking \/ text$/, '#1f2937'], [/^\d+%$/, '#1f2937'], [/^clear filter$/, '#030712']]);
        await attribution.getByRole('button', { name: 'clear filter', exact: true }).click();
        await attribution.getByTitle('Collapse', { exact: true }).click();
        await attribution.getByTitle('Expand token attribution', { exact: true }).waitFor();
        const collapsed = await classic('#transcript-attribution', 'collapsed attribution', { grounds: ['#030712'] });
        reached(collapsed, 'collapsed attribution', [[/^◂$/, '#030712']]);
        await attribution.getByTitle('Expand token attribution', { exact: true }).click();
        // A term adds the match count. The rest of the toolbar (back, the
        // system and noise toggles' labels, the message count) sits on the
        // page.
        await transcriptSearch.fill('aurora');
        await legacy.locator('#transcript-toolbar').getByText(/^\d+ match(es)?$/).waitFor();
        const toolbar = await classic('#transcript-toolbar', 'transcript toolbar', { grounds: ['#0a0a0f', '#111827'] });
        for (const text of [/^back$/, /^system$/, /^noise$/, /^\d+ messages?$/, /^\d+ match(es)?$/]) assert.ok(toolbar.some(entry => text.test(entry.text) && entry.ground === '#0a0a0f'), `${phase}: the transcript toolbar probe measured nothing matching ${text} on the page (measured ${JSON.stringify(toolbar)})`);
        // A matching message is tinted yellow-500/5 (#15120f), and each match
        // is marked on yellow-500/30 over its row.
        const matched = await classic('#transcript-viewer', 'transcript matches', { grounds: ['#15120f'] });
        assert.ok(matched.some(entry => entry.element.startsWith('bg-yellow-500/30') && /^aurora$/i.test(entry.text)), `${phase}: the probe measured no marked match`);
        await transcriptSearch.fill('');

        await legacy.goto(origin + '/?view=concurrent');
        await legacy.getByText(/\d+ tasks · \d+ records in focus · \d+ context tasks/).waitFor();
        const lane = legacy.locator(`a.concurrent-session[title*="${explorerProject}"]`).first();
        await lane.waitFor();
        await legacy.screenshot({ path: path.join(artifacts, `carto-explorer-${phase}-sessions.png`) });
        await lane.focus();
        await legacy.keyboard.press('Enter');
        await legacy.getByRole('link', { name: 'Read conversation ↗', exact: true }).click();
        await legacy.getByText(explorerAnswer, { exact: true }).waitFor();

        await legacy.goto(origin + `/?q=aurora&project=${explorerProject}`);
        await legacy.locator('main > div:not(.hidden)').getByText(explorerSummaries[0], { exact: true }).waitFor();
        assert.equal(await legacy.getByText(controlSummary, { exact: true }).count(), 0);
        const searchInput = legacy.getByRole('combobox');
        // An empty combobox shows its placeholder, read from the field's
        // ::placeholder style and measured on the field's own fill.
        await searchInput.fill('');
        const field = await classic('header [role="combobox"]', 'search placeholder', { grounds: ['#111827'] });
        assert.ok(field.some(entry => entry.element.endsWith('::placeholder') && entry.text === 'Search session history...'), `${phase}: the probe did not measure the search placeholder (measured ${JSON.stringify(field)})`);
        await searchInput.fill('auro');
        await legacy.getByRole('option', { name: 'aurora', exact: true }).waitFor();
        // The suggestion list is painted gray-800 and its active option
        // gray-700, and in each option the typed prefix is split from the
        // completion. Measure the list with no option active, then with one
        // active, then open the co-term flyout from the keyboard: its heading
        // and inactive terms sit on gray-800, its active term on gray-700,
        // and the option it belongs to is marked with a ›.
        await classic('#search-suggestions', 'suggestions', { grounds: ['#1f2937'] });
        await legacy.keyboard.press('ArrowDown');
        await legacy.locator('#search-suggestions [aria-selected="true"]').waitFor();
        await classic('#search-suggestions', 'active suggestion', { grounds: ['#374151'] });
        // No second grey clears 8:1 on the active row, so the split is made
        // with weight, and no contrast probe would fail if it were lost.
        const split = await legacy.locator('#search-suggestions [aria-selected="true"] > span').evaluateAll(spans => spans.map(span => ({ text: span.textContent, weight: Number(getComputedStyle(span).fontWeight) })));
        assert.ok(split[0]?.text === 'auro' && split[1]?.text === 'ra' && split[1].weight > split[0].weight, `${phase}: the completion must be set heavier than the typed prefix (got ${JSON.stringify(split)})`);
        await legacy.keyboard.press('ArrowRight');
        await legacy.locator('#search-coterms').waitFor();
        const flyout = await classic('#search-coterms', 'co-term flyout', { grounds: ['#1f2937', '#374151'] });
        assert.ok(flyout.some(entry => entry.text === 'with "aurora"'), `${phase}: the flyout probe measured no heading`);
        assert.ok(flyout.some(entry => entry.text.startsWith('+ ') && entry.ground === '#1f2937'), `${phase}: the flyout probe measured no inactive co-term`);
        const marked = await classic('#search-suggestions', 'flyout marker', { grounds: ['#374151'] });
        assert.ok(marked.some(entry => entry.text === '›'), `${phase}: the probe measured no flyout marker`);
        await legacy.screenshot({ path: path.join(artifacts, `carto-explorer-${phase}-suggestions.png`), clip: { x: 0, y: 0, width: 900, height: 360 } });
        // Leave the flyout, then close it, so the option's name is bare again.
        await legacy.keyboard.press('ArrowLeft');
        await legacy.keyboard.press('ArrowLeft');
        await legacy.locator('#search-coterms').waitFor({ state: 'detached' });
        const selectedSearch = legacy.waitForResponse(response => {
          const url = new URL(response.url());
          return url.pathname === '/api/search' && url.searchParams.get('q')?.trim() === 'aurora' && url.searchParams.get('project') === explorerProject;
        });
        await legacy.getByRole('option', { name: 'aurora', exact: true }).click();
        assert.equal((await selectedSearch).status(), 200);
        await legacy.locator('main > div:not(.hidden)').getByText(explorerSummaries[0], { exact: true }).waitFor();
        await legacy.evaluate(() => document.activeElement?.blur());
        await legacy.getByRole('listbox').waitFor({ state: 'hidden' });
        await classic('main > div:not(.hidden)', 'search results', { grounds: ['#0a0a0f'] });
        await classic('header', 'header', { grounds: ['#0a0a0f', '#374151'] });
        // The keyboard-active result is the classic views' selected surface
        // (bg-gray-800/50 over the page, #151a23), and the one selected
        // surface an AgentBadge renders on. Step through every result so each
        // agent in the fixture is measured there, and hold the whole card to
        // the floor, not only its badge.
        const activeCard = 'main > div:not(.hidden) .result-list > [data-event-id] > .ring-1';
        const resultCount = await legacy.locator('main > div:not(.hidden) .result-list > [data-event-id]').count();
        assert.ok(resultCount >= 2, `${phase}: the active-result check needs several results (got ${resultCount})`);
        const activeAgents = new Set();
        let activeId = null;
        for (let step = 0; step < resultCount; step++) {
          await legacy.keyboard.press('ArrowDown');
          await legacy.waitForFunction(({ selector, previous }) => {
            const card = document.querySelector(selector);
            return card && card.parentElement.dataset.eventId !== previous;
          }, { selector: activeCard, previous: activeId });
          activeId = await legacy.locator(activeCard).evaluate(card => card.parentElement.dataset.eventId);
          const card = await classic(activeCard, `active result ${activeId}`, { grounds: ['#151a23'] });
          assert.notEqual(await legacy.locator(activeCard).evaluate(card => getComputedStyle(card).backgroundColor), 'rgba(0, 0, 0, 0)', `${phase}: the active result painted no surface`);
          const badges = card.filter(entry => entry.element.includes('agent-badge'));
          assert.equal(badges.length, 1, `${phase}: expected one AgentBadge on active result ${activeId}`);
          assert.ok(card.length > badges.length + 2, `${phase}: the active-result probe measured only ${card.length} elements on ${activeId}`);
          activeAgents.add(badges[0].text);
        }
        assert.deepEqual([...activeAgents].sort(), ['claude', 'codex'], `${phase}: the active-result check must measure both agents in the fixture`);
        await legacy.screenshot({ path: path.join(artifacts, `carto-explorer-${phase}-search.png`) });
        // A selected facet pill is painted in its own hue; measure its text on
        // that fill. Then open a commit card's detail, which carries the hash.
        const facetBar = 'main > div:not(.hidden) .facet-bar';
        await legacy.locator(facetBar).getByRole('button', { name: new RegExp(`^${explorerProject}`) }).click();
        await legacy.locator(`${facetBar} [aria-pressed="true"]`).waitFor();
        const facets = await classic(facetBar, 'facet bar', { grounds: ['#0a0a0f'] });
        assert.ok(facets.some(entry => entry.text.startsWith(explorerProject) && entry.ground !== '#0a0a0f'), `${phase}: the selected facet pill was not measured on its own fill`);
        assert.ok(facets.some(entry => entry.text === 'clear'), `${phase}: the facet probe measured no clear control`);
        const commitCard = legacy.locator('main > div:not(.hidden) .result-list > [data-event-id="explorer-event-0"]');
        await commitCard.getByRole('button', { name: 'more', exact: true }).click();
        await commitCard.getByText('a1b2c3d', { exact: true }).waitFor();
        const detail = await classic('main > div:not(.hidden) .result-list', 'card detail', { grounds: ['#0a0a0f'] });
        assert.ok(detail.some(entry => entry.text === 'a1b2c3d'), `${phase}: the detail probe measured no commit hash`);
        // Repeated summaries collapse under "+N similar", and a long result set
        // ends in "show more": session-0's 38 identical "Modified: field.js"
        // rows produce both. ("working" is in over half the corpus, so BM25
        // scores it zero and returns nothing.)
        const searchView = legacy.locator('main > div:not(.hidden)');
        await legacy.goto(origin + '/?q=modified');
        await searchView.getByRole('button', { name: /^show more/ }).waitFor();
        const repeated = await classic('main > div:not(.hidden)', 'repeated results', { grounds: ['#0a0a0f'] });
        assert.ok(repeated.some(entry => /^\+\d+ similar/.test(entry.text)), `${phase}: the probe measured no duplicate toggle`);
        assert.ok(repeated.some(entry => entry.text.startsWith('show more')), `${phase}: the probe measured no load-more button`);
        await legacy.goto(origin + '/?q=zzqxunmatched');
        await searchView.getByText('No results found.', { exact: true }).waitFor();
        await classic('main > div:not(.hidden)', 'empty search', { grounds: ['#0a0a0f'] });
        // Hold one search in flight to measure its loading line.
        let releaseSearch;
        const held = new Promise(resolve => { releaseSearch = resolve; });
        const holdSearch = url => url.pathname === '/api/search';
        await legacy.route(holdSearch, async route => { await held; await route.continue(); });
        await legacy.goto(origin + '/?q=aurora');
        await searchView.getByText('Searching...', { exact: true }).waitFor();
        await classic('main > div:not(.hidden)', 'search loading', { grounds: ['#0a0a0f'] });
        releaseSearch();
        await legacy.unroute(holdSearch);
        await legacy.goto(origin + `/?project=${explorerProject}`);
        await legacy.locator('main > div:not(.hidden)').getByText(explorerSummaries[0], { exact: true }).waitFor();
        assert.equal(await legacy.getByText(controlSummary, { exact: true }).count(), 0);
        if (phase === 'cold') {
          assert.equal(fs.existsSync(path.join(work, 'turbo')), false, 'Legacy Explorer browsing started Turbo');
          assert.equal(JSON.parse(fs.readFileSync(config, 'utf8')).turbo.enabled, false, 'Legacy Explorer browsing enabled Turbo');
        }
        fs.writeFileSync(path.join(artifacts, `carto-classic-contrast-${phase}.json`), JSON.stringify(classicMeasured, null, 1) + '\n');
        assert.deepEqual([...classicFailures], [], `${phase}: classic Explorer text under 8:1`);
      } finally {
        await legacy.close();
      }
    }
    await page.goto(origin + '/memory');
    await page.getByRole('button', { name: 'Enable Turbo', exact: true }).waitFor();
    assert.equal(fs.existsSync(path.join(work, 'turbo')), false, 'Read-only entry started Turbo');
    const coldLink = await browser.newPage();
    await coldLink.goto(origin + `/memory?from=${encodeURIComponent(new Date(now - 86400000).toISOString())}&through=${encodeURIComponent(new Date(now + 2000).toISOString())}&mode=fixed&session=session-0`);
    await coldLink.getByRole('button', {name:'Enable Turbo', exact:true}).waitFor();
    assert.equal(new URL(coldLink.url()).searchParams.get('session'), 'session-0');
    const coldInternals = await page.request.get(origin+'/api/internals');
    assert.equal(coldInternals.status(), 200);
    assert.equal((await coldInternals.json()).utility.calls, 2);
    assert.equal(fs.existsSync(path.join(work, 'turbo')), false, 'Internals started Turbo');
    await verifyExplorer('cold');
    await page.screenshot({ path: path.join(artifacts, 'carto-memory-entry.png') });
    await page.route('**/api/turbo/start', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Test startup failure. Try again.' }) }), { times: 1 });
    await page.getByRole('button', { name: 'Enable Turbo', exact: true }).click();
    await page.getByRole('alert').getByText('Test startup failure. Try again.').waitFor();
    await wait(5500);
    assert.equal(await page.getByRole('alert').isVisible(), true, 'Startup failure vanished during status polling');
    await page.getByRole('button', { name: 'Enable Turbo', exact: true }).click();
    await page.getByRole('button', { name: 'Edit time range', exact: true }).waitFor({ timeout: 20000 });
    await coldLink.reload();
    await coldLink.getByRole('region', { name: 'Working memory' }).waitFor({ timeout: 15000 });
    assert.equal(new URL(coldLink.url()).searchParams.get('session'), 'session-0');
    await coldLink.getByRole('complementary', { name: 'Evidence inspector' }).getByRole('heading', { name: 'Turbo facts', exact: true }).waitFor();
    await coldLink.close();
    assert.equal(JSON.parse(fs.readFileSync(config, 'utf8')).turbo.enabled, true);
    await verifyExplorer('warm');
    await page.screenshot({ path: path.join(artifacts, 'carto-memory-live.png') });
    // The focus workspace preserves an explicit return point and exposes the
    // same recorded evidence through task and file result modes.
    const deskPage = await browser.newPage({ viewport: { width: 1280, height: 920 }, reducedMotion: 'reduce' });
    deskPage.on('pageerror', e => errors.push(`memory workspace: ${e.message}`));
    await deskPage.goto(origin + '/memory');
    await deskPage.getByRole('region', { name: 'Work results' }).waitFor();
    await deskPage.keyboard.press('/');
    const deskFind = deskPage.getByRole('searchbox', { name: 'Find in this window' });
    assert.equal(await deskFind.evaluate(element => document.activeElement === element), true);
    // The desk's find field is the timeline's, in the other workspace: the
    // same placeholder on the same fill, measured while it is still empty.
    const deskField = await textContrast(deskPage, '.focus-workspace .fw-find input');
    assert.ok(deskField.measured.some(entry => entry.element.endsWith('::placeholder') && entry.text === 'Find tasks, files, or recorded notes…' && entry.ground === '#11151e'), `memory workspace: the probe did not measure the find placeholder (measured ${JSON.stringify(deskField.measured)})`);
    assert.deepEqual(deskField.failures, [], 'memory workspace: find placeholder under 8:1');
    await deskFind.fill('Turbo facts');
    await deskPage.getByText('Turbo facts', { exact: true }).waitFor();
    await deskPage.getByRole('button', { name: 'Clear find' }).click();
    await deskPage.getByRole('button', { name: 'Edit time range', exact: true }).click();
    await deskPage.getByRole('button', { name: 'Use this window as return point', exact: true }).click();
    await deskPage.getByText('Return point set.', { exact: true }).waitFor();
    const savedFocus = await deskPage.evaluate(() => Object.fromEntries(Object.entries(localStorage).filter(([key]) => key.startsWith('cartographer.saved-focus.v1:'))));
    assert.equal(Object.keys(savedFocus).length, 1, 'focus save did not persist one corpus-scoped record');
    await deskPage.reload();
    await deskPage.getByRole('region', { name: 'Work results' }).waitFor();
    assert.equal(await deskPage.getByRole('button', { name: 'Go to return point' }).isEnabled(), true);

    // Activity is another projection of the same exact focus. Find changes
    // chart membership, clearing it restores membership without resetting the
    // chart permalink, keyboard activation opens that exact task, and a
    // transient neighbour never replaces the primary brushed cohort.
    const memoryViewNav = deskPage.getByRole('navigation', { name: 'Memory view' });
    const resultsNavBox = await memoryViewNav.boundingBox();
    assert.equal(await deskPage.locator('.fw-page-heading').getByRole('button', { name: 'Explore activity', exact: true }).count(), 0);
    await memoryViewNav.getByRole('button', { name: 'Activity', exact: true }).click();
    await deskPage.getByRole('region', { name: 'Explore activity' }).waitFor();
    const activityNavBox = await memoryViewNav.boundingBox();
    assert.ok(Math.abs(resultsNavBox.y - activityNavBox.y) < 2, 'Activity navigation moved away from the content it switches');
    assert.equal(await memoryViewNav.getByRole('button', { name: 'Activity', exact: true }).getAttribute('aria-pressed'), 'true');
    const chartIds = panel => deskPage.locator(`.mw-stage[data-panel=${panel}] .mw-target:not([hidden])`).evaluateAll(elements => elements.map(element => element.dataset.session).sort());
    await deskPage.waitForFunction(minimum => document.querySelectorAll('.mw-stage[data-panel=field] .mw-target:not([hidden])').length >= minimum, labels.length);
    const allChartIds = await chartIds('field');
    assert.ok(allChartIds.includes('session-0') && allChartIds.includes('session-4'));
    await deskFind.fill('Turbo facts');
    await deskFind.press('Enter');
    await deskPage.waitForFunction(() => [...document.querySelectorAll('.mw-stage[data-panel=field] .mw-target:not([hidden])')].every(element => element.dataset.session === 'session-0'));
    for (const panel of ['field', 'wake', 'compare']) assert.deepEqual(await chartIds(panel), ['session-0'], `${panel} disagrees with Find scope`);
    assert.equal(new URL(deskPage.url()).searchParams.get('q'), 'Turbo facts');
    await deskPage.getByRole('button', { name: 'Zoom in', exact: true }).click();
    await deskPage.waitForURL(url => url.searchParams.has('cam'));
    const chartCamera = new URL(deskPage.url()).searchParams.get('cam');
    await deskPage.getByRole('button', { name: 'Clear find', exact: true }).click();
    await deskPage.waitForFunction(expected => document.querySelectorAll('.mw-stage[data-panel=field] .mw-target:not([hidden])').length === expected, allChartIds.length);
    assert.equal(new URL(deskPage.url()).searchParams.get('cam'), chartCamera, 'Clear find reset the chart permalink');
    for (const panel of ['field', 'wake', 'compare']) assert.deepEqual(await chartIds(panel), allChartIds, `${panel} did not restore membership`);
    const primary = deskPage.locator('.mw-stage[data-panel=field] .mw-target[data-session="session-0"]');
    const primaryHref = await primary.getAttribute('href');
    await primary.focus();
    await deskPage.keyboard.press('Enter');
    await deskPage.waitForURL(url => url.searchParams.get('session') === 'session-0');
    assert.equal(deskPage.url(), new URL(primaryHref, origin).href, 'keyboard activation opened a different task permalink');
    await deskPage.getByRole('complementary', { name: 'Evidence inspector' }).getByRole('heading', { name: 'Turbo facts', exact: true }).waitFor();
    await deskPage.keyboard.press('Escape');
    await deskPage.getByRole('region', { name: 'Explore activity' }).waitFor();
    await primary.focus();
    await deskPage.keyboard.press('Space');
    await deskPage.waitForURL(url => url.searchParams.get('brush') === 'session-0');
    // The field readout must be readable wherever the described point sits:
    // every line below the panel header and inside the stage, and never over
    // the point itself. It once sat in flow at the top of the stage, where the
    // absolutely positioned header covered its first line.
    async function assertReadoutClear(describedId, context) {
      const layout = await deskPage.evaluate(id => {
        const stage = document.querySelector('.mw-stage[data-panel=field]');
        const label = stage.querySelector('.mw-brush-label');
        const rect = el => { const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right }; };
        const target = stage.querySelector(`.mw-target[data-session="${CSS.escape(id)}"]`).getBoundingClientRect();
        return {
          hidden: label.hidden, placement: label.dataset.placement,
          header: rect(stage.querySelector('.mw-panel-header')), stage: rect(stage), label: rect(label),
          lines: [...label.children].filter(el => el.textContent.trim()).map(el => ({ text: el.textContent.slice(0, 40), ...rect(el) })),
          point: { x: target.left + target.width / 2, y: target.top + target.height / 2 },
        };
      }, describedId);
      assert.equal(layout.hidden, false, `${context}: field readout is hidden`);
      assert.ok(layout.lines.length >= 2, `${context}: field readout has no text`);
      for (const line of layout.lines) assert.ok(line.top >= layout.header.bottom - 1 && line.bottom <= layout.stage.bottom + 1, `${context}: readout line "${line.text}" is under the panel header or cut by the stage: ${JSON.stringify(layout)}`);
      const { point, label } = layout;
      assert.ok(!(point.x >= label.left && point.x <= label.right && point.y >= label.top && point.y <= label.bottom), `${context}: readout covers the point it describes: ${JSON.stringify(layout)}`);
    }
    await assertReadoutClear('session-0', 'brushed thread');
    const neighbour = deskPage.locator('.mw-stage[data-panel=field] .mw-target[data-session="session-4"]');
    await neighbour.focus();
    await deskPage.waitForFunction(() => document.querySelector('#memory-weather')?.dataset.secondary === 'session-4');
    assert.equal(new URL(deskPage.url()).searchParams.get('brush'), 'session-0', 'secondary inspection replaced the primary cohort');
    await deskFind.focus();
    await deskPage.waitForFunction(() => !document.querySelector('#memory-weather')?.dataset.secondary);
    assert.equal(new URL(deskPage.url()).searchParams.get('brush'), 'session-0');
    await deskPage.getByRole('button', { name: '1 selected tasks ×', exact: true }).click();
    await deskPage.waitForURL(url => !url.searchParams.has('brush'));
    // With no brush, focusing any point previews it. One point from each half
    // of the field, so both readout placements are measured.
    const halves = await deskPage.evaluate(() => {
      const stage = document.querySelector('.mw-stage[data-panel=field]').getBoundingClientRect();
      const middle = stage.top + stage.height / 2;
      const points = [...document.querySelectorAll('.mw-stage[data-panel=field] .mw-target:not([hidden])')]
        .map(el => { const r = el.getBoundingClientRect(); return { id: el.dataset.session, y: r.top + r.height / 2 }; });
      return { upper: points.find(p => p.y < middle)?.id || null, lower: points.find(p => p.y >= middle)?.id || null };
    });
    assert.ok(halves.upper && halves.lower, `the fixture must place field points in both halves: ${JSON.stringify(halves)}`);
    for (const [half, id] of [['upper', halves.upper], ['lower', halves.lower]]) {
      await deskPage.locator(`.mw-stage[data-panel=field] .mw-target[data-session="${id}"]`).focus();
      await deskPage.waitForFunction(expected => document.querySelector('.mw-stage[data-panel=field] .mw-target[data-brushed=true]')?.dataset.session === expected, id);
      await assertReadoutClear(id, `${half}-half point`);
    }
    await deskPage.locator('.mw-stage[data-panel=field]').screenshot({ path: path.join(artifacts, 'carto-memory-field-readout.png') });
    await deskPage.getByRole('button', { name: 'Tasks', exact: true }).click();

    fs.appendFileSync(log, JSON.stringify({ event_id: 'after-return', session_id: docSession, session_title: 'Review the handoff', provider: 'codex', project: 'writing', timestamp: now + 1000, type: 'git_commit', summary: 'Commit abcdef1: clarify the return briefing', cwd: corpus }) + '\n');
    await refreshRecords(deskPage);
    await deskPage.getByText('Review the handoff', { exact: true }).click();
    await deskPage.getByRole('complementary', { name: 'Evidence inspector' }).waitFor();
    assert.equal(await deskPage.getByRole('link', { name: 'Open in Codex ↗' }).getAttribute('href'), `codex://threads/${docSession}`);
    await assertHandoffTargets(deskPage, 'Working memory inspector');
    // The same inspector opens in the Timeline under its own workspace root,
    // so its hand-off row is measured there too, on a separate page.
    const timelineInspector = await browser.newPage({ viewport: { width: 1280, height: 920 }, reducedMotion: 'reduce' });
    timelineInspector.on('pageerror', e => errors.push(`timeline inspector: ${e.message}`));
    await timelineInspector.goto(deskPage.url());
    await timelineInspector.getByRole('complementary', { name: 'Evidence inspector' }).waitFor();
    await timelineInspector.getByRole('button', { name: 'Timeline ↗', exact: true }).click();
    await timelineInspector.getByRole('button', { name: 'Review in Memory ↗', exact: true }).waitFor();
    await assertHandoffTargets(timelineInspector, 'Timeline inspector');
    await timelineInspector.close();
    await assertResultRowContrast(deskPage, '.fw-task-row[data-selected]', 'selected task row');
    await deskPage.getByRole('button', { name: 'Back to results' }).click();

    // Markdown remains inert while the source and actual session-bounded diff
    // stay inspectable from the file result.
    await deskPage.getByRole('button', { name: 'Files', exact: true }).click();
    await deskPage.getByText('handoff.md', { exact: true }).click();
    await deskPage.getByRole('region', { name: 'File review' }).waitFor();
    await assertResultRowContrast(deskPage, '.fw-file-row[data-selected]', 'selected file row');
    await deskPage.getByRole('button', { name: 'Preview', exact: true }).waitFor();
    await deskPage.getByRole('heading', { name: 'Return briefing', exact: true }).waitFor();
    await deskPage.getByRole('cell', { name: 'Ready', exact: true }).waitFor();
    assert.equal(await deskPage.evaluate(() => window.artifactExecuted), undefined);
    await deskPage.getByRole('button', { name: 'Source', exact: true }).click();
    assert.match(await deskPage.getByLabel('File source').innerText(), /# Return briefing/);
    await deskPage.getByRole('button', { name: 'Changes', exact: true }).click();
    await deskPage.getByRole('region', { name: 'Artifact changes' }).waitFor();
    await deskPage.getByRole('region', { name: 'Side-by-side diff' }).waitFor({ timeout: 15000 });
    const rangeText = await deskPage.locator('.memory-artifact-range').innerText();
    assert.match(rangeText, /From\s+commit [0-9a-f]{7} “Initial briefing”/i, rangeText);
    assert.match(rangeText, /To\s+the working tree/i, rangeText);
    const splitText = await deskPage.locator('.memory-split-diff').innerText();
    assert.ok(splitText.includes('The original plan.') && splitText.includes('The revised **plan**.'), 'split view omitted a diff side');
    await deskPage.getByRole('button', { name: 'Unified', exact: true }).click();
    await deskPage.getByRole('region', { name: 'Unified diff' }).waitFor();
    assert.ok((await deskPage.locator('.memory-artifact-diff-deletion').innerText()).includes('The original plan.'));
    await deskPage.getByRole('button', { name: 'Split', exact: true }).click();
    const reviewURL = deskPage.url();
    assert.equal(new URL(reviewURL).searchParams.get('session'), docSession);
    assert.equal(new URL(reviewURL).searchParams.get('file'), document);
    await deskPage.reload();
    await deskPage.getByRole('region', { name: 'Side-by-side diff' }).waitFor({ timeout: 15000 });

    // Fixed links report clipboard denial without claiming success, then copy
    // the exact current scope when browser permission is available.
    await deskPage.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
    await deskPage.getByRole('button', { name: 'Edit time range', exact: true }).click();
    const copyLink = deskPage.getByRole('button', { name: 'Copy link to this window', exact: true });
    await deskPage.evaluate(() => {
      window.__fixtureWriteText = navigator.clipboard.writeText;
      navigator.clipboard.writeText = async () => { throw new Error('Fixture clipboard permission denial'); };
    });
    await copyLink.click();
    await deskPage.getByRole('status').filter({ hasText: 'Copy this link:' }).waitFor();
    await deskPage.evaluate(() => {
      navigator.clipboard.writeText = window.__fixtureWriteText;
      delete window.__fixtureWriteText;
    });
    await deskPage.getByRole('button', { name: 'Edit time range', exact: true }).click();
    await copyLink.click();
    await deskPage.getByRole('status').filter({ hasText: 'Link copied' }).waitFor();
    const copiedURL = await deskPage.evaluate(() => navigator.clipboard.readText());
    assert.equal(new URL(copiedURL).pathname, '/memory');
    assert.ok(new URL(copiedURL).searchParams.has('from') && new URL(copiedURL).searchParams.has('through'));

    await deskPage.getByRole('button', { name: 'Back to task', exact: true }).click();
    await deskPage.getByRole('button', { name: 'Back to results' }).waitFor();
    await deskPage.getByRole('button', { name: 'Back to results', exact: true }).click();
    await deskPage.getByRole('region', { name: 'Work results' }).waitFor();
    await deskPage.getByRole('button', { name: 'Files', exact: true }).click();
    await deskPage.getByText('field.js', { exact: true }).click();
    await deskPage.getByRole('button', { name: 'Changes', exact: true }).click();
    await deskPage.getByRole('region', { name: 'Artifact changes' }).waitFor();
    assert.match(await deskPage.getByRole('region', { name: 'Artifact changes' }).innerText(), /does not track this file yet|No session changes/i);
    await deskPage.getByRole('button', { name: 'Current file', exact: true }).click();
    await deskPage.getByText('export const live = true;', { exact: false }).waitFor();
    await deskPage.screenshot({ path: path.join(artifacts, 'carto-memory-review.png') });
    await deskPage.keyboard.press('Escape');
    await deskPage.keyboard.press('Escape');

    // Large text remains reviewable without pushing an unbounded payload into
    // the document. Changes report the real diff cap, Current file opens a
    // bounded source preview, and the UI download proxy preserves every byte.
    await deskPage.getByRole('button', { name: 'Files', exact: true }).click();
    await deskPage.getByText('large-review.txt', { exact: true }).click();
    await deskPage.getByRole('region', { name: 'Artifact changes' }).waitFor();
    assert.match(await deskPage.getByRole('region', { name: 'Artifact changes' }).innerText(), /limit|large|size/i);
    assert.equal(await deskPage.getByRole('button', { name: 'Current file', exact: true }).getAttribute('aria-pressed'), 'false');
    await deskPage.getByRole('button', { name: 'Open current file', exact: true }).click();
    assert.equal(await deskPage.getByRole('button', { name: 'Current file', exact: true }).getAttribute('aria-pressed'), 'true');
    const boundedSource = deskPage.getByLabel('File source');
    await boundedSource.waitFor();
    const boundedText = await boundedSource.innerText();
    assert.match(boundedText, /^current 00000 z+/);
    assert.ok(Buffer.byteLength(boundedText) <= 256 * 1024, `bounded preview exceeded 256 KiB: ${Buffer.byteLength(boundedText)} bytes`);
    const boundedLines = boundedText === '' ? 0 : boundedText.split('\n').length - (boundedText.endsWith('\n') ? 1 : 0);
    assert.ok(boundedLines <= 2000, `bounded preview exceeded 2,000 lines: ${boundedLines}`);
    const previewNotice = deskPage.getByText(/Showing the first/i);
    await previewNotice.waitFor();
    const noticeText = await previewNotice.innerText();
    assert.match(noticeText, /\d+(?:\.\d+)?\s*(?:bytes|KiB|KB|MiB|MB)/i, `large-file notice omitted total size: ${noticeText}`);
    const downloadLink = deskPage.getByRole('link', { name: 'Download full file', exact: true });
    const downloadHref = new URL(await downloadLink.getAttribute('href'), origin);
    assert.equal(downloadHref.pathname, '/api/memory/file');
    assert.equal(downloadHref.searchParams.get('session'), docSession);
    assert.equal(downloadHref.searchParams.get('path'), largeFile);
    assert.equal(downloadHref.searchParams.get('download'), '1');
    assert.ok(downloadHref.searchParams.has('from') && downloadHref.searchParams.has('through'), 'download lost the scoped review interval');
    const downloadReady = deskPage.waitForEvent('download');
    await downloadLink.click();
    const downloaded = await downloadReady;
    assert.equal(downloaded.suggestedFilename(), 'large-review.txt');
    assert.deepEqual(fs.readFileSync(await downloaded.path()), Buffer.from(largeCurrent), 'download proxy changed large-file bytes');
    await deskPage.screenshot({ path: path.join(artifacts, 'carto-memory-large-file.png'), fullPage: true });
    await deskPage.setViewportSize({ width: 390, height: 844 });
    const narrowReview = await deskPage.evaluate(() => {
      const visible = element => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden';
      return {
        width: innerWidth,
        scrollWidth: document.documentElement.scrollWidth,
        controls: [...document.querySelectorAll('button, a, input, select, summary')].filter(visible).map(element => {
          const box = element.getBoundingClientRect();
          return { label: element.getAttribute('aria-label') || element.textContent.trim().slice(0, 40), left: box.left, right: box.right };
        }),
      };
    });
    assert.ok(narrowReview.scrollWidth <= narrowReview.width + 1, `large-file review overflows at 390 px: ${narrowReview.scrollWidth}px`);
    for (const control of narrowReview.controls) assert.ok(control.left >= -1 && control.right <= narrowReview.width + 1, `large-file control leaves 390 px viewport: ${JSON.stringify(control)}`);
    await deskPage.screenshot({ path: path.join(artifacts, 'carto-memory-large-file-390.png'), fullPage: true });
    await deskPage.setViewportSize({ width: 1280, height: 920 });
    await deskPage.keyboard.press('Escape');
    await deskPage.keyboard.press('Escape');

    // New matching work is incorporated only on refresh, and the fixed focus
    // keeps unrelated projects and timestamps governed by its exact bounds.
    fs.appendFileSync(log, JSON.stringify({ event_id: 'new-session-event', timestamp: now + 1200, session_id: 'new-live-session', session_title: 'Fresh session', project: 'new-project', summary: 'A new event', type: 'tool_bash' }) + '\n');
    await deskPage.getByRole('button', { name: 'Tasks', exact: true }).click();
    await refreshRecords(deskPage);
    await deskPage.getByText('Fresh session', { exact: true }).waitFor({ timeout: 15000 });
    await deskPage.setViewportSize({ width: 390, height: 844 });
    assert.equal(await deskPage.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'Memory workspace overflows on mobile');
    await deskPage.screenshot({ path: path.join(artifacts, 'carto-memory-mobile.png') });
    await deskPage.close();

    // Recall lists every call in the window, keeps the unattributed one in its
    // own group, marks the deep use with its served rank, lists the id nothing
    // resolves, and links each result to its episode through a fixed window.
    const recallPage = await browser.newPage({ viewport: { width: 1280, height: 920 }, reducedMotion: 'reduce' });
    recallPage.on('pageerror', e => errors.push(`recall: ${e.message}`));
    await recallPage.goto(origin + '/memory?surface=recall');
    const recallView = recallPage.getByRole('region', { name: 'Recall searches' });
    await recallView.getByText(recallQuery, { exact: true }).waitFor({ timeout: 15000 });
    assert.equal(await recallPage.getByRole('navigation', { name: 'Memory view' }).getByRole('button', { name: 'Recall', exact: true }).getAttribute('aria-pressed'), 'true');
    assert.match(await recallView.locator('.rc-totals').innerText(), /^2 calls · 1 attributed to 1 session · 1 unattributed · 13 results served · 1 marked used · 1 mark with no call/);
    const unattributedGroup = recallView.getByRole('region', { name: 'Unattributed calls' });
    assert.equal(await unattributedGroup.locator('[data-call="fixture-call"]').count(), 1, 'the no-session call was dropped from the window');
    assert.match(await unattributedGroup.locator('[data-call="fixture-call"] .rc-call-counts').innerText(), /0 marked used/, 'a no_session mark was credited to a call it does not name');
    const recallCall = recallView.locator('[data-call="recall-fixture-call"]');
    assert.match(await recallCall.locator('.rc-call-counts').innerText(), /1 marked used · deepest rank 12/);
    await recallCall.getByRole('button', { expanded: false }).click();
    await recallPage.waitForURL(url => url.searchParams.get('call') === 'recall-fixture-call');
    await recallCall.locator('.rc-result').nth(11).waitFor({ timeout: 15000 });
    assert.equal(await recallCall.locator('.rc-result').count(), recallIds.length);
    const usedRow = recallCall.locator('.rc-result[data-used]');
    assert.equal(await usedRow.count(), 1);
    assert.equal(await usedRow.getAttribute('data-event-id'), 'session-5-9');
    assert.match(await usedRow.locator('.rc-used').innerText(), /marked used · rank 12/);
    assert.equal(await recallView.getByText(/helpful/i).count(), 0, 'a use mark is not evidence of help');
    await recallCall.locator('.rc-result[data-event-id="evt-gone-404"]').getByText(/^Unresolved:/).waitFor();
    await recallCall.locator('.rc-result[data-event-id="turn-session-3-7"]').getByText(/^Transcript turn 7/).waitFor();
    const episode = usedRow.getByRole('link', { name: 'Open episode ↗' });
    const episodeUrl = new URL(await episode.getAttribute('href'), origin);
    assert.equal(episodeUrl.searchParams.get('session'), 'session-5');
    assert.ok(episodeUrl.searchParams.get('from') && episodeUrl.searchParams.get('through'), 'episode link carries no fixed window');
    assert.equal(episodeUrl.searchParams.get('mode'), null, 'episode link is not fixed (fixed is the default and costs no parameter)');
    assert.equal(episodeUrl.searchParams.get('durationMs'), null);
    await recallView.locator('.rc-unplaced summary').getByText(/^1 used mark in this window names no call · 1 no session recorded/).waitFor();
    // Recall text holds 8:1 on both the page and the selected row, measured
    // from computed styles, so it stays legible wherever a row is placed. No
    // recall row takes the selected background, where AgentBadge's palette
    // falls under the floor, so the badge is measured only where it renders.
    const recallContrast = await textContrast(recallPage, '.fw-recall [class*="rc-"]', {
      placements: { base: [10, 10, 15], selected: [21, 54, 64] }, fixed: '.agent-badge',
    });
    assert.ok(recallContrast.measured.some(entry => entry.element.includes('agent-badge')), 'the recall probe measured no AgentBadge');
    assert.deepEqual(recallContrast.failures, [], 'recall text under 8:1');
    const selectedRecallRows = await recallPage.locator('.rc-call, .rc-result').evaluateAll(rows => rows.filter(row => getComputedStyle(row).backgroundColor.replace(/\s/g, '') === 'rgb(21,54,64)').length);
    assert.equal(selectedRecallRows, 0);
    await recallPage.screenshot({ path: path.join(artifacts, 'carto-memory-recall.png'), fullPage: true });
    await usedRow.screenshot({ path: path.join(artifacts, 'carto-memory-recall-marker.png') });
    await recallCall.locator('.rc-result[data-event-id="evt-gone-404"]').screenshot({ path: path.join(artifacts, 'carto-memory-recall-unresolved.png') });
    await unattributedGroup.screenshot({ path: path.join(artifacts, 'carto-memory-recall-unattributed.png') });
    // The expanded call is a link: reload restores it.
    await recallPage.reload();
    await recallView.locator('[data-call="recall-fixture-call"] .rc-result[data-used]').waitFor({ timeout: 15000 });
    await recallView.locator('[data-call="recall-fixture-call"] .rc-result[data-used]').getByRole('link', { name: 'Open episode ↗' }).click();
    await recallPage.waitForURL(url => url.searchParams.get('session') === 'session-5' && !url.searchParams.has('mode'));
    await recallPage.getByRole('complementary', { name: 'Evidence inspector' }).getByRole('heading', { name: labels[5], exact: true }).waitFor();
    // The searching task's own detail lists the call, and says where
    // unattributed searches went when a session has none.
    await recallPage.goto(origin + '/memory?session=session-0');
    const taskRecall = recallPage.getByRole('complementary', { name: 'Evidence inspector' }).getByRole('region', { name: 'Recall' });
    await taskRecall.getByText(recallQuery, { exact: true }).waitFor({ timeout: 15000 });
    assert.match(await taskRecall.locator('.rc-call-counts').innerText(), /12 results.*1 marked used · deepest rank 12/s);
    await taskRecall.screenshot({ path: path.join(artifacts, 'carto-memory-recall-task.png') });
    await recallPage.goto(origin + '/memory?session=session-5');
    await recallPage.getByRole('complementary', { name: 'Evidence inspector' }).getByRole('region', { name: 'Recall' }).getByText(/Searches recorded without a session appear under Recall → Unattributed/).waitFor({ timeout: 15000 });
    await recallPage.goto(origin + '/memory?surface=recall');
    await recallPage.setViewportSize({ width: 390, height: 844 });
    await recallView.getByText(recallQuery, { exact: true }).waitFor({ timeout: 15000 });
    assert.equal(await recallPage.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'Recall view overflows on mobile');
    await recallPage.screenshot({ path: path.join(artifacts, 'carto-memory-recall-390.png') });
    // In a fixed window the request URL never changes, so Refresh must still
    // re-read the logs. purpose=manual keeps Internals' remember count below.
    await recallPage.setViewportSize({ width: 1280, height: 920 });
    const fixedThrough = Date.now();
    await recallPage.goto(origin + `/memory?surface=recall&from=${encodeURIComponent(new Date(fixedThrough - 86400000).toISOString())}&through=${encodeURIComponent(new Date(fixedThrough).toISOString())}`);
    await recallView.getByText(recallQuery, { exact: true }).waitFor({ timeout: 15000 });
    assert.equal(new URL(recallPage.url()).searchParams.get('mode'), null, 'the refresh check must run in a fixed window');
    fs.appendFileSync(path.join(corpus, 'served-log.jsonl'), JSON.stringify({ event_id: 'session-6-1', call_id: 'recall-refresh-call', timestamp: new Date(fixedThrough - 1000).toISOString(), purpose: 'manual', session_id: 'session-6', provider: 'claude', query: 'refresh proof', rank: 1, project: 'lights', source: 'changelog' }) + '\n');
    await recallView.getByRole('button', { name: 'Refresh', exact: true }).click();
    await recallView.getByText('refresh proof', { exact: true }).waitFor({ timeout: 15000 });
    await recallPage.close();
    // A backend started before these endpoints existed answers with the SPA's
    // HTML; the view must say so rather than crash or render an empty window.
    const staleRecall = await browser.newPage({ viewport: { width: 1280, height: 920 }, reducedMotion: 'reduce' });
    staleRecall.on('pageerror', e => errors.push(`stale recall: ${e.message}`));
    await staleRecall.route(/\/api\/memory\/recall(\?|$)/, route => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><div id="root"></div>' }));
    await staleRecall.goto(origin + '/memory?surface=recall');
    await staleRecall.getByRole('region', { name: 'Recall searches' }).getByRole('alert').getByText(/does not serve recall telemetry yet/).waitFor({ timeout: 15000 });
    await staleRecall.close();

    // The Day view shows the digest the command line prints for the same day,
    // through /api/memory/day, and holds 8:1 like the rest of the desk. The
    // counts are compared against the script itself, so a view that re-derived
    // any of them would disagree here first.
    const dayPage = await browser.newPage({ viewport: { width: 1280, height: 920 }, reducedMotion: 'reduce' });
    dayPage.on('pageerror', e => errors.push(`day: ${e.message}`));
    await dayPage.goto(origin + '/memory?surface=day');
    const dayView = dayPage.getByRole('region', { name: 'Day digest' });
    await dayView.locator('.dd-stats').waitFor({ timeout: 30000 });
    assert.equal(await dayPage.getByRole('navigation', { name: 'Memory view' }).getByRole('button', { name: 'Day', exact: true }).getAttribute('aria-pressed'), 'true');
    assert.equal(await dayView.getByRole('button', { name: 'Today', exact: true }).getAttribute('aria-pressed'), 'true');
    const shownDay = await dayView.getByLabel('Day', { exact: true }).inputValue();
    const cliDay = JSON.parse(execFileSync(process.execPath, [path.join(root, 'scripts/session-digest.js'), '--day', shownDay, '--json'], { env, encoding: 'utf8' }));
    assert.ok(cliDay.totals.events > 0, 'the fixture day holds no events, so the comparison would pass on nothing');
    const tiles = Object.fromEntries(await dayView.locator('.dd-stats > div').evaluateAll(cells => cells.map(cell => [cell.querySelector('dt').textContent, Number(cell.querySelector('dd').textContent.replace(/\D/g, ''))])));
    assert.equal(tiles.Events, cliDay.totals.events, 'Day view and command line disagree on events');
    assert.equal(tiles.Sessions, cliDay.totals.sessions, 'Day view and command line disagree on sessions');
    assert.equal(tiles.Commits, cliDay.totals.commits_landed + cliDay.totals.commits_git_only, 'Day view and command line disagree on commits');
    assert.equal(await dayView.locator('.dd-project').count(), cliDay.projects.filter(p => p.commits.length || p.git_only_commits.length || p.investigations.length || p.investigation_outcomes.length || Object.keys(p.files).length || p.repo).length);
    const dayContrast = await textContrast(dayPage, '.fw-day', { fixed: '.agent-badge' });
    assert.ok(dayContrast.measured.some(entry => entry.element.includes('dd-tick')), 'the day probe measured no chart label');
    assert.ok(dayContrast.measured.some(entry => entry.element.includes('agent-badge')), 'the day probe measured no AgentBadge');
    assert.deepEqual(dayContrast.failures, [], 'day text under 8:1');
    await dayPage.screenshot({ path: path.join(artifacts, 'carto-memory-day.png'), fullPage: true });
    // Yesterday moves the desk's window onto local midnight to local midnight.
    await dayView.getByRole('button', { name: 'Yesterday', exact: true }).click();
    await dayPage.waitForURL(url => url.searchParams.get('day') && url.searchParams.get('day') !== shownDay);
    const movedTo = new URL(dayPage.url());
    const [dy, dm, dd] = movedTo.searchParams.get('day').split('-').map(Number);
    assert.equal(Date.parse(movedTo.searchParams.get('from')), new Date(dy, dm - 1, dd).getTime(), 'the window does not start at local midnight');
    assert.equal(Date.parse(movedTo.searchParams.get('through')), new Date(dy, dm - 1, dd + 1).getTime(), 'the window does not end at the next local midnight');
    await dayView.getByRole('heading', { level: 2 }).first().waitFor();
    await dayPage.setViewportSize({ width: 390, height: 844 });
    await dayPage.goto(origin + '/memory?surface=day');
    await dayView.locator('.dd-stats').waitFor({ timeout: 30000 });
    assert.equal(await dayPage.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'Day view overflows on mobile');
    await dayPage.screenshot({ path: path.join(artifacts, 'carto-memory-day-390.png') });
    await dayPage.close();
    // An installed backend older than the endpoint answers 404; the view says
    // what is missing and where the same digest runs today.
    const staleDay = await browser.newPage({ viewport: { width: 1280, height: 920 }, reducedMotion: 'reduce' });
    staleDay.on('pageerror', e => errors.push(`stale day: ${e.message}`));
    await staleDay.route(/\/api\/memory\/day(\?|$)/, route => route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'Memory endpoint not found.' }) }));
    await staleDay.goto(origin + '/memory?surface=day');
    await staleDay.getByRole('region', { name: 'Day digest' }).getByRole('alert').getByText(/does not serve the day digest yet/).waitFor({ timeout: 15000 });
    await staleDay.close();

    // Internals remains adjacent to Memory, and managed Turbo can be stopped
    // and restarted without discarding the last successful workspace snapshot.
    await page.getByRole('button', { name: 'internals', exact: true }).click();
    await page.getByText('Current snapshot', { exact: true }).waitFor({ timeout: 15000 });
    assert.equal(await page.locator('.internals-error').count(), 0);
    const internals = await (await page.request.get(origin + '/api/internals?window=7d')).json();
    assert.equal(internals.utility.calls, 2);
    assert.equal(internals.utility.explicitUse.usedRows, 1, 'Internals and the Recall view disagree on marked-used results');
    await page.getByRole('button', { name: 'memory', exact: true }).click();
    await page.getByRole('region', { name: 'Work results' }).waitFor();
    execFileSync(process.execPath, [path.join(root, 'scripts/cartographer-turbo.js'), 'stop'], { env });
    await page.getByRole('button', { name: 'Start Turbo', exact: true }).waitFor({ timeout: 15000 });
    await page.getByRole('button', { name: 'Start Turbo', exact: true }).click();
    await page.getByRole('region', { name: 'Work results' }).waitFor({ timeout: 20000 });

    // A fresh document can restore the exact file review permalink.
    const linked = await browser.newPage({ viewport: { width: 1100, height: 850 }, reducedMotion: 'reduce' });
    linked.on('pageerror', e => errors.push(`memory permalink: ${e.message}`));
    await linked.goto(reviewURL);
    await linked.getByRole('region', { name: 'File review' }).waitFor({ timeout: 15000 });
    await linked.getByRole('region', { name: 'Side-by-side diff' }).waitFor({ timeout: 15000 });
    assert.equal(new URL(linked.url()).searchParams.get('session'), docSession);
    await linked.getByRole('button', { name: 'Back to task' }).click();
    await linked.getByRole('heading', { name: 'Review the handoff', exact: true }).waitFor();
    await linked.getByRole('button', { name: 'Back to results' }).click();
    await linked.getByRole('region', { name: 'Work results' }).waitFor();
    await linked.close();

    // Transcript text is independently useful when optional analysis fails,
    // and an expired source remains retryable without blanking the app shell.
    const transcriptFallback = await browser.newPage({viewport:{width:1100,height:850}});
    transcriptFallback.on('pageerror', e=>errors.push(`transcript fallback: ${e.message}`));
    await transcriptFallback.route(/\/api\/transcript\/analysis(?:\?|$)/, route => route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'fixture analysis unavailable', code: 'TRANSCRIPT_ANALYSIS_UNAVAILABLE' }),
    }));
    const failedAnalysisResponse = transcriptFallback.waitForResponse(response => new URL(response.url()).pathname === '/api/transcript/analysis');
    await transcriptFallback.goto(origin+`/session/${encodeURIComponent(explorerTranscript)}`);
    assert.equal((await failedAnalysisResponse).status(),503);
    await transcriptFallback.getByText(explorerAnswer,{exact:true}).waitFor();
    await transcriptFallback.getByText('Basic view · analysis unavailable',{exact:true}).waitFor();
    // The basic view and the unavailable panel below are the viewer's two
    // failure states; both are held to the same floor as the full view.
    await transcriptFallback.mouse.move(1,1);
    const basicView = await textContrast(transcriptFallback, '#transcript-viewer');
    assert.ok(basicView.measured.some(entry => entry.text === 'Basic view · analysis unavailable' && entry.ground === '#0a0a0f'), 'transcript fallback: the probe did not measure the analysis notice');
    assert.deepEqual(basicView.failures, [], 'transcript fallback: basic view text under 8:1');
    const expiredTranscript = path.join(transcriptRoot,'expired-session.jsonl');
    const missingTranscriptResponse = await transcriptFallback.request.get(origin+`/api/transcript?path=${encodeURIComponent(expiredTranscript)}`);
    assert.equal(missingTranscriptResponse.status(),404);
    assert.equal((await missingTranscriptResponse.json()).code,'TRANSCRIPT_NOT_FOUND');
    await transcriptFallback.goto(origin+`/session/${encodeURIComponent(expiredTranscript)}`);
    await transcriptFallback.getByRole('heading',{name:'Transcript unavailable',exact:true}).waitFor();
    await transcriptFallback.mouse.move(1,1);
    const unavailable = await textContrast(transcriptFallback, '#transcript-viewer');
    assert.ok(unavailable.measured.some(entry => entry.text === 'Transcript unavailable' && entry.ground !== '#0a0a0f'), 'transcript fallback: the probe did not measure the unavailable panel on its own fill');
    assert.deepEqual(unavailable.failures, [], 'transcript fallback: unavailable panel text under 8:1');
    const retryResponse = transcriptFallback.waitForResponse(response => new URL(response.url()).pathname === '/api/transcript');
    await transcriptFallback.getByRole('button',{name:'Retry transcript',exact:true}).click();
    assert.equal((await retryResponse).status(),404);
    await transcriptFallback.getByRole('heading',{name:'Transcript unavailable',exact:true}).waitFor();
    await transcriptFallback.close();

    // EventSource keeps its native retry policy, while the feed makes the
    // interruption and successful reconnection visible.
    const reconnecting = await browser.newPage({viewport:{width:1100,height:850}});
    reconnecting.on('pageerror', e=>errors.push(`stream lifecycle: ${e.message}`));
    let streamAttempts = 0;
    await reconnecting.route(/\/api\/stream$/, async route => {
      streamAttempts++;
      if (streamAttempts === 1) return route.abort('connectionreset');
      // Keep the retry request pending long enough to prove the intermediate
      // state instead of sampling after localhost has already recovered.
      await wait(1500);
      return route.continue();
    });
    await reconnecting.goto(origin);
    await reconnecting.getByText('Reconnecting',{exact:true}).waitFor({timeout:10000});
    await reconnecting.getByText('Live',{exact:true}).waitFor({timeout:15000});
    assert.ok(streamAttempts >= 2,'EventSource did not retry the interrupted stream');
    await reconnecting.close();

    // A render failure is contained to its route. The shell remains usable and
    // retry remounts a clean copy of the view.
    const routeBoundaryPage = await browser.newPage({viewport:{width:1100,height:850}});
    routeBoundaryPage.on('pageerror', e=>errors.push(`route boundary: ${e.message}`));
    let malformedTimeline = true;
    await routeBoundaryPage.route(/\/api\/activity-scope(?:\?|$)/, async route => {
      if (!malformedTimeline) return route.continue();
      const response = await route.fetch();
      const payload = await response.json();
      for (const record of payload.context.evidenceIndex) {
        record.text = { unexpected: 'object' };
        record.summary = record.text;
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(payload),
      });
    });
    await routeBoundaryPage.goto(origin + '/?view=chronological');
    await routeBoundaryPage.getByRole('heading',{name:'Timeline needs a reset',exact:true}).waitFor();
    malformedTimeline = false;
    await routeBoundaryPage.getByRole('button',{name:'Try again',exact:true}).click();
    await routeBoundaryPage.getByText(explorerSummaries[0],{exact:true}).waitFor();
    await routeBoundaryPage.getByText('Live',{exact:true}).waitFor();
    await routeBoundaryPage.close();
    assert.deepEqual(errors, []);
    console.log('PASS: focus workspace entry and persisted return point, task/file result modes, recorded outcomes, Markdown preview/source and inert HTML, session-bounded split/unified diff, current-file disclosure, native Codex provenance, exact fixed links with clipboard failure/success, file permalink reload, managed Turbo stop/start, mobile layout, Recall calls with the unattributed group, rank-12 use marker and fixed-window episode links, the Day view matching the command-line event, session and commit counts with its local-midnight window, 8:1 text and stale-backend notice; the inspector hand-off row at 44px with a keyboard focus ring in Working memory and the Timeline; 8:1 text from computed styles on selected task/file rows and every classic Explorer ground (event feed, hovered group header, session cards closed and open, the whole active search result, a selected facet pill, card detail, repeated/empty/loading search, the search placeholder, suggestion list and co-term flyout idle and active, the timeline and desk find placeholders, the whole Transcript viewer loading, enriched, filtered, collapsed and searched, and its basic and unavailable states); Explorer APIs, timeline, project filters, search/autocomplete, session views, provider facets, transcript/enrichment with basic-view fallback and retryable expiry, visible SSE interruption/recovery, route error containment/retry, Internals, no page errors.');
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
