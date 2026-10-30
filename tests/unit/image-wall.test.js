import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createImageWall, namedBy, projectOfPath, scanTranscriptImages } from '../../explorer/server/image-wall.js';
import { imageDimensions } from '../../explorer/server/image-probe.js';
import { blockedMessage, createGuardedInspector, protectedRoot } from '../../explorer/server/guarded-open.js';
import { inspectImage } from '../../explorer/server/session-artifacts.js';
import { EventEmitter } from 'node:events';
import { createThumbnailer, snapThumbWidth } from '../../explorer/server/image-thumbs.js';
import { resolveWunderkammerFile } from '../../explorer/server/wunderkammer-static.js';
import { createExplorerUiMiddleware } from '../../explorer/server/explorer-ui.js';
import { validateCollection } from '../../explorer/node_modules/wunderkammer/wall/collection.mjs';

// A 2×3 RGB PNG header, enough for the probe; the wall never decodes here.
function png(width, height, colourType = 2) {
  const b = Buffer.alloc(33);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(b, 0);
  b.writeUInt32BE(13, 8); b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(width, 16); b.writeUInt32BE(height, 20); b[24] = 8; b[25] = colourType;
  return b;
}

function fixture(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'carto-image-wall-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const at = iso => Date.parse(iso) / 1000;
  return {
    dir,
    image(rel, content = png(4, 2), mtime) {
      const file = path.join(dir, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
      if (mtime) fs.utimesSync(file, at(mtime), at(mtime));
      return file;
    },
    transcript(name, rows) {
      const file = path.join(dir, name);
      fs.writeFileSync(file, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
      return file;
    },
  };
}

const row = (uuid, role, timestamp, content) => ({ type: role, uuid, sessionId: 'wall-session', timestamp, message: { role, content } });
const bash = (uuid, timestamp, id) => row(uuid, 'assistant', timestamp, [{ type: 'tool_use', id, name: 'Bash', input: { command: 'render' } }]);
const output = (uuid, timestamp, id, text) => row(uuid, 'user', timestamp, [{ type: 'tool_result', tool_use_id: id, content: text }]);
const read = (uuid, timestamp, file) => row(uuid, 'assistant', timestamp, [{ type: 'tool_use', id: `read-${uuid}`, name: 'Read', input: { file_path: file } }]);

const SPAN = { start: '2026-10-29T10:00:00Z', end: '2026-10-29T11:00:00Z' };
const NOW = Date.parse('2026-10-29T12:00:00Z');
const urls = {
  fileUrl: (file, id, w) => `/api/images/file?${new URLSearchParams({ path: file, id, ...(w ? { w: String(w) } : {}) })}`,
  transcriptUrl: (file, link) => `http://127.0.0.1:2527/session/${encodeURIComponent(file)}?uuid=${link.messageId}`,
};
// The worker pool is the production scan; tests run the same function inline.
const inline = files => Promise.resolve(files.map(file => ({ file, record: scanTranscriptImages(file) })));

function sessionFixture(t) {
  const f = fixture(t);
  const written = f.image('repo-a/out/written.png', png(1600, 900), '2026-10-29T10:30:00Z');
  const older = f.image('repo-a/reference.png', png(300, 300, 6), '2026-10-20T09:00:00Z');
  const gone = path.join(f.dir, 'repo-a', 'purged.png');
  const transcript = f.transcript('session.jsonl', [
    row('u0', 'user', SPAN.start, 'make the frames'),
    bash('a1', '2026-10-29T10:29:00Z', 'render-1'),
    output('r1', '2026-10-29T10:30:05Z', 'render-1', `wrote ${written}\nand ${gone}`),
    read('a2', '2026-10-29T10:40:00Z', older),
    row('a3', 'assistant', SPAN.end, 'done'),
  ]);
  return { f, written, older, transcript, session: { session_id: 'wall-session', provider: 'claude', project: 'dev', projects: ['dev', 'repo-a'] } };
}

test('a scanned transcript keeps paths, naming times and how each image was named, not tool bodies', t => {
  const { transcript, written, older } = sessionFixture(t);
  const record = scanTranscriptImages(transcript);
  assert.deepEqual(record.span, { start: '2026-10-29T10:00:00.000Z', end: '2026-10-29T11:00:00.000Z' });
  const byPath = Object.fromEntries(record.images.map(image => [image.path, image]));
  assert.deepEqual(byPath[written].named, ['tool output']);
  assert.equal(byPath[written].firstAt, '2026-10-29T10:30:05Z');
  assert.deepEqual(byPath[written].link, { messageId: 'r1', blockId: byPath[written].link.blockId });
  assert.deepEqual(byPath[older].named, ['read']);
  // The session title is identity and stays; command text and tool output do not.
  assert.equal(record.identity.title, 'make the frames');
  assert.doesNotMatch(JSON.stringify(record), /wrote |"command"|render-1/);
});

test('"changed" keeps only images written inside a naming session; "named" adds the rest, labelled', async t => {
  const { transcript, written, older, session } = sessionFixture(t);
  let scans = 0;
  const wall = createImageWall({ scan: files => { scans += 1; return inline(files); }, now: () => NOW });
  const changed = await wall.collection({ transcripts: [{ path: transcript, session }], days: 7, scope: 'changed', ...urls });
  assert.deepEqual(changed.collection.clips.map(c => c.title), ['written.png']);
  assert.equal(changed.stats.missing, 1, 'the purged file is counted, not shown');
  assert.equal(changed.stats.namedOnly, 1);
  const [clip] = changed.collection.clips;
  assert.equal(clip.props.project, 'repo-a', 'a workspace-root session falls back to its first real project');
  assert.equal(clip.props.shape, 'landscape');
  assert.equal(clip.source, 'Claude Code');
  assert.match(clip.note, /Written during Claude Code session/);
  assert.match(clip.note, /1600 × 900/);
  assert.equal(clip.sourceUrl, urls.transcriptUrl(transcript, { messageId: 'r1' }));
  assert.match(clip.cover, /&w=320$/);
  assert.doesNotMatch(clip.detailCover, /w=/);

  // Wunderkammer must load what the Explorer serves.
  const { collection, warnings } = validateCollection(changed.collection, { baseUrl: 'http://127.0.0.1:2527/images' });
  assert.equal(collection.clips.length, 1);
  assert.deepEqual(warnings, []);

  const named = await wall.collection({ transcripts: [{ path: transcript, session }], days: 30, scope: 'named', ...urls });
  const props = Object.fromEntries(named.collection.clips.map(c => [c.title, c.props.written]));
  assert.deepEqual(props, { 'written.png': 'during a session', 'reference.png': 'outside sessions' });
  assert.ok(named.collection.ui.facetOrder.includes('written'));
  assert.equal(scans, 1, 'an unchanged transcript is not parsed twice');
});

test('the window bounds by write time, and an empty window returns no document', async t => {
  const { transcript, session } = sessionFixture(t);
  const wall = createImageWall({ scan: inline, now: () => NOW + 8 * 24 * 60 * 60 * 1000 });
  const result = await wall.collection({ transcripts: [{ path: transcript, session }], days: 7, scope: 'changed', ...urls });
  assert.equal(result.collection, null, 'the validator refuses zero clips, so none is built');
  assert.equal(result.stats.outside, 1);
});

test('open() serves only images the transcript names, and a grown transcript keeps its authorization', async t => {
  const { transcript, written, session } = sessionFixture(t);
  let scans = 0;
  const wall = createImageWall({ scan: files => { scans += 1; return inline(files); }, now: () => NOW });
  const { collection } = await wall.collection({ transcripts: [{ path: transcript, session }], days: 7, scope: 'changed', ...urls });
  const id = collection.clips[0].id;
  fs.appendFileSync(transcript, JSON.stringify(row('a4', 'assistant', SPAN.end, 'later')) + '\n');
  const opened = await wall.open(transcript, id);
  fs.closeSync(opened.fd);
  assert.equal(opened.artifact.path, written);
  assert.deepEqual(opened.dimensions, { width: 1600, height: 900, alpha: false });
  assert.equal(scans, 1, 'appending does not force a rescan to serve a cover');
  await assert.rejects(wall.open(transcript, 'f'.repeat(24)), error => error.status === 404);
});

test('header probes read PNG, GIF, BMP, WebP and JPEG sizes and refuse truncated files', t => {
  const f = fixture(t);
  const probe = (name, bytes, mime) => {
    const file = f.image(name, bytes);
    const fd = fs.openSync(file, 'r');
    try { return imageDimensions(fd, bytes.length, mime); } finally { fs.closeSync(fd); }
  };
  assert.deepEqual(probe('a.png', png(2, 3, 6), 'image/png'), { width: 2, height: 3, alpha: true });
  const gif = Buffer.from('GIF89a\x05\x00\x07\x00', 'latin1');
  assert.deepEqual(probe('a.gif', gif, 'image/gif'), { width: 5, height: 7, alpha: true });
  const bmp = Buffer.alloc(26); bmp.write('BM', 0); bmp.writeInt32LE(9, 18); bmp.writeInt32LE(-4, 22);
  assert.deepEqual(probe('a.bmp', bmp, 'image/bmp'), { width: 9, height: 4, alpha: false });
  const webp = Buffer.alloc(30); webp.write('RIFF', 0); webp.write('WEBPVP8X', 8); webp[20] = 0x10; webp.writeUIntLE(99, 24, 3); webp.writeUIntLE(49, 27, 3);
  assert.deepEqual(probe('a.webp', webp, 'image/webp'), { width: 100, height: 50, alpha: true });
  // SOI, an APP0 segment to skip, then SOF0 with height 480 and width 640.
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0xe0, 0x02, 0x80, 0x03, 0, 0, 0, 0]);
  assert.deepEqual(probe('a.jpg', jpeg, 'image/jpeg'), { width: 640, height: 480, alpha: false });
  assert.equal(probe('short.png', png(2, 3).subarray(0, 20), 'image/png'), null);
  assert.equal(probe('a.svg', Buffer.from('<svg/>'), 'image/svg+xml'), null);
});

