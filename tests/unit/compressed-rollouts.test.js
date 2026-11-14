/**
 * Codex zstd-compresses a rollout in place about a week after its session:
 * rollout-<ts>-<uuid>.jsonl becomes rollout-<ts>-<uuid>.jsonl.zst. Every reader
 * here matched *.jsonl, so a session older than a week had "no transcript"
 * while its transcript sat on disk. Measured 2026-11-13: the resolver missed
 * 139 of the 1,132 Codex sessions with events in the last 30 days for that
 * reason alone, and codexSessionIndex() held 270 of 3,916 rollouts
 * (docs/COMPRESSED_ROLLOUTS.md).
 *
 * The defect is an absence, and nothing errored. So each test asserts on what
 * came back, never that something did: the exact path, rows equal to an
 * uncompressed twin's, a count that survives an independent directory scan.
 * `onlyCompressed()` is the control: it applies the old *.jsonl rule to the
 * fixture and must find nothing, or these tests would pass against the code
 * that had the defect.
 */

// Pin the semantic leg off before anything imports the search module.
process.env.CARTOGRAPHER_SEMANTIC = '0';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { OFFLINE_INDEX_ENV } from './helpers/offline-index.js';

for (const name of ['CARTOGRAPHER_SESSION_ID', 'CLAUDE_SESSION_ID', 'CLAUDE_CODE_SESSION_ID', 'CODEX_SESSION_ID']) {
  delete process.env[name];
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const RESOLVER = path.join(ROOT, 'scripts', 'resolve-transcript.sh');
// Node 22.15 added zlib zstd. Without it the fixture cannot be compressed, and
// only the name-level tests (resolver, index) run, on placeholder bytes.
const canZstd = typeof zlib.zstdCompressSync === 'function';
const needsZstd = { skip: !canZstd && 'this Node has no zlib zstd' };

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'carto-compressed-rollouts-')));
process.on('exit', () => fs.rmSync(root, { recursive: true, force: true }));
const dev = path.join(root, 'dev');
const sessionsDir = path.join(root, 'sessions');
const liveDir = path.join(sessionsDir, '2026', '10', '01');
const archivedDir = path.join(root, 'archived_sessions');
const claudeDir = path.join(root, 'claude');
for (const dir of [dev, liveDir, archivedDir, claudeDir]) fs.mkdirSync(dir, { recursive: true });

// Four sessions, one per case:
//   IN_PLACE  compressed where the hook recorded it
//   ARCHIVED  moved to the archive, then compressed there
//   BOTH      a plain file in the live tree and a compressed one in the archive
//   PLAIN     never compressed: the twin every compressed read is compared to
const IN_PLACE = '01a10000-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
const ARCHIVED = '01a10000-bbbb-7bbb-8bbb-bbbbbbbbbbbb';
const BOTH = '01a10000-cccc-7ccc-8ccc-cccccccccccc';
const PLAIN = '01a10000-dddd-7ddd-8ddd-dddddddddddd';
const rolloutName = (id) => `rollout-2026-10-01T09-00-00-${id}.jsonl`;
const recorded = (id) => path.join(liveDir, rolloutName(id)); // what the hook stamped

// Ten days back from the wall clock: past the week after which Codex
// compresses, and inside the session list's 90-day window.
const AT = Date.now() - 10 * 24 * 60 * 60 * 1000;
const usage = (input, output) => ({ input_tokens: input, output_tokens: output, cached_input_tokens: 0, cache_write_input_tokens: 0, total_tokens: input + output });
function rolloutRows(id) {
  const at = (offset) => new Date(AT + offset).toISOString();
  return [
    { timestamp: at(0), type: 'session_meta', payload: { id, cwd: '/workspace/repo' } },
    { timestamp: at(1000), type: 'response_item', payload: { type: 'message', role: 'user', id: 'ask', content: [{ type: 'input_text', text: 'Find where the palette is loaded' }] } },
    { timestamp: at(2000), type: 'response_item', payload: { type: 'message', role: 'assistant', id: 'answer', content: [{ type: 'output_text', text: 'The palette loads in src/palette.js, from loadPalette().' }] } },
    { timestamp: at(3000), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: usage(1200, 34), last_token_usage: usage(1200, 34) } } },
    // One model step, so the work map has an action to draw.
    { timestamp: at(3500), type: 'turn_context', payload: { cwd: '/workspace/repo', model: 'gpt-5.5' } },
    { timestamp: at(4000), type: 'token_usage_record', payload: { usage: usage(1200, 34) } },
  ];
}
const body = (id) => rolloutRows(id).map((row) => JSON.stringify(row)).join('\n') + '\n';
const compress = (text) => (canZstd ? zlib.zstdCompressSync(Buffer.from(text)) : Buffer.from('not zstd; a name-only fixture'));

