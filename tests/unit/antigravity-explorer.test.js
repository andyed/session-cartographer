process.env.CARTOGRAPHER_SEMANTIC = '0';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

for (const name of [
  'CARTOGRAPHER_SESSION_ID',
  'CLAUDE_SESSION_ID',
  'CLAUDE_CODE_SESSION_ID',
  'CODEX_SESSION_ID',
  'ANTIGRAVITY_CONVERSATION_ID',
  'ANTIGRAVITY_AGENT',
]) {
  delete process.env[name];
}

const {
  transcriptRoots,
  isAllowedTranscriptPath,
  antigravitySessionIndex,
  normalizeTranscriptEntries,
} = await import('../../explorer/server/transcripts.js');
const { stripAntigravityUserEnvelope } = await import('../../explorer/server/transcript-evidence.js');
const { createTranscriptEnricher } = await import('../../explorer/server/memory-transcript.js');
const { providerOfTranscript, sessionFlowmap } = await import('../../explorer/server/flowmap.js');

function makeFixtureEntries() {
  return [
    {
      step_index: 0,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      status: 'DONE',
      created_at: '2026-11-25T13:02:40Z',
      content: [
        '<USER_REQUEST>',
        'Inspect the Explorer transcript parser and fix Antigravity support.',
        '</USER_REQUEST>',
        '<ADDITIONAL_METADATA>',
        'The current local time is: 2026-11-25T05:02:40-08:00.',
        '</ADDITIONAL_METADATA>',
        '<USER_SETTINGS_CHANGE>',
        'The user changed setting Model Selection.',
        '</USER_SETTINGS_CHANGE>',
      ].join('\n'),
    },
    {
      step_index: 1,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-11-25T13:02:42Z',
      model: 'gemini-4-neon-high',
      input_tokens: 19871,
      cache_read_tokens: 17641,
      output_tokens: 557,
      thinking: 'First inspect transcript-evidence.js, query Cartographer memory, and check tests.',
      tool_calls: [
        {
          name: 'read_file',
          args: {
            Path: '"/workspace/repo/explorer/server/transcript-evidence.js"',
            StartLine: '1',
            EndLine: '40',
          },
        },
        {
          name: 'call_mcp_tool',
          args: {
            ServerName: '"session-cartographer_cartographer"',
            ToolName: '"recall"',
            Arguments: '{"query":"antigravity transcript format","limit":5}',
          },
        },
        {
          name: 'search_web',
          args: {
            query: '"antigravity transcript schema"',
          },
        },
        {
          name: 'read_file',
          args: {
            Path: '"/workspace/repo/missing.js"',
          },
        },
      ],
    },
    {
      step_index: 2,
      source: 'MODEL',
      type: 'GENERIC',
      status: 'DONE',
      created_at: '2026-11-25T13:02:44Z',
      content: 'Showing lines 1-40 of 222\n1: // Provider records...',
    },
    {
      step_index: 3,
      source: 'MODEL',
      type: 'GENERIC',
      status: 'DONE',
      created_at: '2026-11-25T13:02:45Z',
      content: 'call-20261125T130245-abc123\n2 results found for antigravity transcript format.',
    },
    {
      step_index: 4,
      source: 'MODEL',
      type: 'GENERIC',
      status: 'DONE',
      created_at: '2026-11-25T13:02:46Z',
      content: 'Search summary: Antigravity logs steps in transcript.jsonl.',
    },
    {
      step_index: 5,
      source: 'MODEL',
      type: 'GENERIC',
      status: 'ERROR',
      error: 'file does not exist',
      created_at: '2026-11-25T13:02:47Z',
      content: 'Encountered error in step execution: file does not exist',
    },
    {
      step_index: 6,
      source: 'SYSTEM',
      type: 'SYSTEM_MESSAGE',
      status: 'DONE',
      created_at: '2026-11-25T13:02:48Z',
      content: 'Internal reminder',
    },
    {
      step_index: 7,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-11-25T13:02:50Z',
      model: 'gemini-4-neon-high',
      input_tokens: 15895,
      cache_read_tokens: 37513,
      output_tokens: 820,
      tool_calls: [
        {
          name: 'edit_file',
          args: {
            Path: '"/workspace/repo/explorer/server/transcript-evidence.js"',
            Target: '"old"',
            Replacement: '"new"',
          },
        },
        {
          name: 'write_file',
          args: {
            Path: '"/workspace/repo/failed-write.js"',
            Content: '"bad"',
          },
        },
        {
          name: 'run_command',
          args: {
            CommandLine: '"node --test tests/unit/antigravity-explorer.test.js"',
            WaitMsBeforeAsync: '5000',
            toolSummary: '"Run Antigravity explorer unit tests"',
          },
        },
        {
          name: 'invoke_subagent',
          args: {
            TypeName: '"research"',
            Role: '"Flowmap Verifier"',
            Prompt: '"Verify flowmap stations"',
          },
        },
      ],
    },
    {
      step_index: 8,
      source: 'MODEL',
      type: 'GENERIC',
      status: 'DONE',
      created_at: '2026-11-25T13:02:52Z',
      content: 'Edited /workspace/repo/explorer/server/transcript-evidence.js successfully.',
    },
    {
      step_index: 9,
      source: 'MODEL',
      type: 'ERROR_MESSAGE',
      status: 'ERROR',
      error: 'permission denied',
      created_at: '2026-11-25T13:02:53Z',
      content: 'Failed to write /workspace/repo/failed-write.js: permission denied',
    },
    {
      step_index: 10,
      source: 'MODEL',
      type: 'GENERIC',
      status: 'DONE',
      created_at: '2026-11-25T13:02:55Z',
      content: 'Command exited with code 0.\nAll tests passed.',
    },
    {
      step_index: 11,
      source: 'MODEL',
      type: 'GENERIC',
      status: 'DONE',
      created_at: '2026-11-25T13:02:56Z',
      content: 'Subagent launched.',
    },
    {
      step_index: 12,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-11-25T13:03:00Z',
      model: 'gemini-4-neon-high',
      input_tokens: 6029,
      cache_read_tokens: 53409,
      output_tokens: 412,
      thinking: 'All checks passed; ready to summarize.',
      content: 'Antigravity Explorer support is now implemented and verified.',
    },
  ];
}

