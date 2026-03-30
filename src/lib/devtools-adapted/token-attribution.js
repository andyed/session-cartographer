/**
 * token-attribution.js
 *
 * Portions adapted from claude-devtools by matt1398 (MIT License)
 * https://github.com/matt1398/claude-devtools
 *
 * Original files: src/renderer/types/contextInjection.ts,
 *                 src/renderer/utils/contextTracker.ts,
 *                 src/main/utils/tokenizer.ts
 *
 * Adapted to plain ESM JS for session-cartographer. Removed: React/Redux coupling,
 * UI navigation IDs, file-existence IPC calls, task coordination detail tracking.
 * Kept: the 6-category token breakdown per session useful for activation scoring.
 *
 * Categories
 * ----------
 * claudeMd        — CLAUDE.md / system-reminder injections in user messages
 * mentionedFiles  — @-mention file references in user messages (estimated from path extraction)
 * toolOutputs     — tool_result content fed back into context
 * thinkingText    — extended thinking blocks + assistant text output tokens
 * taskCoordination— Task/SendMessage/TeamCreate subagent coordination overhead
 * userMessages    — genuine user prompt tokens
 *
 * Usage
 * -----
 *   import { computeTokenAttribution } from './token-attribution.js';
 *   const attr = computeTokenAttribution(messages);
 *   // { claudeMd: 0, mentionedFiles: 120, toolOutputs: 4300, thinkingText: 890, taskCoordination: 0, userMessages: 210 }
 */

// =============================================================================
// Token estimation (from tokenizer.ts)
// =============================================================================

/**
 * Estimate token count from a string using the chars/4 heuristic.
 * Matches claude-devtools' approach — not exact but fast and consistent.
 *
 * @param {string|null|undefined} text
 * @returns {number}
 */
export function estimateTokens(text) {
  if (!text || text.length === 0) return 0;
  return Math.ceil(text.length / 4);
}

/**
 * Estimate tokens from content that may be a string, array, or object.
 *
 * @param {string|Array|object|null|undefined} content
 * @returns {number}
 */
export function estimateContentTokens(content) {
  if (!content) return 0;
  if (typeof content === 'string') return estimateTokens(content);
  return estimateTokens(JSON.stringify(content));
}

// =============================================================================
// Constants (from contextTracker.ts)
// =============================================================================

/** Tool names treated as task coordination overhead rather than generic tool outputs. */
const TASK_COORDINATION_TOOL_NAMES = new Set([
  'Task',
  'SendMessage',
  'TeamCreate',
  'TeamDelete',
  'TaskCreate',
  'TaskUpdate',
  'TaskList',
  'TaskGet',
]);

/** XML tags Claude Code injects as system context (CLAUDE.md, memory, reminders). */
const SYSTEM_INJECTION_TAGS = [
  '<system-reminder>',
  '<claude-md>',
  '<memory>',
];

/**
 * Regex to find @-mentioned file paths in user message text.
 * Matches patterns like @/path/to/file.js or @filename.ts
 */
const MENTION_PATH_REGEX = /@([\w./~-]+\.\w+)/g;

// =============================================================================
// Per-message attribution helpers
// =============================================================================

/**
 * Estimate tokens consumed by CLAUDE.md / system-reminder injections
 * present in a user message's string content.
 *
 * Claude Code injects these as XML-tagged blocks inside user entries.
 * We extract the content between the tags and count their characters.
 *
 * @param {string} text
 * @returns {number}
 */
function extractSystemInjectionTokens(text) {
  let total = 0;
  for (const openTag of SYSTEM_INJECTION_TAGS) {
    const closeTag = openTag.replace('<', '</');
    let searchFrom = 0;
    while (true) {
      const start = text.indexOf(openTag, searchFrom);
      if (start === -1) break;
      const end = text.indexOf(closeTag, start);
      if (end === -1) break;
      const inner = text.slice(start + openTag.length, end);
      total += estimateTokens(inner);
      searchFrom = end + closeTag.length;
    }
  }
  return total;
}

/**
 * Extract @-mention paths from a user message and estimate their token cost.
 * We can't stat the files here, so we estimate 500 tokens per mention as a
 * conservative floor (real file content is injected separately by Claude Code).
 *
 * @param {string} text
 * @returns {number}
 */
function extractMentionedFileTokens(text) {
  const matches = [...text.matchAll(MENTION_PATH_REGEX)];
  // 500-token floor per unique mention — real cost depends on file size which
  // we don't have without fs access in this pure function.
  return new Set(matches.map(m => m[1])).size * 500;
}

// =============================================================================
// Core attribution function
// =============================================================================

