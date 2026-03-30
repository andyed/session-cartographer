/**
 * compaction-detector.js
 *
 * Portions adapted from claude-devtools by matt1398 (MIT License)
 * https://github.com/matt1398/claude-devtools
 *
 * Original files: src/main/utils/sessionStateDetection.ts,
 *                 src/main/utils/jsonl.ts (analyzeSessionFileMetadata compaction section)
 *
 * Adapted to plain ESM JS for session-cartographer. Removed: Electron/IPC coupling,
 * file-watcher integration. Kept: activity-based ongoing detection, compaction phase
 * tracking with pre/post token deltas.
 *
 * Compaction events are information-loss markers: when Claude Code hits its context
 * limit it compresses prior conversation into a summary and refills. Each compaction
 * cycle = a phase. Tracking them enables:
 *   - decay curve modeling (NEXO-style memory consolidation)
 *   - session complexity scoring (more phases = longer/heavier session)
 *   - energy visualization in session-cartographer bridge
 *
 * Usage
 * -----
 *   import { checkMessagesOngoing, detectCompactionPhases } from './compaction-detector.js';
 *
 *   const ongoing = checkMessagesOngoing(messages);
 *   const { compactionCount, phases, contextConsumption } = detectCompactionPhases(messages);
 */

// =============================================================================
// Ongoing Session Detection (from sessionStateDetection.ts)
// =============================================================================

/**
 * Activity types used internally for ongoing-state computation.
 *
 * Ending events: text_output, interruption, exit_plan_mode
 *   — signal Claude has finished responding
 * Ongoing events: thinking, tool_use, tool_result
 *   — signal Claude is mid-response
 *
 * A session is "ongoing" if there are ongoing events AFTER the last ending event.
 */

/** @param {{ name?: string, input?: Record<string, unknown> }} block */
function isShutdownResponse(block) {
  return (
    block.name === 'SendMessage' &&
    block.input?.type === 'shutdown_response' &&
    block.input?.approve === true
  );
}

/** @param {unknown} toolUseResult */
function isToolUseRejection(toolUseResult) {
  return toolUseResult === 'User rejected tool use';
}

/**
 * @param {{ type: string, index: number }[]} activities
 * @returns {boolean}
 */
function isOngoingFromActivities(activities) {
  if (activities.length === 0) return false;

  // Find the last ending event (text output, interruption, or exit_plan_mode)
  let lastEndingIndex = -1;
  for (let i = activities.length - 1; i >= 0; i--) {
    const t = activities[i].type;
    if (t === 'text_output' || t === 'interruption' || t === 'exit_plan_mode') {
      lastEndingIndex = activities[i].index;
      break;
    }
  }

  if (lastEndingIndex === -1) {
    // No ending event — ongoing if any AI activity exists at all
    return activities.some(a => a.type === 'thinking' || a.type === 'tool_use' || a.type === 'tool_result');
  }

  // Ongoing if any AI activity follows the last ending event
  return activities.some(
    a =>
      a.index > lastEndingIndex &&
      (a.type === 'thinking' || a.type === 'tool_use' || a.type === 'tool_result')
  );
}

/**
 * Check whether a session's messages indicate an in-progress AI response.
 *
 * A session is "ongoing" when AI activities (thinking, tool_use, tool_result)
 * appear after the last natural stopping point (text output or user interruption).
 * ExitPlanMode is treated as a stopping point — it marks the end of plan mode.
 *
 * This is the same logic claude-devtools uses for the "ongoing" badge.
 *
 * @param {import('./session-parser.js').ParsedMessage[]} messages
 * @returns {boolean}
 */
export function checkMessagesOngoing(messages) {
  const activities = [];
  let idx = 0;
  const shutdownToolIds = new Set();

  for (const msg of messages) {
    if (msg.type === 'assistant' && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === 'thinking' && block.thinking) {
          activities.push({ type: 'thinking', index: idx++ });
        } else if (block.type === 'tool_use' && block.id) {
          if (block.name === 'ExitPlanMode') {
            activities.push({ type: 'exit_plan_mode', index: idx++ });
          } else if (isShutdownResponse(block)) {
            shutdownToolIds.add(block.id);
            activities.push({ type: 'interruption', index: idx++ });
          } else {
            activities.push({ type: 'tool_use', index: idx++ });
          }
        } else if (block.type === 'text' && block.text && String(block.text).trim().length > 0) {
          activities.push({ type: 'text_output', index: idx++ });
        }
      }
    } else if (msg.type === 'user' && Array.isArray(msg.content)) {
      const isRejection = isToolUseRejection(msg.toolUseResult);

      for (const block of msg.content) {
        if (block.type === 'tool_result' && block.tool_use_id) {
          if (shutdownToolIds.has(block.tool_use_id) || isRejection) {
            activities.push({ type: 'interruption', index: idx++ });
          } else {
            activities.push({ type: 'tool_result', index: idx++ });
          }
        } else if (
          block.type === 'text' &&
          typeof block.text === 'string' &&
          block.text.startsWith('[Request interrupted by user')
        ) {
          activities.push({ type: 'interruption', index: idx++ });
        }
      }
    }
  }

  return isOngoingFromActivities(activities);
}