test('evidence labels become a small "named by" vocabulary', () => {
  assert.equal(namedBy({ source: 'assistant-link', label: 'Assistant image link' }), 'reply link');
  assert.equal(namedBy({ source: 'tool-input', label: 'mcp__ccd_session__SendUserFile reference' }), 'sent to user');
  assert.equal(namedBy({ source: 'tool-input', label: 'Read reference' }), 'read');
  assert.equal(namedBy({ source: 'tool-output', label: 'exec output' }), 'tool output');
  assert.equal(namedBy({ source: 'tool-output', label: 'Recorded image listing' }), 'listing');
});

test('projects come from the image path, resolving linked worktrees to their repository', t => {
  const f = fixture(t);
  const dev = path.join(f.dir, 'dev');
  fs.mkdirSync(path.join(dev, 'worktrees', 'feature-x'), { recursive: true });
  fs.writeFileSync(path.join(dev, 'worktrees', 'feature-x', '.git'), `gitdir: ${path.join(dev, 'widget-web', '.git', 'worktrees', 'feature-x')}\n`);
  const home = path.join(f.dir, 'home');
  assert.equal(projectOfPath(path.join(dev, 'widget-web', 'shots', 'a.png'), { devDir: dev, home }), 'widget-web');
  assert.equal(projectOfPath(path.join(dev, 'worktrees', 'feature-x', 'a.png'), { devDir: dev, home }), 'widget-web');
  assert.equal(projectOfPath(path.join(dev, 'widget-web', '.claude', 'worktrees', 'brave-hopper-b21262', 'a.png'), { devDir: dev, home }), 'widget-web');
  assert.equal(projectOfPath(path.join(home, '.codex', 'worktrees', '1303', 'gyre', 'a.png'), { devDir: dev, home }), 'gyre');
  assert.equal(projectOfPath(path.join(dev, 'a.png'), { devDir: dev, home }), '', 'a file at the workspace root names no project');
  assert.equal(projectOfPath('/private/tmp/scratch/a.png', { devDir: dev, home }), '');
});

