import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { claudeActions, codexActions, providerOfTranscript, sessionWorkmap, WORKMAP_OPTIONS } from '../../explorer/server/workmap.js';
import { boardAt } from '../../explorer/shared/workmap/board.js';
import { drawMap, mapGeometry } from '../../explorer/shared/workmap/draw.js';
import { DARK, LIGHT } from '../../explorer/shared/workmap/palette.js';
import { STATIONS, setupFrom } from '../../explorer/shared/workmap/setup.js';
import { normalizeEvidenceEntries } from '../../explorer/server/transcript-evidence.js';
import { eventTranscriptHref } from '../../explorer/src/components/event-navigation.js';
import { clip, compact, runsScript, scrub } from '../../explorer/server/workmap-detail.js';
import { normalizeMemoryRoute } from '../../explorer/src/components/memory-route.js';
import { actionLocation, mapHref, readMapRoute, readerHref, recallIndex, reviewableFiles, rowDetail, rowTarget, rowsFor, serpSummary, stampFor, stationBoxes } from '../../explorer/src/components/session-map.js';
import { messageBlocks, resolveTranscriptLocation, safeTranscriptReturn } from '../../explorer/src/components/transcript-navigation.js';

const setup = setupFrom(WORKMAP_OPTIONS);
const T0 = Date.parse('2026-11-13T18:00:00.000Z');
const at = s => new Date(T0 + s * 1000).toISOString();
const jsonl = rows => rows.map(r => JSON.stringify(r)).join('\n') + '\n';
// Claude Code stamps every line with a uuid of its own; the reader keys a message on it.
const stamped = (prefix, rows) => rows.map((r, i) => ({ uuid: `${prefix}-${i}`, ...r }));
const entriesOf = file => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));

function tmp(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'carto-workmap-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function claudeFixture(t) {
  const dir = tmp(t);
  const file = path.join(dir, 'sess-1.jsonl');
  const assistant = (s, id, content) => ({ type: 'assistant', timestamp: at(s), message: { id, model: 'claude-fable-5-2', content } });
  const result = (s, id, isError = false) => ({ type: 'user', timestamp: at(s), message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: isError }] } });
  fs.writeFileSync(file, jsonl(stamped('main', [
    { type: 'user', timestamp: at(0), message: { content: 'please look at the build' } },
    { type: 'user', timestamp: at(0), isMeta: true, message: { content: 'injected reminder, not the person' } },
    assistant(1, 'msg_1', [{ type: 'text', text: 'On it.' }]),
    // The same model request, written as a second line: one model step, not two.
    assistant(1, 'msg_1', [{ type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: 'npm test -- --secret-flag', description: 'Run the unit suite' } }]),
    result(9, 'tu_1', true),
    assistant(10, 'msg_2', [
      { type: 'tool_use', id: 'tu_2', name: 'Read', input: { file_path: '/Users/x/.claude/projects/-p/memory/notes.md' } },
      { type: 'tool_use', id: 'tu_3', name: 'Skill', input: { skill: 'remember' } },
      { type: 'tool_use', id: 'tu_4', name: 'Agent', input: { description: 'Read the docs' } },
    ]),
    result(11, 'tu_2'),
    result(11, 'tu_3'),
    { type: 'attachment', timestamp: at(12), attachment: { type: 'hook_non_blocking_error', hookName: 'PostToolUse:Bash' } },
    // tu_4 never answers: the transcript stops first.
  ])));
  fs.mkdirSync(path.join(dir, 'sess-1', 'subagents'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'sess-1', 'subagents', 'agent-abc123.jsonl'), jsonl(stamped('sub', [
    { type: 'user', timestamp: at(10.5), message: { content: 'Read the docs and report' } },
    { type: 'assistant', timestamp: at(11), message: { id: 'msg_s1', model: 'claude-haiku-5-5', content: [{ type: 'tool_use', id: 'tu_s1', name: 'WebFetch', input: { url: 'https://user:pw@docs.example.com/guide?token=abc' } }] } },
    { type: 'user', timestamp: at(13), message: { content: [{ type: 'tool_result', tool_use_id: 'tu_s1' }] } },
  ])));
  return file;
}

