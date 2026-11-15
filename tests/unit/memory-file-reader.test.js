import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { EventEmitter } from 'node:events';

const fixtureRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'carto-reader-')));
process.env.CARTOGRAPHER_DEV_DIR = fixtureRoot;
for (const name of ['CARTOGRAPHER_SESSION_ID', 'CLAUDE_SESSION_ID', 'CLAUDE_CODE_SESSION_ID', 'CODEX_SESSION_ID', 'CARTOGRAPHER_EDITOR']) delete process.env[name];
process.on('exit', () => fs.rmSync(fixtureRoot, { recursive: true, force: true }));

const { createMemoryHandler } = await import('../../explorer/server/memory.js');
const { createFileReader, editorLauncher } = await import('../../explorer/server/memory-file.js');
const { indexLines, readPage, searchText, PAGE_LINES, PAGE_CHARS, LINE_CHARS, SEARCH_LIMIT } = await import('../../explorer/server/memory-file-text.js');
const { createTurboEntryMiddleware } = await import('../../explorer/server/turbo-entry.js');

const now = Date.parse('2026-11-15T12:00:00Z');
let counter = 0;
const workspace = () => { const dir = path.join(fixtureRoot, `case-${counter++}`); fs.mkdirSync(dir, { recursive: true }); return dir; };
const edit = (file, session = 'session-a') => ({ event_id: `edit-${counter++}`, timestamp: now - 1000, session_id: session, project: 'alpha', type: 'tool_file_edit', file_path: file });
const lines = (n, at = {}) => Array.from({ length: n }, (_, i) => at[i + 1] ?? `line ${i + 1}`).join('\n') + '\n';

function invoke(handler, pathname, { method = 'GET', headers = { host: '127.0.0.1:2526' } } = {}) {
  return new Promise((resolve, reject) => {
    let status;
    handler({ url: pathname, method, headers }, {
      writeHead(code) { status = code; },
      end(raw) { resolve({ status, body: JSON.parse(raw) }); },
    }).then(handled => { if (!handled) resolve({ handled: false }); }, reject);
  });
}

function setup(t, content, { openInEditor = async () => {} } = {}) {
  const dir = workspace();
  const file = path.join(dir, 'big.txt');
  fs.writeFileSync(file, content);
  const fileReader = createFileReader();
  t.after(() => fileReader.close());
  const handler = createMemoryHandler({ getEvents: () => [edit(file)], corpusRoot: dir, now: () => now, fileReader, openInEditor });
  const base = `/api/memory/file?session=session-a&path=${encodeURIComponent(file)}`;
  return { dir, file, handler, base };
}

// ─── Paging and search over decoded text ───

test('pages stop at the line cap, and Previous returns to the exact start Next left', () => {
  const doc = indexLines(lines(1234));
  const first = readPage(doc, 1);
  assert.equal(first.lines.length, PAGE_LINES);
  assert.deepEqual([first.startLine, first.endLine, first.prevLine, first.nextLine, first.totalLines], [1, 500, null, 501, 1234]);
  const second = readPage(doc, first.nextLine);
  assert.equal(second.prevLine, 1);
  const last = readPage(doc, 1001);
  assert.deepEqual([last.endLine, last.nextLine, last.lines.at(-1)], [1234, null, 'line 1234']);
  assert.equal(readPage(doc, last.prevLine).nextLine, 1001);
  assert.throws(() => readPage(doc, 1235), { status: 416 });
  assert.throws(() => readPage(doc, 0), { status: 400 });
  assert.throws(() => readPage(doc, Number.NaN), { status: 400 });
});

