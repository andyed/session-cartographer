// Rendered-copy audit: raw repeated phrases remain visible in the report even
// when they are source content or short, necessary controls rather than chrome.
const fs = require('node:fs');
const words = text => text.match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu) || [];
function scoreCopy(entries) {
  const groups = new Map();
  let interfaceWords = 0, contentWords = 0;
  for (const entry of entries) {
    const text = entry.text.replace(/\s+/g, ' ').trim();
    const count = words(text).length;
    if (entry.content) contentWords += count; else interfaceWords += count;
    if (count < 2) continue;
    const key = `${entry.content ? 'content' : 'interface'}:${text.toLocaleLowerCase()}`;
    const group = groups.get(key) || {text,words:count,count:0,content:entry.content,examples:[]};
    group.count++;
    if(group.examples.length<3)group.examples.push(entry.selector);
    groups.set(key,group);
  }
  const repeated = [...groups.values()].filter(g=>g.count>1).map(g=>({...g,excessWords:(g.count-1)*g.words})).sort((a,b)=>b.excessWords-a.excessWords);
  const excessWords = repeated.filter(g=>!g.content).reduce((n,g)=>n+g.excessWords,0);
  return {interfaceWords,contentWords,excessWords,boilerplatePercent:Number((100*excessWords/Math.max(1,interfaceWords)).toFixed(2)),repeated};
}
async function captureCopy(page, name) {
  const entries = await page.evaluate(() => {
    const source = '.prose-transcript,.tr-web-results,.session-identity-title,.session-identity-context,.session-artifact-name,.session-artifact-path,.mw-artifact-body,.fw-markdown,.fw-diff,.rc-summary,.fw-row-outcome,.fw-result-open > strong,.fw-file-path,.memory-path,.session-card-preview,.ms-observation-text,.internals-metric-value,time,svg text,pre,code,[data-copy-content]';
    const result = [], parents = new Set();
    const walker = document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);
    for(let node; (node=walker.nextNode());) {
      const el=node.parentElement;
      if(!el || parents.has(el))continue;
      parents.add(el);
      const text=[...el.childNodes].filter(n=>n.nodeType===Node.TEXT_NODE).map(n=>n.textContent).join('').replace(/\s+/g,' ').trim();
      if(!el || !text || el.closest('script,style,noscript,.sr-only,.md-sr,[aria-hidden="true"]'))continue;
      let hidden=false;
      for(let p=el;p;p=p.parentElement){
        const style=getComputedStyle(p);
        if(style.display==='none'||style.visibility==='hidden'||style.opacity==='0'){hidden=true;break;}
        if(p.tagName==='DETAILS'&&!p.open && !p.querySelector(':scope > summary')?.contains(el)){hidden=true;break;}
      }
      if(hidden)continue;
      const range=document.createRange();range.selectNodeContents(node);
      if(![...range.getClientRects()].some(r=>r.width>0&&r.height>0))continue;
      const control=el.closest('button,summary');
      // Tool summaries contain source-derived descriptions; their fixed status
      // and control labels still count as interface copy.
      const toolSource=el.closest('.tr-tool-preview,.tr-tool summary strong');
      const value = !/[\p{L}]/u.test(text) || /^(?:\d+[smhd] ago|just now|\d{1,2}:\d{2}(?::\d{2})? [AP]M|[A-Z][a-z]{2} \d{1,2}, \d{1,2}:\d{2} [AP]M)$/.test(text);
      const content=!!el.closest('[data-copy-content]') || value || (!!toolSource && text !== 'Search evidence') || (!control && !!el.closest(source));
      result.push({text,content,selector:el.tagName.toLowerCase()+(el.className&&typeof el.className==='string'?'.'+el.className.trim().split(/\s+/).slice(0,2).join('.'):'')});
    }
    return result;
  });
  const glyphControls = await page.evaluate(() => [...document.querySelectorAll('button,a')].flatMap(el => {
    if(!el.checkVisibility({checkVisibilityCSS:true}) || el.closest('.sr-only,.md-sr'))return [];
    const text=el.innerText.trim();
    if(/[\p{L}\p{N}]/u.test(text) || (!text && !el.querySelector('svg,img')))return [];
    const rect=el.getBoundingClientRect();
    const label=el.getAttribute('aria-label') || (el.getAttribute('aria-labelledby') || '').split(/\s+/).map(id=>document.getElementById(id)?.textContent || '').join(' ').trim() || el.title || el.querySelector('img')?.alt || '';
    return [{label,width:Math.round(rect.width),height:Math.round(rect.height),issue:!label?'missing accessible name':rect.width<44||rect.height<44?'target below 44px':null}];
  }));
  return {name,...scoreCopy(entries),glyphControls,entries};
}
function writeCopyReport(file,reports) { fs.writeFileSync(file,JSON.stringify({metric:'Repeated interface words beyond first occurrence / rendered interface words; exact phrases of 2+ words',targetPercent:5,reports},null,2)+'\n'); }
module.exports={scoreCopy,captureCopy,writeCopyReport};