function codexFixture(t) {
  const file = path.join(tmp(t), 'rollout-2026-11-13T18-00-00-thread.jsonl');
  const item = (s, body) => ({ timestamp: at(s), type: 'event_msg', payload: { type: 'item_completed', item: body } });
  fs.writeFileSync(file, jsonl([
    { timestamp: at(0), type: 'session_meta', payload: { id: 'thread', cwd: '/repo', source: 'vscode' } },
    { timestamp: at(0), type: 'turn_context', payload: { model: 'gpt-6-astra' } },
    item(0, { type: 'UserMessage', id: 'u1', content: [{ type: 'text', text: 'ship it' }] }),
    // The rows the reader shows: the model's own. e1 and e2 complete inside call c1; e3 and e4 after it answered.
    { timestamp: at(1), type: 'response_item', payload: { type: 'message', id: 'msg_a', role: 'assistant', content: [{ type: 'output_text', text: 'Shipping.' }] } },
    { timestamp: at(1), type: 'response_item', payload: { type: 'custom_tool_call', id: 'ctc_1', call_id: 'c1', name: 'exec', input: 'run()' } },
    { timestamp: at(1), type: 'token_usage_record', payload: { thread_id: 'thread' } },
    item(5, { type: 'CommandExecution', id: 'e1', command: ['/bin/zsh', '-lc', 'curl -s https://user:pw@example.com/private?key=1'], status: 'failed', exit_code: 7, duration: { secs: 2, nanos: 500_000_000 } }),
    item(6, { type: 'McpToolCall', id: 'e2', server: 'cartographer', tool: 'recall', arguments: '{"query":"release steps","project":"carto"}', status: 'completed', duration: { secs: 0, nanos: 400_000_000 },
      result: { content: [{ type: 'text', text: 'recall "release steps" — 3 results · call_id call-20261113T180006-mcp1-1 · turbo 286 ms' }] } }),
    { timestamp: at(6.5), type: 'response_item', payload: { type: 'custom_tool_call_output', id: 'out_1', call_id: 'c1', output: 'done' } },
    item(7, { type: 'FileChange', id: 'e3', changes: { '/repo/src/a.js': { type: 'update' }, '/repo/src/b.js': { type: 'add' } }, status: 'completed' }),
    item(8, { type: 'Extension', id: 'e4', kind: 'web.search', query: 'q', action: { type: 'openPage', url: 'https://docs.example.org/x?y=1' } }),
    item(9, { type: 'SomethingNew', id: 'e5' }),
    item(9, { type: 'Reasoning', id: 'r1' }),
  ]));
  return file;
}

test('a Claude transcript becomes actions with a start, an end and the agent that made the call', t => {
  const { actions, model, notes } = claudeActions(claudeFixture(t), setup);
  const by = station => actions.filter(a => a.station === station);

  assert.equal(model, 'claude-fable-5-2');
  // One message from the person; the injected reminder is not one.
  assert.equal(by('you').length, 1);
  // msg_1 and msg_2 in the main loop, msg_s1 in the subagent: three model requests, not four lines.
  assert.equal(by('model').length, 3);

  const [shell] = by('shell');
  assert.equal(shell.label, 'Run the unit suite');
  assert.equal(shell.status, 'err');
  assert.equal(shell.endedAt - shell.startedAt, 8000);

  assert.equal(by('memory').length, 1, 'a read under a Claude memory folder is a memory call');
  assert.equal(by('skills')[0].label, 'remember');
  assert.equal(by('hooks')[0].status, 'err');

  const [fetch] = by('web');
  assert.equal(fetch.from, 'agents');
  assert.equal(fetch.agentId, 'abc123');
  assert.equal(fetch.label, 'docs.example.com');

  // The Agent call never answered, so it keeps no end and reads as running.
  assert.equal(by('agents')[0].endedAt, undefined);
  assert.deepEqual(notes, { subagent_transcripts: 1, unanswered: 1 });
  // The subagent's "user" line is its parent's prompt, not a second message from the person.
  assert.equal(actions.filter(a => a.station === 'you' && a.agentId !== undefined).length, 0);
});

