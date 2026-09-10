/**
 * devtools-adapted/index.js
 *
 * Barrel export for the three claude-devtools adapted modules.
 * Guarded by the DEVTOOLS_PARSER feature flag.
 *
 * Feature flag
 * ------------
 *   DEVTOOLS_PARSER=true node your-script.js
 *
 * When the flag is absent the module still exports everything — the flag is
 * checked by callers that want to conditionally activate the richer parsing
 * path (e.g. reconstruct-history.js) without breaking the default pipeline.
 *
 * Portions adapted from claude-devtools by matt1398 (MIT License)
 * https://github.com/matt1398/claude-devtools
 */

// =============================================================================
// Feature flag
// =============================================================================

/**
 * Whether the devtools-adapted parser is enabled.
 * Set DEVTOOLS_PARSER=true (any truthy string) to activate.
 *
 * @type {boolean}
 */
export const DEVTOOLS_PARSER_ENABLED =
  process.env.DEVTOOLS_PARSER === 'true' || process.env.DEVTOOLS_PARSER === '1';

// =============================================================================
// Priority 1 — Session parser
// =============================================================================

export {
  // File-level parsing
  parseJsonlFile,
  parseJsonlLine,
  // Tool extraction
  extractToolCalls,
  extractToolResults,
  // Deduplication + metrics
  deduplicateByRequestId,
  calculateMetrics,
  // Type guards
  isParsedUserChunkMessage,
  isParsedHardNoiseMessage,
  isParsedCompactMessage,
  // Session enumeration + high-level parse
  enumerateSessions,
  parseSession,
  extractTextContent,
} from './session-parser.js';

// =============================================================================
// Priority 2 — Token attribution
// =============================================================================

export {
  estimateTokens,
  estimateContentTokens,
  computeTokenAttribution,
  totalAttributedTokens,
  attributionFractions,
} from './token-attribution.js';

// =============================================================================
// Priority 3 — Compaction detection
// =============================================================================

export {
  checkMessagesOngoing,
  detectCompactionPhases,
} from './compaction-detector.js';

// =============================================================================
// Convenience: full session analysis in one call
// =============================================================================

import { parseSession } from './session-parser.js';
import { computeTokenAttribution } from './token-attribution.js';
import { checkMessagesOngoing, detectCompactionPhases } from './compaction-detector.js';

/**
 * Parse a session file and return a fully-enriched analysis object.
 * Combines all three priorities into a single async call.
 *
 * @param {string} filePath - Absolute path to a .jsonl session file
 * @returns {Promise<EnrichedSession>}
 *
 * @example
 * const session = await analyzeSession('/path/to/session.jsonl');
 * console.log(session.metrics.totalTokens);
 * console.log(session.attribution.toolOutputs);
 * console.log(session.compaction.compactionCount);
 * console.log(session.isOngoing);
 */
export async function analyzeSession(filePath) {
  const parsed = await parseSession(filePath);
  const { messages, metrics, taskCalls, byType, sidechainMessages, mainMessages } = parsed;

  const attribution = computeTokenAttribution(messages);
  const compaction = detectCompactionPhases(messages);
  const isOngoing = checkMessagesOngoing(messages);

  return {
    filePath,
    messages,
    metrics,
    taskCalls,
    byType,
    sidechainMessages,
    mainMessages,
    attribution,
    compaction,
    isOngoing,
  };
}

/**
 * @typedef {object} EnrichedSession
 * @property {string}   filePath
 * @property {import('./session-parser.js').ParsedMessage[]} messages
 * @property {object}   metrics         - Token and timing metrics (calculateMetrics output)
 * @property {object[]} taskCalls       - All Task/subagent tool calls
 * @property {object}   byType          - Messages grouped by type
 * @property {object[]} sidechainMessages
 * @property {object[]} mainMessages
 * @property {import('./token-attribution.js').TokenAttribution} attribution
 * @property {import('./compaction-detector.js').CompactionResult} compaction
 * @property {boolean}  isOngoing
 */
