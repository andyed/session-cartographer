import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { artifactHeaders, canonicalSessionArtifacts, createSessionArtifactCache, discoverSessionArtifacts, documentHeaders, openSessionArtifact, openSessionDocument } from '../../explorer/server/session-artifacts.js';
import { OFFLINE_INDEX_ENV } from './helpers/offline-index.js';
import { createGuardedInspector } from '../../explorer/server/guarded-open.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aPcQAAAAASUVORK5CYII=', 'base64');
function fixture(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'carto-artifacts-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, image(name = 'graphic.png', content = PNG) { const file = path.join(dir, name); fs.writeFileSync(file, content); return file; } };
}
const msg = (uuid, role, content) => ({ type: role, uuid, sessionId: 'artifact-session', message: { role, content } });
const call = (id, name, input) => ({ type: 'tool_use', id, name, input });
const result = (id, content, extra = {}) => ({ type: 'tool_result', tool_use_id: id, content, ...extra });
const read = (file, id = 'read') => msg(id, 'assistant', [call(id, 'Read', { file_path: file })]);

test('lists explicit image references with stable IDs and exact conversation provenance', t => {
  const f = fixture(t), image = f.image(), image2 = f.image('graphic two.png');
  const missing = path.join(f.dir, 'purged.png');
  const rows = [read(image), read(missing, 'missing'), msg('shared', 'assistant', [call('share', 'SendUserFile', { files: [image] })]),
    msg('links', 'assistant', [{ type: 'text', text: `[Second graphic](${pathToFileURL(image2)}) ![Remote](https://example.com/remote.png) [Remote file](file://server/share/remote.png)` }]),
    read('\\\\server\\share\\remote.png', 'remote-share'),
  ];
  f.image('unreferenced.png');
  const response = discoverSessionArtifacts(rows, { transcriptPath: '/authorized/session.jsonl' });
  assert.equal(response.identity.sessionId, 'artifact-session');
  assert.equal(response.artifacts.length, 3, 'does not scan neighbors or fetch remote images');
  assert.deepEqual(response.artifacts.map(a => a.status), ['available', 'available', 'missing']);
  const graphic = response.artifacts.find(a => a.path === image);
  assert.equal(graphic.source, 'referenced', 'Read and sharing are not evidence of creation');
  assert.deepEqual(graphic.evidence.map(e => [e.messageId, e.blockId]), [['read', 'read--block-0'], ['shared', 'shared--block-0']]);
  assert.equal(graphic.mime, 'image/png');
  assert.equal(graphic.size, PNG.length);
  const preview = new URL(graphic.previewUrl, 'http://local.invalid');
  assert.equal(preview.pathname, '/api/session/artifact');
  assert.equal(preview.searchParams.get('path'), '/authorized/session.jsonl');
  assert.equal(preview.searchParams.get('id'), graphic.id);
  assert.equal(response.artifacts.find(a => a.path === missing).previewUrl, null);
  assert.equal(discoverSessionArtifacts(rows).artifacts.find(a => a.path === image).id, graphic.id);
});

test('retains output text paths and only labels explicit successful Write results as created', t => {
  const f = fixture(t), image = f.image('created.png'), uncertain = f.image('uncertain.png'), failed = f.image('failed.png');
  const rows = [
    msg('write-call', 'assistant', [call('write', 'Write', { file_path: image }), call('uncertain', 'Write', { file_path: uncertain }), call('failed', 'Write', { file_path: failed })]),
    msg('write-result', 'user', [result('write', `File created successfully at: ${image}`), result('uncertain', 'File created successfully? No.'), result('failed', 'File created successfully? No.', { is_error: true })]),
    { type: 'response_item', payload: { type: 'function_call_output', call_id: 'output', output: [{ type: 'input_text', text: JSON.stringify({ output: image }) }] } },
  ];
  // Provider records are never mixed in a real transcript.
  const claude = discoverSessionArtifacts(rows.slice(0, 2)).artifacts;
  assert.equal(claude.find(a => a.path === image).source, 'created');
  assert.equal(claude.find(a => a.path === uncertain).source, 'referenced');
  assert.equal(claude.find(a => a.path === failed).source, 'referenced');
  const codex = discoverSessionArtifacts(rows.slice(2)).artifacts;
  assert.equal(codex[0].path, image);
  assert.equal(codex[0].evidence[0].source, 'tool-output');
});