test('long lines are clipped and bound the page by characters, both directions alike', () => {
  const wide = 'x'.repeat(LINE_CHARS * 3);
  const doc = indexLines(Array.from({ length: 100 }, () => wide).join('\n'));
  const page = readPage(doc, 1);
  // The fixture must exceed the character cap well before the line cap.
  assert.ok(100 * LINE_CHARS > PAGE_CHARS && page.lines.length < 100);
  assert.ok(page.lines.every(line => line.length === LINE_CHARS));
  assert.equal(page.clipped, page.lines.length);
  const next = readPage(doc, page.nextLine);
  assert.equal(next.prevLine, 1, 'Previous must land where this page began');
});

test('CRLF, a trailing newline and an empty file count lines the way an editor does', () => {
  assert.deepEqual(readPage(indexLines('a\r\nb\r\n'), 1).lines, ['a', 'b']);
  assert.equal(indexLines('a\nb').total, 2);
  assert.equal(indexLines('a\nb\n').total, 2);
  assert.equal(indexLines('\n').total, 1);
  assert.deepEqual(readPage(indexLines(''), 1), { totalLines: 0, startLine: 1, endLine: 0, lines: [], clipped: 0, prevLine: null, nextLine: null });
});

test('search is literal and case-insensitive, and its offsets survive characters that lowercase longer', () => {
  const doc = indexLines(lines(50, { 7: 'İstanbul a.b NEEDLE', 40: 'needle (again)' }));
  const found = searchText(doc, 'needle');
  assert.deepEqual(found.matches.map(m => m.line), [7, 40]);
  const first = found.matches[0];
  assert.equal(first.excerpt.slice(first.start, first.end), 'NEEDLE');
  assert.equal(first.column, 'İstanbul a.b '.length + 1);
  // A regex metacharacter is matched as itself.
  assert.deepEqual(searchText(doc, 'a.b').matches.map(m => m.line), [7]);
  assert.deepEqual(searchText(doc, '(again)').matches.map(m => m.line), [40]);
  assert.throws(() => searchText(doc, '  '), { status: 400 });
  assert.throws(() => searchText(doc, 'x'.repeat(257)), { status: 400 });
});

test('search stops at its limit and says so', () => {
  const found = searchText(indexLines('hit\n'.repeat(SEARCH_LIMIT + 5)), 'hit');
  assert.equal(found.matches.length, SEARCH_LIMIT);
  assert.equal(found.limited, true);
  assert.equal(searchText(indexLines('hit\n'.repeat(3)), 'hit').limited, false);
});

// ─── The route ───

test('a file the preview cuts short is paged and searched through the worker, never opened on the main thread', async t => {
  const { file, handler, base } = setup(t, lines(3000, { 2999: 'the needle is here' }));
  const review = await invoke(handler, base);
  assert.equal(review.status, 200);
  assert.equal(review.body.preview.truncated, true, 'the fixture must exceed the preview');
  assert.equal(review.body.reader.available, true);
  assert.ok(review.body.version && review.body.readerUrl);
  const version = encodeURIComponent(review.body.version);

  // memory.js opens with fs.openSync. A worker has its own fs, so refusing the
  // file here fails any read that still happens on this thread.
  const open = fs.openSync;
  fs.openSync = (target, ...rest) => {
    if (String(target) === file) throw Object.assign(new Error('opened on the main thread'), { code: 'EPERM' });
    return open(target, ...rest);
  };
  t.after(() => { fs.openSync = open; });

  const page = await invoke(handler, `${base}&action=page&line=2501&version=${version}`);
  assert.equal(page.status, 200, JSON.stringify(page.body));
  assert.deepEqual([page.body.startLine, page.body.lines[0], page.body.totalLines, page.body.prevLine], [2501, 'line 2501', 3000, 2001]);
  const found = await invoke(handler, `${base}&action=search&find=NEEDLE&version=${version}`);
  assert.equal(found.status, 200);
  assert.deepEqual(found.body.matches.map(m => m.line), [2999]);
  assert.equal(found.body.version, review.body.version);
});