/**
 * Compute a 6-category token attribution breakdown for a parsed session.
 *
 * This operates on the full message array and walks through each message
 * categorizing its token contribution. All values are estimates — the
 * char/4 heuristic matches what claude-devtools uses for consistency.
 *
 * The result is intended as session-level metadata for the cartographer index,
 * not for per-turn UI display (that's claude-devtools' job).
 *
 * @param {import('./session-parser.js').ParsedMessage[]} messages
 * @returns {TokenAttribution}
 */
export function computeTokenAttribution(messages) {
  const result = {
    claudeMd: 0,
    mentionedFiles: 0,
    toolOutputs: 0,
    thinkingText: 0,
    taskCoordination: 0,
    userMessages: 0,
  };

  for (const msg of messages) {
    if (msg.isSidechain) continue; // Main thread only

    if (msg.type === 'assistant') {
      _attributeAssistantMessage(msg, result);
    } else if (msg.type === 'user') {
      _attributeUserMessage(msg, result);
    }
  }

  return result;
}

/**
 * @param {object} msg
 * @param {TokenAttribution} result
 */
function _attributeAssistantMessage(msg, result) {
  if (!Array.isArray(msg.content)) return;

  for (const block of msg.content) {
    if (block.type === 'thinking' && block.thinking) {
      // Extended thinking block
      result.thinkingText += estimateTokens(block.thinking);
    } else if (block.type === 'text' && block.text) {
      // Regular assistant text output
      result.thinkingText += estimateTokens(block.text);
    } else if (block.type === 'tool_use') {
      // Tool calls: separate task coordination from generic tools
      if (TASK_COORDINATION_TOOL_NAMES.has(block.name)) {
        result.taskCoordination += estimateContentTokens(block.input);
      }
      // Generic tool input tokens are small and already counted in API input_tokens;
      // we don't double-count them here.
    }
  }
}

/**
 * @param {object} msg
 * @param {TokenAttribution} result
 */
function _attributeUserMessage(msg, result) {
  const content = msg.content;

  if (msg.isMeta) {
    // Internal user messages: tool results being fed back into context
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === 'tool_result') {
          const toolContent = block.content ?? '';
          const tokens = estimateContentTokens(toolContent);
          // Check if this was a task coordination result
          // (task tools return structured data; we attribute by size)
          result.toolOutputs += tokens;
        }
      }
    }
    return;
  }

  // Real user message
  if (typeof content === 'string') {
    // Extract system injections (CLAUDE.md blocks embedded by Claude Code)
    const injectionTokens = extractSystemInjectionTokens(content);
    result.claudeMd += injectionTokens;

    // Remaining non-injection text is genuine user input
    const userTokens = estimateTokens(content) - injectionTokens;
    if (userTokens > 0) result.userMessages += userTokens;

    // @-mention file references
    result.mentionedFiles += extractMentionedFileTokens(content);

  } else if (Array.isArray(content)) {
    for (const block of content) {
      if (block.type === 'text') {
        const injectionTokens = extractSystemInjectionTokens(block.text);
        result.claudeMd += injectionTokens;
        const userTokens = estimateTokens(block.text) - injectionTokens;
        if (userTokens > 0) result.userMessages += userTokens;
        result.mentionedFiles += extractMentionedFileTokens(block.text);
      }
      // image blocks: skip (binary, token cost is model-internal)
    }
  }
}

// =============================================================================
// Aggregation helpers
// =============================================================================

/**
 * Sum all category values in an attribution object.
 *
 * @param {TokenAttribution} attribution
 * @returns {number}
 */
export function totalAttributedTokens(attribution) {
  return (
    attribution.claudeMd +
    attribution.mentionedFiles +
    attribution.toolOutputs +
    attribution.thinkingText +
    attribution.taskCoordination +
    attribution.userMessages
  );
}

/**
 * Compute the fraction each category contributes to the total.
 * Returns an object with the same keys, values in [0, 1].
 *
 * @param {TokenAttribution} attribution
 * @returns {Record<string, number>}
 */
export function attributionFractions(attribution) {
  const total = totalAttributedTokens(attribution);
  if (total === 0) {
    return { claudeMd: 0, mentionedFiles: 0, toolOutputs: 0, thinkingText: 0, taskCoordination: 0, userMessages: 0 };
  }
  return Object.fromEntries(
    Object.entries(attribution).map(([k, v]) => [k, v / total])
  );
}

/**
 * @typedef {object} TokenAttribution
 * @property {number} claudeMd         - Tokens from CLAUDE.md / system-reminder injections
 * @property {number} mentionedFiles   - Estimated tokens from @-mentioned files
 * @property {number} toolOutputs      - Tokens from tool results fed back into context
 * @property {number} thinkingText     - Tokens from extended thinking + assistant text
 * @property {number} taskCoordination - Tokens from subagent / task coordination overhead
 * @property {number} userMessages     - Tokens from genuine user prompt text
 */