test('transcriptRoots includes Antigravity brain roots and rejects sibling-prefix traversal', () => {
  const defaultRoots = transcriptRoots({}, '/home/tester');
  assert.ok(defaultRoots.includes(path.resolve('/home/tester/.gemini/antigravity/brain')));
  assert.ok(defaultRoots.includes(path.resolve('/home/tester/.gemini/antigravity-ide/brain')));
  assert.ok(defaultRoots.includes(path.resolve('/home/tester/.gemini/antigravity-cli/brain')));

  const overrideRoots = transcriptRoots(
    { CARTOGRAPHER_ANTIGRAVITY_TRANSCRIPTS_DIR: '/custom/agy/brain' },
    '/home/tester',
  );
  assert.ok(overrideRoots.includes(path.resolve('/custom/agy/brain')));
  assert.equal(overrideRoots.includes(path.resolve('/home/tester/.gemini/antigravity/brain')), false);

  assert.equal(
    isAllowedTranscriptPath('/custom/agy/brain/conv-1/.system_generated/logs/transcript.jsonl', overrideRoots),
    true,
  );
  assert.equal(
    isAllowedTranscriptPath('/custom/agy/brain-evil/conv-1/.system_generated/logs/transcript.jsonl', overrideRoots),
    false,
    'sibling-prefix traversal must be rejected',
  );
});

test('antigravitySessionIndex indexes valid brain transcripts and ignores dirs without one', (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'carto-agy-idx-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const brain = path.join(root, 'brain');
  const convA = '11111111-2222-3333-4444-555555555555';
  const convB = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const transcriptA = path.join(brain, convA, '.system_generated', 'logs', 'transcript.jsonl');
  fs.mkdirSync(path.dirname(transcriptA), { recursive: true });
  fs.writeFileSync(transcriptA, '{"step_index":0,"type":"USER_INPUT","content":"hello"}\n');

  // Conversation directory without a transcript.jsonl must be ignored.
  fs.mkdirSync(path.join(brain, convB, '.system_generated', 'logs'), { recursive: true });
  // Regular file directly under brain must also be ignored.
  fs.writeFileSync(path.join(brain, 'stray-file.txt'), 'ignore me');

  const index = antigravitySessionIndex({
    env: { CARTOGRAPHER_ANTIGRAVITY_TRANSCRIPTS_DIR: brain },
    home: root,
    force: true,
  });

  assert.equal(index.size, 1);
  assert.equal(index.get(convA), transcriptA);
  assert.equal(index.has(convB), false);
});