test('a Codex rollout becomes the same actions, with the start taken back from the duration', t => {
  const { actions, model, notes } = codexActions(codexFixture(t), setup);
  const by = station => actions.filter(a => a.station === station);

  assert.equal(model, 'gpt-6-astra');
  assert.equal(by('you').length, 1);
  assert.equal(by('model').length, 1);

  const [curl] = by('web').filter(a => a.tool === 'exec_command');
  assert.equal(curl.status, 'err');
  assert.equal(curl.endedAt - curl.startedAt, 2500);

  const [recall] = by('memory');
  // The query is what tells one recall from the next; the tool's name is the same on every row.
  assert.equal(recall.label, '“release steps”');
  assert.equal(recall.detail, 'search · project carto · 3 results');
  assert.equal(recall.call, 'call-20261113T180006-mcp1-1');
  assert.equal(curl.detail, 'curl -s https://example.com/private · exit 7');
  assert.deepEqual([by('files')[0].op, by('files')[0].file, by('files')[0].detail], ['edit', '/repo/src/a.js', 'edit, created · 2 files']);
  assert.equal(by('you')[0].label, 'ship it');
  assert.equal(recall.endedAt - recall.startedAt, 400);

  assert.equal(by('files')[0].label, 'src/a.js +1');
  assert.equal(by('web').find(a => a.tool === 'web.search').label, 'docs.example.org');
  // An item type this reader does not know is counted, never guessed onto a station.
  assert.deepEqual(notes.unknown_items, { SomethingNew: 1 });
});

test('a row never shows a credential, in its label or in its detail', t => {
  const rows = [...claudeActions(claudeFixture(t), setup).actions, ...codexActions(codexFixture(t), setup).actions];
  const shown = rows.map(a => `${a.label}\n${a.detail ?? ''}`).join('\n');
  // Control: the command lines are shown, so the masking below is what removes the rest.
  assert.ok(shown.includes('npm test -- --secret-flag') && shown.includes('curl -s https://example.com/private'));
  for (const leak of ['pw@', 'user:pw', 'token=', 'key=1']) assert.ok(!shown.includes(leak), `a row shows "${leak}"`);

  assert.equal(scrub('curl -H "Authorization: Bearer abc.DEF-123" https://u:p@h.test/x?sig=9'), 'curl -H "Authorization: Bearer …" https://h.test/x');
  assert.equal(scrub('API_TOKEN=hunter2 deploy --password "two words" --name ok'), 'API_TOKEN=… deploy --password … --name ok');
  // A clip is one line and never splits a character.
  assert.equal(clip('a\n  b\tc'), 'a b c');
  assert.equal(clip('😀😀😀😀', 3), '😀😀…');
  assert.deepEqual([464, 92634, 1_240_000].map(compact), ['464', '93k', '1.2M']);
});