test('literal output directory plus paired identify rows discovers exact names without evaluating shell', t => {
  const f = fixture(t), image = f.image('one.png');
  f.image('not-listed.png');
  const command = `O=${f.dir}\nmagick identify "$O"/*.png | awk '{print $3, $1}' | sed "s|$O/||"`;
  const rows = [msg('render', 'assistant', [call('render', 'Bash', { command })]), msg('listing', 'user', [result('render', '3200x1800 one.png\n3200x1800 ../escape.png')])];
  const artifacts = discoverSessionArtifacts(rows).artifacts;
  assert.equal(artifacts.length, 1);
  assert.equal(artifacts[0].path, image);
  assert.equal(artifacts[0].source, 'referenced');
  assert.equal(artifacts[0].evidence[0].label, 'Recorded image listing');
  for (const command of ['O=$HOME/output\nmagick identify "$O"/*.png', `O=${f.dir}\nO=/another\nmagick identify "$O"/*.png`, `O=${f.dir}\nls "$O"`]) {
    const response = discoverSessionArtifacts([msg('call', 'assistant', [call('r', 'Bash', { command })]), msg('result', 'user', [result('r', '3200x1800 one.png')])]);
    assert.equal(response.artifacts.length, 0, 'ambiguous or unrecognized shell forms are not expanded');
  }
});

test('serves only a rediscovered exact reference and rechecks missing or changed files', t => {
  const f = fixture(t), image = f.image(), other = f.image('unreferenced.png');
  const rows = [read(image)], id = discoverSessionArtifacts(rows).artifacts[0].id;
  const opened = openSessionArtifact(rows, id);
  try { assert.deepEqual(fs.readFileSync(opened.fd), PNG); } finally { fs.closeSync(opened.fd); }
  const otherId = discoverSessionArtifacts([read(other)]).artifacts[0].id;
  assert.throws(() => openSessionArtifact(rows, otherId), error => error.status === 404);
  assert.throws(() => openSessionArtifact(rows, '../../outside.png'), error => error.status === 404);
  fs.writeFileSync(image, '<html><script>alert(1)</script></html>');
  assert.throws(() => openSessionArtifact(rows, id), error => error.status === 415);
  fs.unlinkSync(image);
  assert.throws(() => openSessionArtifact(rows, id), error => error.status === 404);
});

test('rejects image extensions containing HTML and nonregular files; SVG is sandboxed image content', t => {
  const f = fixture(t), html = f.image('pretend.png', '<!doctype html><script>alert(1)</script>');
  const svg = f.image('vector.svg', '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><rect width="1" height="1"/></svg>');
  const directory = path.join(f.dir, 'directory.png'); fs.mkdirSync(directory);
  const rows = [read(html), read(svg, 'svg'), read(directory, 'directory')];
  const artifacts = discoverSessionArtifacts(rows).artifacts;
  assert.equal(artifacts.find(a => a.path === html).status, 'unavailable');
  assert.equal(artifacts.find(a => a.path === directory).status, 'unavailable');
  const opened = openSessionArtifact(rows, artifacts.find(a => a.path === svg).id);
  try {
    const headers = artifactHeaders(opened);
    assert.equal(headers['Content-Type'], 'image/svg+xml');
    assert.equal(headers['X-Content-Type-Options'], 'nosniff');
    assert.match(headers['Content-Security-Policy'], /sandbox; default-src 'none'/);
    assert.doesNotMatch(headers['Content-Security-Policy'], /allow-scripts|allow-same-origin|script-src/);
    assert.equal(headers['Cross-Origin-Resource-Policy'], 'same-origin');
  } finally { fs.closeSync(opened.fd); }
});

