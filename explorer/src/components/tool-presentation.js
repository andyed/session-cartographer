import { readableText, isOrchestration } from './evidence-content.js';
import { literalToolInputs } from '../../shared/literal-tool-inputs.js';
// Display excerpts only; the original blocks remain the evidence/search source.
export function excerpt(value, limit = 180) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function structured(value) {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return value; }
}

export function outputText(value) { return readableText(value); }

export function toolInput(block) {
  const input = structured(block?.input);
  if (typeof input === 'string' && isOrchestration(input)) {
    return literalToolInputs(input, {requireWorkdir:false}).map(call =>
      call.name === 'exec_command' ? {Command:call.input.cmd, ...(call.input.workdir ? {Directory:call.input.workdir} : {})} : {Patch:call.input});
  }
  return input;
}

// Claude WebSearch embeds a JSON Links array inside a plain-text result.
// Parse just that balanced array; never evaluate text or invent clipped URLs.
export function searchResultLinks(block) {
  if (block.type !== 'tool_result' || !/web.?search|search.*web/i.test(block.name || '')) return [];
  const output = structured(block.output);
  let candidates = output?.links || output?.results;
  if (!Array.isArray(candidates)) {
    const rawText = value => typeof value === 'string' ? value : Array.isArray(value) ? value.map(rawText).join('\n') : value?.text || rawText(value?.content || '');
    const text = rawText(block.output);
    const marker = /\bLinks:\s*(\[)/i.exec(text);
    if (!marker) return [];
    const start = marker.index + marker[0].length - 1;
    let depth = 0, quoted = false, escaped = false;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (quoted) { if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === '"') quoted = false; continue; }
      if (c === '"') quoted = true;
      else if (c === '[') depth++;
      else if (c === ']' && --depth === 0) { try { candidates = JSON.parse(text.slice(start, i + 1)); } catch {} break; }
    }
  }
  const seen = new Set();
  return (Array.isArray(candidates) ? candidates : []).flatMap(item => {
    if (!item || typeof item.url !== 'string' || /[\u0000-\u0020\u007f]/.test(item.url)) return [];
    let url;
    try { url = new URL(item.url); } catch { return []; }
    if (!['http:', 'https:'].includes(url.protocol) || seen.has(url.href)) return [];
    seen.add(url.href);
    return [{url:url.href, title:typeof item.title === 'string' && item.title.trim() ? item.title : url.hostname, domain:url.hostname.replace(/^www\./,'')}];
  });
}

export function toolPresentation(block, pairedCall) {
  const call = block.type === 'tool_call' ? block : pairedCall;
  const input = toolInput(call);
  const name = Array.isArray(input) ? 'Commands' : call?.name || block.name || 'Tool';
  const args = input && typeof input === 'object' ? input : {};
  const path = args.file_path || args.filePath || args.path;
  const command = args.command || args.cmd;
  const subject = path || args.description || command || args.pattern || args.query || args.url
    || (typeof input === 'string' ? readableText(input) : Array.isArray(input) ? input.map(item => item.Command || 'Apply patch').join(' · ') : '');
  const shortName = typeof path === 'string' ? path.split(/[\\/]/).pop() : excerpt(subject, 100);
  const result = block.type === 'tool_result';
  const title = `${name}${result ? ' output' : ''}${shortName ? ` · ${shortName}` : ''}`;
  const detail = result ? excerpt(outputText(block.output))
    : excerpt(path || command || subject || (Object.keys(args).length ? readableText(args) : ''));
  const status = block.status === 'error' ? 'Error'
    : block.status === 'missing-result' ? 'No result recorded'
    : block.orphan ? 'Call unavailable' : '';
  return { title, detail: detail === shortName && !result ? '' : detail, status };
}

export function messagePresentation(message, blocks) {
  const toolOnly = blocks.length > 0 && blocks.every(b => ['tool_call', 'tool_result'].includes(b.type));
  const textLength = blocks.filter(b => b.type === 'text').reduce((n, b) => n + (b.text || '').length, 0);
  return { toolOnly, textLength, role: toolOnly ? 'tool' : message.role };
}
