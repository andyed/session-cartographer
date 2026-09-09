import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'carto-memory-transcript-')));
process.env.CARTOGRAPHER_DEV_DIR = root;
process.on('exit', () => fs.rmSync(root, { recursive: true, force: true }));
const { createTranscriptEnricher, literalToolInputs } = await import('../../explorer/server/memory-transcript.js');
const { projectMemory, enrichMemory } = await import('../../explorer/server/memory.js');
const now = Date.parse('2026-09-09T12:00:00Z');
const start = now - 86400000;
let counter = 0;
function fixture(t, id = `session-${counter++}`) {
  const dir = path.join(root, id);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.jsonl`);
  const enricher = createTranscriptEnricher({ roots: [dir] });
  t.after(() => enricher.close());
  return { id, dir, file, enricher, write(rows) { fs.writeFileSync(file, rows.map((row) => JSON.stringify(row)).join('\n') + '\n'); }, read() { return enricher.read({ id, transcript: file }, { start, end: now }); } };
}
function claude(id, msg, t, usage, extra = {}) {
  return { type: 'assistant', sessionId: id, timestamp: new Date(t).toISOString(), uuid: `${msg}-${t}`, message: { id: msg, role: 'assistant', model: 'claude', usage, content: [] }, ...extra };
}
function codexToken(t, total, last = total) {
  return { timestamp: new Date(t).toISOString(), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: total, last_token_usage: last } } };
}
function codexUsage(input, output, cached = 0) { return { input_tokens: input, output_tokens: output, cached_input_tokens: cached, cache_write_input_tokens: 0, total_tokens: input + output }; }

test('Claude usage deduplicates message ids and normalizes cached input exactly once', async (t) => {
  const f = fixture(t);
  const tokens = { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 300, cache_creation_input_tokens: 50 };
  f.write([
    { type: 'user', sessionId: f.id, timestamp: new Date(start - 1000).toISOString(), message: { content: 'Fix the spectrum renderer' } },
    claude(f.id, 'message-old', start - 500, tokens),
    claude(f.id, 'message-one', now - 3000, tokens),
    claude(f.id, 'message-one', now - 2000, tokens),
    claude(f.id, 'message-one', now - 1000, { ...tokens, output_tokens: 30 }),
    { type: 'custom-title', sessionId: f.id, customTitle: 'Spectrum phase trails' },
  ]);
  const result = await f.read();
  assert.equal(result.title, 'Spectrum phase trails');
  assert.equal(result.tokens.status, 'available');
  assert.equal(result.tokens.samples, 1);
  assert.equal(result.tokens.output, 30);
  assert.equal(result.tokens.input, 450);
  assert.equal(result.tokens.total, 480);
  assert.equal(result.tokens.cacheRead, 300);
  assert.equal(result.tokens.cacheWrite, 50);
  assert.equal(result.tokens.capturedUntil, now - 1000);
  assert.equal(result.tokenSeries.length, 1);
});

test('Codex uses cumulative deltas with a pre-window baseline and ignores duplicate usage records', async (t) => {
  const f = fixture(t);
  f.write([
    { type: 'session_meta', payload: { id: f.id, cwd: f.dir } },
    codexToken(start - 1000, codexUsage(1000, 100, 800)),
    codexToken(now - 3000, codexUsage(1300, 150, 1000), codexUsage(300, 50, 200)),
    { type: 'token_usage_record', timestamp: new Date(now - 2500).toISOString(), payload: { usage: codexUsage(300, 50, 200) } },
    codexToken(now - 2000, codexUsage(1300, 150, 1000), codexUsage(300, 50, 200)),
    codexToken(now - 1000, codexUsage(1600, 175, 1200), codexUsage(300, 25, 200)),
  ]);
  const result = await f.read();
  assert.equal(result.tokens.status, 'available');
  assert.equal(result.tokens.input, 600);
  assert.equal(result.tokens.output, 75);
  assert.equal(result.tokens.cacheRead, 400);
  assert.equal(result.tokens.total, 675);
  assert.deepEqual(result.tokenSeries.map((sample) => sample.output), [50, 25]);
});

test('unknown initial cumulative baseline is partial, while missing usage remains null', async (t) => {
  const f = fixture(t);
  f.write([
    { type: 'session_meta', payload: { id: f.id } },
    codexToken(now - 1000, codexUsage(10000, 1000), codexUsage(100, 10)),
  ]);
  const result = await f.read();
  assert.equal(result.tokens.status, 'partial');
  assert.equal(result.tokens.output, 10, 'unknown earlier cumulative work is never assigned to this window');
  assert.match(result.tokens.reason, /baseline/);
  const noUsage = fixture(t);
  noUsage.write([{ type: 'session_meta', payload: { id: noUsage.id } }]);
  const missing = await noUsage.read();
  assert.equal(missing.tokens.status, 'missing');
  assert.equal(missing.tokens.output, null);
  assert.equal(missing.tokens.total, null);
});

test('incremental transcript parsing reads appended usage and handles rewrites', async (t) => {
  const f = fixture(t);
  const meta = { type: 'session_meta', payload: { id: f.id } };
  f.write([meta, codexToken(now - 3000, codexUsage(100, 10))]);
  assert.equal((await f.read()).tokens.output, 10);
  fs.appendFileSync(f.file, JSON.stringify(codexToken(now - 2000, codexUsage(200, 30), codexUsage(100, 20))) + '\n');
  assert.equal((await f.read()).tokens.output, 30);
  assert.equal((await f.read()).tokens.output, 30, 'unchanged files do not re-add prior samples');
  f.write([meta, codexToken(now - 1000, codexUsage(500, 50))]);
  assert.equal((await f.read()).tokens.output, 50);
});

test('transcript path and identity checks reject escapes and another session', async (t) => {
  const f = fixture(t);
  f.write([{ type: 'session_meta', payload: { id: 'other-session' } }, codexToken(now - 1000, codexUsage(100, 10))]);
  assert.equal((await f.read()).valid, false);
  const outside = path.join(root, `${f.id}-outside.jsonl`);
  fs.writeFileSync(outside, JSON.stringify({ type: 'session_meta', payload: { id: f.id } }) + '\n');
  fs.unlinkSync(f.file);
  fs.symlinkSync(outside, f.file);
  assert.equal((await f.read()).valid, false);
});

test('literal wrapper extraction ignores comments, strings, variables and interpolation', () => {
  const source = [
    '// tools.exec_command({cmd:"fake",workdir:"/fake"})',
    'const fake = "tools.apply_patch(\\"fake\\")";',
    'await tools.exec_command({cmd:"write through shell",workdir:"/workspace/repo"});',
    'await tools.exec_command({cmd: variable, workdir:"/wrong"});',
    'await tools.exec_command({cmd:`echo ${secret}`,workdir:"/wrong"});',
    'await tools.apply_patch("*** Begin Patch\\n*** Update File: /workspace/repo/app.js\\n*** End Patch");',
  ].join('\n');
  assert.deepEqual(literalToolInputs(source), [
    { name: 'exec_command', input: { cmd: 'write through shell', workdir: '/workspace/repo' } },
    { name: 'apply_patch', input: '*** Begin Patch\n*** Update File: /workspace/repo/app.js\n*** End Patch' },
  ]);
});

test('session enrichment recovers recorded workdirs and explicit patches without guessing siblings', async (t) => {
  const f = fixture(t);
  const repo = path.join(f.dir, 'repo');
  fs.mkdirSync(repo);
  fs.writeFileSync(path.join(repo, 'app.js'), 'current');
  fs.writeFileSync(path.join(repo, 'style.css'), 'current');
  const at = now - 5000;
  const call = { type: 'response_item', timestamp: new Date(at).toISOString(), payload: { type: 'custom_tool_call', name: 'exec', call_id: 'call-real-work', input: `await tools.exec_command({cmd:"a command that the parser does not interpret",workdir:${JSON.stringify(repo)}}); await tools.apply_patch(${JSON.stringify(`*** Begin Patch\n*** Update File: ${path.join(repo, 'style.css')}\n*** End Patch`)});` } };
  f.write([
    { type: 'session_meta', payload: { id: f.id, cwd: f.dir } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Build a live working memory view' }] } },
    call,
    { type: 'response_item', timestamp: new Date(at + 3000).toISOString(), payload: { type: 'custom_tool_call_output', call_id: 'call-real-work', output: 'success' } },
  ]);
  const events = [
    { event_id: 'edit-real', timestamp: at + 1000, session_id: f.id, type: 'tool_file_edit', project: 'dev', cwd: f.dir, summary: 'Modified: app.js, errors.push (via bash)', transcript_path: f.file },
    { event_id: 'edit-outside-interval', timestamp: at - 5000, session_id: f.id, type: 'tool_file_edit', project: 'dev', cwd: f.dir, summary: 'Modified: app.js', transcript_path: f.file },
  ];
  const data = await enrichMemory(projectMemory(events, { now, corpusRoot: f.dir }), f.enricher, f.dir);
  assert.equal(data.sessions[0].title, 'Build a live working memory view');
  assert.equal(data.files[f.id].length, 2);
  const app = data.files[f.id].find((file) => file.name === 'app.js');
  assert.deepEqual(app.edits.map((edit) => edit.id), ['edit-real']);
  assert.deepEqual(app.edits[0].workdirCallIds, ['call-real-work:0']);
  const style = data.files[f.id].find((file) => file.name === 'style.css');
  assert.equal(style.edits[0].source, 'transcript');
  assert.equal(style.edits[0].callId, 'call-real-work:1');
  assert.deepEqual(data.sessions[0].fileEvidenceStats, { recordedEdits: 2, resolvedFiles: 2, unresolvedEdits: 1 });
  assert.equal('_editEvidence' in data.sessions[0], false);
});

test('session metrics use observed spans and bounded activity gaps, with notes even when no files resolve', () => {
  const times = [now - 3600000, now - 3540000, now - 1000];
  const data = projectMemory(times.map((timestamp, i) => ({ event_id: `event-${i}`, timestamp, session_id: 'metrics', type: i === 1 ? 'web_fetch' : 'tool_bash', description: `Activity ${i}` })), { now, corpusRoot: root });
  const session = data.sessions[0];
  assert.equal(session.metrics.spanMs, 3599000);
  assert.equal(session.metrics.activeMs, 60000, 'the long gap is not counted as active work');
  assert.equal(session.metrics.counts.research, 1);
  assert.equal(session.notes.length, 3);
  assert.equal(data.files.metrics.length, 0);
});