test('rejects final-file and parent-directory symlinks including substitution after discovery', t => {
  const f = fixture(t), image = f.image();
  const link = path.join(f.dir, 'linked.png');
  try { fs.symlinkSync(image, link, 'file'); } catch (error) {
    if (['EPERM', 'EACCES'].includes(error.code)) { t.skip('Host disallows creating file symlinks'); return; }
    throw error;
  }
  assert.equal(discoverSessionArtifacts([read(link)]).artifacts[0].status, 'unavailable');
  const nested = path.join(f.dir, 'parent-link'); fs.symlinkSync(f.dir, nested, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(discoverSessionArtifacts([read(path.join(nested, 'graphic.png'))]).artifacts[0].status, 'unavailable');
  const rows = [read(image)], id = discoverSessionArtifacts(rows).artifacts[0].id;
  const replacement = f.image('replacement.png'); fs.unlinkSync(image); fs.symlinkSync(replacement, image, 'file');
  assert.throws(() => openSessionArtifact(rows, id), error => error.status === 403);
});

test('derived cache avoids repeated parsing, invalidates source changes, and restats image availability', async t => {
  const f = fixture(t), image = f.image(), second = f.image('second.png');
  const transcript = path.join(f.dir, 'transcript.jsonl');
  const write = rows => fs.writeFileSync(transcript, rows.map(JSON.stringify).join('\n'));
  write([read(image)]);
  let parses = 0;
  const cache = createSessionArtifactCache({ inspector: createGuardedInspector(), loadEntries(file) { parses++; return fs.readFileSync(file, 'utf8').split('\n').map(JSON.parse); } });
  const initial = (await cache.list(transcript)).artifacts[0];
  const opened = await cache.open(transcript, initial.id); fs.closeSync(opened.fd);
  assert.equal((await cache.list(transcript)).artifacts[0].status, 'available');
  assert.equal(parses, 1, 'list plus image requests reuse derived references');
  fs.unlinkSync(image);
  assert.equal((await cache.list(transcript)).artifacts[0].status, 'missing');
  await assert.rejects(cache.open(transcript, initial.id), error => error.status === 404);
  assert.equal(parses, 1, 'image status is never part of cached source parsing');
  write([read(second)]);
  assert.equal((await cache.list(transcript)).artifacts[0].path, second);
  assert.equal(parses, 2);
  await assert.rejects(cache.open(transcript, initial.id), error => error.status === 404);
  const replacement = path.join(f.dir, 'replacement.jsonl');
  fs.writeFileSync(replacement, JSON.stringify(read(image)));
  fs.renameSync(replacement, transcript);
  assert.equal((await cache.list(transcript)).artifacts[0].path, image, 'atomic source replacement invalidates provenance');
  assert.equal(parses, 3);
});

test('derived cache respects both entry and byte limits', async t => {
  const f = fixture(t), image = f.image();
  const a = path.join(f.dir, 'a.jsonl'), b = path.join(f.dir, 'b.jsonl');
  fs.writeFileSync(a, JSON.stringify(read(image))); fs.writeFileSync(b, JSON.stringify(read(image)));
  let parses = 0;
  const loadEntries = file => { parses++; return [JSON.parse(fs.readFileSync(file, 'utf8'))]; };
  const inspector = createGuardedInspector();
  const small = createSessionArtifactCache({ inspector, maxEntries: 1, loadEntries });
  await small.list(a); await small.list(b); await small.list(a);
  assert.equal(parses, 3);
  parses = 0;
  const bytes = createSessionArtifactCache({ inspector, maxBytes: 1, loadEntries });
  await bytes.list(a); await bytes.list(a);
  assert.equal(parses, 2, 'oversized derived entries are not retained');
});

test('documents preserve successful creation/edit evidence independently of a scoped milestone', t => {
  const f = fixture(t), created = f.image('brief.md', '# Brief'), edited = f.image('notes.txt', 'Updated notes');
  const failed = f.image('failed.md', 'Unchanged'), pending = f.image('pending.pdf', 'Not evidence of a completed edit');
  const missing = path.join(f.dir, 'purged.html'), readOnly = f.image('reference.md', 'Read only');
  const rows = [
    msg('document-requests', 'assistant', [call('write-doc', 'Write', { file_path: created }), call('edit-doc', 'Edit', { file_path: edited }), call('failed-doc', 'Edit', { file_path: failed }), call('pending-doc', 'Write', { file_path: pending }), call('purged-doc', 'Write', { file_path: missing })]),
    msg('document-results', 'user', [result('write-doc', `File created successfully at: ${created}`), result('edit-doc', 'File updated successfully.'), result('failed-doc', 'Permission denied', { is_error: true }), result('purged-doc', `File created successfully at: ${missing}`)]),
    read(readOnly, 'reference-only'),
  ];
  const response = discoverSessionArtifacts(rows, { events: [{ event_id: 'one-visible', type: 'wrapup', session_id: 'artifact-session', summary: 'One scoped milestone' }] });
  assert.deepEqual(response.documents.map(d => d.name).sort(), ['brief.md', 'notes.txt', 'pending.pdf', 'purged.html']);
  assert.equal(response.documents.find(d => d.path === created).source, 'created');
  assert.equal(response.documents.find(d => d.path === edited).source, 'edited');
  assert.equal(response.documents.find(d => d.path === pending).source, 'referenced');
  assert.equal(response.documents.find(d => d.path === missing).status, 'missing');
  const brief = response.documents.find(d => d.path === created);
  assert.equal(brief.status, 'current');
  assert.equal(brief.reviewUrl, null, 'no invented document-serving or Memory ownership URL');
  assert.deepEqual(brief.evidence.map(e => e.messageId), ['document-requests', 'document-results']);
  assert.equal(brief.evidence[1].blockId, 'document-results--block-0');
  assert.equal(response.commits.length, 0);
});

test('direct and literal wrapped patches use recorded cwd and exclude failed or dynamic paths', t => {
  const f = fixture(t), created = f.image('new.md', 'New'), edited = f.image('report.csv', 'A,B');
  const patch = '*** Begin Patch\n*** Add File: new.md\n+New\n*** Update File: report.csv\n@@\n-A\n+A,B\n*** Update File: source.js\n@@\n-a\n+b\n*** End Patch';
  const rows = [
    { type: 'session_meta', payload: { id: 'patch-session', cwd: f.dir } },
    { type: 'response_item', payload: { type: 'custom_tool_call', name: 'functions.exec', call_id: 'wrapped', input: `await tools.apply_patch(${JSON.stringify(patch)});` } },
    { type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'wrapped', output: 'Success. Updated the following files.' } },
    { type: 'response_item', payload: { type: 'custom_tool_call', name: 'apply_patch', call_id: 'failed-patch', input: '*** Begin Patch\n*** Add File: failed.md\n+x\n*** End Patch' } },
    { type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'failed-patch', output: 'apply_patch verification failed: unavailable' } },
    { type: 'response_item', payload: { type: 'custom_tool_call', name: 'functions.exec', call_id: 'dynamic', input: 'await tools.apply_patch(patchVariable);' } },
    { type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'dynamic', output: 'Success.' } },
  ];
  const docs = discoverSessionArtifacts(rows).documents;
  assert.deepEqual(docs.map(d => [d.path, d.source]), [[created, 'created'], [edited, 'edited']]);
  assert.equal(docs[0].evidence[0].callId, 'wrapped');
});

