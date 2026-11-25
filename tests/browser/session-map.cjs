// The session map against an isolated corpus: one session that uses ten stations,
// so the tape is at its tallest. Checks what a unit test cannot see: that the
// map, the scrubber and the tape are all above the fold at 1440x900, that the
// narrow layout shows the whole map, that "calls" is one number on the list and
// the tape, and that the Directions look draws every candidate with readable text.
// `--preview` runs against the built Explorer, as CI does.
const { chromium } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function port() { const server = net.createServer(); await new Promise(r => server.listen(0, '127.0.0.1', r)); const value = server.address().port; await new Promise(r => server.close(r)); return value; }

(async () => {
  const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'carto-session-map-')));
  const artifacts = path.join(os.tmpdir(), 'carto-session-map-browser-artifacts'); fs.mkdirSync(artifacts, { recursive: true });
  const corpus = path.join(work, 'corpus'), transcripts = path.join(work, 'transcripts');
  for (const dir of [corpus, transcripts]) fs.mkdirSync(dir);
  const sid = 'session-map-fixture';
  const start = new Date(Date.now() - 40 * 60 * 1000);
  const at = seconds => new Date(start.getTime() + seconds * 1000).toISOString();

  // Forty steps: the person asks, then the agent works through every kind of tool, twice over, with one failure,
  // one background task reporting back and one look at the person's own terminal.
  const tools = [
    ['Read', { file_path: '/repo/src/app.js' }], ['Bash', { command: 'npm test', description: 'Run the unit suite' }], ['Edit', { file_path: '/repo/src/app.js', old_string: 'a', new_string: 'b' }],
    ['Bash', { command: 'npm test', description: 'Run the unit suite again' }], ['WebFetch', { url: 'https://docs.example.com/guide' }], ['mcp__Claude_Browser__navigate', { url: 'http://localhost:5173/' }],
    ['Skill', { skill: 'remember' }], ['Read', { file_path: '/Users/x/.claude/projects/-p/memory/notes.md' }], ['Agent', { description: 'Survey the docs' }], ['mcp__ccd_turn__update_plan', { advance: true }],
    ['mcp__terminal__read_terminal', {}],
  ];
  const rows = [{ type: 'user', timestamp: at(0), message: { content: 'please fix the failing build' } }];
  let step = 0;
  for (let round = 0; round < 4; round++) {
    if (round === 2) rows.push({ type: 'user', timestamp: at(step * 20 + 5), message: { content: '<task-notification>\n<task-id>bg1</task-id>\n<status>completed</status>\n</task-notification>' } });
    for (const [name, input] of tools) {
      step++;
      const id = `tu_${step}`;
      rows.push({ type: 'assistant', timestamp: at(step * 20), message: { id: `msg_${step}`, model: 'claude-fable-5-2', usage: { input_tokens: 1000 * step, cache_read_input_tokens: step === 1 ? 49_000 : 150_000 }, content: [{ type: 'tool_use', id, name, input }] } });
      rows.push({ type: 'user', timestamp: at(step * 20 + 4), message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: step === 4, content: 'ok' }] } });
    }
  }
  rows.push({ type: 'attachment', timestamp: at(step * 20 + 8), attachment: { type: 'hook_success', hookName: 'PostToolUse:Bash' } });
  // A subagent's rows carry the most fixed parts (station, "subagent 1234567", duration): the widest a row gets.
  fs.mkdirSync(path.join(transcripts, sid, 'subagents'), { recursive: true });
  fs.writeFileSync(path.join(transcripts, sid, 'subagents', 'agent-abc1234def.jsonl'), [
    { type: 'user', timestamp: at(181), message: { content: 'Survey the docs' } },
    { type: 'assistant', timestamp: at(182), message: { id: 'msg_s1', model: 'claude-haiku-5-5', content: [{ type: 'tool_use', id: 'tu_s1', name: 'WebFetch', input: { url: 'https://docs.example.com/a/very/long/path/to/a/page/about/configuration' } }] } },
    { type: 'user', timestamp: at(190), message: { content: [{ type: 'tool_result', tool_use_id: 'tu_s1', content: 'ok' }] } },
    { type: 'assistant', timestamp: at(step * 20 + 6), message: { id: 'msg_s2', model: 'claude-haiku-5-5', content: [{ type: 'tool_use', id: 'tu_s2', name: 'Bash', input: { command: 'ls docs', description: 'List the documentation folder and count its files' } }] } },
    { type: 'user', timestamp: at(step * 20 + 7), message: { content: [{ type: 'tool_result', tool_use_id: 'tu_s2', content: 'ok' }] } },
  ].map((r, i) => JSON.stringify({ uuid: `s-${i}`, ...r })).join('\n') + '\n');
  const end = new Date(start.getTime() + (step * 20 + 10) * 1000);
  const transcript = path.join(transcripts, `${sid}.jsonl`);
  fs.writeFileSync(transcript, rows.map((r, i) => JSON.stringify({ uuid: `m-${i}`, sessionId: sid, cwd: corpus, ...r })).join('\n') + '\n');
  fs.writeFileSync(path.join(corpus, 'changelog.jsonl'), JSON.stringify({ event_id: 'map-end', session_id: sid, session_title: 'Fix the failing build', provider: 'claude', project: 'widget', cwd: corpus, transcript_path: transcript, timestamp: end.toISOString(), type: 'milestone_session_end', summary: 'Session ended' }) + '\n');

  const uiPort = await port(), apiPort = await port();
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('CARTOGRAPHER_') && !['CLAUDE_SESSION_ID', 'CLAUDE_CODE_SESSION_ID', 'CODEX_SESSION_ID', 'ANTIGRAVITY_CONVERSATION_ID', 'ANTIGRAVITY_AGENT', 'VITE_DEMO'].includes(key)));
  const config = path.join(work, 'config.json'); fs.writeFileSync(config, JSON.stringify({ turbo: { enabled: false, url: `http://127.0.0.1:${apiPort}` } }));
  Object.assign(env, { CARTOGRAPHER_DEV_DIR: corpus, CARTOGRAPHER_CONFIG: config, CARTOGRAPHER_TURBO_STATE_DIR: path.join(work, 'turbo'), CARTOGRAPHER_TURBO_URL: `http://127.0.0.1:${apiPort}`, CARTOGRAPHER_SEMANTIC: '0', CARTOGRAPHER_QDRANT_URL: 'http://127.0.0.1:1', CARTOGRAPHER_API_PORT: String(apiPort), CARTOGRAPHER_EMBED_URL: 'http://127.0.0.1:1/v1/embeddings', CARTOGRAPHER_CLAUDE_TRANSCRIPTS_DIR: transcripts, CARTOGRAPHER_CODEX_TRANSCRIPTS_DIR: path.join(work, 'codex'), CARTOGRAPHER_CODEX_ARCHIVED_DIR: path.join(work, 'archives'), CARTOGRAPHER_THUMBNAIL_DIR: path.join(work, 'thumbnails') });
  const vite = spawn(process.execPath, [path.join(root, 'explorer/node_modules/vite/bin/vite.js'), ...(process.argv.includes('--preview') ? ['preview'] : []), '--host', '127.0.0.1', '--port', String(uiPort), '--strictPort'], { cwd: path.join(root, 'explorer'), env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', browser;
  vite.stdout.on('data', d => { output += d; }); vite.stderr.on('data', d => { output += d; });
  try {
    const origin = `http://127.0.0.1:${uiPort}`;
    for (let i = 0; ; i++) { try { if ((await fetch(origin)).ok) break; } catch {} if (i > 100) throw Error(output); await pause(100); }

    // What the server made of it: the fixture has to hold what the page is checked for, or the checks prove nothing.
    const map = await (await fetch(`${origin}/api/flowmap?path=${encodeURIComponent(transcript)}`)).json();
    const calls = map.actions.filter(a => a.station !== 'model');
    const steps = map.actions.length - calls.length;
    assert.ok(steps >= 40, `${steps} model steps`);
    assert.equal(map.present.filter(id => id !== 'model').length, 10, `ten stations beside the model: ${map.present.join(' ')}`);
    assert.equal(map.actions.filter(a => a.wake === 'task').length, 1, 'the task notification is a wake, not the person');
    assert.equal(map.actions.filter(a => a.station === 'you').length, 1);

    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    const base = `${origin}/flow?session=${encodeURIComponent(transcript)}`;

    // The percentage belongs inside the selected session's center node, including early in a replay.
    const expectCoreFill = async percent => {
      const core = page.getByRole('button', { name: 'All stations', exact: true });
      await core.waitFor();
      assert.equal(await core.getAttribute('aria-description'), `Context window ${percent}% full`);
      const svg = await page.locator('.sm-map img').evaluate(img => decodeURIComponent(img.src.split(',')[1]));
      assert.match(svg, new RegExp(`<text x="230" [^>]*>${percent}%(?: full)?</text>`));
    };
    await page.goto(`${base}&at=${Date.parse(at(21))}`);
    await expectCoreFill(25);
    await page.getByRole('button', { name: 'Board', exact: true }).click();
    await page.waitForSelector('.sm-map[data-layout="board"]');
    await expectCoreFill(25);

    // ── 1440 x 900: nothing on the page's first screen is below the fold ──
    await page.goto(base);
    await page.waitForSelector('.sm-tape img');
    await page.waitForFunction(() => document.querySelector('.sm-map img')?.naturalWidth > 0 && document.querySelector('.sm-tape img')?.naturalWidth > 0);
    const desk = await page.evaluate(() => {
      const box = sel => { const r = document.querySelector(sel).getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height }; };
      return { map: box('.sm-map'), scrub: box('.sm-scrub'), tape: box('.sm-tape'), list: box('.sm-list'), heading: document.querySelector('.sm-list h2').textContent, caption: document.querySelector('.sm-tape figcaption').textContent, rows: [...document.querySelectorAll('.sm-item')].map(li => li.getBoundingClientRect().height), page: document.documentElement.scrollHeight };
    });
    for (const part of ['map', 'scrub', 'tape']) assert.ok(desk[part].bottom <= 900 && desk[part].top >= 0, `${part} is on the first screen: ${Math.round(desk[part].top)} to ${Math.round(desk[part].bottom)} of 900`);
    assert.ok(desk.map.width >= 440, `the map is ${Math.round(desk.map.width)} px wide`);
    // The ribbon (20 px) sits between them, with the column's 12 px gap on either side.
    assert.ok(desk.scrub.top - desk.map.bottom <= 48, `the scrubber sits under the map and its ribbon (${Math.round(desk.scrub.top - desk.map.bottom)} px below the map)`);
    assert.ok(desk.list.top < 900 && desk.rows.length >= 3, `${desk.rows.length} rows of the list are on the first screen`);
    assert.ok(desk.rows.every(h => h >= 40), `a row is a target: shortest ${Math.min(...desk.rows)} px`);
    // "Calls" is one set: the list's count is the tape's set, and the model's steps are named apart.
    const bySubagents = calls.filter(a => a.agentId !== undefined).length;
    assert.ok(bySubagents >= 2, 'the fixture holds subagent rows');
    assert.match(desk.heading, new RegExp(`${calls.length} calls · 1 failed · ${bySubagents} by subagents · ${steps} model steps not listed`));
    assert.match(desk.caption, /^Last \d+ calls, oldest to newest$/);
    assert.equal(Number(/Last (\d+) calls/.exec(desk.caption)[1]), Math.min(60, calls.length));
    assert.equal(await page.locator('.sm-where', { hasText: /^Model$/ }).count(), 0, 'no model row in the every-station list');
    // The map is the hub adopted on 2026-11-13: Your screen is a station, what the agent tells is part of You, and every
    // station is a control of 40 px or more with the ribbon directly under the map, as wide as the map.
    const hub = await page.evaluate(() => {
      const map = document.querySelector('.sm-map').getBoundingClientRect();
      const ribbon = document.querySelector('.sm-ribbon').getBoundingClientRect();
      return { labels: [...document.querySelectorAll('.sm-hit')].map(b => b.getAttribute('aria-label')), sizes: [...document.querySelectorAll('.sm-hit')].map(b => { const r = b.getBoundingClientRect(); return Math.min(r.width, r.height); }), shape: map.width / map.height, ribbon: { gap: ribbon.top - map.bottom, width: ribbon.width, mapWidth: map.width, bottom: ribbon.bottom, loaded: document.querySelector('.sm-ribbon').naturalWidth > 0 } };
    });
    assert.ok(hub.labels.includes('Your screen') && hub.labels.includes('You') && !hub.labels.includes('Tells you'), hub.labels.join(', '));
    assert.equal(hub.labels.length, 12, 'eleven stations and the core');
    assert.ok(hub.sizes.every(px => px >= 40), `smallest control ${Math.min(...hub.sizes).toFixed(0)} px`);
    assert.ok(Math.abs(hub.shape - 460 / 474) < 0.02, 'the hub keeps its shape');
    assert.ok(hub.ribbon.loaded && hub.ribbon.gap >= 0 && hub.ribbon.gap <= 16 && Math.abs(hub.ribbon.width - hub.ribbon.mapWidth) <= 1 && hub.ribbon.bottom <= 900, JSON.stringify(hub.ribbon));
    // Pressed, You lists both directions and says how many of each.
    await page.locator('.sm-hit[aria-label="You"]').click();
    await page.waitForFunction(() => /^You/.test(document.querySelector('.sm-list h2')?.textContent ?? ''));
    const told = map.actions.filter(a => a.station === 'tells').length;
    assert.ok(told >= 4, 'the fixture holds reports');
    assert.match(await page.locator('.sm-list h2').textContent(), new RegExp(`1 from you · ${told} to you`));
    assert.match(page.url(), /station=you/);
    await page.locator('.sm-hit[aria-label="You"]').click();
    // An address that names the old station opens You.
    await page.goto(`${base}&station=tells`);
    await page.waitForFunction(() => /^You/.test(document.querySelector('.sm-list h2')?.textContent ?? ''));
    assert.equal(await page.locator('.sm-hit[aria-label="You"]').getAttribute('aria-pressed'), 'true');
    await page.goto(base);
    await page.waitForSelector('.sm-tape img');
    await page.waitForFunction(() => document.querySelector('.sm-map img')?.naturalWidth > 0);
    await page.screenshot({ path: path.join(artifacts, 'session-map-1440.png') });

    // Under Model the steps are the list.
    await page.locator('.sm-hit[aria-label="Model"]').click();
    await page.waitForFunction(n => document.querySelector('.sm-list h2')?.textContent.includes(`${n} steps`), steps);
    await page.locator('.sm-hit[aria-label="Model"]').click();

    // ── Directions: every candidate drawn, every word readable ──
    await page.getByRole('button', { name: 'Directions' }).click();
    await page.waitForSelector('.sm-directions .sd-fig');
    await page.waitForFunction(() => [...document.querySelectorAll('.sm-directions img')].every(img => img.complete && img.naturalWidth > 0));
    assert.match(page.url(), /look=directions/);
    const dir = await page.evaluate(() => {
      const lum = c => { const [r, g, b] = c.match(/[\d.]+/g).slice(0, 3).map(Number).map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
      const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
      const ground = getComputedStyle(document.querySelector('.session-map')).backgroundColor;
      const panel = document.querySelector('.sm-directions');
      const text = [];
      const walker = document.createTreeWalker(panel, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!node.textContent.trim()) continue;
        const style = getComputedStyle(node.parentElement);
        const bg = node.parentElement.closest('button') ? getComputedStyle(node.parentElement.closest('button')).backgroundColor : ground;
        text.push({ said: node.textContent.trim().slice(0, 30), px: parseFloat(style.fontSize), ratio: contrast(style.color, bg) });
      }
      return {
        figures: [...panel.querySelectorAll('.sd-fig h3')].map(h => h.textContent),
        images: panel.querySelectorAll('img').length,
        text,
        buttons: [...panel.querySelectorAll('.sd-stations button')].map(b => b.getBoundingClientRect().height),
        mapStillThere: document.querySelector('.sm-map').getBoundingClientRect().width,
        overflow: panel.scrollWidth - panel.clientWidth,
      };
    });
    assert.deepEqual(dir.figures, ['Route first', 'Who started it', 'One colour per kind of work', 'One moment at small sizes', 'Sequence at small sizes', 'Sidebar pane']);
    assert.ok(dir.images >= 30, `${dir.images} drawings`);
    // The sequence strip: six moves, each column headed by what the recording says, and no two neighbouring frames alike.
    const seq = await page.evaluate(() => {
      const table = document.querySelector('.sd-strip');
      return { heads: [...table.querySelectorAll('thead th')].slice(1).map(th => th.textContent.trim()), rows: [...table.querySelectorAll('tbody tr')].map(tr => ({ name: tr.querySelector('th').textContent, frames: [...tr.querySelectorAll('img')].map(img => img.src) })) };
    });
    assert.equal(seq.heads.length, 6);
    assert.ok(seq.heads.every(h => /^.+ → .+$/.test(h)), seq.heads.join(' | '));
    assert.equal(seq.rows.length, 8);
    for (const row of seq.rows.filter(r => r.name.startsWith('Candidate') || r.name.startsWith('Ribbon'))) {
      for (let i = 1; i < row.frames.length; i++) assert.notEqual(row.frames[i], row.frames[i - 1], `${row.name}: frame ${i + 1} differs from the one before`);
    }
    const small = dir.text.filter(t => t.px < 16);
    assert.deepEqual(small, [], 'no text under 16 px');
    const faint = dir.text.filter(t => t.ratio < 8);
    assert.deepEqual(faint, [], 'every word is 8:1 or better on its ground');
    assert.ok(dir.buttons.length >= 6 && dir.buttons.every(h => h >= 40), `station buttons are targets: shortest ${Math.min(...dir.buttons)} px`);
    assert.ok(dir.mapStillThere >= 440, 'the adopted hub stays on the left, to compare against');
    // And lot-map's hub, which the page drew before, is the first figure's picture.
    assert.equal(await page.locator('.sd-fig').first().locator('h4').first().textContent(), "Before: lot-map's hub at this moment");
    assert.ok(await page.locator('.sd-fig').first().locator('img').first().evaluate(img => img.naturalWidth > 0));
    assert.ok(dir.overflow <= 0, 'the panel does not scroll sideways');
    // The pane's page buttons are where they were when their counts were smaller: same boxes early in the session and at its end.
    const boxes = () => page.evaluate(() => [...document.querySelector('.sd-pane').querySelectorAll('.sd-stations button')].map(b => { const r = b.getBoundingClientRect(); const p = b.closest('.sd-pane').getBoundingClientRect(); return [b.querySelector('span').textContent, Math.round(r.left - p.left), Math.round(r.top - p.top), Math.round(r.width), b.querySelector('b').textContent].join(' '); }));
    const late = await boxes();
    await page.goto(`${base}&look=directions&at=${Math.round(map.actions[14].startedAt) + 200}`);
    await page.waitForSelector('.sd-pane .sd-stations button');
    const early = await boxes();
    const strip = rows => rows.map(r => r.replace(/ \d+$/, ''));
    assert.deepEqual(strip(early), strip(late), 'same buttons in the same boxes');
    assert.notDeepEqual(early, late, 'and the counts did change between the two moments');
    await page.goto(`${base}&look=directions`);
    await page.waitForSelector('.sd-pane .sd-stations button');
    // Pressing a page station in the pane lists pages, in the pane.
    const pane = page.locator('.sd-pane').first();
    await pane.getByRole('button', { name: /Browser/ }).click();
    assert.match(await pane.locator('h4').textContent(), /^Browser: pages, newest first$/);
    assert.match(await pane.locator('.sd-rows li').first().textContent(), /localhost:5173/);
    await page.screenshot({ path: path.join(artifacts, 'session-map-directions-1440.png') });

    // ── 390 wide: the whole map, no sideways scroll ──
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(base);
    await page.waitForFunction(() => document.querySelector('.sm-map img')?.naturalWidth > 0);
    await expectCoreFill(97);
    const narrow = await page.evaluate(() => {
      const r = document.querySelector('.sm-map').getBoundingClientRect();
      const img = document.querySelector('.sm-map img').getBoundingClientRect();
      const body = document.querySelector('.sm-body');
      const stage = document.querySelector('.sm-stage');
      return { left: r.left, right: r.right, width: r.width, height: r.height, img: { left: img.left, right: img.right, width: img.width, height: img.height }, sideways: Math.max(document.documentElement.scrollWidth - 390, body.scrollWidth - body.clientWidth), cut: stage.scrollHeight - stage.clientHeight, agentRows: document.querySelectorAll('.sm-agent').length, play: document.querySelector('.sm-play').getBoundingClientRect().height };
    });
    assert.ok(narrow.left >= 0 && narrow.right <= 390, `the map spans ${Math.round(narrow.left)} to ${Math.round(narrow.right)} of 390`);
    assert.ok(narrow.width >= 340, `the map is ${Math.round(narrow.width)} px wide`);
    assert.ok(Math.abs(narrow.img.width / narrow.img.height - 460 / 474) < 0.02, 'the picture keeps its shape');
    assert.ok(Math.abs(narrow.img.width - narrow.width) < 1 && narrow.img.left >= 0 && narrow.img.right <= 390, 'the picture is not cropped');
    // The stage is as tall as what it holds: before, it was a 250 px box that scrolled, with the 342 px map cut off inside it.
    assert.ok(narrow.cut <= 0, `the stage does not scroll its own contents (${narrow.cut} px hidden)`);
    assert.ok(narrow.agentRows >= 1, 'a subagent row, the widest kind, is in the list');
    assert.ok(narrow.sideways <= 0, `nothing scrolls sideways (${narrow.sideways} px)`);
    assert.ok(narrow.play >= 40);
    await page.screenshot({ path: path.join(artifacts, 'session-map-390.png') });

    assert.deepEqual(errors, []);
    console.log('session map browser check passed');
  } finally {
    await browser?.close();
    vite.kill();
    fs.rmSync(work, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exit(1); });
