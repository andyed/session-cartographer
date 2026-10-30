// Provider records become chronological messages with typed evidence blocks.
// Tool results stay where they occurred; links point back to the call rather
// than moving results into the assistant's earlier message.
const TEXT_TYPES = new Set(['text', 'input_text', 'output_text', 'summary_text']);
const CALL_TYPES = new Set(['tool_use', 'server_tool_use', 'function_call', 'custom_tool_call']);
const RESULT_TYPES = new Set(['tool_result', 'function_call_output', 'custom_tool_call_output']);
const BINARY_TYPES = new Set(['image', 'input_image', 'output_image', 'audio', 'input_audio', 'output_audio', 'document', 'redacted_thinking', 'encrypted_content']);
const isResult = value => RESULT_TYPES.has(value.type) || (typeof value.type === 'string' && value.type.endsWith('_tool_result') && !!value.tool_use_id);

function printable(value) {
  return typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value, null, 2);
}

// Preserve structured/text input and output, but never send embedded binary
// assets or encrypted reasoning to the browser as a giant JSON string.
function safeValue(value) {
  if (typeof value === 'string') {
    if (/^data:[^,]*;base64,/i.test(value)) return '[Embedded binary omitted]';
    // Tool transports also serialize content blocks inside a JSON string.
    // Keep the original bytes when nothing needs omission.
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object') {
        const safe = safeValue(parsed);
        if (JSON.stringify(safe) !== JSON.stringify(parsed)) return JSON.stringify(safe);
      }
    } catch { /* ordinary text remains complete */ }
    return value;
  }
  if (Array.isArray(value)) return value.map(safeValue);
  if (!value || typeof value !== 'object') return value;
  if (value.type === 'base64') return { type: 'base64', media_type: value.media_type || '', omitted: true };
  if (BINARY_TYPES.has(value.type)) return {
    type: value.type,
    media_type: value.media_type || value.source?.media_type || '',
    label: value.title || value.name || value.type,
    omitted: true,
  };
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
    key === 'encrypted_content' ? '[Opaque content omitted]' : safeValue(item),
  ]));
}

function explicitFailure(value) {
  if (typeof value === 'string') {
    try { return explicitFailure(JSON.parse(value)); } catch {
      // Codex's exec tool records this envelope even when output is plain text.
      const exit = value.match(/^Process exited with code (-?\d+)\s*$/m);
      return !!exit && Number(exit[1]) !== 0;
    }
  }
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(explicitFailure);
  if (TEXT_TYPES.has(value.type) && typeof value.text === 'string') return explicitFailure(value.text);
  return value.is_error === true || value.isError === true || value.success === false
    || (typeof value.type === 'string' && value.type.endsWith('_tool_result_error'))
    || (typeof value.exit_code === 'number' && value.exit_code !== 0)
    || (typeof value.exitCode === 'number' && value.exitCode !== 0)
    || (value.metadata && explicitFailure(value.metadata)) || false;
}

function blockText(block) {
  if (block.type === 'text' || block.type === 'thinking') return block.text;
  if (block.type === 'tool_call') return `${block.name}\n${printable(block.input)}`;
  if (block.type === 'tool_result') return printable(block.output);
  return `[${block.label}]${block.metadata ? `\n${printable(block.metadata)}` : ''}`;
}

function normalizeBlock(raw, id, messageId) {
  if (typeof raw === 'string') return { type: 'text', id, messageId, text: raw };
  if (!raw || typeof raw !== 'object') return { type: 'text', id, messageId, text: printable(raw) };
  if (TEXT_TYPES.has(raw.type)) return { type: 'text', id, messageId, text: raw.text || '' };
  if (raw.type === 'thinking') return { type: 'thinking', id, messageId, text: raw.thinking || raw.text || '' };
  if (CALL_TYPES.has(raw.type)) return {
    type: 'tool_call', id, messageId, callId: raw.call_id || raw.id || '',
    name: raw.name || 'Tool', input: safeValue(raw.input ?? raw.arguments ?? ''),
    status: 'missing-result', resultIds: [], resultMessageIds: [],
  };
  if (isResult(raw)) {
    const output = safeValue(raw.output ?? raw.content ?? '');
    const isError = explicitFailure(raw) || explicitFailure(raw.output ?? raw.content);
    return {
      type: 'tool_result', id, messageId, callId: raw.tool_use_id || raw.call_id || '',
      name: raw.name || 'Tool', output, isError,
      status: isError ? 'error' : 'orphan-result', orphan: true, callMessageId: null, callBlockId: null,
    };
  }
  if (BINARY_TYPES.has(raw.type)) return {
    type: 'attachment', id, messageId, blockType: raw.type,
    mediaType: raw.media_type || raw.source?.media_type || '',
    label: raw.title || raw.name || `${raw.type} (embedded content not displayed)`,
  };
  return { type: 'attachment', id, messageId, blockType: raw.type || 'unknown', mediaType: '', label: raw.type || 'Unrecognized content', metadata: safeValue(raw) };
}