function enrichedFixture(t) {
  const dir = tmp(t);
  const file = path.join(dir, 'sess-2.jsonl');
  const call = (s, id, name, input) => ({ type: 'assistant', timestamp: at(s), message: { id: `msg_${id}`, model: 'claude-fable-5-2', usage: { input_tokens: 2, cache_read_input_tokens: 44776, cache_creation_input_tokens: 47856, output_tokens: 464 }, content: [{ type: 'tool_use', id, name, input }] } });
  const answer = (s, id, text, toolUseResult) => ({ type: 'user', timestamp: at(s), toolUseResult, message: { content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text }] }] } });
  fs.writeFileSync(file, jsonl(stamped('rich', [
    { type: 'user', timestamp: at(0), message: { content: 'cut the release\nand tell me when it lands' } },
    call(1, 'search', 'Bash', { description: 'Search past release work', command: 'ROOT=/p; CARTOGRAPHER_PURPOSE=focus bash "$ROOT/scripts/cartographer-search.sh" "release steps" --project carto --since 7d 2>&1 | head -40' }),
    answer(2, 'search', 'release steps — 20 results\ncall_id: call-20261113T180002-4242\n1. evt-a …'),
    call(3, 'get', 'Bash', { description: 'Fetch two records', command: 'bash /p/scripts/cartographer-search.sh --get evt-a,evt-b --call-id call-20261113T180002-4242 | cut -c1-900' }),
    answer(4, 'get', '…'),
    // Names the script, runs grep: lot-map files this under Memory.
    call(5, 'grep', 'Bash', { description: 'Find where a recall is logged', command: 'grep -n served scripts/cartographer-pulse.sh scripts/cartographer-search.sh | head' }),
    answer(6, 'grep', '…'),
    // Mentions the script inside a heredoc it writes to a file.
    call(7, 'heredoc', 'Bash', { description: 'Write the probe', command: 'cat > /tmp/probe.txt <<EOF\ncartographer-search.sh "not a search"\nEOF\nwc -l /tmp/probe.txt' }),
    answer(8, 'heredoc', '1'),
    // A variable and a directory named like the project are not a script that ran.
    call(8.5, 'assign', 'Bash', { description: 'List the plugin', command: 'R=/dev/session-cartographer; ls $R/plugins; bash /dev/session-cartographer/tests/release-smoke.sh' }),
    answer(8.7, 'assign', '…'),
    call(9, 'facts', 'Bash', { description: 'Count the week', command: 'cd /p; time (node scripts/cartographer-facts.js census --project carto --since 7d --top 6 2>&1 | head -45)' }),
    answer(10, 'facts', '…'),
    call(11, 'edit', 'Edit', { file_path: '/repo/src/a.js', old_string: 'b', new_string: 'c\nd' }),
    answer(12, 'edit', 'ok', { filePath: '/repo/src/a.js', structuredPatch: [{ lines: [' a', '-b', '+c', '+d'] }] }),
    call(13, 'read', 'Read', { file_path: '/repo/src/a.js', offset: 99, limit: 32 }),
    answer(14, 'read', '…'),
    call(15, 'agent', 'Agent', { description: 'Read the docs', subagent_type: 'web-fetch', prompt: 'long' }),
    answer(16, 'agent', 'done', { agentId: 'abc123', agentType: 'web-fetch', totalToolUseCount: 1, totalTokens: 65000 }),
    call(17, 'plan', 'mcp__ccd_turn__update_plan', { items: [{ content: 'Tag the release', status: 'in_progress' }, { content: 'Publish', status: 'pending' }] }),
    answer(18, 'plan', 'ok'),
    { type: 'attachment', timestamp: at(19), attachment: { type: 'hook_additional_context', hookName: 'PostToolUse:Edit', content: ['A preview server is running.\nSecond line.'] } },
  ])));
  fs.mkdirSync(path.join(dir, 'sess-2', 'subagents'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'sess-2', 'subagents', 'agent-abc123.jsonl'), jsonl(stamped('sub', [
    { type: 'assistant', timestamp: at(15.5), message: { id: 'msg_s1', content: [{ type: 'tool_use', id: 'tu_s1', name: 'WebFetch', input: { url: 'https://docs.example.com/guide/install?v=2', prompt: 'How is it installed?' } }] } },
    { type: 'user', timestamp: at(15.9), message: { content: [{ type: 'tool_result', tool_use_id: 'tu_s1' }] } },
  ])));
  return file;
}

