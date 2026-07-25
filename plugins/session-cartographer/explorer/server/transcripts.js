import { resolve, sep } from 'path';
import { homedir } from 'os';

export function transcriptRoots(env = process.env, home = homedir()) {
  return [
    resolve(env.CARTOGRAPHER_CLAUDE_TRANSCRIPTS_DIR || env.CARTOGRAPHER_TRANSCRIPTS_DIR || `${home}/.claude/projects`),
    resolve(env.CARTOGRAPHER_CODEX_TRANSCRIPTS_DIR || `${home}/.codex/sessions`),
  ];
}

export function isAllowedTranscriptPath(path, roots) {
  return roots.some(root => path === root || path.startsWith(`${root}${sep}`));
}

function classifyNoise(content) {
  if (content.includes('<task-notification>')) return 'task-notification';
  if (content.includes('<command-name>')) return 'slash-command';
  if (content.includes('<local-command-caveat>')) return 'command-caveat';
  if (content.includes('<local-command-stdout>') || content.includes('<local-command-stderr>')) return 'command-output';
  if (content.startsWith('Base directory for this skill:')) return 'skill-injection';
  if (content.startsWith('Launching skill:')) return 'skill-launch';
  if (content.startsWith('This session is being continued')) return 'compaction-summary';
  return null;
}

function noiseSummary(content, noiseType) {
  switch (noiseType) {
    case 'task-notification': {
      const status = content.match(/<status>([^<]+)/)?.[1] || '';
      const summary = content.match(/<summary>([^<]+)/)?.[1] || '';
      return `agent ${status}${summary ? `: ${summary.slice(0, 80)}` : ''}`;
    }
    case 'slash-command':
      return content.match(/<command-name>([^<]+)/)?.[1] || '';
    case 'command-caveat':
      return 'local command output follows';
    case 'command-output': {
      const text = content.replace(/<[^>]+>/g, '').trim();
      return text.slice(0, 80) || 'command output';
    }
    case 'skill-injection': {
      const name = content.match(/^Base directory for this skill:[^\n]*\n+#\s*(.+)/m)?.[1] || 'skill';
      return `skill loaded: ${name}`;
    }
    case 'skill-launch': {
      const skill = content.match(/^Launching skill:\s*(.+)/)?.[1] || '';
      return `launching ${skill}`;
    }
    case 'compaction-summary':
      return 'session continuation summary';
    default:
      return null;
  }
}

function codexMessage(e) {
  const p = e.payload || {};
  let content = '';
  let role = 'tool';

  if (e.type === 'event_msg') {
    content = p.message || '';
    role = 'user';
  } else if (p.type === 'message') {
    content = Array.isArray(p.content)
      ? p.content.map(block => block.text || block.content || '').filter(Boolean).join('\n')
      : p.content || '';
    role = p.role || 'assistant';
  } else if (p.type === 'custom_tool_call' || p.type === 'function_call') {
    const input = p.input || p.arguments || '';
    content = `${p.name || 'tool'}${input ? `\n${input}` : ''}`;
  } else {
    content = typeof p.output === 'string' ? p.output : JSON.stringify(p.output || '');
  }

  const noise = classifyNoise(content);
  return {
    uuid: p.id || p.call_id || '',
    type: p.type || e.type,
    timestamp: e.timestamp,
    role,
    content,
    model: '',
    toolUseID: p.call_id || '',
    parentToolUseID: '',
    isSidechain: false,
    agentId: '',
    noise,
    noiseSummary: noise ? noiseSummary(content, noise) : null,
  };
}

function claudeMessage(e) {
  const content = typeof e.message?.content === 'string'
    ? e.message.content
    : Array.isArray(e.message?.content)
      ? e.message.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
      : e.data?.type || '';
  const noise = classifyNoise(content);
  return {
    uuid: e.uuid,
    type: e.type,
    timestamp: e.timestamp,
    role: e.message?.role || e.type,
    content,
    model: e.message?.model || '',
    toolUseID: e.toolUseID || '',
    parentToolUseID: e.parentToolUseID || '',
    isSidechain: e.isSidechain ?? false,
    agentId: e.agentId || '',
    noise,
    noiseSummary: noise ? noiseSummary(content, noise) : null,
  };
}

export function normalizeTranscriptEntries(entries) {
  const provider = entries.some(entry => entry.type === 'session_meta') ? 'codex' : 'claude';
  const messages = entries.filter(entry => provider === 'codex'
    ? (entry.type === 'event_msg' && entry.payload?.type === 'user_message') ||
      (entry.type === 'response_item' && ['message', 'custom_tool_call', 'custom_tool_call_output', 'function_call', 'function_call_output'].includes(entry.payload?.type))
    : entry.type === 'user' || entry.type === 'assistant' || entry.type === 'progress'
  ).map(provider === 'codex' ? codexMessage : claudeMessage).filter(message => message.content);

  return { provider, messages };
}
