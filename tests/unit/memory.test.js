import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';

const fixtureRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'carto-memory-')));
process.env.CARTOGRAPHER_DEV_DIR = fixtureRoot;
for (const name of ['CARTOGRAPHER_SESSION_ID', 'CLAUDE_SESSION_ID', 'CLAUDE_CODE_SESSION_ID', 'CODEX_SESSION_ID']) delete process.env[name];
process.on('exit', () => fs.rmSync(fixtureRoot, { recursive: true, force: true }));
const { createMemoryHandler, projectMemory, resolveMemoryFile } = await import('../../explorer/server/memory.js');
const now = Date.parse('2026-09-09T12:00:00Z');
let counter = 0;
function workspace() {
  const dir = path.join(fixtureRoot, `case-${counter++}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
function event(id, overrides = {}) {
  return { event_id: id, timestamp: now - 1000, session_id: 'session-a', project: 'alpha', type: 'tool_file_edit', ...overrides };
}
function invoke(handler, pathname, method = 'GET') {
  return new Promise((resolve, reject) => {
    let status;
    handler({ url: pathname, method }, {
      writeHead(code) { status = code; },
      end(raw) { resolve({ status, body: JSON.parse(raw) }); },
    }).then((handled) => { if (!handled) resolve({ handled: false }); }, reject);
  });
}

test('memory windows the full warm corpus and preserves exact session identity', () => {
  const rows = [
    event('old', { timestamp: now - 86400001 }),
    event('future', { timestamp: now + 1 }),
    event('undated', { timestamp: 'nonsense' }),
    event('one', { timestamp: (now - 3000) / 1000, session_id: 'unknown', session: 'session-b', type: 'web_fetch' }),
    event('one', { timestamp: new Date(now - 3000).toISOString(), session_id: 'unknown', session: 'session-b', type: 'web_fetch', transcript_path: '/a/transcript.jsonl' }),
    event('two', { timestamp: new Date(now - 2000).toISOString(), session_id: '', sessionId: 'session-b', project: 'dev', type: 'git_commit' }),
    event('orphan', { session_id: 'unknown', session: '', sessionId: null, type: 'git_commit' }),
    event('life', { session_id: 'session-c', type: 'milestone', milestone: 'session_wrapup', project: 'beta' }),
    event('early', { timestamp: now - 86400000, session_id: 'session-a', type: 'user_prompt', prompt: 'Implement live working memory' }),
    event('title', { session_id: 'session-b', type: 'session_start', session_title: 'Memory bridge' }),
  ];
  const result = projectMemory(rows, { now, corpusRoot: fixtureRoot });
  assert.equal(result.total, 6);
  assert.equal(result.unattributed, 1, 'orphan commit is never assigned by proximity');
  assert.deepEqual(result.sessions.map((s) => s.id), ['session-a', 'session-b', 'session-c']);
  const b = result.sessions[1];
  assert.equal(b.group, 'alpha');
  assert.equal(b.title, 'Memory bridge');
  assert.equal(b.transcript, '/a/transcript.jsonl');
  assert.deepEqual(b.events.map((e) => e[1]), ['research', 'commit', 'lifecycle']);
  assert.equal(result.sessions[0].title, 'Implement live working memory');
  assert.equal(result.sessions[2].lifecycleOnly, true);
  assert.deepEqual(result.sessions[2].wraps, [{ t: now - 1000, id: 'life' }]);
  assert.equal(result.total, result.unattributed + result.sessions.reduce((sum, s) => sum + s.count, 0));
});

test('edit evidence resolves only explicit existing paths within the corpus', () => {
  const dir = workspace();
  const other = workspace();
  const file = path.join(dir, 'app.js');
  const commas = path.join(dir, 'comma,name.txt');
  fs.writeFileSync(file, 'hello');
  fs.writeFileSync(commas, 'comma');
  fs.writeFileSync(path.join(other, 'outside.js'), 'outside');
  fs.symlinkSync(path.join(other, 'outside.js'), path.join(dir, 'escape.js'));
  const result = projectMemory([
    event('absolute', { file_path: file }),
    event('relative', { cwd: dir, summary: 'Modified: app.js, missing.js (via bash)' }),
    event('structured', { cwd: dir, files: [{ path: 'app.js' }] }),
    event('comma', { cwd: dir, summary: 'Created: comma,name.txt' }),
    event('no-cwd', { summary: 'Wrote: app.js' }),
    event('shell', { cwd: dir, summary: 'node script.js > app.js' }),
    event('mention', { type: 'user_prompt', prompt: file, file_path: file }),
    event('escape', { cwd: dir, file_path: 'escape.js' }),
    event('outside', { file_path: path.join(other, 'outside.js') }),
    event('directory', { file_path: dir }),
    event('', { cwd: dir, file_path: file }),
  ], { now, corpusRoot: dir });
  assert.equal(result.files['session-a'].length, 2);
  assert.deepEqual(result.files['session-a'].find((f) => f.path === file).edits.map((e) => e.id).sort(), ['absolute', 'relative', 'structured']);
  assert.equal(resolveMemoryFile('app.js', null, dir), null);
  assert.equal(resolveMemoryFile(path.join(dir, 'escape.js'), null, dir), null);
});

test('handler caches only briefly and sees warm array mutations and replacement', async () => {
  let time = now;
  let rows = [event('one')];
  let reads = 0;
  const handler = createMemoryHandler({ getEvents: () => { reads += 1; return rows; }, corpusRoot: fixtureRoot, now: () => time });
  const health = await invoke(handler, '/api/memory/health');
  assert.deepEqual(health.body, { status: 'ok', contract_version: 1, corpus_root: fixtureRoot, refresh_ms: 5000 });
  assert.equal(reads, 0);
  assert.equal((await invoke(handler, '/api/memory/state')).body.total, 1);
  rows.push(event('two'));
  assert.equal((await invoke(handler, '/api/memory/state')).body.total, 1);
  time += 2000;
  assert.equal((await invoke(handler, '/api/memory/state')).body.total, 2);
  rows = [event('replacement')];
  time += 2000;
  assert.equal((await invoke(handler, '/api/memory/state')).body.total, 1);
  assert.equal((await invoke(handler, '/api/memory/state', 'POST')).status, 405);
  assert.equal((await invoke(handler, '/api/memory/missing')).status, 404);
  assert.equal((await invoke(handler, '/api/facts/health')).handled, false);
});

test('file review returns current contents and bounded git diff with exact evidence', async () => {
  const dir = workspace();
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  git('init', '-q');
  const file = path.join(dir, 'app.js');
  fs.writeFileSync(file, 'before\n');
  git('add', '--', 'app.js');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'fixture');
  fs.writeFileSync(file, 'after\n');
  const handler = createMemoryHandler({ getEvents: () => [event('edit-one', { file_path: file })], corpusRoot: dir, now: () => now });
  const result = await invoke(handler, `/api/memory/file?session=session-a&path=${encodeURIComponent(file)}`);
  assert.equal(result.status, 200);
  assert.equal(result.body.content, 'after\n');
  assert.equal(result.body.diffAvailable, true);
  assert.match(result.body.diff, /-before\n\+after/);
  assert.equal(result.body.state, 'current');
  assert.match(result.body.note, /other sessions/);
  assert.deepEqual(result.body.evidence, [{ t: now - 1000, id: 'edit-one' }]);
  assert.equal((await invoke(handler, `/api/memory/file?session=another&path=${encodeURIComponent(file)}`)).status, 404);
  assert.equal((await invoke(handler, `/api/memory/file?session=session-a&path=${encodeURIComponent(path.join(dir, '.git', 'config'))}`)).status, 404);
  assert.equal(git('status', '--porcelain').trim(), 'M app.js', 'review leaves the working tree unchanged');
});

test('session permalinks reopen an older recorded window and retain exact file evidence', async () => {
  const dir = workspace();
  const file = path.join(dir, 'older file.js');
  fs.writeFileSync(file, 'still here');
  const last = now - 3 * 86400000;
  const rows = [event('old-edit', { timestamp: last, file_path: file }), event('other-session', { session_id: 'session-b' })];
  const handler = createMemoryHandler({ getEvents: () => rows, corpusRoot: dir, now: () => now });
  assert.deepEqual((await invoke(handler, '/api/memory/state')).body.sessions.map(s => s.id), ['session-b']);
  const archived = await invoke(handler, '/api/memory/session?session=session-a');
  assert.equal(archived.status, 200);
  assert.equal(archived.body.end, last);
  assert.deepEqual(archived.body.sessions.map(s => s.id), ['session-a']);
  const review = await invoke(handler, `/api/memory/file?session=session-a&path=${encodeURIComponent(file)}`);
  assert.equal(review.status, 200);
  assert.deepEqual(review.body.evidence, [{ t: last, id: 'old-edit' }]);
  assert.equal((await invoke(handler, '/api/memory/session?session=unknown-session')).status, 404);
  assert.equal((await invoke(handler, '/api/memory/session')).status, 400);
});

test('pinned windows survive later activity without poisoning live snapshots', async () => {
  let time = now;
  const rows = [event('earlier', { timestamp: now - 10000 }), event('later', { timestamp: now - 1000 })];
  const handler = createMemoryHandler({ getEvents: () => rows, corpusRoot: fixtureRoot, now: () => time });
  const link = `/api/memory/state?end=${now - 5000}`;
  assert.equal((await invoke(handler, link)).body.total, 1);
  time += 5 * 86400000;
  rows.push(event('new', { timestamp: time, session_id: 'new' }));
  assert.equal((await invoke(handler, link)).body.total, 1);
  assert.equal((await invoke(handler, '/api/memory/state')).body.total, 1);
  assert.equal((await invoke(handler, '/api/memory/state?end=nonsense')).status, 400);
  assert.equal((await invoke(handler, `/api/memory/state?end=${time + 86400000}`)).status, 400);
  assert.equal((await invoke(handler, `/api/memory/session?session=session-a&end=${now - 5000}`)).body.total, 1);
});

test('file review rejects symlink swaps, oversize, binary and invalid UTF-8', async () => {
  const dir = workspace();
  const other = workspace();
  const file = path.join(dir, 'app.js');
  fs.writeFileSync(file, 'normal');
  fs.writeFileSync(path.join(other, 'secret.txt'), 'outside');
  const handler = createMemoryHandler({ getEvents: () => [event('edit', { file_path: file })], corpusRoot: dir, now: () => now });
  const request = `/api/memory/file?session=session-a&path=${encodeURIComponent(file)}`;
  await invoke(handler, '/api/memory/state');
  fs.unlinkSync(file);
  fs.symlinkSync(path.join(other, 'secret.txt'), file);
  assert.equal((await invoke(handler, request)).status, 403);
  fs.unlinkSync(file);
  fs.writeFileSync(file, Buffer.alloc(256 * 1024 + 1, 65));
  assert.equal((await invoke(handler, request)).status, 413);
  fs.writeFileSync(file, Buffer.from([1, 0, 2]));
  assert.equal((await invoke(handler, request)).status, 415);
  fs.writeFileSync(file, Buffer.from([0xc3, 0x28]));
  assert.equal((await invoke(handler, request)).status, 415);
});

test('headless Turbo serves memory from its watched hermetic corpus', { timeout: 15000 }, async (t) => {
  const dir = workspace();
  const state = workspace();
  const reserve = http.createServer();
  reserve.listen(0, '127.0.0.1');
  await once(reserve, 'listening');
  const port = reserve.address().port;
  await new Promise((resolve) => reserve.close(resolve));
  const initial = event('initial', { timestamp: Date.now(), type: 'user_prompt', prompt: 'A live session' });
  fs.writeFileSync(path.join(dir, 'changelog.jsonl'), `${JSON.stringify(initial)}\n`);
  const child = spawn(process.execPath, ['scripts/turbo-server.js'], { cwd: path.resolve(import.meta.dirname, '../..'), env: { ...process.env, CARTOGRAPHER_DEV_DIR: dir, CARTOGRAPHER_TURBO_STATE_DIR: state, CARTOGRAPHER_TURBO_URL: `http://127.0.0.1:${port}`, CARTOGRAPHER_TURBO_SPOOL_ONLY: '0' }, stdio: 'ignore' });
  t.after(async () => { if (child.exitCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); } });
  const fetchState = async () => {
    try { const response = await fetch(`http://127.0.0.1:${port}/api/memory/state`); return response.ok ? response.json() : null; } catch { return null; }
  };
  let result;
  for (let i = 0; i < 60; i++) { result = await fetchState(); if (result) break; await new Promise((resolve) => setTimeout(resolve, 100)); }
  assert.equal(result?.total, 1);
  fs.appendFileSync(path.join(dir, 'changelog.jsonl'), `${JSON.stringify(event('new', { timestamp: Date.now(), type: 'git_commit' }))}\n`);
  for (let i = 0; i < 50; i++) { result = await fetchState(); if (result?.total === 2) break; await new Promise((resolve) => setTimeout(resolve, 100)); }
  assert.equal(result.total, 2, 'newly appended events flow through the shared warm service');
});


test('desk preserves earlier outcomes when recent observations roll over, and keeps provider evidence', () => {
  const rows = [event('landed', { timestamp: now - 100000, type: 'git_commit', provider: 'codex', cwd: fixtureRoot, summary: 'Commit abcdef1: the actual outcome' })];
  for (let i = 0; i < 75; i++) rows.push(event(`later-${i}`, { timestamp: now - 99000 + i, type: 'tool_bash', summary: `Routine observation ${i}` }));
  const snapshot = projectMemory(rows, { now, corpusRoot: fixtureRoot });
  const session = snapshot.sessions[0];
  assert.equal(session.notes.length, 60);
  assert.ok(!session.notes.some(note => note.id === 'landed'), 'fixture must push the commit out of recent notes');
  assert.deepEqual(session.outcomes.map(note => note.id), ['landed']);
  assert.equal(session.provider, 'codex');
  assert.equal(session.cwd, fixtureRoot);
});