test('commits require canonical same-session events or paired git commit stdout, never mentioned hashes', t => {
  const f = fixture(t), full = `abc1234${'0'.repeat(33)}`;
  const rows = [
    msg('commit-call', 'assistant', [call('commit', 'Bash', { command: 'git add brief.md && git commit -m "Create graphics brief"' }), call('pending', 'Bash', { command: 'git commit -m "Not recorded"' }), call('read-log', 'Bash', { command: 'cat historical-log.txt' })]),
    msg('commit-result', 'user', [result('commit', '[main abc1234] Create graphics brief\n 1 file changed'), result('read-log', '[main fedcba9] A historical commit merely read')]),
    msg('mention', 'assistant', [{ type: 'text', text: 'Could commit deadbee later; [main ddddddd] is only an example.' }]),
  ];
  const events = [
    { event_id: 'canonical', type: 'git_commit', session_id: 'artifact-session', commit_hash: full, summary: '[docs] Commit abc1234: Canonical subject | files: brief.md', timestamp: '2026-10-29T12:00:00Z' },
    { event_id: 'another', type: 'git_commit', session_id: '', sessionId: 'artifact-session', summary: 'Commit 1122334: Earlier full-session change' },
    { event_id: 'other-session', type: 'git_commit', session_id: 'elsewhere', summary: 'Commit 7654321: Another session' },
    { event_id: 'not-commit', type: 'wrapup', session_id: 'artifact-session', summary: 'Commit deadbee: mentioned only' },
  ];
  const commits = discoverSessionArtifacts(rows, { events }).commits;
  assert.equal(commits.length, 2);
  assert.equal(commits[0].hash, full);
  assert.equal(commits[0].subject, 'Canonical subject');
  assert.equal(commits[0].source, 'event');
  assert.deepEqual(commits[0].evidence.map(e => e.source), ['event', 'tool-output']);
  assert.equal(commits[0].evidence[1].messageId, 'commit-result');
  assert.equal(commits[1].hash, '1122334');
  assert.equal(discoverSessionArtifacts(rows).commits[0].subject, 'Create graphics brief');
});

