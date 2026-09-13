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
const { createMemoryHandler, projectMemory, enrichMemory, resolveMemoryFile } = await import('../../explorer/server/memory.js');
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

test('expanded windows include all boundary events and report unfiltered corpus bounds', () => {
  const hour = 3600000;
  const rows = [
    event('outside', { timestamp: now - 48 * hour - 1, session_id: 'outside' }),
    event('boundary', { timestamp: now - 48 * hour, session_id: 'older' }),
    event('older', { timestamp: now - 30 * hour, session_id: 'older' }),
    event('recent', { timestamp: now, session_id: 'recent' }),
    event('future', { timestamp: now + hour, session_id: 'future' }),
    event('invalid', { timestamp: 'invalid', session_id: 'invalid' }),
  ];
  const recent = projectMemory(rows, { now, corpusRoot: fixtureRoot });
  assert.equal(recent.windowHours, 24);
  assert.deepEqual(recent.sessions.map(s => s.id), ['recent'], 'the default window must exclude older evidence');
  const wide = projectMemory(rows, { now, hours: 48, corpusRoot: fixtureRoot });
  assert.equal(wide.start, now - 48 * hour);
  assert.equal(wide.end, now);
  assert.equal(wide.windowHours, 48);
  assert.equal(wide.total, 3);
  assert.deepEqual(wide.sessions.flatMap(s => s.events.map(e => e[2])).sort(), ['boundary', 'older', 'recent']);
  for (const result of [recent, wide]) {
    assert.equal(result.availableStart, now - 48 * hour - 1);
    assert.equal(result.availableEnd, now + hour, 'corpus bounds describe recorded timestamps, including rows outside the selected end');
  }
  const empty = projectMemory([event('invalid', { timestamp: 'invalid' })], { now });
  assert.equal(empty.availableStart, null);
  assert.equal(empty.availableEnd, null);
  assert.throws(() => projectMemory(rows, { now, hours: 2161 }), RangeError);
});

