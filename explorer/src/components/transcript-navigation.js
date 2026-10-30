// Literal search includes retained tool arguments, output and reasoning. A hit
// is one source block, so next/previous always lands on a distinct location.
export function blockText(block) {
  if (block.type === 'tool_call') return `${block.name || ''}\n${typeof block.input === 'string' ? block.input : JSON.stringify(block.input ?? {}, null, 2)}`;
  if (block.type === 'tool_result') return `${block.name || ''}\n${typeof block.output === 'string' ? block.output : JSON.stringify(block.output ?? '', null, 2)}`;
  return [block.text || block.label || '', block.metadata ? JSON.stringify(block.metadata, null, 2) : ''].filter(Boolean).join('\n');
}
export function messageBlocks(message) {
  return message.blocks?.length ? message.blocks : [{ type: 'text', id: `${message.uuid}-text`, text: message.content || '' }];
}
export function transcriptMatches(messages, query) {
  const term = query.trim().toLocaleLowerCase();
  if (!term) return [];
  return messages.flatMap(message => messageBlocks(message).flatMap(block => {
    const text = blockText(block), index = text.toLocaleLowerCase().indexOf(term);
    if (index < 0) return [];
    const start = Math.max(0, index - 45), end = Math.min(text.length, index + term.length + 85);
    return [{ messageId: message.uuid, blockId: block.id, role: message.role, type: block.type, snippet: `${start ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}` }];
  }));
}
export function resolveTranscriptLocation(messages, uuid, blockId) {
  if (!uuid && !blockId) return null;
  const message = (blockId && messages.find(m => messageBlocks(m).some(b => b.id === blockId))) || (uuid && messages.find(m => m.uuid === uuid || m.sourceUuid === uuid));
  return message ? { messageId: message.uuid, blockId: messageBlocks(message).find(b => b.id === blockId)?.id || null } : null;
}
// Only local Explorer destinations may be restored from a shared reader URL.
export function safeTranscriptReturn(value, base = '/') {
  if (!value || !value.startsWith(base) || value.startsWith('//') || value.includes('\\')) return null;
  const url = new URL(value, 'http://explorer.invalid');
  const relative = url.pathname.slice(base.length).replace(/^\/|\/$/g, '');
  return ['memory', 'timeline', ''].includes(relative) ? `${url.pathname}${url.search}` : null;
}

// Pair only visible, explicitly linked operations. Research owns its own bundles.
export function operationBundles(messages, research = {searches:new Map(),memberships:new Map()}) {
  const lookup = new Map(messages.flatMap(message => messageBlocks(message).map(block => [block.id,{...block,messageId:message.uuid}])));
  const results = new Map(), owners = new Map();
  for (const block of lookup.values()) {
    if (block.type !== 'tool_call' || /(?:^|[._])web(?:search|fetch)$/i.test(block.name || '') || research.memberships.has(block.id)) continue;
    const paired = (block.resultIds || []).map(id => lookup.get(id)).filter(result => result?.type === 'tool_result' && result.callBlockId === block.id && !research.searches.has(result.id) && !research.memberships.has(result.id));
    if (!paired.length) continue;
    results.set(block.id,paired);
    for (const result of paired) owners.set(result.id,block.id);
  }
  return {results,owners};
}
