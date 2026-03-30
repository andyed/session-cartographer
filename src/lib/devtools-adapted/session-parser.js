/**
 * session-parser.js
 *
 * Portions adapted from claude-devtools by matt1398 (MIT License)
 * https://github.com/matt1398/claude-devtools
 *
 * Original files: src/main/utils/jsonl.ts, src/main/utils/toolExtraction.ts,
 *                 src/main/types/messages.ts, src/main/constants/messageTags.ts,
 *                 src/main/services/parsing/SessionParser.ts
 *
 * Adapted to plain ESM JS for session-cartographer (no TypeScript, no Electron).
 * Removes: FileSystemProvider abstraction, sidechain/subagent wiring, SSH support.
 * Adds: session enumeration across ~/.claude/projects/.
 */

import { createReadStream, existsSync, readdirSync, statSync } from 'fs';
import { join, basename } from 'path';
import { homedir } from 'os';
import { createInterface } from 'readline';

// =============================================================================
// Message Tag Constants (from messageTags.ts)
// =============================================================================

const LOCAL_COMMAND_STDOUT_TAG = '<local-command-stdout>';
const LOCAL_COMMAND_STDERR_TAG = '<local-command-stderr>';
const EMPTY_STDOUT = '<local-command-stdout></local-command-stdout>';
const EMPTY_STDERR = '<local-command-stderr></local-command-stderr>';

const SYSTEM_OUTPUT_TAGS = [
  LOCAL_COMMAND_STDERR_TAG,
  LOCAL_COMMAND_STDOUT_TAG,
  '<local-command-caveat>',
  '<system-reminder>',
];

const HARD_NOISE_TAGS = ['<local-command-caveat>', '<system-reminder>'];

// =============================================================================
// Core JSONL Parsing (from jsonl.ts)
// =============================================================================

/**
 * Parse a JSONL session file line by line using streaming.
 * Returns all parsed messages, skipping malformed/unsupported lines.
 *
 * @param {string} filePath - Absolute path to a .jsonl session file
 * @returns {Promise<ParsedMessage[]>}
 */
export async function parseJsonlFile(filePath) {
  const messages = [];

  if (!existsSync(filePath)) {
    return messages;
  }

  const fileStream = createReadStream(filePath, { encoding: 'utf8' });
  const rl = createInterface({ input: fileStream, crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const parsed = parseJsonlLine(line);
      if (parsed) messages.push(parsed);
    } catch {
      // Malformed line — skip
    }
  }

  return messages;
}

/**
 * Parse a single JSONL line into a ParsedMessage.
 * Returns null for invalid/unsupported lines.
 *
 * @param {string} line
 * @returns {ParsedMessage|null}
 */
export function parseJsonlLine(line) {
  if (!line.trim()) return null;
  const entry = JSON.parse(line);
  return parseChatHistoryEntry(entry);
}

/**
 * @param {object} entry
 * @returns {ParsedMessage|null}
 */
function parseChatHistoryEntry(entry) {
  if (!entry.uuid) return null;

  const type = parseMessageType(entry.type);
  if (!type) return null;

  let content = '';
  let role;
  let usage;
  let model;
  let requestId;
  let cwd;
  let gitBranch;
  let agentId;
  let isSidechain = false;
  let isMeta = false;
  let userType;
  let sourceToolUseID;
  let sourceToolAssistantUUID;
  let toolUseResult;
  let parentUuid = null;
  let isCompactSummary = false;

  const isConversational = entry.type === 'user' || entry.type === 'assistant' || entry.type === 'system';

  if (isConversational) {
    cwd = entry.cwd;
    gitBranch = entry.gitBranch;
    isSidechain = entry.isSidechain ?? false;
    userType = entry.userType;
    parentUuid = entry.parentUuid ?? null;

    if (entry.type === 'user') {
      content = entry.message?.content ?? '';
      role = entry.message?.role;
      agentId = entry.agentId;
      isMeta = entry.isMeta ?? false;
      sourceToolUseID = entry.sourceToolUseID;
      sourceToolAssistantUUID = entry.sourceToolAssistantUUID;
      toolUseResult = entry.toolUseResult;
      isCompactSummary = entry.isCompactSummary === true;
    } else if (entry.type === 'assistant') {
      content = entry.message?.content ?? [];
      role = entry.message?.role;
      usage = entry.message?.usage;
      model = entry.message?.model;
      agentId = entry.agentId;
      requestId = entry.requestId;
    }
    // system entries: no extra fields beyond base
  }

  const toolCalls = extractToolCalls(content);
  const toolResults = extractToolResults(content);

  return {
    uuid: entry.uuid,
    parentUuid,
    type,
    timestamp: entry.timestamp ? new Date(entry.timestamp) : new Date(),
    role,
    content,
    usage,
    model,
    cwd,
    gitBranch,
    agentId,
    isSidechain,
    isMeta,
    userType,
    isCompactSummary,
    toolCalls,
    toolResults,
    sourceToolUseID,
    sourceToolAssistantUUID,
    toolUseResult,
    requestId,
  };
}