test('the wall route serves only the page and wall/, and refuses traversal', t => {
  const f = fixture(t);
  f.image('pkg/index.html', Buffer.from('<!doctype html>'));
  f.image('pkg/wall/embed.mjs', Buffer.from('export {}'));
  f.image('pkg/serve.mjs', Buffer.from('secret'));
  const root = path.join(f.dir, 'pkg');
  assert.equal(resolveWunderkammerFile('/wunderkammer/', root), path.join(root, 'index.html'));
  assert.equal(resolveWunderkammerFile('/wunderkammer/wall/embed.mjs', root), path.join(root, 'wall', 'embed.mjs'));
  for (const url of ['/wunderkammer/serve.mjs', '/wunderkammer/wall/../serve.mjs', '/wunderkammer/wall/%2e%2e/serve.mjs', '/wunderkammer/wall/%00.mjs', '/wunderkammer/wall/missing.mjs', '/elsewhere/wall/embed.mjs']) {
    assert.equal(resolveWunderkammerFile(url, root), null, url);
  }
});

test('thumbnails: widths snap, other platforms serve originals, and a changed source is refused', async t => {
  assert.deepEqual([0, 100, 320, 321, 5000].map(snapThumbWidth), [0, 160, 320, 640, 640]);
  const f = fixture(t);
  const file = f.image('big.png', Buffer.concat([png(2000, 1000), Buffer.alloc(300 * 1024)]));
  const opened = () => ({ artifact: { path: file }, stat: fs.statSync(file), mime: 'image/png', dimensions: { width: 2000, height: 1000, alpha: false } });
  assert.equal(await createThumbnailer({ platform: 'linux', dir: path.join(f.dir, 'off') }).thumbnail(opened(), 320), null);

  const sips = f.image('sips', Buffer.from('#!/bin/sh\n'));
  const calls = [];
  const exec = async (bin, args) => { calls.push(args); fs.writeFileSync(args.at(-1), 'thumb'); };
  const thumbs = createThumbnailer({ platform: 'darwin', sips, dir: path.join(f.dir, 'thumbs'), exec });
  const first = await thumbs.thumbnail(opened(), 320);
  assert.equal(first.mime, 'image/jpeg', 'an opaque PNG becomes a JPEG thumbnail');
  assert.equal(fs.readFileSync(first.file, 'utf8'), 'thumb');
  assert.deepEqual(calls[0].slice(0, 4), ['-Z', '320', '-s', 'format']);
  await thumbs.thumbnail(opened(), 320);
  assert.equal(calls.length, 1, 'a cached thumbnail is not regenerated');
  const small = { ...opened(), dimensions: { width: 200, height: 100, alpha: false } };
  assert.equal(await thumbs.thumbnail(small, 320), null, 'never enlarge');

  const racing = createThumbnailer({ platform: 'darwin', sips, dir: path.join(f.dir, 'race'), exec: async (bin, args) => { fs.appendFileSync(file, 'x'); fs.writeFileSync(args.at(-1), 'thumb'); } });
  await assert.rejects(racing.thumbnail(opened(), 640), error => error.status === 409);
  assert.deepEqual(fs.readdirSync(path.join(f.dir, 'race')), [], 'nothing half-made is left behind');
});

