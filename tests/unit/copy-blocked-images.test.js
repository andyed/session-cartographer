import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { copyOne, planCopies } from '../../scripts/copy-blocked-images.js';
import { copyPathFor } from '../../explorer/server/guarded-open.js';

const SCRIPT = fileURLToPath(new URL('../../scripts/copy-blocked-images.js', import.meta.url));

function fixture(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'carto-copy-blocked-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, 'home'), copyDir = path.join(dir, 'copies');
  const put = (rel, content = 'png') => { const file = path.join(home, rel); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); return file; };
  return { dir, home, copyDir, put };
}

test('only regular images inside a protected folder are planned', t => {
  const { home, copyDir, put } = fixture(t);
  const image = put(path.join('Downloads', 'walker', 'contact.png'));
  const notes = put(path.join('Downloads', 'notes.md'));
  const outside = put(path.join('repo', 'shot.png'));
  // Windows refuses symlinkSync without elevation; the case runs where it can.
  const link = path.join(home, 'Downloads', 'link.png');
  let linked = true;
  try { fs.symlinkSync(image, link); } catch { linked = false; }
  const { copy, skipped } = planCopies([image, notes, outside, ...(linked ? [link] : []), path.join(home, 'Downloads', 'gone.png'), 'relative.png'], { copyDir, home });
  assert.deepEqual(copy.map(c => [c.from, c.to]), [[image, copyPathFor(image, copyDir)]]);
  assert.deepEqual(Object.fromEntries(skipped.map(s => [path.basename(s.file), s.reason])), {
    'notes.md': 'not an image', 'shot.png': 'not in a protected folder', ...(linked ? { 'link.png': 'symlink' } : {}), 'gone.png': 'missing', 'relative.png': 'not an absolute path',
  });
});

test('a copy keeps its original mtime, because the wall classifies writes by it', t => {
  const { home, copyDir, put } = fixture(t);
  const image = put(path.join('Downloads', 'a.png'), 'pixels');
  const when = new Date('2026-10-29T10:30:00Z');
  fs.utimesSync(image, when, when);
  const [item] = planCopies([image], { copyDir, home }).copy;
  copyOne(item);
  assert.equal(fs.readFileSync(item.to, 'utf8'), 'pixels');
  assert.equal(fs.statSync(item.to).mtimeMs, when.getTime());
  assert.deepEqual(fs.readdirSync(path.dirname(item.to)), ['a.png'], 'no temporary file is left');
});

test('the script copies what the running Explorer reports blocked', async t => {
  const { home, copyDir, put } = fixture(t);
  const image = put(path.join('Downloads', 'walker', 'contact.png'), 'pixels');
  const server = http.createServer((req, res) => {
    assert.match(req.url, /^\/api\/images\/collection\?days=30&scope=named$/);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ collection: null, stats: { blockedFiles: [image], blockedRoots: ['~/Downloads'] } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const env = { ...process.env, HOME: home, USERPROFILE: home, CARTOGRAPHER_PROTECTED_COPY_DIR: copyDir };
  const child = spawn(process.execPath, [SCRIPT, '--days', '30', '--explorer', `http://127.0.0.1:${server.address().port}`], { env });
  let out = '';
  child.stdout.on('data', d => { out += d; }); child.stderr.on('data', d => { out += d; });
  const code = await new Promise(resolve => child.on('close', resolve));
  assert.equal(code, 0, out);
  assert.match(out, /^Copied 1 of 1 blocked image into /m);
  assert.equal(fs.readFileSync(copyPathFor(image, copyDir), 'utf8'), 'pixels');
});