function promptTitle(value) {
  const text = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
  if (text.length < 8 || text.startsWith('<') || text.startsWith('# AGENTS.md') || /^(This session is being continued|Base directory for this skill|You are |\[Request interrupted)/.test(text)) return '';
  return text.slice(0, 600);
}

function identityFrom(entries, provider, messages) {
  const meta = entries.find(e => e.type === 'session_meta')?.payload || {};
  const custom = [...entries].reverse().find(e => e.type === 'custom-title' && promptTitle(e.customTitle));
  const sessionId = provider === 'codex' ? meta.id || '' : entries.find(e => e.sessionId)?.sessionId || '';
  const prompts = messages.filter(m => m.role === 'user').map(m => promptTitle(m.blocks.filter(b => b.type === 'text').map(b => b.text).join(' '))).filter(Boolean);
  return {
    provider, sessionId,
    title: custom?.customTitle || prompts.find(p => !p.startsWith('/')) || prompts[0] || '',
    cwd: meta.cwd || entries.find(e => typeof e.cwd === 'string')?.cwd || '',
  };
}

function filesFromCall(call, message) {
  let input = call.input;
  const reference = (path, operation) => ({ path, operation, messageId: message.uuid, blockId: call.id, callId: call.callId, status: call.status });
  if (typeof input === 'string' && /(?:^|\.)apply_patch$/.test(call.name) && input.startsWith('*** Begin Patch')) {
    const paths = [...input.matchAll(/^\*\*\* (?:(?:Add|Update|Delete) File|Move to): (.+)\r?$/gm)].map(match => match[1].trim());
    return [...new Set(paths)].map(path => reference(path, 'write'));
  }
  if (typeof input === 'string') { try { input = JSON.parse(input); } catch { return []; } }
  if (!input || typeof input !== 'object') return [];
  // Only explicit file parameters; never infer a path from arbitrary shell
  // text or claim that a requested edit succeeded.
  const path = input.file_path || input.filePath || input.path;
  if (typeof path !== 'string' || !path.trim()) return [];
  const name = call.name.toLowerCase();
  if (!/read|write|edit|file|notebook/.test(name)) return [];
  return [reference(path, /write|edit|delete|remove|create|patch/.test(name) ? 'write' : 'read')];
}

function pairEvidence(messages) {
  const calls = new Map();
  const key = (message, id) => `${message.agentId || ''}\0${id}`;
  messages.forEach((message, position) => {
    message.blocks.forEach(block => {
      if (block.type !== 'tool_call' || !block.callId) return;
      const k = key(message, block.callId);
      if (!calls.has(k)) calls.set(k, []);
      calls.get(k).push({ message, block, position });
    });
  });
  messages.forEach((message, position) => {
    message.blocks.forEach(block => {
      if (block.type !== 'tool_result' || !block.callId) return;
      const candidates = calls.get(key(message, block.callId)) || [];
      const call = candidates.filter(item => item.position <= position).at(-1)
        || (candidates.length === 1 ? candidates[0] : null);
      if (!call) return;
      block.orphan = false;
      block.name = call.block.name;
      block.callMessageId = call.message.uuid;
      block.callBlockId = call.block.id;
      block.status = block.isError ? 'error' : 'returned';
      call.block.resultIds.push(block.id);
      if (!call.block.resultMessageIds.includes(message.uuid)) call.block.resultMessageIds.push(message.uuid);
      call.block.status = block.isError || call.block.status === 'error' ? 'error' : 'returned';
    });
  });
  const evidence = { calls: [], files: [], errors: [] };
  for (const message of messages) for (const block of message.blocks) {
    if (block.type === 'tool_call') {
      evidence.calls.push({ callId: block.callId, name: block.name, messageId: message.uuid, blockId: block.id, status: block.status, resultMessageIds: block.resultMessageIds });
      evidence.files.push(...filesFromCall(block, message));
    }
    if (block.type === 'tool_result' && block.isError) evidence.errors.push({ callId: block.callId, name: block.name, messageId: message.uuid, blockId: block.id, callMessageId: block.callMessageId, summary: printable(block.output).slice(0, 240) });
  }
  return evidence;
}

export function normalizeEvidenceEntries(entries) {
  const provider = entries.some(entry => ['session_meta', 'response_item', 'event_msg'].includes(entry.type)) ? 'codex' : 'claude';
  const legacyPrompts = new Set(entries.filter(e => e.type === 'event_msg' && e.payload?.type === 'user_message')
    .map(e => `${e.timestamp || ''}\0${e.payload.message || ''}`));
  const ids = new Set();
  const messages = [];
  entries.forEach((e, index) => {
    const p = provider === 'codex' ? e.payload || {} : e.message || {};
    let rawBlocks, role, sourceUuid, type;
    if (provider === 'codex') {
      type = p.type || e.type;
      if (e.type === 'event_msg' && p.type === 'user_message') { rawBlocks = [p.message || '']; role = 'user'; }
      else if (e.type === 'event_msg' && p.type === 'item_completed' && p.item?.type === 'UserMessage') {
        rawBlocks = p.item.content || [];
        const text = rawBlocks.filter(b => TEXT_TYPES.has(b.type)).map(b => b.text || '').join('\n');
        // Transitional logs can contain both display-event formats for one prompt.
        if (legacyPrompts.has(`${e.timestamp || ''}\0${text}`)) return;
        role = 'user';
      }
      else if (e.type === 'response_item' && p.type === 'message') { rawBlocks = p.content || []; role = p.role || 'assistant'; }
      else if (e.type === 'response_item' && p.type === 'agent_message') { rawBlocks = p.content || []; role = 'assistant'; }
      else if (e.type === 'response_item' && (CALL_TYPES.has(p.type) || isResult(p))) { rawBlocks = [p]; role = 'tool'; }
      else if (e.type === 'response_item' && p.type === 'reasoning') {
        // Only recorded public summaries/text. encrypted_content is opaque.
        rawBlocks = [...(p.summary || []), ...(Array.isArray(p.content) ? p.content : [])].map(b => ({ type: 'thinking', text: b.text || '' })); role = 'assistant';
      } else return;
      sourceUuid = p.id || p.item?.id || (CALL_TYPES.has(p.type) ? p.call_id : '') || '';
    } else {
      if (!['user', 'assistant', 'progress'].includes(e.type)) return;
      rawBlocks = p.content ?? (e.data?.type ? [e.data.type] : []);
      role = p.role || e.type;
      sourceUuid = e.uuid || '';
      type = e.type;
    }
    const baseId = sourceUuid || `${provider}-record-${index}`;
    let uuid = baseId;
    let duplicate = 0;
    while (ids.has(uuid)) uuid = `${baseId}--record-${index}${duplicate++ ? `-${duplicate}` : ''}`;
    ids.add(uuid);
    const blocks = (Array.isArray(rawBlocks) ? rawBlocks : [rawBlocks]).map((block, i) => normalizeBlock(block, `${uuid}--block-${i}`, uuid));
    if (!blocks.length || blocks.every(b => b.type === 'text' && !b.text)) return;
    messages.push({
      uuid, sourceUuid, sourceIndex: index, type, timestamp: e.timestamp, role, blocks,
      content: blocks.map(blockText).filter(Boolean).join('\n'),
      model: provider === 'claude' ? p.model || '' : '',
      toolUseID: provider === 'claude' ? e.toolUseID || '' : p.call_id || '',
      parentToolUseID: e.parentToolUseID || '', isSidechain: e.isSidechain ?? false, agentId: e.agentId || '',
      ...(provider === 'codex' && p.type === 'agent_message' ? { author: p.author || '', recipient: p.recipient || '' } : {}),
    });
  });
  return { provider, identity: identityFrom(entries, provider, messages), messages, evidence: pairEvidence(messages) };
}
