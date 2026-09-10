import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// fs.watch needs a moment to arm, and handleChange debounces 100ms.
const settle = (ms = 900) => new Promise((r) => setTimeout(r, ms));

// changelog carries the threading fields; the domain log carries `tool`. The
// corpus overlaps by design, so the same event_id lands in both.
const changelogRow = (id) => `${JSON.stringify({
  event_id: id, timestamp: '2026-09-10T03:26:52Z', type: 'tool_bash',
  summary: 'Ran: echo hello', session_id: 's-1', related_ids: [], salience: 0.2,
})}\n`;
const toolUseRow = (id) => `${JSON.stringify({
  event_id: id, timestamp: '2026-09-10T03:26:52Z', type: 'tool_bash',
  summary: 'Ran: echo hello', session: 's-1', tool: 'Bash', salience: 0.2,
})}\n`;

test('an event appended to two logs reaches the feed once, with fields merged', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-dupe-'));
  const changelog = path.join(dir, 'changelog.jsonl');
  const toolUse = path.join(dir, 'tool-use-log.jsonl');
  fs.writeFileSync(changelog, changelogRow('evt-seed'));
  fs.writeFileSync(toolUse, toolUseRow('evt-seed'));

  // DEV_DIR is captured when jsonl.js is first evaluated.
  process.env.CARTOGRAPHER_DEV_DIR = dir;
  const { createExplorerApp } = await import('../../explorer/server/app.js');
  const { app, close } = createExplorerApp();

  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    await settle(300); // let the watchers arm before touching the files

    // The live-append path: one event, delivered once per log.
    fs.appendFileSync(changelog, changelogRow('evt-dup'));
    fs.appendFileSync(toolUse, toolUseRow('evt-dup'));
    await settle();

    const body = await (await fetch(`${base}/api/events?limit=50`)).json();
    const events = body.events || body;
    const hits = events.filter((e) => e.event_id === 'evt-dup');

    assert.equal(hits.length, 1, 'a dual-logged event must not be appended twice');
    // Skipping the second copy outright would drop whichever fields only it had.
    assert.equal(hits[0].tool, 'Bash', 'fields from the domain log must survive');
    assert.equal(hits[0].session_id, 's-1', 'fields from changelog must survive');

    const ids = events.map((e) => e.event_id);
    assert.equal(new Set(ids).size, ids.length, 'the feed must not repeat any event_id');
  } finally {
    close();
    await new Promise((r) => server.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
