import { messageBlocks } from './transcript-navigation.js';
import { readableText } from './evidence-content.js';


// Extract only author-labelled sections. A heading is attribution, not proof
// that a claim is true or a historical next step is still open.
export function recordedSections(items) {
  const sections = new Map();
  for (const item of items) {
    let current = null, fence = null;
    const flush = () => {
      if (!current) return;
      const text = current.lines.join('\n').trim();
      if (!text) return;
      const key = `${current.kind}:${text.replace(/\s+/g, ' ')}`;
      const value = { ...item, heading: current.heading, kind: current.kind, text };
      sections.delete(key);
      sections.set(key, value);
    };
    for (const line of item.text.split('\n')) {
      const delimiter = line.match(/^\s*(`{3,}|~{3,})/);
      if (delimiter) {
        if (!fence) fence = delimiter[1][0];
        else if (fence === delimiter[1][0]) fence = null;
        if (current) current.lines.push(line);
        continue;
      }
      if (fence) { if (current) current.lines.push(line); continue; }
      const heading = line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/)?.[1]
        || line.match(/^\s*\*\*([^*]+)\*\*:?\s*$/)?.[1];
      if (heading) {
        flush();
        const clean = heading.replace(/[:.!?]+$/, '').trim();
        const kind = /^(?:(?:key|recorded) )?(?:findings?|conclusions?|what we learned)$/i.test(clean) ? 'findings'
          : /^(?:(?:key|recorded) )?decisions?$/i.test(clean) ? 'decisions'
          : /^(?:validation|verification|tests?|testing|checks)$/i.test(clean) ? 'validation'
          : /^(?:next steps?|remaining(?: work)?|open (?:issues|questions)|unresolved(?: issues)?|limitations?|follow[- ]?ups?)$/i.test(clean) ? 'next'
          : null;
        current = kind ? { kind, heading: clean, lines: [] } : null;
      } else if (current) current.lines.push(line);
    }
    flush();
  }
  return [...sections.values()];
}

// An evidence index, not generated claims. Never infer completion or whether a
// historical failure is still unresolved from the presence of a tool result.
export function sessionReview(messages, bundles) {
  const prose = role => messages.filter(m => m.role === role && !m.noise && !m.isSidechain)
    .flatMap(m => messageBlocks(m).filter(b => b.type === 'text').map(b => ({messageId:m.uuid,blockId:b.id,text:readableText(b.text),timestamp:m.timestamp})))
    .filter(item => item.text && !/^\s*<(?:system|environment|instructions|local-command)/i.test(item.text));
  const pages = new Map();
  for (const [blockId, links] of bundles.searches) for (const link of links) {
    const message = messages.find(m => messageBlocks(m).some(b => b.id === blockId));
    const previous = pages.get(link.url);
    pages.set(link.url, {...link,blockId,messageId:message?.uuid,fetches:[...(previous?.fetches || []),...link.fetches]});
  }
  const failures = messages.flatMap(m => messageBlocks(m).filter(b => b.type === 'tool_result' && (b.isError || b.status === 'error'))
    .map(b => ({messageId:m.uuid,blockId:b.id,name:b.name,text:readableText(b.output)}))).filter(item => item.text);
  const responses = prose('assistant');
  return {request:prose('user')[0],conclusion:responses.at(-1),sections:recordedSections(responses),pages:[...pages.values()],failures};
}