test('the UI host routes both image endpoints to the Explorer app', async () => {
  const seen = [];
  const middleware = createExplorerUiMiddleware({ loadApp: async () => ({ app: req => seen.push(req.url), close() {} }) });
  for (const url of ['/api/images/collection?days=7', '/api/images/file?path=x&id=y&w=320']) {
    await middleware({ url, method: 'GET', headers: { host: '127.0.0.1:2527' } }, { headersSent: false, writeHead() {}, end() {} }, () => assert.fail(`${url} escaped to Turbo`));
  }
  assert.equal(seen.length, 2);
  await middleware.close();
});

// A worker stand-in: answers each file on a later tick, except files that
// "stall", which it never answers, as a thread parked in open(2) never does.
function fakeSpawn(stalls, spawned, resultFor = file => ({ status: 'available', file })) {
  return data => {
    const worker = new EventEmitter();
    worker.terminate = () => { worker.terminated = true; };
    worker.unref = () => {};
    spawned.push(data.files);
    (async () => {
      for (const [index, file] of data.files.entries()) {
        await new Promise(resolve => setTimeout(resolve, 1));
        if (worker.terminated) return;
        if (stalls.has(file)) return;
        worker.emit('message', { index, result: resultFor(file) });
      }
      worker.emit('message', { done: true });
    })();
    return worker;
  };
}