test('new canonical commits refresh without reparsing cached transcripts or narrowing document scope', async t => {
  const f = fixture(t), document = f.image('whole-session.md', '# Whole session');
  const transcript = path.join(f.dir, 'session.jsonl');
  const rows = [msg('write', 'assistant', [call('write', 'Write', { file_path: document })]), msg('result', 'user', [result('write', `File created successfully at: ${document}`)])];
  fs.writeFileSync(transcript, rows.map(JSON.stringify).join('\n'));
  let parses = 0;
  const cache = createSessionArtifactCache({ inspector: createGuardedInspector(), loadEntries() { parses++; return rows; } });
  const scoped = [{ type: 'wrapup', session_id: 'artifact-session' }];
  assert.equal((await cache.list(transcript, { events: scoped })).documents.length, 1);
  const commit = { event_id: 'later', type: 'git_commit', session_id: 'artifact-session', summary: 'Commit bbbbbbb: A new event' };
  const updated = await cache.list(transcript, { events: [...scoped, commit] });
  assert.equal(updated.commits[0].hash, 'bbbbbbb');
  assert.equal(parses, 1);
  fs.unlinkSync(document);
  assert.equal((await cache.list(transcript)).documents[0].status, 'missing');
  assert.equal(parses, 1);
});

test('session review takes the guarded verdict: a blocked folder is reported and never opened here', async t => {
  const f = fixture(t), image = f.image(), document = f.image('notes.md', '# Notes');
  const transcript = path.join(f.dir, 'transcript.jsonl');
  const rows = [read(image), msg('write', 'assistant', [call('write', 'Write', { file_path: document })]), msg('result', 'user', [result('write', `File created successfully at: ${document}`)])];
  fs.writeFileSync(transcript, rows.map(JSON.stringify).join('\n'));
  // Both files exist and would open fine on this thread; only the inspector says no.
  const blocked = { status: 'blocked', root: f.dir, code: 503, reason: 'macOS has not let the Explorer read the fixture folder.' };
  const asked = [];
  const inspector = {
    async inspect(files) { asked.push(['inspect', ...files]); return new Map(files.map(file => [file, blocked])); },
    async ensure(file, { kind = 'image' } = {}) { asked.push(['ensure', kind, file]); return blocked; },
  };
  const cache = createSessionArtifactCache({ inspector, loadEntries: () => rows });
  const listed = await cache.list(transcript);
  assert.deepEqual(listed.artifacts.map(a => [a.status, a.reason, a.previewUrl]), [['unavailable', blocked.reason, null]]);
  await assert.rejects(cache.open(transcript, listed.artifacts[0].id), error => error.status === 503 && error.message === blocked.reason);
  await assert.rejects(cache.openDocument(transcript, listed.documents[0].id), error => error.status === 503);
  assert.deepEqual(asked, [['inspect', image], ['ensure', 'image', image], ['ensure', 'document', document]]);
  assert.throws(() => createSessionArtifactCache({ loadEntries: () => rows }), /needs an inspector/);
});