test('a row says what its call did, from what the transcript holds', t => {
  const map = sessionWorkmap(enrichedFixture(t));
  const row = id => map.actions.find(a => a.uuid === `rich-${id}` && a.tool !== undefined);
  const said = a => [a.station, a.label, a.detail];

  assert.equal(map.session_id, 'sess-2');
  assert.equal(map.actions.find(a => a.station === 'you' && a.from === 'inbound').label, 'cut the release and tell me when it lands');

  // The search is named by its query, and carries the call id its own output printed.
  assert.deepEqual(said(row(1)), ['memory', '“release steps”', 'search · project carto · since 7d']);
  assert.deepEqual([row(1).recall, row(1).call], ['search', 'call-20261113T180002-4242']);
  assert.deepEqual([row(3).label, row(3).recall, row(3).call], ['get 2 records', 'get', 'call-20261113T180002-4242']);
  assert.deepEqual(said(row(11)), ['memory', 'facts census', 'counted, not ranked · project carto · since 7d']);

  // Naming a carto script is not a recall. Both lines are filed as the plain commands they are.
  for (const id of [5, 7, 9]) assert.notEqual(row(id).station, 'memory', `${row(id).label} is filed under Memory`);
  assert.equal(row(5).label, 'Find where a recall is logged');
  assert.equal(row(5).detail, 'grep -n served scripts/cartographer-pulse.sh scripts/cartographer-search.sh | head');
  assert.deepEqual(map.actions.filter(a => a.station === 'memory').map(a => a.label), ['“release steps”', 'get 2 records', 'facts census']);

  // Shell text inside quotes is text: these three were filed as recalls by a pattern that split on every | and (.
  for (const named of [
    'grep -rln "cartographer-feed\\|cartographer-pulse" hooks skills',
    `jq '.plugins | with_entries(select(.key|test("session-cartographer")))' ~/.claude/plugins/installed.json`,
    'echo "run cartographer-search.sh later"',
  ]) assert.equal(runsScript(named, 'cartographer'), false, named);
  for (const ran of [
    'cd /p && FOO=1 node --no-warnings scripts/cartographer-facts.js census 2>&1 | head',
    'echo start; (bash "$ROOT/scripts/cartographer-search.sh" "a query")',
    'x=$(cartographer-search.sh --get evt-a)',
  ]) assert.equal(runsScript(ran, 'cartographer'), true, ran);

  assert.deepEqual([row(13).op, row(13).file, row(13).detail], ['edit', '/repo/src/a.js', 'edit · +2 −1']);
  assert.deepEqual([row(15).op, row(15).detail, row(15).file], ['read', 'read · lines 99–130', undefined]);
  assert.deepEqual([row(17).label, row(17).detail, row(17).spawned], ['Read the docs', 'web-fetch · 1 tool use · 65k tokens', 'abc123']);
  assert.equal(row(19).detail, '2 steps · Tag the release');

  assert.equal(map.actions.find(a => a.station === 'model').detail, '464 tokens out · 93k context');
  assert.equal(map.actions.find(a => a.station === 'hooks').detail, 'added context · A preview server is running.');
  const fetched = map.actions.find(a => a.agentId === 'abc123' && a.tool === 'WebFetch');
  assert.deepEqual([fetched.label, fetched.detail], ['docs.example.com', 'fetch · /guide/install · “How is it installed?”']);
});

