// Built Explorer + synthetic API, served on a disposable loopback port.
// No live corpus, backend, config, or external network is used.
const { chromium } = require('@playwright/test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const dist = path.join(root, 'explorer/dist');
const artifacts = path.join(os.tmpdir(), 'carto-search-review-browser-artifacts');
const now = Date.now();
const repeated = 'The same recorded conclusion in two separate sessions';
const prefix = 'Shared evidence prefix '.repeat(17);
const rows = [
  {event_id:'equal-a',summary:repeated,session_id:'session-a',session_title:'First task',uuid:'message-a',block_id:'message-a--block-0',url:'https://reference.invalid/article'},
  {event_id:'prefix-a',summary:prefix+'DISTINCT ENDING ALPHA',session_id:'session-c',uuid:'message-c'},
  {event_id:'equal-b',summary:repeated,session_id:'session-b',session_title:'Second task',uuid:'message-b',block_id:'message-b--block-0'},
  {event_id:'prefix-b',summary:prefix+'DISTINCT ENDING BETA',session_id:'session-d',uuid:'message-d'},
  {event_id:'title-only',title:'A title-only source destination',session_id:'session-e'},
].map((row,index)=>({...row,transcript_path:'/synthetic/'+row.session_id+'.jsonl',timestamp:new Date(now-index*60000).toISOString(),provider:'claude',project:'review-fixture',type:'research_search',_sources:'keyword',_score:1-index/10}));
const transcript = {identity:{title:'Fixture transcript',provider:'claude'},messages:rows.map(row=>({uuid:row.uuid || 'title-message',role:'assistant',timestamp:row.timestamp,content:'Source for '+row.event_id,blocks:[{id:(row.uuid || 'title-message')+'--block-0',type:'text',text:'Source for '+row.event_id}]})),evidence:{calls:[],files:[],errors:[]}};
const response = {
  results:rows,meta:{keyword_count:rows.length,semantic_count:0,duration_ms:1},
  facets:{projects:[{name:'review-fixture',count:rows.length}],types:[{name:'research_search',count:rows.length}],providers:[{name:'claude',count:rows.length}],sources:[{name:'keyword',count:rows.length}],quadrants:[]},
};
(async()=>{
  assert.ok(fs.existsSync(path.join(dist,'index.html')),'Build Explorer before this browser proof');
  fs.mkdirSync(artifacts,{recursive:true});
  const server=http.createServer((req,res)=>{
    const url=new URL(req.url,'http://localhost');
    const requested=path.resolve(dist,'.'+url.pathname);
    if(!requested.startsWith(dist+path.sep) && requested!==dist){res.writeHead(403);res.end();return;}
    const file=fs.existsSync(requested) && fs.statSync(requested).isFile()?requested:path.join(dist,'index.html');
    res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':file.endsWith('.svg')?'image/svg+xml':'text/html');
    res.end(fs.readFileSync(file));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${server.address().port}`;
  let browser, page;
  const errors=[],unexpected=[];
  try {
    browser=await chromium.launch({headless:true});
    const context=await browser.newContext({viewport:{width:1200,height:900},reducedMotion:'reduce'});
    context.on('page',page=>page.on('pageerror',error=>errors.push(error.message)));
    await context.route('**/*',async route=>{
      const url=new URL(route.request().url());
      if(url.origin!==origin){await route.fulfill({contentType:'text/html',body:'<title>External reference fixture</title><p>Reference</p>'});return;}
      if(!url.pathname.startsWith('/api/')){await route.continue();return;}
      const bodies={
        '/api/search':response,
        '/api/autocomplete':{suggestions:[]},'/api/coterms':{terms:[]},
        '/api/transcript':transcript,'/api/transcript/analysis':{unavailable:true},
        '/api/session/artifacts':{artifacts:[],documents:[],commits:[]},
      };
      if(!(url.pathname in bodies)){unexpected.push(url.pathname);await route.fulfill({status:501,contentType:'application/json',body:'{"error":"Unexpected fixture API"}'});return;}
      await route.fulfill({contentType:'application/json',body:JSON.stringify(bodies[url.pathname])});
    });
    page=await context.newPage();
    const load=async()=>{await page.goto(origin+'/?q=evidence');await page.locator('[data-event-id="equal-a"]').waitFor();};
    await load();
    assert.equal(await page.locator('.search-result-group').count(),4,'Distinct suffixes must not collapse under a shared 120-character prefix');
    assert.equal(await page.locator('[data-event-id="equal-b"]').count(),0);
    const occurrences=page.getByRole('button',{name:'Show 1 other occurrence',exact:true});
    await occurrences.focus();await page.keyboard.press('Enter');
    const second=page.locator('[data-event-id="equal-b"]');
    await second.waitFor();
    assert.equal(await second.getAttribute('data-result-rank'),'3','Grouping must retain retrieval rank');
    assert.ok((await second.locator('.search-occurrence-context').innerText()).includes('Second task'));
    assert.equal(await second.locator('.event-primary').getAttribute('href'),'/session/%2Fsynthetic%2Fsession-b.jsonl?reader=conversation&return=%2F%3Fq%3Devidence&uuid=message-b&block=message-b--block-0');
    const long=page.locator('[data-event-id="prefix-a"]');
    assert.equal(await long.getByText(/DISTINCT ENDING ALPHA/).count(),0);
    await long.getByRole('button',{name:'Show full text',exact:true}).click();
    assert.equal(await long.locator('.event-primary p').textContent(),prefix+'DISTINCT ENDING ALPHA');
    assert.equal(await long.getByText(/DISTINCT ENDING ALPHA/).count(),1,'Expanded prose must replace the excerpt');
    const unchanged=page.url();
    await long.getByRole('button',{name:/^Metadata/}).click();
    assert.equal(page.url(),unchanged,'Metadata must not trigger the primary destination');
    await long.getByText('session: session-c',{exact:true}).waitFor();

    // Actual pointer text selection must not activate the enclosing native link.
    const text=page.locator('[data-event-id="equal-a"] .event-primary p');
    await text.scrollIntoViewIfNeeded();const textBox=await text.boundingBox();
    await page.mouse.move(textBox.x+2,textBox.y+10);await page.mouse.down();
    await page.mouse.move(textBox.x+180,textBox.y+10,{steps:12});await page.mouse.up();
    assert.ok(await page.evaluate(()=>String(getSelection()).length>0));
    assert.equal(page.url(),unchanged);
    await page.evaluate(()=>getSelection().removeAllRanges());

    // Source is a peer action; its own destination must not open a transcript.
    const [external]=await Promise.all([context.waitForEvent('page'),page.locator('[data-event-id="equal-a"]').getByRole('link',{name:/^Open source:/}).click()]);
    await external.waitForLoadState();assert.equal(external.url(),'https://reference.invalid/article');
    assert.equal(page.url(),unchanged);await external.close();

    // Body-level arrow navigation visits an expanded member, then opens its exact source.
    await page.evaluate(()=>document.activeElement.blur());
    await page.keyboard.press('ArrowDown');await page.keyboard.press('ArrowDown');
    assert.equal(await page.locator('.event-review-card.ring-1').evaluate(el=>el.parentElement.dataset.eventId),'equal-b');
    await page.keyboard.press('Enter');
    await page.waitForURL(url=>url.searchParams.get('uuid')==='message-b');
    assert.equal(new URL(page.url()).searchParams.get('block'),'message-b--block-0');
    assert.equal(new URL(page.url()).searchParams.get('reader'),'conversation');
    await page.getByRole('button',{name:'Conversation',exact:true}).waitFor();
    assert.equal(await page.getByRole('button',{name:'Conversation',exact:true}).getAttribute('aria-pressed'),'true');

    await load();
    const titleRow=page.locator('[data-event-id="title-only"]');
    const titleLink=titleRow.locator('.event-primary');
    const nativeHref=await titleLink.getAttribute('href');
    const sourceURL=page.url();
    const [native]=await Promise.all([context.waitForEvent('page'),titleLink.click({modifiers:['ControlOrMeta']})]);
    await native.waitForURL(origin+nativeHref);
    await native.getByRole('button',{name:'Conversation',exact:true}).waitFor();
    assert.equal(await native.getByRole('button',{name:'Conversation',exact:true}).getAttribute('aria-pressed'),'true');
    assert.equal(page.url(),sourceURL);await native.close();
    const box=await titleLink.boundingBox();
    await titleLink.click({position:{x:box.width-5,y:box.height-5}});
    await page.waitForURL(url=>url.pathname.startsWith('/session/'));
    assert.equal(new URL(page.url()).searchParams.get('reader'),'conversation','Plain title-only activation must match the native destination');
    assert.equal(new URL(page.url()).pathname,new URL(nativeHref,origin).pathname);

    await load();await page.getByRole('button',{name:'Show 1 other occurrence',exact:true}).click();
    await page.setViewportSize({width:390,height:844});
    await page.locator('[data-event-id="equal-b"]').scrollIntoViewIfNeeded();
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
    await page.screenshot({path:path.join(artifacts,'search-occurrences-390.png'),fullPage:true});
    assert.deepEqual(unexpected,[]);assert.deepEqual(errors,[]);
    fs.writeFileSync(path.join(artifacts,'verification.json'),JSON.stringify({build:fs.readFileSync(path.join(dist,'index.html'),'utf8').match(/assets\/index-[^" ]+\.js/)?.[0],checks:['full-text grouping','all source occurrences','original ranks','keyboard exact source','native and ordinary title-only destinations','full prose recovery','text selection','peer source/metadata actions','390px layout'],errors},null,2)+'\n');
    console.log('PASS: search occurrences, distinct endings, full prose, exact keyboard/native destinations, selection, peer actions and 390px; artifacts: '+artifacts);
  } catch (error) {
    if (page) await page.screenshot({path:path.join(artifacts,'failure.png'),fullPage:true}).catch(()=>{});
    throw error;
  } finally {await browser?.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;});