test('duration cache keys isolate live and pinned window composition, with validated hours on every endpoint', async () => {
  let reads = 0;
  const rows = [event('old', { timestamp: now - 30 * 3600000, session_id: 'older' }), event('recent')];
  const handler = createMemoryHandler({ getEvents: () => { reads++; return rows; }, corpusRoot: fixtureRoot, now: () => now });
  assert.equal((await invoke(handler, '/api/memory/state')).body.total, 1);
  assert.equal((await invoke(handler, '/api/memory/state?hours=48')).body.total, 2);
  assert.equal((await invoke(handler, '/api/memory/state?hours=24')).body.total, 1);
  assert.equal(reads, 2, 'the explicit default shares its live cache, while the wider duration has an independent snapshot');
  const pinned = `/api/memory/state?end=${now - 2 * 3600000}`;
  assert.equal((await invoke(handler, `${pinned}&hours=24`)).body.total, 0);
  assert.deepEqual((await invoke(handler, `${pinned}&hours=48`)).body.sessions.map(s => s.id), ['older']);
  assert.equal((await invoke(handler, '/api/memory/state?hours=1')).body.windowHours, 1);
  assert.equal((await invoke(handler, '/api/memory/state?hours=2160')).body.windowHours, 2160);
  for (const hours of ['', '0', '-1', '1.5', '2161', 'Infinity', 'NaN', '24h', '1e2', ' 24 ']) {
    for (const endpoint of ['state', 'session?session=session-a', 'file?session=session-a&path=anything']) {
      const result = await invoke(handler, `/api/memory/${endpoint}${endpoint.includes('?') ? '&' : '?'}hours=${encodeURIComponent(hours)}`);
      assert.equal(result.status, 400, `${endpoint} must reject hours=${JSON.stringify(hours)}`);
      assert.match(result.body.error, /hours/);
    }
  }
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

test('wide enrichment bounds concurrent work without losing session evidence', async () => {
  const rows = Array.from({ length: 150 }, (_, i) => event(`event-${i}`, { session_id: `session-${i}`, type: 'user_prompt' }));
  const snapshot = projectMemory(rows, { now, hours: 2160, corpusRoot: fixtureRoot });
  const visited = [];
  let active = 0;
  let peak = 0;
  const enricher = { async read(session) {
    active++;
    peak = Math.max(peak, active);
    await new Promise(resolve => setImmediate(resolve));
    visited.push(session.id);
    active--;
    return { valid: false, reason: 'Fixture has no transcript.' };
  } };
  await enrichMemory(snapshot, enricher, fixtureRoot);
  assert.equal(peak, 4);
  assert.equal(new Set(visited).size, 150);
  assert.equal(snapshot.total, 150);
  assert.equal(snapshot.sessions.length, 150);
  assert.equal(snapshot.sessions.reduce((sum, session) => sum + session.events.length, 0), 150);
});

test('slow snapshots are shared while pending and refresh after the completed cache expires', async () => {
  let time = now;
  let reads = 0;
  let release;
  let blocked = true;
  const gate = new Promise(resolve => { release = resolve; });
  const handler = createMemoryHandler({
    getEvents: () => { reads++; return [event('one')]; }, corpusRoot: fixtureRoot, now: () => time,
    transcriptEnricher: { async read() { if (blocked) await gate; return { valid: false, reason: 'Fixture' }; } },
  });
  const first = invoke(handler, '/api/memory/state?hours=2160');
  time += 10000;
  const second = invoke(handler, '/api/memory/state?hours=2160');
  assert.equal(reads, 1, 'a slow transcript pass must not restart when the cache duration elapses');
  blocked = false;
  release();
  const results = await Promise.all([first, second]);
  assert.deepEqual(results[0].body, results[1].body);
  await invoke(handler, '/api/memory/state?hours=2160');
  assert.equal(reads, 1, 'cache freshness starts at completion');
  time += 2000;
  await invoke(handler, '/api/memory/state?hours=2160');
  assert.equal(reads, 2);
});

test('file review bounds the diff by the session, not by HEAD, and names both ends', async () => {
  const dir = workspace();
  const hour = 3600000;
  const iso = (ms) => new Date(ms).toISOString();
  const git = (args, at) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_COMMITTER_DATE: iso(at), GIT_AUTHOR_DATE: iso(at) } });
  git(['init', '-q'], now);
  const file = path.join(dir, 'app.js');
  const commit = (content, message, at) => { fs.writeFileSync(file, content); git(['add', '--', 'app.js'], at); git(['commit', '-qm', message], at); return git(['rev-parse', 'HEAD'], at).trim(); };
  const a = commit('before\n', 'A before the session', now - 4 * hour);
  const b = commit('before\nduring\n', 'B inside the session', now - 2.5 * hour);
  const c = commit('before\nduring\nafter\n', 'C after the session', now - hour);
  const rows = [
    event('edit-one', { timestamp: now - 3 * hour, file_path: file }),
    event('prompt-end', { timestamp: now - 2 * hour, type: 'user_prompt', prompt: 'wrap up' }),
    event('ancient-edit', { timestamp: now - 5 * 86400000, session_id: 'ancient', file_path: file }),
  ];
  // The handler caches projections for two seconds of its own clock, so every
  // mutation below advances that clock past the cache before asking again.
  let time = now;
  const handler = createMemoryHandler({ getEvents: () => rows, corpusRoot: dir, now: () => time });
  const url = (session, target = file) => `/api/memory/file?session=${session}&path=${encodeURIComponent(target)}`;
  let result = await invoke(handler, url('session-a'));
  assert.equal(result.status, 200);
  assert.equal(result.body.content, 'before\nduring\nafter\n', 'content stays the current file');
  assert.equal(result.body.diffAvailable, true);
  assert.equal(result.body.range.base.sha, a);
  assert.equal(result.body.range.head.kind, 'commit');
  assert.equal(result.body.range.head.sha, b);
  assert.equal(result.body.range.base.subject, 'A before the session');
  assert.equal(result.body.range.inFlight, false);
  assert.equal(result.body.range.committedAfter, true, 'commit C changed the file after the session');
  assert.equal(result.body.range.uncommittedAfter, false);
  assert.match(result.body.diff, /\+during/);
  assert.doesNotMatch(result.body.diff, /after/, 'a commit after the session must not leak into its diff');
  assert.equal(result.body.range.oldContent, 'before\n');
  assert.equal(result.body.range.newContent, 'before\nduring\n');
  assert.equal(result.body.diffBase, a.slice(0, 7));
  assert.match(result.body.note, new RegExp(`commit ${a.slice(0, 7)} to commit ${b.slice(0, 7)}`));
  assert.deepEqual(result.body.evidence, [{ t: now - 3 * hour, id: 'edit-one' }]);
  assert.equal((await invoke(handler, url('another'))).status, 404);
  assert.equal((await invoke(handler, url('session-a', path.join(dir, '.git', 'config')))).status, 404);

  // Uncommitted work after a finished session is reported, not folded in.
  fs.writeFileSync(file, 'before\nduring\nafter\nlater uncommitted\n');
  time += 2000;
  result = await invoke(handler, url('session-a'));
  assert.equal(result.body.range.head.sha, b);
  assert.equal(result.body.range.uncommittedAfter, true);
  assert.doesNotMatch(result.body.diff, /later uncommitted/);

  // A session still in flight always reads the working tree, from the last commit before it began.
  rows.push(event('live-edit', { timestamp: now - 1000, session_id: 'live', file_path: file }));
  time += 2000;
  result = await invoke(handler, url('live'));
  assert.equal(result.status, 200);
  assert.equal(result.body.range.inFlight, true);
  assert.equal(result.body.range.base.sha, c);
  assert.equal(result.body.range.head.kind, 'working-tree');
  assert.match(result.body.diff, /\+later uncommitted/);
  assert.doesNotMatch(result.body.diff, /\+during/, 'the live session did not write the earlier commits');
  assert.equal(result.body.range.oldContent, 'before\nduring\nafter\n');
  assert.equal(result.body.range.newContent, result.body.content);

  // A file the session created and never committed diffs against nothing.
  const fresh = path.join(dir, 'notes.md');
  fs.writeFileSync(fresh, '# new note\n');
  rows.push(event('live-new', { timestamp: now - 500, session_id: 'live', file_path: fresh }));
  time += 2000;
  result = await invoke(handler, url('live', fresh));
  assert.equal(result.status, 200);
  assert.equal(result.body.range.tracked, false);
  assert.equal(result.body.range.base.sha, c, 'the base commit is still named; the file simply was not in it');
  assert.equal(result.body.range.oldContent, null);
  assert.equal(result.body.range.head.kind, 'working-tree');
  assert.match(result.body.diff, /\+# new note/);

  // A session older than the repository sees the whole tracked file as new.
  result = await invoke(handler, url('ancient'));
  assert.equal(result.status, 200);
  assert.equal(result.body.range.base, null);
  assert.equal(result.body.range.head.kind, 'working-tree', 'no commit falls inside the ancient session, so only the working tree can show its work');
  assert.match(result.body.diff, /\+before\n\+during\n\+after\n\+later uncommitted/);
  assert.equal(git(['status', '--porcelain'], now).trim().split('\n').map(line => line.trim()).sort().join('|'), '?? notes.md|M app.js', 'review leaves the working tree unchanged');
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

test('session fallback and file review honor the chosen duration and preserve overall corpus bounds', async () => {
  const dir = workspace();
  const file = path.join(dir, 'older.md');
  fs.writeFileSync(file, '# Evidence remains reviewable');
  const hour = 3600000;
  const last = now - 7 * 24 * hour;
  const rows = [
    event('archive-edit', { timestamp: last - 30 * hour, session_id: 'archived', file_path: file }),
    event('archive-last', { timestamp: last, session_id: 'archived', type: 'user_prompt' }),
    event('active-edit', { timestamp: now - 30 * hour, session_id: 'active', file_path: file }),
    event('active-last', { timestamp: now, session_id: 'active', type: 'user_prompt' }),
  ];
  const handler = createMemoryHandler({ getEvents: () => rows, corpusRoot: dir, now: () => now });
  const narrow = (await invoke(handler, '/api/memory/session?session=archived')).body;
  assert.equal(narrow.total, 1, 'the older file evidence lies outside the archived default window');
  const archived = (await invoke(handler, '/api/memory/session?session=archived&hours=48')).body;
  assert.equal(archived.start, last - 48 * hour);
  assert.equal(archived.end, last);
  assert.equal(archived.windowHours, 48);
  assert.deepEqual(archived.sessions[0].events.map(e => e[2]), ['archive-edit', 'archive-last']);
  assert.equal(archived.availableStart, last - 30 * hour);
  assert.equal(archived.availableEnd, now, 'session permalinks retain the bounds of the entire corpus');
  for (const [session, evidenceId, timestamp] of [['archived', 'archive-edit', last - 30 * hour], ['active', 'active-edit', now - 30 * hour]]) {
    const link = `/api/memory/file?session=${session}&path=${encodeURIComponent(file)}`;
    assert.equal((await invoke(handler, link)).status, 404);
    const wide = await invoke(handler, `${link}&hours=48`);
    assert.equal(wide.status, 200);
    assert.deepEqual(wide.body.evidence, [{ t: timestamp, id: evidenceId }]);
    assert.equal(wide.body.content, '# Evidence remains reviewable');
  }
  const pinned = await invoke(handler, `/api/memory/session?session=archived&hours=48&end=${now}`);
  assert.equal(pinned.status, 404, 'an explicit historical end never silently relocates to the session');
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