test('canonical commit artifacts survive an unavailable transcript only for an exactly known session', () => {
  const events = [
    { event_id: 'known-commit', type: 'git_commit', session_id: 'known-session', provider: 'codex', cwd: '/workspace', session_title: 'Recorded session title', summary: 'Commit 123abcd: Preserve the outcome' },
    { event_id: 'another-commit', type: 'git_commit', session_id: 'other-session', summary: 'Commit abc1234: Not this session' },
  ];
  const fallback = canonicalSessionArtifacts(events, 'known-session');
  assert.equal(fallback.path, null);
  assert.deepEqual(fallback.identity, { sessionId: 'known-session', provider: 'codex', cwd: '/workspace', title: 'Recorded session title' });
  assert.deepEqual(fallback.artifacts, []);
  assert.deepEqual(fallback.documents, []);
  assert.deepEqual(fallback.commits.map(commit => commit.hash), ['123abcd']);
  assert.equal(fallback.commits[0].evidence[0].eventId, 'known-commit');
  assert.equal(canonicalSessionArtifacts(events, 'not-recorded'), null);
});

test('document downloads return exact bytes as attachments and reject unrecorded or pending document IDs', t => {
  const f = fixture(t), content = '<html><script>this must never run inline</script></html>\n';
  const file = f.image('created.html', content), pending = f.image('pending.txt', 'Not completed');
  const rows = [msg('call', 'assistant', [call('write', 'Write', { file_path: file }), call('pending', 'Write', { file_path: pending })]), msg('result', 'user', [result('write', `File created successfully at: ${file}`)])];
  const documents = discoverSessionArtifacts(rows, { transcriptPath: '/allowed/session.jsonl' }).documents;
  const current = documents.find(d => d.path === file);
  assert.match(current.downloadUrl, /^\/api\/session\/document\?/);
  assert.equal(documents.find(d => d.path === pending).downloadUrl, null);
  const opened = openSessionDocument(rows, current.id);
  try {
    assert.deepEqual(fs.readFileSync(opened.fd), Buffer.from(content));
    const headers = documentHeaders(opened);
    assert.equal(headers['Content-Type'], 'application/octet-stream');
    assert.match(headers['Content-Disposition'], /^attachment;/);
    assert.equal(headers['X-Content-Type-Options'], 'nosniff');
    assert.equal(headers['Content-Security-Policy'], "sandbox; default-src 'none'");
  } finally { fs.closeSync(opened.fd); }
  assert.throws(() => openSessionDocument(rows, documents.find(d => d.path === pending).id), error => error.status === 404);
  assert.throws(() => openSessionDocument(rows, JSON.stringify({ path: file })), error => error.status === 404);
  assert.throws(() => openSessionDocument(rows, 'document-unrecorded'), error => error.status === 404);
});

test('document downloads revalidate symlinks, regular files, and the 64 MiB bound', t => {
  const f = fixture(t), file = f.image('notes.md', 'original');
  const rows = [msg('call', 'assistant', [call('edit', 'Edit', { file_path: file })]), msg('result', 'user', [result('edit', 'Updated successfully')])];
  const id = discoverSessionArtifacts(rows).documents[0].id;
  const descriptor = fs.openSync(file, 'r+'); fs.ftruncateSync(descriptor, 64 * 1024 * 1024 + 1); fs.closeSync(descriptor);
  assert.equal(discoverSessionArtifacts(rows).documents[0].downloadUrl, null);
  assert.throws(() => openSessionDocument(rows, id), error => error.status === 413);
  fs.unlinkSync(file); fs.mkdirSync(file);
  assert.throws(() => openSessionDocument(rows, id), error => error.status === 403);
  fs.rmdirSync(file);
  const target = f.image('target.md', 'must not follow a substituted symlink');
  try { fs.symlinkSync(target, file, 'file'); } catch (error) {
    if (['EPERM', 'EACCES'].includes(error.code)) { t.skip('Host disallows creating file symlinks'); return; }
    throw error;
  }
  assert.throws(() => openSessionDocument(rows, id), error => error.status === 403);
});

