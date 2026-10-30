import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTranscriptEntries } from '../../explorer/server/transcripts.js';

const claude = (uuid, role, content, extra = {}) => ({
  type: role, uuid, sessionId: 'claude-session', cwd: '/project',
  message: { role, content }, ...extra,
});
const codex = payload => ({ type: 'response_item', payload });

test('Claude preserves mixed content, parallel calls, chronology and exact result links', () => {
  const large = 'a complete output line\n'.repeat(15000);
  const rows = [
    claude('prompt', 'user', 'Investigate the fixture failure'),
    claude('calls', 'assistant', [
      { type: 'text', text: 'Reading both files.' },
      { type: 'tool_use', id: 'call-a', name: 'Read', input: { file_path: '/project/a.js', extra: large } },
      { type: 'thinking', thinking: 'Compare their state.' },
      { type: 'tool_use', id: 'call-b', name: 'Edit', input: { file_path: '/project/b.js', old_string: 'a', new_string: 'b' } },
    ]),
    claude('results', 'user', [
      { type: 'tool_result', tool_use_id: 'call-b', is_error: true, content: 'Edit refused' },
      { type: 'text', text: 'The second operation failed.' },
      { type: 'tool_result', tool_use_id: 'call-a', content: large },
    ]),
  ];
  const original = JSON.stringify(rows);
  const { messages, evidence, identity } = normalizeTranscriptEntries(rows);
  assert.equal(JSON.stringify(rows), original, 'normalization never mutates source records');
  assert.deepEqual(messages.map(m => m.uuid), ['prompt', 'calls', 'results']);
  assert.deepEqual(messages[1].blocks.map(b => b.type), ['text', 'tool_call', 'thinking', 'tool_call']);
  assert.equal(messages[1].blocks[1].input.extra, large);
  assert.equal(messages[2].blocks[2].output, large);
  assert.ok(messages[2].content.endsWith(large));
  assert.deepEqual(messages[1].blocks[1].resultIds, ['results--block-2']);
  assert.deepEqual(messages[1].blocks[3].resultIds, ['results--block-0']);
  assert.equal(messages[2].blocks[0].callMessageId, 'calls');
  assert.equal(messages[2].blocks[0].callBlockId, 'calls--block-3');
  assert.deepEqual(evidence.calls.map(c => [c.callId, c.status]), [['call-a', 'returned'], ['call-b', 'error']]);
  assert.deepEqual(evidence.files.map(f => [f.path, f.operation, f.status, f.messageId]), [
    ['/project/a.js', 'read', 'returned', 'calls'], ['/project/b.js', 'write', 'error', 'calls'],
  ]);
  assert.equal(evidence.errors[0].messageId, 'results');
  assert.equal(evidence.errors[0].summary, 'Edit refused');
  assert.deepEqual(identity, { provider: 'claude', sessionId: 'claude-session', title: 'Investigate the fixture failure', cwd: '/project' });
});

test('missing and orphan results remain explicit, and agent-scoped IDs do not cross-pair', () => {
  const { messages, evidence } = normalizeTranscriptEntries([
    claude('main', 'assistant', [{ type: 'tool_use', id: 'shared', name: 'Bash', input: { command: 'main' } }]),
    claude('child', 'assistant', [{ type: 'tool_use', id: 'shared', name: 'Bash', input: { command: 'child' } }], { agentId: 'child-agent', isSidechain: true }),
    claude('child-result', 'user', [{ type: 'tool_result', tool_use_id: 'shared', content: 'done' }], { agentId: 'child-agent', isSidechain: true }),
    claude('orphan', 'user', [{ type: 'tool_result', tool_use_id: 'not-recorded', content: 'error is mentioned, but no failure is recorded' }]),
  ]);
  assert.equal(messages[0].blocks[0].status, 'missing-result');
  assert.equal(messages[1].blocks[0].status, 'returned');
  assert.equal(messages[2].blocks[0].callMessageId, 'child');
  assert.equal(messages[3].blocks[0].status, 'orphan-result');
  assert.equal(messages[3].blocks[0].callMessageId, null);
  assert.equal(messages[3].blocks[0].orphan, true);
  assert.equal(evidence.errors.length, 0, 'words like error are not failure evidence');
});