test('normalizeTranscriptEntries parses Antigravity steps, strips user envelope, links calls and results, and extracts file refs', () => {
  assert.equal(
    stripAntigravityUserEnvelope('<USER_REQUEST>\nHello world\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\ntime\n</ADDITIONAL_METADATA>'),
    'Hello world',
  );

  const normalized = normalizeTranscriptEntries(makeFixtureEntries());
  assert.equal(normalized.provider, 'antigravity');
  assert.equal(
    normalized.identity.title,
    'Inspect the Explorer transcript parser and fix Antigravity support.',
    'title strips <USER_REQUEST> and metadata tags',
  );

  // SYSTEM_MESSAGE step 6 is skipped; all 12 conversation/tool steps remain.
  assert.equal(normalized.messages.some(m => m.uuid === 'step-6'), false);
  const userMsg = normalized.messages.find(m => m.uuid === 'step-0');
  assert.equal(userMsg.role, 'user');
  assert.equal(userMsg.content, 'Inspect the Explorer transcript parser and fix Antigravity support.');

  const step1 = normalized.messages.find(m => m.uuid === 'step-1');
  assert.equal(step1.role, 'assistant');
  assert.equal(step1.model, 'gemini-4-neon-high');
  assert.equal(step1.blocks[0].type, 'thinking');
  const step1Calls = step1.blocks.filter(b => b.type === 'tool_call');
  assert.equal(step1Calls.length, 4);
  // Stringified JSON args were unwrapped cleanly.
  assert.equal(step1Calls[0].input.Path, '/workspace/repo/explorer/server/transcript-evidence.js');
  assert.equal(step1Calls[0].status, 'returned');
  assert.deepEqual(step1Calls[0].resultMessageIds, ['step-2']);
  assert.equal(step1Calls[1].input.ServerName, 'session-cartographer_cartographer');
  assert.deepEqual(step1Calls[1].input.Arguments, { query: 'antigravity transcript format', limit: 5 });
  assert.equal(step1Calls[3].status, 'error');
  assert.deepEqual(step1Calls[3].resultMessageIds, ['step-5']);

  // Result block links back to its exact call.
  const step5 = normalized.messages.find(m => m.uuid === 'step-5');
  assert.equal(step5.role, 'tool');
  assert.equal(step5.blocks[0].type, 'tool_result');
  assert.equal(step5.blocks[0].orphan, false);
  assert.equal(step5.blocks[0].isError, true);
  assert.equal(step5.blocks[0].callMessageId, 'step-1');
  assert.equal(step5.blocks[0].callBlockId, step1Calls[3].id);

  // Evidence errors include both failed steps (step 5 and step 9).
  assert.deepEqual(normalized.evidence.errors.map(e => e.messageId), ['step-5', 'step-9']);

  // Evidence files extract Antigravity read_file, edit_file, and write_file paths with exact operations.
  assert.deepEqual(
    normalized.evidence.files.map(f => [f.path, f.operation, f.status]),
    [
      ['/workspace/repo/explorer/server/transcript-evidence.js', 'read', 'returned'],
      ['/workspace/repo/missing.js', 'read', 'error'],
      ['/workspace/repo/explorer/server/transcript-evidence.js', 'write', 'returned'],
      ['/workspace/repo/failed-write.js', 'write', 'error'],
    ],
  );

  // Final assistant turn keeps thinking and answer text.
  const finalMsg = normalized.messages.find(m => m.uuid === 'step-12');
  assert.equal(finalMsg.role, 'assistant');
  assert.equal(finalMsg.blocks[0].type, 'thinking');
  assert.equal(finalMsg.blocks[1].type, 'text');
  assert.equal(finalMsg.blocks[1].text, 'Antigravity Explorer support is now implemented and verified.');
});

