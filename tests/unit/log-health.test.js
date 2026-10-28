// A line that does not parse used to be skipped without a word: readJsonlFile
// called it "a mid-flush write", and on 2026-10-16 six such lines sat in
// session-milestones.jsonl, three pairs of records torn apart by concurrent
// appends, while every health check answered ok. The load and the watcher now
// count them, and both health endpoints say how many and where.
//
// The fixture tears a pair exactly as the hooks did (first chunk of one row,
// the other row whole, the first row's remainder on the next line) and then
// has the watcher meet one more torn row appended live.

process.env.CARTOGRAPHER_SEMANTIC = '0';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OFFLINE_INDEX_ENV } from './helpers/offline-index.js';

for (const name of ['CARTOGRAPHER_SESSION_ID', 'CLAUDE_SESSION_ID', 'CLAUDE_CODE_SESSION_ID', 'CODEX_SESSION_ID']) {
  delete process.env[name];
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-log-health-'));
const row = (id, extra = {}) => JSON.stringify({ event_id: id, timestamp: '2026-10-16T12:00:00Z', summary: `row ${id}`, ...extra });
const a = row('evt-torn-a', { pad: 'a'.repeat(1100) });
const b = row('evt-torn-b', { pad: 'b'.repeat(1100) });
fs.writeFileSync(path.join(dir, 'session-milestones.jsonl'),
  `${row('evt-whole')}\n${a.slice(0, 1024)}${b}\n${a.slice(1024)}\n`);
fs.writeFileSync(path.join(dir, 'changelog.jsonl'), `${row('evt-changelog')}\n`);
// Rows a rewrite diverted and has not drained yet.
fs.writeFileSync(path.join(dir, 'changelog.jsonl.spool'), `${row('evt-spooled')}\n`);
Object.assign(process.env, { ...OFFLINE_INDEX_ENV, CARTOGRAPHER_DEV_DIR: dir });

const { createExplorerApp } = await import('../../explorer/server/app.js');

test('both health endpoints count torn rows, at load and appended live', async (t) => {
  // Without these the counts below would pass against the old silent skip.
  const lines = fs.readFileSync(path.join(dir, 'session-milestones.jsonl'), 'utf8').split('\n').filter(Boolean);
  assert.equal(lines.length, 3);
  assert.throws(() => JSON.parse(lines[1]));
  assert.throws(() => JSON.parse(lines[2]));

  const { app, close } = createExplorerApp();
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(async () => {
    close();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const get = async (route) => (await fetch(`http://127.0.0.1:${server.address().port}${route}`)).json();

  const health = await get('/api/health');
  assert.equal(health.status, 'ok', 'torn rows are history to repair, not a log that failed to load');
  assert.deepEqual(health.load_errors, {});
  assert.equal(health.logs.malformed, 2);
  const milestones = health.logs.sources.milestones;
  assert.equal(milestones.rows, 1);
  assert.equal(milestones.malformed, 2);
  assert.deepEqual(milestones.malformed_lines, [2, 3]);
  assert.equal(health.logs.sources.changelog.malformed, 0);
  assert.equal(health.logs.spooled_rows, 1);
  assert.equal(health.logs.sources.changelog.spooled_rows, 1);
  assert.equal(health.logs.sources.prompts.absent, true, 'a missing log reads as absent, not as an error');

  const recall = await get('/api/recall/health');
  assert.equal(recall.status, 'ok');
  assert.deepEqual(recall.load_errors, {}, 'both endpoints serve the same log fields');
  assert.equal(recall.logs.malformed, 2);
  assert.deepEqual(recall.logs.sources.milestones.malformed_lines, [2, 3]);

  // A torn row appended while the service runs, and a whole one after it.
  fs.appendFileSync(path.join(dir, 'session-milestones.jsonl'), `${row('evt-live').slice(0, 40)}\n${row('evt-after')}\n`);
  const deadline = Date.now() + 5000;
  let live;
  do {
    await new Promise((resolve) => setTimeout(resolve, 150));
    live = await get('/api/recall/health');
  } while (live.logs.sources.milestones.appended_malformed === 0 && Date.now() < deadline);
  assert.equal(live.logs.sources.milestones.appended_malformed, 1);
  assert.equal(live.logs.malformed, 3);
  assert.equal((await get('/api/health')).logs.malformed, 3);
});