test('Codex function/custom calls keep full inputs and outputs with unique message IDs', () => {
  const patch = '*** Begin Patch\n*** Update File: a.js\n@@\n-a\n+b\n*** End Patch';
  const rows = [
    { type: 'session_meta', payload: { id: 'codex-session', cwd: '/codex-project' } },
    { type: 'event_msg', payload: { type: 'user_message', message: '# AGENTS.md instructions should not be the title' } },
    codex({ type: 'message', role: 'user', id: 'prompt', content: [{ type: 'input_text', text: 'Repair the input parser' }] }),
    codex({ type: 'function_call', call_id: 'exec', name: 'exec_command', arguments: '{"cmd":"exit 3"}' }),
    codex({ type: 'custom_tool_call', call_id: 'patch', name: 'apply_patch', input: patch }),
    codex({ type: 'function_call_output', call_id: 'exec', output: '{"exit_code":3,"output":"failed"}' }),
    codex({ type: 'custom_tool_call_output', call_id: 'patch', output: '' }),
    codex({ type: 'reasoning', summary: [{ type: 'summary_text', text: 'The parser must preserve this.' }], encrypted_content: 'opaque-secret' }),
    codex({ type: 'message', id: 'final', role: 'assistant', content: [{ type: 'output_text', text: 'Finished reviewing.' }] }),
  ];
  const { messages, identity, evidence } = normalizeTranscriptEntries(rows);
  assert.equal(identity.title, 'Repair the input parser');
  assert.equal(identity.sessionId, 'codex-session');
  assert.equal(identity.cwd, '/codex-project');
  assert.equal(new Set(messages.map(m => m.uuid)).size, messages.length);
  const call = messages.find(m => m.uuid === 'exec');
  assert.equal(call.sourceUuid, 'exec');
  assert.equal(call.blocks[0].input, '{"cmd":"exit 3"}');
  const result = messages.find(m => m.blocks[0].type === 'tool_result' && m.blocks[0].callId === 'exec');
  assert.notEqual(result.uuid, call.uuid);
  assert.equal(result.blocks[0].output, '{"exit_code":3,"output":"failed"}');
  assert.equal(result.blocks[0].callMessageId, call.uuid);
  assert.equal(result.blocks[0].isError, true);
  assert.equal(messages.find(m => m.uuid === 'patch').blocks[0].input, patch);
  assert.deepEqual(evidence.files.map(f => [f.path, f.operation, f.messageId]), [['a.js', 'write', 'patch']]);
  assert.deepEqual(evidence.calls.map(c => c.status), ['error', 'returned'], 'an empty recorded result is not a missing result');
  assert.ok(messages.some(m => m.blocks[0].type === 'thinking'));
  assert.ok(!JSON.stringify(messages).includes('opaque-secret'));
});

test('embedded binary is omitted while attachment metadata and adjacent evidence remain', () => {
  const { messages } = normalizeTranscriptEntries([
    claude('media', 'user', [
      { type: 'text', text: 'Inspect the image' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'TOP_SECRET_IMAGE_BYTES' } },
      { type: 'tool_result', tool_use_id: 'image-tool', content: [
        { type: 'text', text: 'Visible caption' },
        { type: 'image', source: { type: 'base64', data: 'TOP_SECRET_RESULT_BYTES' } },
      ] },
      { type: 'future_block', detail: 'Preserve unsupported metadata', image_url: 'data:image/png;base64,TOP_SECRET_URL_BYTES' },
      { type: 'tool_result', tool_use_id: 'serialized-image', content: JSON.stringify({
        content: [{ type: 'text', text: 'Keep serialized text' }, { type: 'image', data: 'TOP_SECRET_SERIALIZED_BYTES' }],
      }) },
    ]),
  ]);
  const serialized = JSON.stringify(messages);
  assert.ok(!serialized.includes('TOP_SECRET'));
  assert.equal(messages[0].blocks[1].mediaType, 'image/png');
  assert.match(messages[0].content, /Visible caption/);
  assert.match(messages[0].content, /Preserve unsupported metadata/);
  assert.equal(messages[0].blocks[3].blockType, 'future_block');
  assert.match(messages[0].content, /Keep serialized text/);
});

test('Codex UserMessage display records retain prompts without duplicating legacy display events', () => {
  const item = (text, timestamp) => ({ timestamp, type: 'event_msg', payload: {
    type: 'item_completed', item: { type: 'UserMessage', id: `user-${timestamp}`, content: [{ type: 'text', text }] },
  } });
  const { messages, identity } = normalizeTranscriptEntries([
    { type: 'session_meta', payload: { id: 'new-format' } },
    item('Show the session evidence', '2026-10-29T10:00:00Z'),
    { timestamp: '2026-10-29T10:01:00Z', type: 'event_msg', payload: { type: 'user_message', message: 'Check the results' } },
    item('Check the results', '2026-10-29T10:01:00Z'),
    item('Check the results', '2026-10-29T10:02:00Z'),
  ]);
  assert.deepEqual(messages.map(m => m.content), ['Show the session evidence', 'Check the results', 'Check the results']);
  assert.equal(messages[0].sourceUuid, 'user-2026-10-29T10:00:00Z');
  assert.equal(identity.title, 'Show the session evidence');
});

test('source UUIDs and append-stable message IDs survive duplicate source IDs', () => {
  const rows = [
    claude('same', 'assistant', 'First message'),
    claude('same', 'assistant', 'Second message'),
    claude('same--record-1', 'assistant', 'Third message'),
  ];
  const before = normalizeTranscriptEntries(rows).messages;
  const after = normalizeTranscriptEntries([...rows, claude('new', 'assistant', 'Fourth message')]).messages;
  assert.equal(new Set(before.map(m => m.uuid)).size, 3);
  assert.deepEqual(before.map(m => m.sourceUuid), ['same', 'same', 'same--record-1']);
  assert.deepEqual(before.map(m => m.uuid), after.slice(0, 3).map(m => m.uuid));
  assert.deepEqual(before.map(m => m.sourceIndex), [0, 1, 2]);
});