test('a page names the version it belongs to: an edit, a missing version or a bad line is refused', async t => {
  const { file, handler, base } = setup(t, lines(2500));
  const review = await invoke(handler, base);
  const version = encodeURIComponent(review.body.version);
  assert.equal((await invoke(handler, `${base}&action=page&line=1&version=${version}`)).status, 200);
  assert.equal((await invoke(handler, `${base}&action=page&line=1`)).status, 400);
  assert.equal((await invoke(handler, `${base}&action=page&line=x&version=${version}`)).status, 400);
  assert.equal((await invoke(handler, `${base}&action=page&line=9999&version=${version}`)).status, 416);
  assert.equal((await invoke(handler, `${base}&action=delete&version=${version}`)).status, 400);
  fs.appendFileSync(file, 'one more line\n');
  const stale = await invoke(handler, `${base}&action=page&line=1&version=${version}`);
  assert.equal(stale.status, 409);
  assert.match(stale.body.error, /changed/);
});

test('paging keeps the review guards: another session, a symlink swap and a binary file are refused', async t => {
  const { dir, file, handler, base } = setup(t, lines(2500));
  const other = workspace();
  fs.writeFileSync(path.join(other, 'secret.txt'), 'outside\n');
  const review = await invoke(handler, base);
  const version = encodeURIComponent(review.body.version);
  const elsewhere = `/api/memory/file?session=session-b&path=${encodeURIComponent(file)}&action=page&version=${version}`;
  assert.equal((await invoke(handler, elsewhere)).status, 404);
  fs.unlinkSync(file);
  fs.symlinkSync(path.join(other, 'secret.txt'), file);
  assert.equal((await invoke(handler, `${base}&action=page&version=${version}`)).status, 403);
  fs.unlinkSync(file);
  fs.writeFileSync(file, Buffer.concat([Buffer.from(lines(2500)), Buffer.from([0])]));
  const binary = await invoke(handler, base);
  assert.equal(binary.status, 200, 'the preview stops before the NUL');
  assert.equal((await invoke(handler, `${base}&action=page&version=${encodeURIComponent(binary.body.version)}`)).status, 415);
  assert.ok(dir);
});

test('a stalled read fails with 503 and the next request starts a fresh worker', async () => {
  const spawned = [];
  const reader = createFileReader({
    stallMs: 30,
    spawn: () => {
      const worker = Object.assign(new EventEmitter(), { posted: [], terminated: false, postMessage(message) { this.posted.push(message); }, terminate() { this.terminated = true; }, unref() {} });
      spawned.push(worker);
      return worker;
    },
  });
  await assert.rejects(reader.read({ file: '/x', version: 'v', action: 'page', line: 1 }), { status: 503 });
  assert.equal(spawned[0].terminated, true);
  const second = reader.read({ file: '/x', version: 'v', action: 'page', line: 1 });
  assert.equal(spawned.length, 2);
  spawned[1].emit('message', { id: spawned[1].posted[0].id, result: { lines: ['ok'] } });
  assert.deepEqual(await second, { lines: ['ok'] });
  reader.close();
});

// ─── Open in editor ───

test('open in editor needs POST, the action header and the version the review read', async t => {
  const opened = [];
  const { file, handler, base } = setup(t, 'short file\n', { openInEditor: async target => { opened.push(target); } });
  const review = await invoke(handler, base);
  // The client posts this URL as served, so it must already carry the version.
  const target = review.body.openUrl;
  const served = new URL(target, 'http://127.0.0.1');
  assert.equal(served.pathname, '/api/memory/file/open');
  assert.equal(served.searchParams.get('version'), review.body.version);
  assert.equal(served.searchParams.get('path'), file);
  const action = { host: '127.0.0.1:2526', 'x-cartographer-action': 'open-file' };
  assert.equal((await invoke(handler, target)).status, 405);
  assert.equal((await invoke(handler, target, { method: 'POST' })).status, 403);
  assert.equal((await invoke(handler, target, { method: 'POST', headers: { ...action, host: 'attacker.example' } })).status, 403);
  assert.equal((await invoke(handler, target, { method: 'POST', headers: { ...action, origin: 'https://attacker.example' } })).status, 403);
  assert.deepEqual(opened, [], 'no refused request may launch anything');
  const ok = await invoke(handler, target, { method: 'POST', headers: action });
  assert.equal(ok.status, 200);
  assert.deepEqual(opened, [file]);
  fs.appendFileSync(file, 'edited\n');
  assert.equal((await invoke(handler, target, { method: 'POST', headers: action })).status, 409);
  const stranger = target.replace('session=session-a', 'session=session-b');
  assert.equal((await invoke(handler, stranger, { method: 'POST', headers: action })).status, 404);
  assert.deepEqual(opened, [file]);
});