test('a stalled open blocks its protected folder and the rest continue on a fresh worker', async () => {
  const home = path.join(path.parse(process.cwd()).root, 'Users', 'someone');
  const stalled = path.join(home, 'Downloads', 'export', 'contact.png');
  const sibling = path.join(home, 'Downloads', 'other.png');
  const files = ['/repo/a.png', stalled, sibling, '/repo/b.png'];
  const spawned = [];
  let clock = 0;
  const inspector = createGuardedInspector({ stallMs: 40, retryMs: 1000, home, platform: 'darwin', spawn: fakeSpawn(new Set([stalled]), spawned), now: () => clock });
  const tick = setInterval(() => { clock += 10; }, 5);
  try {
    const results = await inspector.inspect(files);
    assert.equal(results.get('/repo/a.png').status, 'available');
    assert.equal(results.get('/repo/b.png').status, 'available', 'files after the stall are still checked');
    assert.deepEqual(results.get(stalled), { status: 'blocked', root: path.join(home, 'Downloads'), code: 503, reason: `macOS has not let the Explorer read ~${path.sep}Downloads.` });
    assert.equal(results.get(sibling).status, 'blocked', 'a sibling in the blocked folder is not attempted');
    assert.deepEqual(spawned, [files, ['/repo/b.png']]);
    assert.deepEqual(inspector.blockedRoots(), [path.join(home, 'Downloads')]);
    assert.equal(inspector.isBlocked(sibling), true);
    clock += 2000;
    assert.equal(inspector.isBlocked(sibling), false, 'the folder is retried after retryMs, once a grant may exist');
  } finally { clearInterval(tick); }
});

test('the real worker inspects images, and protected roots name the grant, not the file', async t => {
  const f = fixture(t);
  const image = f.image('ok.png', png(10, 20, 6));
  const inspector = createGuardedInspector();
  const results = await inspector.inspect([image, path.join(f.dir, 'gone.png')]);
  assert.equal(results.get(image).status, 'available');
  assert.deepEqual(results.get(image).dimensions, { width: 10, height: 20, alpha: true });
  assert.equal(results.get(path.join(f.dir, 'gone.png')).status, 'missing');
  const again = inspectImage(image, { key: results.get(image).key, dimensions: { width: 1, height: 1, alpha: false } });
  assert.deepEqual(again.dimensions, { width: 1, height: 1, alpha: false }, 'a matching fingerprint skips the header read');

  const root = path.parse(process.cwd()).root, home = path.join(root, 'Users', 'someone');
  assert.equal(protectedRoot(path.join(home, 'Desktop', 'a', 'b.png'), home), path.join(home, 'Desktop'));
  assert.equal(protectedRoot(path.join(home, 'Library', 'CloudStorage', 'GoogleDrive-x', 'My Drive', 'a.png'), home), path.join(home, 'Library', 'CloudStorage', 'GoogleDrive-x'));
  assert.equal(protectedRoot(path.join(root, 'Volumes', 'andyed', 'Pictures', 'a.JPG'), home), path.join(root, 'Volumes', 'andyed'));
  const own = path.join(home, '.codex', 'generated_images', 'a.png');
  assert.equal(protectedRoot(own, home), own);
  assert.equal(blockedMessage(path.join(home, 'Downloads'), home, 'darwin'), `macOS has not let the Explorer read ~${path.sep}Downloads.`);
  assert.match(blockedMessage(path.join(root, 'Volumes', 'nas'), home, 'win32'), /^Opening files in .+ stalled, so the Explorer skipped them\.$/);
});

test('ensure() trusts a recent worker open, re-checks after trustMs, and never trusts a failure', async () => {
  const spawned = [];
  let clock = 0;
  const inspector = createGuardedInspector({ trustMs: 100, spawn: fakeSpawn(new Set(), spawned), now: () => clock });
  assert.equal((await inspector.ensure('/repo/a.png')).status, 'available');
  assert.equal(spawned.length, 1);
  clock = 50;
  await inspector.ensure('/repo/a.png');
  assert.equal(spawned.length, 1, 'a recent success needs no second worker');
  await inspector.ensure('/repo/a.png', { kind: 'document' });
  assert.equal(spawned.length, 2, 'an image check does not vouch for a document open');
  clock = 200;
  await inspector.ensure('/repo/a.png');
  assert.equal(spawned.length, 3, 'trust expires');
  const failing = createGuardedInspector({ spawn: fakeSpawn(new Set(), spawned, () => ({ status: 'missing' })) });
  await failing.ensure('/repo/gone.png'); await failing.ensure('/repo/gone.png');
  assert.equal(spawned.length, 5, 'a failed check is repeated rather than trusted');
});