const inPlaceFile = `${recorded(IN_PLACE)}.zst`;
const archivedFile = path.join(archivedDir, `${rolloutName(ARCHIVED)}.zst`);
const bothPlain = recorded(BOTH);
const bothCompressed = path.join(archivedDir, `${rolloutName(BOTH)}.zst`);
const plainFile = recorded(PLAIN);
fs.writeFileSync(inPlaceFile, compress(body(IN_PLACE)));
fs.writeFileSync(archivedFile, compress(body(ARCHIVED)));
fs.writeFileSync(bothPlain, body(BOTH));
fs.writeFileSync(bothCompressed, compress(body(BOTH)));
fs.writeFileSync(plainFile, body(PLAIN));

// Two events per session, as the hooks would have written them while the
// rollout was still plain and still in the live tree.
fs.writeFileSync(path.join(dev, 'changelog.jsonl'), [IN_PLACE, ARCHIVED, BOTH, PLAIN].flatMap((id, n) => [
  { event_id: `evt-${n}-a`, timestamp: new Date(AT).toISOString(), type: 'tool_bash', provider: 'codex', session_id: id, project: 'repo', summary: 'rg palette src', transcript_path: recorded(id) },
  { event_id: `evt-${n}-b`, timestamp: new Date(AT + 4000).toISOString(), type: 'session_end', provider: 'codex', session_id: id, project: 'repo', summary: 'Codex turn completed', transcript_path: recorded(id) },
]).map((row) => JSON.stringify(row)).join('\n') + '\n');

Object.assign(process.env, OFFLINE_INDEX_ENV, {
  CARTOGRAPHER_DEV_DIR: dev,
  CARTOGRAPHER_CODEX_TRANSCRIPTS_DIR: sessionsDir,
  CARTOGRAPHER_CODEX_ARCHIVED_DIR: archivedDir,
  CARTOGRAPHER_CLAUDE_TRANSCRIPTS_DIR: claudeDir,
});

// Namespace imports, read at use: a missing export then fails the test that
// needs it instead of the whole file at link time.
const transcripts = await import('../../explorer/server/transcripts.js');

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}
const onDisk = () => [...walk(sessionsDir), ...walk(archivedDir)];
/** The control: true when the old rule (a name ending .jsonl) cannot find this session. */
const onlyCompressed = (id) => !onDisk().some((file) => file.endsWith('.jsonl') && file.includes(id))
  && onDisk().some((file) => file.endsWith('.jsonl.zst') && file.includes(id));