test('HTTP artifacts retain canonical commits without a transcript and never bypass path authorization', async t => {
  const f = fixture(t);
  const transcripts = path.join(f.dir, 'transcripts'); fs.mkdirSync(transcripts);
  const id = '11111111-1111-4111-8111-111111111111';
  fs.writeFileSync(path.join(f.dir, 'changelog.jsonl'), JSON.stringify({ event_id: 'http-commit', timestamp: '2020-01-01T00:00:00Z', type: 'git_commit', session_id: id, provider: 'claude', summary: 'Commit abcdef1: Preserved despite missing transcript' }) + '\n');
  const saved = { ...process.env };
  for (const name of ['CLAUDE_SESSION_ID', 'CLAUDE_CODE_SESSION_ID', 'CODEX_SESSION_ID', 'CARTOGRAPHER_SESSION_ID']) delete process.env[name];
  Object.assign(process.env, OFFLINE_INDEX_ENV, { CARTOGRAPHER_DEV_DIR: f.dir, CARTOGRAPHER_SEMANTIC: '0', CARTOGRAPHER_CLAUDE_TRANSCRIPTS_DIR: transcripts, CARTOGRAPHER_CODEX_TRANSCRIPTS_DIR: transcripts, CARTOGRAPHER_CODEX_ARCHIVED_DIR: transcripts });
  const { createExplorerApp } = await import('../../explorer/server/app.js');
  const { app, close } = createExplorerApp();
  const server = app.listen(0, '127.0.0.1');
  t.after(async () => {
    close(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name];
    Object.assign(process.env, saved);
  });
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  const base = `http://127.0.0.1:${server.address().port}/api/session/artifacts?`;
  const response = await fetch(base + new URLSearchParams({ session_id: id, hours: '1' }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.path, null);
  assert.equal(body.identity.sessionId, id);
  assert.equal(body.commits[0].hash, 'abcdef1', 'old canonical commit survives a narrow current time window');
  assert.deepEqual(body.documents, []);
  const stale = await fetch(base + new URLSearchParams({ session_id: id, path: path.join(transcripts, `${id}.jsonl`) }));
  assert.equal(stale.status, 200); await stale.arrayBuffer();
  const forbidden = await fetch(base + new URLSearchParams({ session_id: id, path: path.join(f.dir, 'outside-allowed-roots.jsonl') }));
  assert.equal(forbidden.status, 403); await forbidden.arrayBuffer();
  const absent = await fetch(base + new URLSearchParams({ session_id: '22222222-2222-4222-8222-222222222222' }));
  assert.equal(absent.status, 404); await absent.arrayBuffer();
  const document = f.image('download.html', '<html><script>Never inline</script></html>\n');
  // Use a fresh path: the existing resolver intentionally caches misses for a
  // minute, and the stale-transcript assertion above populated that cache.
  const transcript = path.join(transcripts, 'document-session.jsonl');
  const rows = [msg('http-write', 'assistant', [call('http-write', 'Write', { file_path: document })]), msg('http-result', 'user', [result('http-write', `File created successfully at: ${document}`)])];
  fs.writeFileSync(transcript, rows.map(JSON.stringify).join('\n'));
  const artifacts = await fetch(base + new URLSearchParams({ path: transcript }));
  const listed = await artifacts.json();
  assert.equal(artifacts.status, 200, JSON.stringify(listed));
  const downloadUrl = new URL(listed.documents[0].downloadUrl, base);
  const download = await fetch(downloadUrl);
  assert.equal(download.status, 200);
  assert.equal(download.headers.get('content-type'), 'application/octet-stream');
  assert.match(download.headers.get('content-disposition'), /^attachment;/);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), fs.readFileSync(document));
  downloadUrl.searchParams.set('id', JSON.stringify({ path: document }));
  const fake = await fetch(downloadUrl);
  assert.equal(fake.status, 404); await fake.arrayBuffer();
});