test('memory-transcript reads Antigravity prompts, uncached+cached token totals, and completed file edits', async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'carto-agy-mem-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const convId = '6ae50945-e5bd-47b9-85a0-dddbaaac0148';
  const transcriptPath = path.join(root, convId, '.system_generated', 'logs', 'transcript.jsonl');
  fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
  fs.writeFileSync(transcriptPath, `${makeFixtureEntries().map(e => JSON.stringify(e)).join('\n')}\n`);

  const enricher = createTranscriptEnricher({ roots: [root] });
  t.after(() => enricher.close());

  const start = Date.parse('2026-11-25T13:00:00Z');
  const end = Date.parse('2026-11-25T13:10:00Z');

  // Discovers transcript via brain root even when session.transcript is not passed.
  const result = await enricher.read({ id: convId }, { start, end });
  assert.equal(result.valid, true, result.reason);
  assert.equal(result.provider, 'antigravity');
  assert.equal(result.path, transcriptPath);
  assert.equal(result.title, 'Inspect the Explorer transcript parser and fix Antigravity support.');

  // Step 1: input=19871+17641=37512, out=557, cacheRead=17641
  // Step 7: input=15895+37513=53408, out=820, cacheRead=37513
  // Step 12: input=6029+53409=59438, out=412, cacheRead=53409
  const expectedCacheRead = 17641 + 37513 + 53409;
  const expectedInput = (19871 + 15895 + 6029) + expectedCacheRead;
  const expectedOutput = 557 + 820 + 412;
  assert.equal(result.tokens.status, 'available');
  assert.equal(result.tokens.source, 'antigravity');
  assert.equal(result.tokens.samples, 3);
  assert.equal(result.tokens.cacheRead, expectedCacheRead);
  assert.equal(result.tokens.cacheWrite, 0);
  assert.equal(result.tokens.input, expectedInput);
  assert.equal(result.tokens.output, expectedOutput);
  assert.equal(result.tokens.total, expectedInput + expectedOutput);
  assert.equal(result.tokenSeries.length, 3);

  // Completed edit_file and run_command are retained; failed write_file (step 9) is excluded.
  const editedPaths = result.tools.flatMap(tool => tool.paths);
  assert.deepEqual(editedPaths, ['/workspace/repo/explorer/server/transcript-evidence.js']);
  assert.equal(
    result.tools.some(tool => tool.commandPrefix === 'node --test tests/unit/antigravity-explorer.test.js'),
    true,
  );

  // A mismatched session id cannot reuse another conversation's transcript.
  const wrongSession = await enricher.read(
    { id: '99999999-8888-7777-6666-555555555555', transcript: transcriptPath },
    { start, end },
  );
  assert.equal(wrongSession.valid, false);
});

test('flowmap replays an Antigravity transcript into valid stations and context fill', (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'carto-agy-flow-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const convId = '77777777-8888-9999-aaaa-bbbbbbbbbbbb';
  const transcriptPath = path.join(root, convId, '.system_generated', 'logs', 'transcript.jsonl');
  fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
  fs.writeFileSync(transcriptPath, `${makeFixtureEntries().map(e => JSON.stringify(e)).join('\n')}\n`);

  assert.equal(providerOfTranscript(transcriptPath), 'antigravity');

  const map = sessionFlowmap(transcriptPath);
  assert.equal(map.provider, 'antigravity');
  assert.equal(map.session_id, convId);
  assert.equal(map.model, 'gemini-4-neon-high');
  assert.deepEqual(map.context, { window: 1_000_000, source: 'inferred' });

  for (const station of ['you', 'model', 'files', 'shell', 'memory', 'web', 'agents', 'tells']) {
    assert.ok(map.present.includes(station), `expected station "${station}" in ${JSON.stringify(map.present)}`);
  }

  // Inbound user prompt is cleanly stripped.
  const youAction = map.actions.find(a => a.station === 'you');
  assert.equal(youAction.from, 'inbound');
  assert.equal(youAction.uuid, 'step-0');
  assert.match(youAction.label, /^Inspect the Explorer transcript parser/);

  // Model steps carry context fill (input_tokens + cache_read_tokens).
  const modelActions = map.actions.filter(a => a.station === 'model');
  assert.deepEqual(modelActions.map(a => a.ctx), [37512, 53408, 59438]);

  // Cartographer MCP recall maps to memory station and captures call id + result count.
  const memoryAction = map.actions.find(a => a.station === 'memory');
  assert.equal(memoryAction.recall, 'search');
  assert.equal(memoryAction.call, 'call-20261125T130245-abc123');
  assert.match(memoryAction.detail, /2 results/);

  // Failed tool results mark status 'err'.
  const failed = map.actions.filter(a => a.status === 'err');
  assert.equal(failed.length, 2);

  // Final text PLANNER_RESPONSE (no tool_calls) emits a 'tells' action.
  const tellsAction = map.actions.find(a => a.station === 'tells');
  assert.equal(tellsAction.uuid, 'step-12');
  assert.match(tellsAction.label, /^Antigravity Explorer support is now implemented/);
});