function resolve(needle) {
  try {
    return execFileSync('bash', [RESOLVER, needle], { encoding: 'utf8', env: process.env, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (error) {
    if (error.status === 1) return ''; // the resolver's "not found"
    throw error;
  }
}

test('the fixture holds two sessions that exist only compressed', () => {
  // Without this, every assertion below passes against a *.jsonl-only reader.
  assert.equal(onlyCompressed(IN_PLACE), true);
  assert.equal(onlyCompressed(ARCHIVED), true);
  assert.equal(onlyCompressed(BOTH), false, 'BOTH keeps a plain file');
  assert.equal(fs.existsSync(recorded(IN_PLACE)), false, 'the recorded path is really gone');
  assert.equal(fs.existsSync(recorded(ARCHIVED)), false);
});

test('the resolver finds a rollout compressed where it was recorded', () => {
  assert.equal(resolve(recorded(IN_PLACE)), inPlaceFile);
});

test('the resolver finds a rollout archived and then compressed', () => {
  assert.equal(resolve(recorded(ARCHIVED)), archivedFile);
});

test('the resolver finds a compressed rollout from a bare session id', () => {
  assert.equal(resolve(IN_PLACE), inPlaceFile);
  assert.equal(resolve(ARCHIVED), archivedFile);
});

test('the resolver accepts a needle already spelled .jsonl.zst', () => {
  // A path the resolver returned last week, for a rollout archived since.
  assert.equal(resolve(`${recorded(ARCHIVED)}.zst`), archivedFile);
});

test('the resolver prefers the plain file when both spellings exist', () => {
  assert.equal(resolve(recorded(BOTH)), bothPlain, 'recorded path still valid');
  // The archive is searched first, and holds only the compressed copy.
  assert.equal(resolve(BOTH), bothPlain, 'id hunt: plain beats an earlier compressed match');
});

test('the resolver still reports a miss as a miss', () => {
  assert.equal(resolve('01a10000-eeee-7eee-8eee-eeeeeeeeeeee'), '');
  assert.equal(resolve(path.join(liveDir, rolloutName('01a10000-eeee-7eee-8eee-eeeeeeeeeeee'))), '');
});

test('codexSessionIndex() holds every rollout in either spelling, the plain file winning', () => {
  const index = transcripts.codexSessionIndex({ env: process.env, home: root, force: true });
  assert.equal(index.get(IN_PLACE), inPlaceFile);
  assert.equal(index.get(ARCHIVED), archivedFile);
  assert.equal(index.get(BOTH), bothPlain);
  assert.equal(index.get(PLAIN), plainFile);

  // Composition: one entry per session id on disk, counted by a scan that
  // shares nothing with the index's walk.
  const ids = new Set(onDisk().map((file) => /-(01a10000-[0-9a-f-]+)\.jsonl(?:\.zst)?$/.exec(file)?.[1]).filter(Boolean));
  assert.equal(ids.size, 4);
  assert.equal(index.size, ids.size);
  assert.equal(onDisk().length, 5, 'five files, four sessions: BOTH is counted once');
});

test('resolveTranscriptPath() follows a cached hit that Codex has compressed since', () => {
  const id = '01a10000-ffff-7fff-8fff-ffffffffffff';
  const plain = recorded(id);
  fs.writeFileSync(plain, body(id));
  const cache = new Map();
  try {
    assert.equal(transcripts.resolveTranscriptPath(id, { cache }), plain);
    // Codex compresses in place: the cached answer now names no file.
    fs.renameSync(plain, `${plain}.zst`);
    assert.equal(transcripts.resolveTranscriptPath(id, { cache }), `${plain}.zst`);
  } finally {
    fs.rmSync(plain, { force: true });
    fs.rmSync(`${plain}.zst`, { force: true });
  }
});

test('a compressed rollout reads back row for row', needsZstd, () => {
  const twin = transcripts.readTranscriptEntries(plainFile);
  assert.equal(twin.length, 6);
  const rows = transcripts.readTranscriptEntries(inPlaceFile);
  assert.deepEqual(rows, rolloutRows(IN_PLACE));

  const messages = (file) => transcripts.normalizeTranscriptEntries(transcripts.readTranscriptEntries(file)).messages.map((message) => message.content);
  assert.equal(messages(plainFile).length, 2);
  assert.deepEqual(messages(inPlaceFile), messages(plainFile));
});

test('a compressed rollout that will not decode is reported, never read as empty', needsZstd, () => {
  const id = '01a10000-9999-7999-8999-999999999999';
  const broken = `${recorded(id)}.zst`;
  fs.writeFileSync(broken, zlib.zstdCompressSync(Buffer.from(body(id))).subarray(0, 40));
  try {
    assert.throws(() => transcripts.readTranscriptEntries(broken), (error) => error.code === 'TRANSCRIPT_COMPRESSED');
  } finally {
    fs.rmSync(broken, { force: true });
  }
});

test('the Explorer serves a compressed rollout from its recorded path and from its session id', needsZstd, async (t) => {
  const { createExplorerApp } = await import('../../explorer/server/app.js');
  const { app, close } = createExplorerApp();
  const server = app.listen(0, '127.0.0.1');
  t.after(async () => {
    close();
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  });
  await new Promise((done, fail) => { server.once('listening', done); server.once('error', fail); });
  const api = (route, query) => fetch(`http://127.0.0.1:${server.address().port}${route}?${new URLSearchParams(query)}`);
  const transcript = async (query) => {
    const response = await api('/api/transcript', query);
    return { status: response.status, body: await response.json() };
  };

  const twin = await transcript({ path: plainFile });
  assert.equal(twin.status, 200);
  assert.equal(twin.body.messages.length, 2);
  const content = (result) => result.body.messages.map((message) => message.content);

  for (const [id, file] of [[IN_PLACE, inPlaceFile], [ARCHIVED, archivedFile]]) {
    const byPath = await transcript({ path: recorded(id) });
    assert.equal(byPath.status, 200, JSON.stringify(byPath.body));
    assert.equal(byPath.body.path, file);
    assert.equal(byPath.body.path_status, 'resolved');
    assert.equal(byPath.body.provider, 'codex');
    assert.equal(byPath.body.identity.sessionId, id);
    assert.deepEqual(content(byPath), content(twin));

    const byId = await transcript({ session_id: id });
    assert.equal(byId.status, 200, JSON.stringify(byId.body));
    assert.equal(byId.body.path, file);
    assert.deepEqual(content(byId), content(twin));
  }

  // The session list derives the same paths through the bulk index.
  const sessions = (await (await api('/api/sessions', { days: '90' })).json()).sessions || [];
  const listed = Object.fromEntries(sessions.map((session) => [session.session_id, session]));
  for (const [id, file] of [[IN_PLACE, inPlaceFile], [ARCHIVED, archivedFile], [BOTH, bothPlain], [PLAIN, plainFile]]) {
    assert.equal(listed[id]?.transcript_path, file, `session list path for ${id}`);
  }
  assert.equal(listed[IN_PLACE].transcript_path_status, 'resolved');
  assert.equal(listed[PLAIN].transcript_path_status, 'recorded');

  // A reader that cannot decompress says "compressed", not "empty" or "not found".
  const analysis = await api('/api/transcript/analysis', { path: recorded(IN_PLACE) });
  assert.equal(analysis.status, 503);
  assert.equal((await analysis.json()).code, 'TRANSCRIPT_COMPRESSED');

  // On disk but not decodable: the route says so, never "not found or empty".
  const brokenId = '01a10000-8888-7888-8888-888888888888';
  const broken = `${recorded(brokenId)}.zst`;
  fs.writeFileSync(broken, zlib.zstdCompressSync(Buffer.from(body(brokenId))).subarray(0, 40));
  t.after(() => fs.rmSync(broken, { force: true }));
  const unreadable = await transcript({ session_id: brokenId });
  assert.equal(unreadable.status, 503);
  assert.equal(unreadable.body.code, 'TRANSCRIPT_COMPRESSED');

  // The work map reads the same file through the same locator.
  const map = await api('/api/workmap', { session_id: IN_PLACE });
  const mapBody = await map.json();
  const twinMap = await (await api('/api/workmap', { session_id: PLAIN })).json();
  assert.equal(map.status, 200, JSON.stringify(mapBody));
  assert.equal(mapBody.path, inPlaceFile);
  assert.equal(twinMap.actions.length, 1, 'the fixture gives the map one action');
  assert.deepEqual(mapBody.actions.map((action) => [action.station, action.label]), twinMap.actions.map((action) => [action.station, action.label]));
});

test('the Memory Desk reads tokens and title from a compressed rollout', needsZstd, async (t) => {
  const { createTranscriptEnricher } = await import('../../explorer/server/memory-transcript.js');
  const enricher = createTranscriptEnricher({ roots: [sessionsDir, archivedDir] });
  t.after(() => enricher.close());
  const window = { start: AT - 1000, end: AT + 60_000 };

  const twin = await enricher.read({ id: PLAIN, transcript: plainFile }, window);
  assert.equal(twin.valid, true);
  assert.equal(twin.tokens.output, 34);
  assert.equal(twin.title, 'Find where the palette is loaded');

  // By the path the hooks recorded (compressed in place since)…
  const inPlace = await enricher.read({ id: IN_PLACE, transcript: recorded(IN_PLACE), transcriptPaths: [recorded(IN_PLACE)] }, window);
  assert.equal(inPlace.valid, true, inPlace.reason);
  assert.equal(inPlace.path, inPlaceFile);
  // …and with no usable path at all, through the filename index.
  const archived = await enricher.read({ id: ARCHIVED }, window);
  assert.equal(archived.valid, true, archived.reason);
  assert.equal(archived.path, archivedFile);

  for (const result of [inPlace, archived]) {
    assert.equal(result.provider, 'codex');
    assert.equal(result.title, twin.title);
    assert.deepEqual({ ...result.tokens }, { ...twin.tokens });
    assert.equal(result.tokens.status, 'available');
  }

  // A session with both spellings reads the plain one.
  assert.equal((await enricher.read({ id: BOTH }, window)).path, bothPlain);

  // A second read is answered from the parsed state: nothing is inflated again.
  const before = enricher.cacheStats();
  const again = await enricher.read({ id: ARCHIVED }, window);
  const after = enricher.cacheStats();
  assert.deepEqual({ ...again.tokens }, { ...archived.tokens });
  assert.equal(after.transcriptBytesRead, before.transcriptBytesRead);
  assert.equal(after.hits, before.hits + 1);
});
