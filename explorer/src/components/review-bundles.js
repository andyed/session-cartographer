import { messageBlocks } from './transcript-navigation.js';
import { searchResultLinks, outputText, excerpt } from './tool-presentation.js';

function urlKey(value) {
  try { const url = new URL(value); if (!['http:', 'https:'].includes(url.protocol)) return null; url.hash = ''; return url.href; } catch { return null; }
}
function args(block) {
  if (typeof block.input !== 'string') return block.input || {};
  try { return JSON.parse(block.input); } catch { return {}; }
}

// A derived review view, never a replacement transcript. Each attachment keeps
// its original block/message IDs. Match only explicit URLs, earlier searches,
// and the same agent; retries remain separate attempts under the same page.
export function buildReviewBundles(messages) {
  const blocks = new Map(messages.flatMap(m => messageBlocks(m).map(b => [b.id, b])));
  const searches = new Map(), latest = new Map(), memberships = new Map();
  for (const message of messages) for (const block of messageBlocks(message)) {
    const links = searchResultLinks(block);
    if (links.length) {
      const pages = links.map(link => ({ ...link, fetches: [] }));
      searches.set(block.id, pages);
      for (const page of pages) latest.set(`${message.agentId || ''}\0${urlKey(page.url)}`, {page,searchBlockId:block.id,searchMessageId:message.uuid});
    }
    if (block.type !== 'tool_call' || !/(?:^|[_.])WebFetch$/i.test(block.name || '')) continue;
    const input = args(block), key = urlKey(input.url);
    if (!key) continue;
    const owner = latest.get(`${message.agentId || ''}\0${key}`);
    if (!owner) continue;
    const results = (block.resultIds || []).map(id => blocks.get(id)).filter(Boolean);
    const fetch = {call:block,results,prompt:input.prompt || '',messageId:message.uuid};
    owner.page.fetches.push(fetch);
    for (const item of [block,...results]) memberships.set(item.id,{...owner,title:owner.page.title,url:owner.page.url});
  }
  return {searches,memberships};
}

export function fetchSummary(result) {
  const text = outputText(result.output);
  const http = text.match(/^The server returned HTTP ([45]\d\d)\b[^\n]*/);
  return {text,summary:excerpt(text.replace(/^#{1,6}\s*/gm,'').replace(/\*\*([^*]+)\*\*/g,'$1'),220),error:result.isError || !!http};
}