test('explicit execution failures and server-tool results are represented without noise hiding', () => {
  const { messages, evidence } = normalizeTranscriptEntries([
    claude('call', 'assistant', [{ type: 'server_tool_use', id: 'search', name: 'web_search', input: { query: 'test' } }]),
    claude('result', 'user', [{ type: 'web_search_tool_result', tool_use_id: 'search', content: [] }]),
    claude('failure', 'user', [{ type: 'tool_result', tool_use_id: 'exec', content: 'Chunk ID: 1\nProcess exited with code 2\nFinal output:\n<task-notification>' }]),
    claude('notice', 'user', '<task-notification><status>completed</status></task-notification>'),
    { type: 'custom-title', customTitle: 'Explicit session title' },
  ]);
  assert.equal(messages[1].blocks[0].callMessageId, 'call');
  assert.equal(messages[1].blocks[0].status, 'returned');
  assert.equal(messages[2].noise, null);
  assert.equal(messages[3].noise, 'task-notification');
  assert.equal(evidence.errors[0].messageId, 'failure');
  assert.equal(normalizeTranscriptEntries([{ type: 'custom-title', customTitle: 'Explicit session title' }]).identity.title, 'Explicit session title');
});

test('current Codex content-block result envelopes expose explicit failures including orphans', () => {
  const { messages, evidence } = normalizeTranscriptEntries([
    codex({ type: 'function_call', call_id: 'exec-current', name: 'exec_command', arguments: '{"cmd":"exit 7"}' }),
    codex({ type: 'function_call_output', id: 'result-current', call_id: 'exec-current', output: [
      { type: 'input_text', text: '{"exit_code":7,"output":"command failed"}' },
      { type: 'input_text', text: 'Additional complete output' },
    ] }),
    codex({ type: 'function_call_output', call_id: 'unrecorded', output: [
      { type: 'input_text', text: 'Chunk ID: 123\nProcess exited with code 3\nFinal output:\nfailure details' },
    ] }),
    codex({ type: 'function_call_output', call_id: 'no-failure', output: [
      { type: 'input_text', text: 'The word error alone establishes nothing' },
    ] }),
  ]);
  assert.equal(messages[0].blocks[0].status, 'error');
  assert.equal(messages[1].blocks[0].output.length, 2);
  assert.equal(messages[2].blocks[0].orphan, true);
  assert.equal(messages[2].blocks[0].status, 'error');
  assert.equal(messages[3].blocks[0].isError, false);
  assert.deepEqual(evidence.errors.map(e => e.callId), ['exec-current', 'unrecorded']);
  assert.equal(evidence.errors[1].callMessageId, null);
});

test('Codex inter-agent messages preserve author/recipient and text while omitting encrypted bytes', () => {
  const { messages } = normalizeTranscriptEntries([
    codex({ type: 'agent_message', id: 'agent-message', author: 'agent-source', recipient: 'agent-target', content: [
      { type: 'input_text', text: 'This recorded handoff is conversation evidence.' },
      { type: 'encrypted_content', data: 'OPAQUE_SECRET_BYTES' },
    ] }),
  ]);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].role, 'assistant');
  assert.equal(messages[0].author, 'agent-source');
  assert.equal(messages[0].recipient, 'agent-target');
  assert.equal(messages[0].sourceUuid, 'agent-message');
  assert.equal(messages[0].blocks[0].text, 'This recorded handoff is conversation evidence.');
  assert.equal(messages[0].blocks[1].blockType, 'encrypted_content');
  assert.ok(!JSON.stringify(messages).includes('OPAQUE_SECRET_BYTES'));
});

test('result block IDs retain all results while result message IDs are unique destinations', () => {
  const { messages } = normalizeTranscriptEntries([
    claude('multi-call', 'assistant', [{ type: 'tool_use', id: 'multi', name: 'Tool', input: {} }]),
    claude('multi-results', 'user', [
      { type: 'tool_result', tool_use_id: 'multi', content: 'First result' },
      { type: 'tool_result', tool_use_id: 'multi', content: 'Second result' },
    ]),
    claude('later-result', 'user', [{ type: 'tool_result', tool_use_id: 'multi', content: 'Later result' }]),
  ]);
  const call = messages[0].blocks[0];
  assert.deepEqual(call.resultIds, ['multi-results--block-0', 'multi-results--block-1', 'later-result--block-0']);
  assert.deepEqual(call.resultMessageIds, ['multi-results', 'later-result']);
  for (const result of messages.slice(1).flatMap(m => m.blocks)) assert.equal(result.callBlockId, call.id);
});