test('a row links to the closest view the Explorer has of its call', t => {
  const file = enrichedFixture(t);
  const map = { ...sessionWorkmap(file), path: file };
  const search = map.actions.find(a => a.recall === 'search');
  const get = map.actions.find(a => a.recall === 'get');
  const edit = map.actions.find(a => a.op === 'edit');
  const now = map.span.last + 5000;

  // What the desk says it holds, in the shapes its two endpoints answer with.
  const calls = recallIndex({ calls: [{ call_id: search.call, session_id: 'sess-2', query: 'release steps', served: 20, used: 1, used_ranks: [9] }, { call_id: null }] });
  const files = reviewableFiles({ files: { 'sess-2': [{ path: '/repo/src/a.js', edits: [] }], other: [{ path: '/repo/src/z.js' }] } }, 'sess-2');
  assert.deepEqual([[...calls.keys()], [...files]], [[search.call], ['/repo/src/a.js']]);

  const route = target => normalizeMemoryRoute(Object.fromEntries(new URL(target.href, 'http://x').searchParams));
  const recall = rowTarget('/', map, search, { calls, files }, '/map', now);
  assert.equal(recall.kind, 'recall');
  assert.deepEqual([route(recall).session, route(recall).call, route(recall).routeError], ['sess-2', search.call, null]);
  assert.equal(rowTarget('/', map, get, { calls, files }, '/map', now).kind, 'recall', 'a fetch opens the search it belongs to');

  const review = rowTarget('/', map, edit, { calls, files }, '/map', now);
  assert.deepEqual([review.kind, route(review).file, route(review).review, route(review).routeError], ['review', '/repo/src/a.js', 'changes', null]);
  assert.ok(new URL(review.href, 'http://x').pathname === '/memory');

  // The desk does not know the call or the edit: the row still opens, in the reader.
  for (const action of [search, edit]) {
    const target = rowTarget('/', map, action, {}, '/map?session=sess-2', now);
    assert.equal(target.kind, 'reader');
    assert.equal(target.href, readerHref('/', actionLocation(map, action), '/map?session=sess-2'));
  }
  // A read is never a diff, whatever the desk holds for the file.
  assert.equal(rowTarget('/', map, map.actions.find(a => a.op === 'read'), { calls, files }, '/map', now).kind, 'reader');
  // A session still running ends "now": the desk refuses a window that ends later.
  const live = rowTarget('/', map, search, { calls, files }, '/map', map.span.last - 2000);
  assert.deepEqual([route(live).routeError, route(live).through], [null, map.span.last - 2000]);

  // A call the desk recorded with no session is still this session's: the transcript made it. It opens in the
  // desk's Recall list, since the desk files it under no thread.
  const orphaned = recallIndex({ calls: [] }, { calls: [{ call_id: search.call, session_id: null, query: 'release steps', served: 5, used: 0, used_ranks: [], stray_marks: 1 }] });
  const listed = rowTarget('/', map, search, { calls: orphaned, files }, '/map', now);
  assert.deepEqual([listed.kind, route(listed).surface, route(listed).session, route(listed).call, route(listed).routeError], ['recall', 'recall', null, search.call, null]);
  assert.equal(route(recall).surface, 'results');
  assert.equal(serpSummary(orphaned.get(search.call)), '5 served · 0 used · 1 stray mark');
  // The session's own record of a call wins over the window's.
  assert.equal(recallIndex({ calls: [{ call_id: 'c', served: 1 }] }, { calls: [{ call_id: 'c', served: 2 }] }).get('c').served, 1);

  assert.equal(serpSummary(calls.get(search.call)), '20 served · 1 used at rank 9');
  assert.equal(rowDetail(search, calls), 'search · project carto · since 7d · 20 served · 1 used at rank 9');
  assert.equal(rowDetail(get, calls), 'full records · from “release steps”');
  assert.equal(rowDetail(search), 'search · project carto · since 7d');
  assert.equal(rowDetail({ recall: 'search', call: search.call, detail: 'search · project carto · 5 results' }, orphaned), 'search · project carto · 5 served · 0 used · 1 stray mark');
  assert.equal(rowDetail({ recall: 'search', call: 'unknown', detail: 'search · 5 results' }, orphaned), 'search · 5 results');
});

