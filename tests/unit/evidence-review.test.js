import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTranscriptEntries } from '../../explorer/server/transcripts.js';
import { buildEvidenceReview, operationResults, operationState } from '../../explorer/src/components/evidence-review.js';

const request = (messageId, callId, name, input, extra = {}) => ({ type: 'assistant', uuid: messageId, timestamp: '2026-10-29T12:00:00Z', message: { content: [{ type: 'tool_use', id: callId, name, input }] }, ...extra });
const response = (messageId, callId, content, is_error = false, extra = {}) => ({ type: 'user', uuid: messageId, message: { content: [{ type: 'tool_result', tool_use_id: callId, content, is_error }] }, ...extra });

test('one exact file review retains read, failed edit and later returned edit without inferring resolution', () => {
  const normalized = normalizeTranscriptEntries([
    request('read', 'r', 'Read', { file_path: '/work/alpha/report.md' }), response('read-result', 'r', 'Original document'),
    request('failed-edit', 'e1', 'Edit', { file_path: '/work/alpha/report.md', old_string: 'missing', new_string: 'replacement' }), response('failed-result', 'e1', 'sensor disconnected', true),
    request('later-edit', 'e2', 'Edit', { file_path: '/work/alpha/report.md', old_string: 'original', new_string: 'replacement' }), response('later-result', 'e2', 'Edit result recorded'),
    request('other-worktree', 'r2', 'Read', { file_path: '/work/beta/report.md' }), response('other-result', 'r2', 'Different document'),
  ]);
  const before = JSON.stringify(normalized);
  const review = buildEvidenceReview(normalized.evidence, normalized.messages);
  assert.equal(review.files.length, 2, 'same basenames in distinct worktrees never merge');
  const file = review.files.find(file => file.path === '/work/alpha/report.md');
  assert.deepEqual(file.operations.map(op => op.id), ['read--block-0', 'failed-edit--block-0', 'later-edit--block-0']);
  assert.deepEqual(file.operations.map(op => op.state.key), ['returned', 'error', 'returned']);
  assert.equal(file.operations[1].errors[0].summary, 'sensor disconnected');
  assert.equal(file.errorCount, 1, 'the later response does not erase a historical failure');
  assert.equal(file.readCount, 1); assert.equal(file.writeCount, 2);
  assert.deepEqual(file.operations.flatMap(op => op.sources.map(source => source.messageId)), ['read', 'read-result', 'failed-edit', 'failed-result', 'later-edit', 'later-result']);
  assert.ok(file.operations.every(op => !/success|resolved/i.test(op.state.label)));
  assert.equal(review.activity.length, 0); assert.equal(review.errors.length, 0);
  assert.equal(JSON.stringify(normalized), before, 'review grouping never rewrites chronological evidence');
});

test('call IDs shared across agents never join another operation or steal its error', () => {
  const normalized = normalizeTranscriptEntries([
    request('main-read', 'shared', 'Read', { file_path: '/work/main.md' }),
    request('child-read', 'shared', 'Read', { file_path: '/work/child.md' }, { agentId: 'child' }),
    response('child-failed', 'shared', 'child failure', true, { agentId: 'child' }),
    response('orphan', 'not-recorded', 'orphan failure', true),
    request('command', 'shell', 'Bash', { command: 'echo done' }), response('command-result', 'shell', 'done'),
  ]);
  const review = buildEvidenceReview(normalized.evidence, normalized.messages);
  const main = review.files.find(file => file.path === '/work/main.md').operations[0];
  const child = review.files.find(file => file.path === '/work/child.md').operations[0];
  assert.equal(main.state.key, 'missing'); assert.equal(main.results.length, 0); assert.equal(main.errors.length, 0);
  assert.equal(child.state.key, 'error'); assert.equal(child.results[0].id, 'child-failed--block-0');
  assert.deepEqual(review.errors.map(error => error.blockId), ['orphan--block-0']);
  assert.equal(review.errors[0].result.orphan, true);
  assert.equal(review.activity[0].call.id, 'command--block-0');
  assert.equal(review.activity[0].results[0].id, 'command-result--block-0');
});

test('one-to-many results preserve each source ID instead of zipping distinct message IDs', () => {
  const call = { id: 'call', type: 'tool_call', status: 'returned', resultIds: ['one', 'two', 'three'], resultMessageIds: ['combined', 'later'] };
  const results = [
    { id: 'three', type: 'tool_result', callBlockId: 'call', messageId: 'later', output: 'Third' },
    { id: 'one', type: 'tool_result', callBlockId: 'call', messageId: 'combined', output: 'First' },
    { id: 'two', type: 'tool_result', callBlockId: 'call', messageId: 'combined', output: 'Second' },
  ];
  const paired = operationResults(call, [...results, results[0]]);
  assert.deepEqual(paired.results.map(result => result.id), ['one', 'two', 'three']);
  assert.deepEqual(paired.results.map(result => result.messageId), ['combined', 'combined', 'later']);
  assert.deepEqual(paired.missingResultIds, []);
  const incomplete = operationResults(call, results.slice(0, 2));
  assert.deepEqual(incomplete.missingResultIds, ['two']);
  assert.equal(operationState(call, incomplete.results, incomplete.missingResultIds).key, 'unavailable');
});

test('inconsistent links and relative paths remain separate rather than guessing shared ownership', () => {
  const call = { id: 'call', resultIds: ['conflict'] };
  assert.deepEqual(operationResults(call, [{ id: 'conflict', type: 'tool_result', callBlockId: 'another-call' }]).missingResultIds, ['conflict']);
  const normalized = normalizeTranscriptEntries([
    request('relative-a', 'a', 'Read', { file_path: 'docs/report.md' }),
    request('relative-b', 'b', 'Read', { file_path: 'docs/report.md' }),
  ]);
  const review = buildEvidenceReview(normalized.evidence, normalized.messages);
  assert.equal(review.files.length, 2, 'a relative string without cwd does not establish one physical file');
  assert.ok(review.files.every(file => file.relative));
  const missingMessages = buildEvidenceReview({ files: [{ path: '/work/a.md', blockId: 'a', messageId: 'message', callId: 'same', operation: 'write' }], calls: [{ blockId: 'a', name: 'Edit' }], errors: [{ blockId: 'error', callId: 'same', summary: 'unjoined failure' }] });
  assert.equal(missingMessages.files[0].operations[0].errors.length, 0);
  assert.equal(missingMessages.errors.length, 1, 'matching call_id alone cannot reconstruct an absent canonical link');
});