/**
 * @param {string|undefined} type
 * @returns {string|null}
 */
function parseMessageType(type) {
  switch (type) {
    case 'user':
    case 'assistant':
    case 'system':
    case 'summary':
    case 'file-history-snapshot':
    case 'queue-operation':
      return type;
    default:
      return null;
  }
}

// =============================================================================
// Tool Extraction (from toolExtraction.ts)
// =============================================================================

/**
 * Extract tool_use blocks from assistant message content.
 *
 * @param {Array|string} content
 * @returns {ToolCall[]}
 */
export function extractToolCalls(content) {
  if (!Array.isArray(content)) return [];

  const toolCalls = [];
  for (const block of content) {
    if (block.type === 'tool_use' && block.id && block.name) {
      const input = block.input ?? {};
      const isTask = block.name === 'Task';
      const toolCall = { id: block.id, name: block.name, input, isTask };
      if (isTask) {
        toolCall.taskDescription = input.description;
        toolCall.taskSubagentType = input.subagent_type;
      }
      toolCalls.push(toolCall);
    }
  }
  return toolCalls;
}

/**
 * Extract tool_result blocks from user message content.
 *
 * @param {Array|string} content
 * @returns {ToolResult[]}
 */
export function extractToolResults(content) {
  if (!Array.isArray(content)) return [];

  const toolResults = [];
  for (const block of content) {
    if (block.type === 'tool_result' && block.tool_use_id) {
      toolResults.push({
        toolUseId: block.tool_use_id,
        content: block.content ?? '',
        isError: block.is_error ?? false,
      });
    }
  }
  return toolResults;
}

// =============================================================================
// Streaming Deduplication (from jsonl.ts)
// =============================================================================

/**
 * Claude Code writes multiple JSONL entries per streaming response, each with
 * the same requestId but incrementally increasing output_tokens. Only the last
 * entry per requestId has final token counts. Deduplicate to avoid overcounting.
 *
 * @param {ParsedMessage[]} messages
 * @returns {ParsedMessage[]}
 */
export function deduplicateByRequestId(messages) {
  const lastIndexByRequestId = new Map();
  for (let i = 0; i < messages.length; i++) {
    const rid = messages[i].requestId;
    if (rid) lastIndexByRequestId.set(rid, i);
  }

  if (lastIndexByRequestId.size === 0) return messages;

  return messages.filter((msg, i) => {
    if (!msg.requestId) return true;
    return lastIndexByRequestId.get(msg.requestId) === i;
  });
}

// =============================================================================
// Metrics Calculation (from jsonl.ts)
// =============================================================================

/**
 * Calculate session-level token and timing metrics from parsed messages.
 * Deduplicates streaming entries before summing to avoid overcounting.
 *
 * @param {ParsedMessage[]} messages
 * @returns {SessionMetrics}
 */
export function calculateMetrics(messages) {
  if (messages.length === 0) {
    return { durationMs: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, messageCount: 0 };
  }

  const deduped = deduplicateByRequestId(messages);

  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;

  const timestamps = messages.map(m => m.timestamp.getTime()).filter(t => isFinite(t));
  let minTime = 0, maxTime = 0;
  if (timestamps.length > 0) {
    minTime = maxTime = timestamps[0];
    for (let i = 1; i < timestamps.length; i++) {
      if (timestamps[i] < minTime) minTime = timestamps[i];
      if (timestamps[i] > maxTime) maxTime = timestamps[i];
    }
  }

  for (const msg of deduped) {
    if (msg.usage) {
      inputTokens += msg.usage.input_tokens ?? 0;
      outputTokens += msg.usage.output_tokens ?? 0;
      cacheReadTokens += msg.usage.cache_read_input_tokens ?? 0;
      cacheCreationTokens += msg.usage.cache_creation_input_tokens ?? 0;
    }
  }

  return {
    durationMs: maxTime - minTime,
    totalTokens: inputTokens + outputTokens + cacheReadTokens + cacheCreationTokens,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    messageCount: messages.length,
  };
}

// =============================================================================
// Message Type Guards (from messages.ts)
// =============================================================================

/** Returns true for genuine user input (not tool results, not system noise). */
export function isParsedUserChunkMessage(msg) {
  if (msg.type !== 'user') return false;
  if (msg.isMeta === true) return false;

  const content = msg.content;

  if (typeof content === 'string') {
    const trimmed = content.trim();
    for (const tag of SYSTEM_OUTPUT_TAGS) {
      if (trimmed.startsWith(tag)) return false;
    }
    return trimmed.length > 0;
  }

  if (Array.isArray(content)) {
    const hasUserContent = content.some(b => b.type === 'text' || b.type === 'image');
    if (!hasUserContent) return false;

    // Interruption messages are not user chunks
    if (
      content.length === 1 &&
      content[0].type === 'text' &&
      typeof content[0].text === 'string' &&
      content[0].text.startsWith('[Request interrupted by user')
    ) {
      return false;
    }

    for (const block of content) {
      if (block.type === 'text') {
        for (const tag of SYSTEM_OUTPUT_TAGS) {
          if (block.text.startsWith(tag)) return false;
        }
      }
    }
    return true;
  }

  return false;
}