test('without a launcher the review offers no open link, and the route says why', async t => {
  const { handler, base } = setup(t, 'x\n', { openInEditor: null });
  const review = await invoke(handler, base);
  assert.equal(review.body.openUrl, null);
  const refused = await invoke(handler, `/api/memory/file/open?${base.split('?')[1]}&version=${encodeURIComponent(review.body.version)}`, { method: 'POST', headers: { host: '127.0.0.1', 'x-cartographer-action': 'open-file' } });
  assert.equal(refused.status, 501);
});

test('the editor is CARTOGRAPHER_EDITOR when set, macOS open -t otherwise, and nothing elsewhere', async () => {
  const runs = [];
  const run = async (...args) => { runs.push(args.slice(0, 2)); };
  await editorLauncher({ env: { CARTOGRAPHER_EDITOR: ' cursor ' }, platform: 'linux', run })('/a b.js');
  await editorLauncher({ env: {}, platform: 'darwin', run })('/a b.js');
  assert.deepEqual(runs, [['cursor', ['/a b.js']], ['/usr/bin/open', ['-t', '--', '/a b.js']]]);
  assert.equal(editorLauncher({ env: {}, platform: 'linux', run }), null);
});

test('the UI host forwards an open as a POST with its action, and refuses one without it', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-reader-entry-'));
  const config = path.join(root, 'config.json');
  fs.writeFileSync(config, JSON.stringify({ turbo: { enabled: true, url: 'http://127.0.0.1:45977' } }));
  const forwarded = [];
  const middleware = createTurboEntryMiddleware({
    env: { ...process.env, CARTOGRAPHER_CONFIG: config, CARTOGRAPHER_TURBO_URL: 'http://127.0.0.1:45977' },
    startupProbeMs: 0, runController: async () => ({}), probeMemory: async () => null,
    fetchImpl: async (target, options) => { forwarded.push({ target: target.toString(), method: options.method || 'GET', action: options.headers['x-cartographer-action'] }); return new Response('{"opened":true}'); },
  });
  const server = http.createServer((req, res) => middleware(req, res, () => { res.writeHead(404); res.end(); }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${server.address().port}`;
  const pathname = '/api/memory/file/open?session=one&path=%2Ftmp%2Fa.js&version=1';
  const headers = { Origin: url, 'Content-Type': 'application/json', 'X-Cartographer-Action': 'open-file' };
  assert.equal((await fetch(`${url}${pathname}`)).status, 403, 'a GET is not an open');
  assert.equal((await fetch(`${url}${pathname}`, { method: 'POST', headers: { ...headers, 'X-Cartographer-Action': 'start' } })).status, 403);
  assert.equal((await fetch(`${url}${pathname}`, { method: 'POST', headers: { ...headers, Origin: 'https://attacker.example' } })).status, 403);
  assert.deepEqual(forwarded, []);
  const ok = await fetch(`${url}${pathname}`, { method: 'POST', headers, body: '{}' });
  assert.equal(ok.status, 200);
  assert.deepEqual(forwarded, [{ target: `http://127.0.0.1:45977${pathname}`, method: 'POST', action: 'open-file' }]);
});