test('the provider is read from the file, and one call serves either', t => {
  const claude = claudeFixture(t);
  const codex = codexFixture(t);
  assert.equal(providerOfTranscript(claude), 'claude');
  assert.equal(providerOfTranscript(codex), 'codex');

  const map = sessionWorkmap(codex);
  assert.equal(map.provider, 'codex');
  assert.deepEqual(map.present, ['you', 'model', 'memory', 'files', 'web']);
  assert.equal(map.span.first, map.actions[0].startedAt);
});

test('the list under the map and the count on the map are one number at every moment', t => {
  const { actions } = claudeActions(claudeFixture(t), setup);
  for (const moment of [T0 + 500, T0 + 5000, T0 + 10500, T0 + 11500, T0 + 60000]) {
    const board = boardAt(actions, moment);
    for (const { id } of STATIONS) {
      assert.equal(rowsFor(actions, id, moment).total, board.counts[id] ?? 0, `${id} at +${moment - T0} ms`);
    }
  }
  // Mid-call the shell command is running on both, not yet failed.
  const mid = T0 + 5000;
  assert.equal(boardAt(actions, mid).entries.find(e => e.station === 'shell').status, 'run');
  assert.deepEqual(rowsFor(actions, 'shell', mid).rows.map(r => r.status), ['run']);
  assert.equal(rowsFor(actions, 'shell', mid).failed, 0);
  assert.equal(rowsFor(actions, 'shell', T0 + 9500).failed, 1);
});

test('a station the session never used gets no ink, and the others keep their places', t => {
  const { actions } = codexActions(codexFixture(t), setup);
  const board = boardAt(actions, Infinity);
  const now = actions.at(-1).endedAt + 60_000;
  const names = setup.t.stations;
  const present = new Set(['you', 'model', 'memory', 'files', 'web']);
  const all = drawMap(board, now, { ...setup, theme: 'dark', motion: 'reduced' });
  const some = drawMap(board, now, { ...setup, theme: 'dark', motion: 'reduced', present });

  const label = (svg, id) => svg.match(new RegExp(`<text [^>]*>${names[id]}</text>`))?.[0];
  for (const { id } of STATIONS) {
    if (present.has(id)) assert.equal(label(some, id), label(all, id), `${id} moved`);
    else assert.equal(label(some, id), undefined, `${id} is still drawn`);
  }
  // Control: without `present` every station is drawn, so the absence above is the option's doing.
  assert.ok(STATIONS.every(({ id }) => label(all, id) !== undefined));
  // Ten spokes drawn in the spoke colour without the option, five with it.
  const spokes = svg => (svg.match(new RegExp(`stroke="${DARK.spoke}"`, 'g')) ?? []).length;
  assert.equal(spokes(all), 10);
  assert.equal(spokes(some), 5);

  const boxes = stationBoxes(mapGeometry(setup), present);
  assert.deepEqual(boxes.map(b => b.id), ['you', 'model', 'memory', 'files', 'web']);
  for (const b of boxes) for (const k of ['left', 'top', 'width', 'height']) assert.ok(parseFloat(b[k]) >= 0 && parseFloat(b[k]) <= 100, `${b.id}.${k} = ${b[k]}`);
});

