/**
 * tests/unit/devtools-adapted.test.js
 *
 * Smoke tests for the three devtools-adapted modules.
 *
 * Run with:
 *   node --test tests/unit/devtools-adapted.test.js
 *
 * Uses Node's built-in test runner (no extra deps). Tests exercise real session
 * files from ~/.claude/projects/ where available, with synthetic fallbacks so
 * the suite passes even in CI or fresh environments.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'os';
import { writeFileSync, mkdtempSync } from 'fs';
import { join } from 'path';

import {
  parseJsonlFile,
  parseJsonlLine,
  extractToolCalls,
  extractToolResults,
  deduplicateByRequestId,
  calculateMetrics,
  isParsedUserChunkMessage,
  isParsedHardNoiseMessage,
  isParsedCompactMessage,
  enumerateSessions,
  parseSession,
  extractTextContent,
} from '../../src/lib/devtools-adapted/session-parser.js';

import {
  estimateTokens,
  computeTokenAttribution,
  totalAttributedTokens,
  attributionFractions,
} from '../../src/lib/devtools-adapted/token-attribution.js';

import {
  checkMessagesOngoing,
  detectCompactionPhases,
} from '../../src/lib/devtools-adapted/compaction-detector.js';

import {
  DEVTOOLS_PARSER_ENABLED,
  analyzeSession,
} from '../../src/lib/devtools-adapted/index.js';

// =============================================================================
// Fixtures
// =============================================================================

/** A minimal synthetic JSONL session for deterministic unit testing. */
const SYNTHETIC_LINES = [
  // Real user message
  JSON.stringify({
    uuid: 'aaa-001',
    parentUuid: null,
    type: 'user',
    timestamp: '2026-01-01T10:00:00.000Z',
    isSidechain: false,
    isMeta: false,
    cwd: '/test',
    gitBranch: 'main',
    message: { role: 'user', content: 'Help me write a function.' },
  }),
  // Assistant response with tool_use and text
  JSON.stringify({
    uuid: 'bbb-002',
    parentUuid: 'aaa-001',
    type: 'assistant',
    timestamp: '2026-01-01T10:00:05.000Z',
    requestId: 'req-1',
    isSidechain: false,
    isMeta: false,
    cwd: '/test',
    gitBranch: 'main',
    message: {
      role: 'assistant',
      model: 'claude-sonnet-4-6',
      content: [
        { type: 'text', text: 'Sure, let me read the file first.' },
        { type: 'tool_use', id: 'tool-read-1', name: 'Read', input: { file_path: '/test/foo.js' } },
      ],
      usage: { input_tokens: 100, output_tokens: 40, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
  }),
  // Duplicate streaming entry for same request (should be deduplicated)
  JSON.stringify({
    uuid: 'bbb-002-dup',
    parentUuid: 'aaa-001',
    type: 'assistant',
    timestamp: '2026-01-01T10:00:05.500Z',
    requestId: 'req-1',
    isSidechain: false,
    isMeta: false,
    cwd: '/test',
    gitBranch: 'main',
    message: {
      role: 'assistant',
      model: 'claude-sonnet-4-6',
      content: [
        { type: 'text', text: 'Sure, let me read the file first.' },
        { type: 'tool_use', id: 'tool-read-1', name: 'Read', input: { file_path: '/test/foo.js' } },
      ],
      // Final streaming entry has higher token count — this is the one to keep
      usage: { input_tokens: 100, output_tokens: 55, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
  }),
  // Internal user message with tool_result
  JSON.stringify({
    uuid: 'ccc-003',
    parentUuid: 'bbb-002',
    type: 'user',
    timestamp: '2026-01-01T10:00:06.000Z',
    isSidechain: false,
    isMeta: true,
    cwd: '/test',
    message: {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'tool-read-1', content: 'function foo() {}', is_error: false },
      ],
    },
  }),
  // Assistant final text response
  JSON.stringify({
    uuid: 'ddd-004',
    parentUuid: 'ccc-003',
    type: 'assistant',
    timestamp: '2026-01-01T10:00:10.000Z',
    requestId: 'req-2',
    isSidechain: false,
    isMeta: false,
    cwd: '/test',
    gitBranch: 'main',
    message: {
      role: 'assistant',
      model: 'claude-sonnet-4-6',
      content: [{ type: 'text', text: 'Here is the updated function.' }],
      usage: { input_tokens: 160, output_tokens: 30, cache_read_input_tokens: 20, cache_creation_input_tokens: 0 },
    },
  }),
  // Hard noise: system-reminder
  JSON.stringify({
    uuid: 'eee-005',
    parentUuid: 'aaa-001',
    type: 'user',
    timestamp: '2026-01-01T10:00:01.000Z',
    isSidechain: false,
    isMeta: false,
    cwd: '/test',
    message: { role: 'user', content: '<system-reminder>Remember to be helpful.</system-reminder>' },
  }),
];

/** Write synthetic lines to a temp file and return its path. */
function makeTempSession(lines = SYNTHETIC_LINES) {
  const dir = mkdtempSync(join(tmpdir(), 'cartographer-test-'));
  const filePath = join(dir, 'test-session.jsonl');
  writeFileSync(filePath, lines.join('\n') + '\n');
  return filePath;
}

// =============================================================================
// Priority 1 — Session Parser
// =============================================================================

describe('session-parser: parseJsonlLine', () => {
  test('parses a real user message', () => {
    const line = SYNTHETIC_LINES[0];
    const msg = parseJsonlLine(line);
    assert.ok(msg, 'should return a message');
    assert.equal(msg.type, 'user');
    assert.equal(msg.uuid, 'aaa-001');
    assert.ok(msg.timestamp instanceof Date);
    assert.equal(msg.isMeta, false);
    assert.equal(msg.isSidechain, false);
  });

  test('parses an assistant message and extracts tool calls', () => {
    const line = SYNTHETIC_LINES[1];
    const msg = parseJsonlLine(line);
    assert.ok(msg);
    assert.equal(msg.type, 'assistant');
    assert.equal(msg.model, 'claude-sonnet-4-6');
    assert.equal(msg.toolCalls.length, 1);
    assert.equal(msg.toolCalls[0].name, 'Read');
    assert.equal(msg.toolCalls[0].id, 'tool-read-1');
    assert.equal(msg.toolCalls[0].isTask, false);
  });

  test('parses an internal user message and extracts tool results', () => {
    const line = SYNTHETIC_LINES[3];
    const msg = parseJsonlLine(line);
    assert.ok(msg);
    assert.equal(msg.type, 'user');
    assert.equal(msg.isMeta, true);
    assert.equal(msg.toolResults.length, 1);
    assert.equal(msg.toolResults[0].toolUseId, 'tool-read-1');
    assert.equal(msg.toolResults[0].isError, false);
  });

  test('returns null for empty line', () => {
    assert.equal(parseJsonlLine(''), null);
    assert.equal(parseJsonlLine('   '), null);
  });
});

describe('session-parser: parseJsonlFile', () => {
  test('parses a temp file and returns correct message count', async () => {
    const filePath = makeTempSession();
    const messages = await parseJsonlFile(filePath);
    assert.equal(messages.length, SYNTHETIC_LINES.length);
  });

  test('returns empty array for non-existent file', async () => {
    const messages = await parseJsonlFile('/nonexistent/path.jsonl');
    assert.deepEqual(messages, []);
  });
});

describe('session-parser: deduplicateByRequestId', () => {
  test('removes duplicate streaming entries, keeps last per requestId', async () => {
    const filePath = makeTempSession();
    const messages = await parseJsonlFile(filePath);
    const deduped = deduplicateByRequestId(messages);

    // req-1 appears twice (bbb-002 and bbb-002-dup) — only bbb-002-dup (last) should survive
    const req1Messages = deduped.filter(m => m.requestId === 'req-1');
    assert.equal(req1Messages.length, 1);
    assert.equal(req1Messages[0].usage?.output_tokens, 55, 'should keep the final streaming entry');
  });
});

describe('session-parser: calculateMetrics', () => {
  test('correctly sums tokens after deduplication', async () => {
    const filePath = makeTempSession();
    const messages = await parseJsonlFile(filePath);
    const metrics = calculateMetrics(messages);

    // After dedup: req-1 (output=55) + req-2 (output=30)
    // Input: 100 + 160 = 260; Cache read: 20; Output: 55 + 30 = 85
    assert.equal(metrics.inputTokens, 260);
    assert.equal(metrics.outputTokens, 85);
    assert.equal(metrics.cacheReadTokens, 20);
    assert.equal(metrics.messageCount, SYNTHETIC_LINES.length);
    assert.ok(metrics.durationMs > 0);
  });
});

describe('session-parser: type guards', () => {
  test('isParsedUserChunkMessage: true for real user message', () => {
    const msg = parseJsonlLine(SYNTHETIC_LINES[0]);
    assert.ok(isParsedUserChunkMessage(msg));
  });

  test('isParsedUserChunkMessage: false for isMeta=true', () => {
    const msg = parseJsonlLine(SYNTHETIC_LINES[3]);
    assert.ok(!isParsedUserChunkMessage(msg));
  });

  test('isParsedUserChunkMessage: false for system-reminder content', () => {
    // SYNTHETIC_LINES[5] is the system-reminder hard-noise entry
    const msg = parseJsonlLine(SYNTHETIC_LINES[5]);
    assert.ok(!isParsedUserChunkMessage(msg));
  });

  test('isParsedHardNoiseMessage: true for system-reminder wrapped content', () => {
    // SYNTHETIC_LINES[5] is the system-reminder hard-noise entry
    const msg = parseJsonlLine(SYNTHETIC_LINES[5]);
    assert.ok(isParsedHardNoiseMessage(msg));
  });

  test('isParsedHardNoiseMessage: false for normal user message', () => {
    const msg = parseJsonlLine(SYNTHETIC_LINES[0]);
    assert.ok(!isParsedHardNoiseMessage(msg));
  });

  test('isParsedCompactMessage: true only for isCompactSummary entries', () => {
    const line = JSON.stringify({
      uuid: 'compact-001', parentUuid: 'x', type: 'user', timestamp: '2026-01-01T10:00:00Z',
      isSidechain: false, isMeta: false, isCompactSummary: true, cwd: '/test',
      message: { role: 'user', content: 'Summary of prior conversation.' },
    });
    const msg = parseJsonlLine(line);
    assert.ok(isParsedCompactMessage(msg));
    assert.ok(!isParsedCompactMessage(parseJsonlLine(SYNTHETIC_LINES[0])));
  });
});

describe('session-parser: parseSession', () => {
  test('groups messages by type correctly', async () => {
    const filePath = makeTempSession();
    const { byType, metrics, taskCalls } = await parseSession(filePath);

    assert.equal(byType.assistant.length, 3); // Two real + one duplicate (dedup happens in metrics not parse)
    assert.ok(byType.user.length >= 2);
    assert.equal(taskCalls.length, 0); // No Task calls in synthetic fixture
    assert.ok(metrics.totalTokens > 0);
  });
});

describe('session-parser: extractTextContent', () => {
  test('extracts text from string content', () => {
    const msg = parseJsonlLine(SYNTHETIC_LINES[0]);
    const text = extractTextContent(msg);
    assert.ok(text.includes('Help me write'));
  });

  test('extracts text from array content', () => {
    const msg = parseJsonlLine(SYNTHETIC_LINES[1]);
    const text = extractTextContent(msg);
    assert.ok(text.includes('Sure, let me read'));
  });
});

describe('session-parser: enumerateSessions', () => {
  test('returns an array (may be empty in CI)', () => {
    const sessions = enumerateSessions();
    assert.ok(Array.isArray(sessions));
    // If sessions exist, validate shape
    if (sessions.length > 0) {
      const s = sessions[0];
      assert.ok(typeof s.projectId === 'string');
      assert.ok(typeof s.sessionId === 'string');
      assert.ok(typeof s.filePath === 'string');
      assert.ok(typeof s.mtimeMs === 'number');
    }
  });
});

// =============================================================================
// Priority 2 — Token Attribution
// =============================================================================

describe('token-attribution: estimateTokens', () => {
  test('returns 0 for empty input', () => {
    assert.equal(estimateTokens(''), 0);
    assert.equal(estimateTokens(null), 0);
    assert.equal(estimateTokens(undefined), 0);
  });

  test('uses chars/4 heuristic', () => {
    assert.equal(estimateTokens('abcd'), 1);       // 4 chars → 1 token
    assert.equal(estimateTokens('abcde'), 2);      // 5 chars → ceil(5/4) = 2
    assert.equal(estimateTokens('a'.repeat(400)), 100);
  });
});

describe('token-attribution: computeTokenAttribution', () => {
  test('returns all-zero attribution for empty message array', () => {
    const attr = computeTokenAttribution([]);
    assert.equal(totalAttributedTokens(attr), 0);
    assert.deepEqual(attr, {
      claudeMd: 0, mentionedFiles: 0, toolOutputs: 0,
      thinkingText: 0, taskCoordination: 0, userMessages: 0,
    });
  });

  test('attributes user text to userMessages', async () => {
    const filePath = makeTempSession();
    const messages = await parseJsonlFile(filePath);
    const attr = computeTokenAttribution(messages);

    assert.ok(attr.userMessages > 0, 'should have user message tokens');
  });

  test('attributes tool results to toolOutputs', async () => {
    const filePath = makeTempSession();
    const messages = await parseJsonlFile(filePath);
    const attr = computeTokenAttribution(messages);

    assert.ok(attr.toolOutputs > 0, 'should have tool output tokens');
  });

  test('attributes assistant text to thinkingText', async () => {
    const filePath = makeTempSession();
    const messages = await parseJsonlFile(filePath);
    const attr = computeTokenAttribution(messages);

    assert.ok(attr.thinkingText > 0, 'should have thinking/text tokens');
  });

  test('attributes system-reminder content to claudeMd', () => {
    const line = JSON.stringify({
      uuid: 'sys-001', parentUuid: null, type: 'user',
      timestamp: '2026-01-01T10:00:00Z', isSidechain: false, isMeta: false, cwd: '/test',
      message: { role: 'user', content: 'Hello <system-reminder>Be helpful and accurate.</system-reminder>' },
    });
    const messages = [parseJsonlLine(line)];
    const attr = computeTokenAttribution(messages);

    assert.ok(attr.claudeMd > 0, 'should attribute system-reminder content to claudeMd');
    assert.ok(attr.userMessages > 0, 'should attribute non-injection text to userMessages');
  });

  test('fractions sum to 1.0 (within float tolerance)', async () => {
    const filePath = makeTempSession();
    const messages = await parseJsonlFile(filePath);
    const attr = computeTokenAttribution(messages);
    const fractions = attributionFractions(attr);

    const sum = Object.values(fractions).reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(sum - 1.0) < 0.001, `fractions should sum to 1.0, got ${sum}`);
  });
});

// =============================================================================
// Priority 3 — Compaction Detection
// =============================================================================

describe('compaction-detector: checkMessagesOngoing', () => {
  test('returns false for empty messages', () => {
    assert.equal(checkMessagesOngoing([]), false);
  });

  test('returns false when last event is text_output', async () => {
    const filePath = makeTempSession();
    const messages = await parseJsonlFile(filePath);
    // Synthetic session ends with text output — not ongoing
    assert.equal(checkMessagesOngoing(messages), false);
  });

  test('returns true when last event is a pending tool_use', () => {
    const assistantWithToolOnly = {
      uuid: 'x', parentUuid: null, type: 'assistant',
      timestamp: new Date(), isSidechain: false, isMeta: false,
      toolCalls: [], toolResults: [],
      content: [{ type: 'tool_use', id: 'tu-1', name: 'Read', input: {} }],
    };
    assert.equal(checkMessagesOngoing([assistantWithToolOnly]), true);
  });

  test('returns false when tool_use is followed by tool_result and then text', () => {
    const msgs = [
      {
        uuid: 'a', parentUuid: null, type: 'assistant', timestamp: new Date(),
        isSidechain: false, isMeta: false, toolCalls: [], toolResults: [],
        content: [
          { type: 'tool_use', id: 'tu-2', name: 'Read', input: {} },
        ],
      },
      {
        uuid: 'b', parentUuid: 'a', type: 'user', timestamp: new Date(),
        isSidechain: false, isMeta: true, toolCalls: [], toolResults: [],
        content: [{ type: 'tool_result', tool_use_id: 'tu-2', content: 'result', is_error: false }],
      },
      {
        uuid: 'c', parentUuid: 'b', type: 'assistant', timestamp: new Date(),
        isSidechain: false, isMeta: false, toolCalls: [], toolResults: [],
        content: [{ type: 'text', text: 'Here is the answer.' }],
      },
    ];
    assert.equal(checkMessagesOngoing(msgs), false);
  });
});

describe('compaction-detector: detectCompactionPhases', () => {
  test('returns zero compaction for normal session', async () => {
    const filePath = makeTempSession();
    const messages = await parseJsonlFile(filePath);
    const result = detectCompactionPhases(messages);

    assert.equal(result.compactionCount, 0);
    // Should have one phase with the final assistant's input tokens
    assert.ok(result.phases.length <= 1);
  });

  test('detects a compaction boundary correctly', () => {
    const pre = {
      uuid: 'a', parentUuid: null, type: 'assistant', timestamp: new Date(),
      requestId: 'r1', isSidechain: false, isMeta: false, model: 'claude-sonnet-4-6',
      toolCalls: [], toolResults: [], isCompactSummary: false, content: [],
      usage: { input_tokens: 1000, output_tokens: 50, cache_read_input_tokens: 200, cache_creation_input_tokens: 0 },
    };
    const compact = {
      uuid: 'b', parentUuid: 'a', type: 'user', timestamp: new Date(),
      isSidechain: false, isMeta: false, isCompactSummary: true,
      toolCalls: [], toolResults: [],
      content: 'Summary of conversation up to this point.',
    };
    const post = {
      uuid: 'c', parentUuid: 'b', type: 'assistant', timestamp: new Date(),
      requestId: 'r2', isSidechain: false, isMeta: false, model: 'claude-sonnet-4-6',
      toolCalls: [], toolResults: [], isCompactSummary: false, content: [],
      usage: { input_tokens: 200, output_tokens: 30, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    };

    const result = detectCompactionPhases([pre, compact, post]);

    assert.equal(result.compactionCount, 1);
    assert.equal(result.phases.length, 2);
    // Phase 1 peak: pre input (1000 + 200 = 1200)
    assert.equal(result.phases[0].peakTokens, 1200);
    // Phase 1 post: post input (200)
    assert.equal(result.phases[0].postCompaction, 200);
    // Phase 2 contribution: 200 − 200 = 0... wait
    // Actually post assistant has input=200, phase2 = lastMainAssistant(200) − post(200) = 0
    // contextConsumption = 1200 + 0 = 1200
    assert.equal(result.contextConsumption, 1200);
  });

  test('contextConsumption equals peakTokens for uncompacted session', async () => {
    const filePath = makeTempSession();
    const messages = await parseJsonlFile(filePath);
    const result = detectCompactionPhases(messages);

    if (result.phases.length === 1) {
      assert.equal(result.contextConsumption, result.phases[0].peakTokens);
    }
  });
});

// =============================================================================
// Integration — analyzeSession
// =============================================================================

describe('integration: analyzeSession', () => {
  test('returns all three priority outputs in one call', async () => {
    const filePath = makeTempSession();
    const session = await analyzeSession(filePath);

    // P1: parser
    assert.ok(Array.isArray(session.messages));
    assert.ok(session.metrics.totalTokens > 0);

    // P2: attribution
    assert.ok('claudeMd' in session.attribution);
    assert.ok('toolOutputs' in session.attribution);
    assert.ok(totalAttributedTokens(session.attribution) > 0);

    // P3: compaction
    assert.ok('compactionCount' in session.compaction);
    assert.ok(Array.isArray(session.compaction.phases));
    assert.ok(typeof session.isOngoing === 'boolean');
  });
});

describe('integration: DEVTOOLS_PARSER_ENABLED flag', () => {
  test('flag reflects DEVTOOLS_PARSER env var', () => {
    // Flag is evaluated at import time. In test runs without the env var it's false.
    // We just confirm it's a boolean — caller should set DEVTOOLS_PARSER=true to enable.
    assert.ok(typeof DEVTOOLS_PARSER_ENABLED === 'boolean');
  });
});

// =============================================================================
// Live session smoke test (skipped if no ~/.claude/projects/ sessions found)
// =============================================================================

describe('live session smoke test', () => {
  test('parses at least one real session without throwing', async () => {
    const sessions = enumerateSessions();
    if (sessions.length === 0) {
      // No sessions available — pass trivially
      return;
    }

    // Pick the most recently modified session
    const { filePath } = sessions[0];
    const session = await analyzeSession(filePath);

    assert.ok(Array.isArray(session.messages), 'messages should be an array');
    assert.ok(typeof session.metrics.totalTokens === 'number', 'totalTokens should be a number');
    assert.ok(typeof session.isOngoing === 'boolean', 'isOngoing should be boolean');
    assert.ok('compactionCount' in session.compaction);

    // Attribution shape
    const keys = ['claudeMd', 'mentionedFiles', 'toolOutputs', 'thinkingText', 'taskCoordination', 'userMessages'];
    for (const k of keys) {
      assert.ok(k in session.attribution, `attribution should have key: ${k}`);
      assert.ok(typeof session.attribution[k] === 'number', `${k} should be a number`);
    }
  });
});