/** Returns true for messages that should be filtered entirely from display. */
export function isParsedHardNoiseMessage(msg) {
  if (msg.type === 'system') return true;
  if (msg.type === 'summary') return true;
  if (msg.type === 'file-history-snapshot') return true;
  if (msg.type === 'queue-operation') return true;
  if (msg.type === 'assistant' && msg.model === '<synthetic>') return true;

  if (msg.type === 'user') {
    const content = msg.content;
    if (typeof content === 'string') {
      const trimmed = content.trim();
      for (const tag of HARD_NOISE_TAGS) {
        const closeTag = tag.replace('<', '</');
        if (trimmed.startsWith(tag) && trimmed.endsWith(closeTag)) return true;
      }
      if (trimmed === EMPTY_STDOUT || trimmed === EMPTY_STDERR) return true;
      if (trimmed.startsWith('[Request interrupted by user')) return true;
    }
    if (Array.isArray(content)) {
      if (
        content.length === 1 &&
        content[0].type === 'text' &&
        typeof content[0].text === 'string' &&
        content[0].text.startsWith('[Request interrupted by user')
      ) {
        return true;
      }
    }
  }

  return false;
}

/** Returns true for compact summary boundary messages (context compaction marker). */
export function isParsedCompactMessage(msg) {
  return msg.isCompactSummary === true;
}

// =============================================================================
// Session Enumeration (session-cartographer specific)
// =============================================================================

const CLAUDE_PROJECTS_DIR = join(homedir(), '.claude', 'projects');

/**
 * List all session files under ~/.claude/projects/.
 * Returns an array of { projectId, projectPath, sessionId, filePath, mtimeMs }.
 *
 * @returns {{ projectId: string, projectPath: string, sessionId: string, filePath: string, mtimeMs: number }[]}
 */
export function enumerateSessions() {
  if (!existsSync(CLAUDE_PROJECTS_DIR)) return [];

  const sessions = [];

  for (const projectId of readdirSync(CLAUDE_PROJECTS_DIR)) {
    const projectDir = join(CLAUDE_PROJECTS_DIR, projectId);

    let stat;
    try { stat = statSync(projectDir); } catch { continue; }
    if (!stat.isDirectory()) continue;

    for (const file of readdirSync(projectDir)) {
      if (!file.endsWith('.jsonl')) continue;

      // Skip subagent files (agent-*.jsonl at root or inside session subdirs)
      if (file.startsWith('agent-')) continue;

      const filePath = join(projectDir, file);
      const sessionId = basename(file, '.jsonl');

      let fileStat;
      try { fileStat = statSync(filePath); } catch { continue; }

      sessions.push({
        projectId,
        // Decode the encoded project path (e.g., "-Users-andyed-..." → "/Users/andyed/...")
        projectPath: projectId.replace(/-/g, '/').replace(/^\//, ''),
        sessionId,
        filePath,
        mtimeMs: fileStat.mtimeMs,
      });
    }
  }

  // Sort newest first
  sessions.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return sessions;
}

/**
 * Parse a single session by path and return structured data.
 *
 * @param {string} filePath
 * @returns {Promise<{ messages: ParsedMessage[], metrics: SessionMetrics, taskCalls: ToolCall[], byType: object }>}
 */
export async function parseSession(filePath) {
  const messages = await parseJsonlFile(filePath);

  const byType = { user: [], realUser: [], internalUser: [], assistant: [], system: [], other: [] };
  const sidechainMessages = [];
  const mainMessages = [];

  for (const m of messages) {
    switch (m.type) {
      case 'user':
        byType.user.push(m);
        if (!m.isMeta) byType.realUser.push(m);
        else byType.internalUser.push(m);
        break;
      case 'assistant':
        byType.assistant.push(m);
        break;
      case 'system':
        byType.system.push(m);
        break;
      default:
        byType.other.push(m);
    }

    if (m.isSidechain) sidechainMessages.push(m);
    else mainMessages.push(m);
  }

  const metrics = calculateMetrics(messages);
  const taskCalls = messages.flatMap(m => m.toolCalls.filter(tc => tc.isTask));

  return { messages, metrics, taskCalls, byType, sidechainMessages, mainMessages };
}

/**
 * Extract text content from a message for search/indexing.
 *
 * @param {ParsedMessage} msg
 * @returns {string}
 */
export function extractTextContent(msg) {
  if (typeof msg.content === 'string') return msg.content;
  if (!Array.isArray(msg.content)) return '';
  return msg.content
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('\n');
}