// =============================================================================
// Compaction Phase Detection (from jsonl.ts analyzeSessionFileMetadata)
// =============================================================================

/**
 * Detect compaction events and compute per-phase token contributions.
 *
 * Claude Code marks compaction boundaries with `isCompactSummary: true` on the
 * user entry that carries the summary. The assistant entry immediately before the
 * compaction records the peak context size (pre-compaction input tokens). The
 * assistant entry immediately after records the refilled size (post-compaction).
 *
 * Phase contribution model:
 *   Phase 1  : pre-compaction tokens of first compaction boundary
 *   Phase N  : pre[N] − post[N-1]  (tokens added after the last refill)
 *   Last phase: final input tokens − last post-compaction tokens
 *
 * contextConsumption is the sum of all phase contributions — a compaction-aware
 * measure of total context work done by the session, more meaningful than the
 * raw final input_tokens count.
 *
 * @param {import('./session-parser.js').ParsedMessage[]} messages
 * @returns {CompactionResult}
 */
export function detectCompactionPhases(messages) {
  let lastMainAssistantInputTokens = 0;
  const compactionPhases = []; // Array of { pre: number, post: number }
  let awaitingPostCompaction = false;

  for (const msg of messages) {
    if (msg.isSidechain) continue; // Main thread only

    // Track input tokens from main-thread assistant messages
    if (msg.type === 'assistant' && msg.model !== '<synthetic>') {
      const inputTokens =
        (msg.usage?.input_tokens ?? 0) +
        (msg.usage?.cache_read_input_tokens ?? 0) +
        (msg.usage?.cache_creation_input_tokens ?? 0);

      if (inputTokens > 0) {
        if (awaitingPostCompaction && compactionPhases.length > 0) {
          // This is the first real assistant message after a compaction — record post size
          compactionPhases[compactionPhases.length - 1].post = inputTokens;
          awaitingPostCompaction = false;
        }
        lastMainAssistantInputTokens = inputTokens;
      }
    }

    // Compaction boundary: isCompactSummary marks the summary user entry
    if (msg.isCompactSummary) {
      compactionPhases.push({ pre: lastMainAssistantInputTokens, post: 0 });
      awaitingPostCompaction = true;
    }
  }

  // ─── Compute contextConsumption and phaseBreakdown ───────────────────────

  if (lastMainAssistantInputTokens === 0) {
    // No assistant messages with usage — nothing to report
    return { compactionCount: 0, phases: [], contextConsumption: 0 };
  }

  if (compactionPhases.length === 0) {
    // Single uncompacted phase
    return {
      compactionCount: 0,
      phases: [{ phaseNumber: 1, contribution: lastMainAssistantInputTokens, peakTokens: lastMainAssistantInputTokens }],
      contextConsumption: lastMainAssistantInputTokens,
    };
  }

  const phases = [];
  let total = 0;

  // Phase 1: tokens up to the first compaction
  const p1Contribution = compactionPhases[0].pre;
  total += p1Contribution;
  phases.push({
    phaseNumber: 1,
    contribution: p1Contribution,
    peakTokens: compactionPhases[0].pre,
    postCompaction: compactionPhases[0].post || undefined,
  });

  // Middle phases: contribution = pre[i] − post[i-1]
  for (let i = 1; i < compactionPhases.length; i++) {
    const contribution = compactionPhases[i].pre - compactionPhases[i - 1].post;
    total += contribution;
    phases.push({
      phaseNumber: i + 1,
      contribution,
      peakTokens: compactionPhases[i].pre,
      postCompaction: compactionPhases[i].post || undefined,
    });
  }

  // Last (current) phase: final tokens − last post-compaction
  // Guard: if the last compaction had no following assistant message, post is 0 — skip to
  // avoid double-counting the pre-compaction tokens.
  const lastPhase = compactionPhases[compactionPhases.length - 1];
  if (lastPhase.post > 0) {
    const lastContribution = lastMainAssistantInputTokens - lastPhase.post;
    total += lastContribution;
    phases.push({
      phaseNumber: compactionPhases.length + 1,
      contribution: lastContribution,
      peakTokens: lastMainAssistantInputTokens,
    });
  }

  return {
    compactionCount: compactionPhases.length,
    phases,
    contextConsumption: total,
  };
}

/**
 * @typedef {object} PhaseBreakdown
 * @property {number}  phaseNumber     - 1-based phase index
 * @property {number}  contribution    - Tokens added during this phase
 * @property {number}  peakTokens      - Context window at phase peak (pre-compaction or final)
 * @property {number}  [postCompaction]- Context window immediately after compaction (undefined for last phase)
 */

/**
 * @typedef {object} CompactionResult
 * @property {number}          compactionCount   - Number of compaction events detected
 * @property {PhaseBreakdown[]} phases           - Per-phase token breakdown
 * @property {number}          contextConsumption - Total context work done (compaction-aware sum)
 */