test('every colour that letters are drawn in clears 8:1 on its ground', () => {
  const lum = hex => {
    const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const ratio = (a, b) => {
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };
  for (const [name, p] of [['dark', DARK], ['light', LIGHT]]) {
    // Names and counts sit on the ground; the core's name and model sit on the raised node.
    for (const key of ['bone', 'ash', 'dim', 'hot']) {
      for (const ground of ['ground', 'raised']) assert.ok(ratio(p[key], p[ground]) >= 8, `${name} ${key} on ${ground}: ${ratio(p[key], p[ground]).toFixed(2)}`);
    }
    // The fault badge letters its count in the ground colour on red.
    assert.ok(ratio(p.ground, p.red) >= 8, `${name} ground on red: ${ratio(p.ground, p.red).toFixed(2)}`);
  }
  // The light rules repaint by colour value, so two dark colours may not share one.
  assert.equal(new Set(Object.values(DARK)).size, Object.keys(DARK).length);
});

test('a list row links to a message and a part the transcript reader really has', t => {
  // The reader's own normalizer decides what resolves, so the link is checked against it, not against a copy of its id rule.
  const landing = (file, action, map) => {
    const location = actionLocation(map, action);
    assert.equal(location.path, file);
    const { messages } = normalizeEvidenceEntries(entriesOf(file));
    const found = resolveTranscriptLocation(messages, location.uuid, location.blockId);
    assert.ok(found, `${action.station} "${action.label}" resolves to nothing`);
    const message = messages.find(m => m.uuid === found.messageId);
    return { message, block: messageBlocks(message).find(b => b.id === found.blockId) };
  };

  const claude = claudeFixture(t);
  const map = { ...sessionWorkmap(claude), path: claude };
  const sub = map.agents.abc123;
  assert.equal(sub, path.join(path.dirname(claude), 'sess-1', 'subagents', 'agent-abc123.jsonl'));
  for (const action of map.actions) {
    const file = action.agentId === undefined ? claude : sub;
    const { message, block } = landing(file, action, map);
    if (action.tool !== undefined) {
      // msg_2 holds three calls in one line: each must land on its own part, not on the first.
      assert.equal(block?.type, 'tool_call');
      assert.equal(block.name, action.tool);
    } else if (action.station === 'you') {
      assert.equal(message.role, 'user');
    }
  }
  assert.equal(map.actions.filter(a => a.tool !== undefined).length, 5);
  // A hook's own line is not shown by the reader, so it lands on the line it ran beside.
  assert.equal(map.actions.find(a => a.station === 'hooks').uuid, 'main-7');

  const codex = codexFixture(t);
  const cmap = { ...sessionWorkmap(codex), path: codex };
  const anchors = Object.fromEntries(cmap.actions.filter(a => a.tool !== undefined).map(a => [a.tool, a.uuid]));
  // While the call is the last row shown: the call. After it answered: the answer.
  assert.deepEqual(anchors, { exec_command: 'ctc_1', 'cartographer.recall': 'ctc_1', apply_patch: 'out_1', 'web.search': 'out_1' });
  for (const action of cmap.actions) landing(codex, action, cmap);
  assert.equal(landing(codex, cmap.actions.find(a => a.tool === 'exec_command'), cmap).block.type, 'tool_call');

  // One address for a call, whichever view links to it, and Back from the reader may return to the map.
  const shell = map.actions.find(a => a.station === 'shell');
  const back = '/map?session=sess-1&station=shell&at=5';
  const location = actionLocation(map, shell);
  assert.equal(readerHref('/', location, back), eventTranscriptHref({ transcript_path: claude, uuid: location.uuid, block_id: location.blockId }, back, '/'));
  assert.equal(safeTranscriptReturn(back), back);
  // No transcript named: no link, rather than a link to nowhere.
  assert.equal(actionLocation({ agents: {} }, shell), null);
  assert.equal(actionLocation({ path: claude, agents: {} }, { ...shell, agentId: 'gone' }), null);
});

test('the address round-trips, and a session that crosses midnight names the day', () => {
  const route = { session: 'abc', station: 'shell', at: 1794608515323 };
  assert.deepEqual(readMapRoute(new URL(mapHref('/', route), 'http://x').search), route);
  assert.deepEqual(readMapRoute(''), { session: '', station: '', at: null });
  assert.equal(mapHref('/base/', { session: 'abc', station: '', at: null }), '/base/map?session=abc');

  const noon = new Date(2026, 10, 12, 12, 0, 0).getTime();
  assert.equal(stampFor({ first: noon, last: noon + 3_600_000 })(noon), '12:00:00');
  assert.equal(stampFor({ first: noon, last: noon + 86_400_000 })(noon), 'Nov 12 12:00:00');
});
