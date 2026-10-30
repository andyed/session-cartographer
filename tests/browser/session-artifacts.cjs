// Isolated single-record session, with images evidenced only in its transcript.
// Optional --transcript /absolute/file.jsonl --session id verifies a real session
// read-only, using synthetic scope metadata rather than the live corpus/server.
const { chromium } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..');
const option = name => process.argv[process.argv.indexOf(name) + 1];
const interactionAudit = process.argv.includes('--interaction-audit');
const interactionFindings = [];
const live = process.argv.includes('--transcript') ? option('--transcript') : null;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function port() { const server = net.createServer(); await new Promise(r => server.listen(0, '127.0.0.1', r)); const value = server.address().port; await new Promise(r => server.close(r)); return value; }
(async () => {
  const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'carto-artifacts-')));
  const artifacts = path.join(os.tmpdir(), 'carto-artifact-browser-artifacts'); fs.mkdirSync(artifacts, { recursive: true });
  const corpus = path.join(work, 'corpus'), outputs = path.join(work, 'outputs'), transcripts = path.join(work, 'transcripts');
  for (const dir of [corpus, outputs, transcripts]) fs.mkdirSync(dir);
  const sid = live ? option('--session') : 'graphics-session';
  assert.ok(sid && !sid.startsWith('--'));
  const transcript = live || path.join(transcripts, `${sid}.jsonl`);
  const now = new Date().toISOString();
  const title = live ? 'Obama Ohio messaging infographic' : 'Graphics with one recorded milestone';
  if (!live) {
    const messages = [{ type: 'user', uuid: 'prompt', sessionId: sid, cwd: corpus, timestamp: now, message: { role: 'user', content: title } }];
    for (let i = 0; i < 6; i++) {
      const file = path.join(outputs, `graphic-${i}.svg`);
      fs.writeFileSync(file, `<svg xmlns="http://www.w3.org/2000/svg" width="${i % 2 ? 200 : 400}" height="${i % 2 ? 300 : 200}"><rect width="100%" height="100%" fill="#163442"/><text x="20" y="70" fill="white" font-size="28">Output ${i}</text><script>window.artifactRan=true;fetch('/__unexpected_svg_request')</script></svg>`);
      messages.push({type:'assistant',uuid:`call-${i}`,sessionId:sid,timestamp:now,message:{role:'assistant',content:[{type:'tool_use',id:`read-${i}`,name:'Read',input:{file_path:file}}]}});
    }
    for (const [name, body] of [['not-an-image.png', '<html><script>window.artifactRan=true</script></html>'], ['unreferenced.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>']]) fs.writeFileSync(path.join(outputs, name), body);
    messages.push({type:'assistant',uuid:'bad-refs',sessionId:sid,timestamp:now,message:{role:'assistant',content:[{type:'tool_use',id:'missing',name:'Read',input:{file_path:path.join(outputs,'missing.png')}},{type:'tool_use',id:'unsafe',name:'Read',input:{file_path:path.join(outputs,'not-an-image.png')}}]}});
    const brief=path.join(outputs,'brief.md'), notes=path.join(outputs,'notes.txt');
    fs.writeFileSync(brief,'# Created brief\n');fs.writeFileSync(notes,'Edited notes\n');
    messages.push({type:'assistant',uuid:'document-calls',sessionId:sid,timestamp:now,message:{role:'assistant',content:[{type:'tool_use',id:'write-brief',name:'Write',input:{file_path:brief,content:'# Created brief'}},{type:'tool_use',id:'edit-notes',name:'Edit',input:{file_path:notes,old_string:'old',new_string:'new'}},{type:'tool_use',id:'failed-write',name:'Write',input:{file_path:path.join(outputs,'failed.md'),content:'not written'}},{type:'tool_use',id:'commit-call',name:'Bash',input:{command:'git commit -m "Create graphics brief"'}}]}});
    messages.push({type:'user',uuid:'document-results',sessionId:sid,timestamp:now,message:{role:'user',content:[{type:'tool_result',tool_use_id:'write-brief',content:'File created successfully at: '+brief},{type:'tool_result',tool_use_id:'edit-notes',content:'File updated successfully'},{type:'tool_result',tool_use_id:'failed-write',is_error:true,content:'Permission denied'},{type:'tool_result',tool_use_id:'commit-call',content:'[main abc1234] Create graphics brief\n 2 files changed, 4 insertions(+)'}]}});
    messages.push({type:'assistant',uuid:'web-search-call',sessionId:sid,timestamp:now,message:{role:'assistant',content:[{type:'tool_use',id:'search-call',name:'WebSearch',input:{query:'visual evidence'}}]}});
    messages.push({type:'user',uuid:'web-search-result',sessionId:sid,timestamp:now,message:{role:'user',content:[{type:'tool_result',tool_use_id:'search-call',content:'Links: '+JSON.stringify([{title:'Visual evidence guide',url:'https://example.com/guide'},{title:'Unsafe link',url:'javascript:window.injected=true'}])}]}});
    messages.push({type:'assistant',uuid:'web-fetch-call',sessionId:sid,timestamp:now,message:{role:'assistant',content:[{type:'tool_use',id:'fetch-call',name:'WebFetch',input:{url:'https://example.com/guide',prompt:'Find evidence'}}]}});
    messages.push({type:'user',uuid:'web-fetch-result',sessionId:sid,timestamp:now,message:{role:'user',content:[{type:'tool_result',tool_use_id:'fetch-call',content:'## Retrieved guide\nA useful passage with <script>window.injected=true</script> retained as text.'}]}});
    messages.push({type:'assistant',uuid:'earlier-findings',sessionId:sid,timestamp:now,message:{role:'assistant',content:'## Findings\nThe guide ties graphics to named evidence.\n## Next steps\nReview the phone layout.'}});
    messages.push({type:'assistant',uuid:'conclusion',sessionId:sid,timestamp:now,message:{role:'assistant',content:'Created **the brief** and graphics from `source.md`; notes were edited. The additional document could not be written because permission was denied.'}});
    fs.writeFileSync(transcript, messages.map(JSON.stringify).join('\n')+'\n');
    const codexRows=[
      {type:'session_meta',payload:{id:'codex-review',cwd:outputs}},
      {type:'response_item',payload:{type:'message',role:'user',id:'codex-request',content:[{type:'input_text',text:'Review the Capacitor dependency'}]}},
      {type:'response_item',payload:{type:'custom_tool_call',call_id:'inspect-dependency',name:'exec',input:'for (const r of await Promise.allSettled([tools.exec_command({cmd:"rg -n Capacitor Package.swift"})])) text(r);'}},
      {type:'response_item',payload:{type:'custom_tool_call_output',call_id:'inspect-dependency',output:'Script completed\nWall time 4.9 seconds\nOutput: '+JSON.stringify({status:'fulfilled',value:{chunk_id:'abc',wall_time_seconds:4.9,exit_code:0,original_token_count:1943,output:'Capacitor dependency found in Package.swift'}})}},
      {type:'response_item',payload:{type:'function_call',call_id:'counts',name:'validation',arguments:'{}'}},
      {type:'response_item',payload:{type:'function_call_output',call_id:'counts',output:JSON.stringify({passed:3,failed:0})}},
      {type:'response_item',payload:{type:'message',role:'assistant',id:'codex-finish',content:[{type:'output_text',text:'The package declares Capacitor. Device validation remains pending.'}]}}
    ];
    fs.writeFileSync(path.join(transcripts,'codex-review.jsonl'),codexRows.map(JSON.stringify).join('\n')+'\n');
    fs.writeFileSync(path.join(transcripts,'empty-session.jsonl'),JSON.stringify({type:'user',uuid:'empty-user',sessionId:'empty-session',cwd:corpus,timestamp:now,message:{role:'user',content:'Session with no artifacts'}})+'\n');
    fs.writeFileSync(path.join(transcripts,'missing-only.jsonl'),JSON.stringify({type:'assistant',uuid:'missing-only',sessionId:'missing-only',timestamp:now,message:{role:'assistant',content:[{type:'tool_use',id:'old-image',name:'Read',input:{file_path:path.join(outputs,'gone.png')}}]}})+'\n');
  }
  fs.writeFileSync(path.join(corpus,'changelog.jsonl'), JSON.stringify({event_id:'single-end',session_id:sid,session_title:title,provider:'claude',project:'graphics',cwd:corpus,transcript_path:transcript,timestamp:now,type:'milestone_session_end',summary:'Session ended (other) [63 events]'})+'\n');
  if(!live)fs.appendFileSync(path.join(corpus,'changelog.jsonl'),JSON.stringify({event_id:'canonical-commit',session_id:'commit-only-session',session_title:'Commit-only task',provider:'claude',project:'graphics',cwd:corpus,timestamp:now,type:'git_commit',commit_hash:'bcdef1234567890',summary:'Commit bcdef1234567890: Canonical change'})+'\n');
  if(!live){
    const pairedPath=path.join(transcripts,'paired-commits.jsonl');
    const pairs=[['cafe123','Record launch variety'],['beef456','Add Operator purchase']];
    const records=[];
    for(const [hash,subject] of pairs){
      records.push({type:'assistant',uuid:'call-'+hash,sessionId:'paired-commits',cwd:corpus,timestamp:now,message:{role:'assistant',content:[{type:'tool_use',id:hash,name:'Bash',input:{command:'git commit -m "'+subject+'"'}}]}});
      records.push({type:'user',uuid:'result-'+hash,sessionId:'paired-commits',timestamp:now,message:{role:'user',content:[{type:'tool_result',tool_use_id:hash,content:'[main '+hash+'] '+subject}]}});
      fs.appendFileSync(path.join(corpus,'changelog.jsonl'),JSON.stringify({event_id:'event-'+hash,session_id:'paired-commits',session_title:'Paired commit sources',transcript_path:pairedPath,provider:'claude',project:'graphics',cwd:corpus,timestamp:now,type:'git_commit',commit_hash:hash,summary:'Commit '+hash+': '+subject})+'\n');
    }
    fs.writeFileSync(pairedPath,records.map(JSON.stringify).join('\n')+'\n');
  }
  const uiPort = await port(), apiPort = await port();
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('CARTOGRAPHER_') && !['CLAUDE_SESSION_ID','CLAUDE_CODE_SESSION_ID','CODEX_SESSION_ID','VITE_DEMO'].includes(key)));
  const config = path.join(work, 'config.json'); fs.writeFileSync(config,JSON.stringify({turbo:{enabled:false,url:`http://127.0.0.1:${apiPort}`}}));
  Object.assign(env,{CARTOGRAPHER_DEV_DIR:corpus,CARTOGRAPHER_CONFIG:config,CARTOGRAPHER_TURBO_STATE_DIR:path.join(work,'turbo'),CARTOGRAPHER_TURBO_URL:`http://127.0.0.1:${apiPort}`,CARTOGRAPHER_SEMANTIC:'0',CARTOGRAPHER_QDRANT_URL:'http://127.0.0.1:1',CARTOGRAPHER_EMBED_URL:'http://127.0.0.1:1/v1/embeddings',CARTOGRAPHER_CLAUDE_TRANSCRIPTS_DIR:path.dirname(transcript),CARTOGRAPHER_CODEX_TRANSCRIPTS_DIR:path.join(work,'codex'),CARTOGRAPHER_CODEX_ARCHIVED_DIR:path.join(work,'archives')});
  const vite = spawn(process.execPath,[path.join(root,'explorer/node_modules/vite/bin/vite.js'),...(process.argv.includes('--preview')?['preview']:[]),'--host','127.0.0.1','--port',String(uiPort),'--strictPort'],{cwd:path.join(root,'explorer'),env,stdio:['ignore','pipe','pipe']});
  let output='',browser,page; vite.stdout.on('data',d=>output+=d);vite.stderr.on('data',d=>output+=d);
  try {
    const origin = `http://127.0.0.1:${uiPort}`;
    for(let i=0;;i++){try{if((await fetch(origin)).ok)break;}catch{} if(i>100)throw Error(output);await pause(100);}
    browser=await chromium.launch({headless:true});page=await browser.newPage({viewport:{width:1200,height:950},reducedMotion:'reduce'});
    const errors=[],unwanted=[]; page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.url().includes('__unexpected_svg_request'))unwanted.push(r.url());});
    const response=await page.request.get(`${origin}/api/session/artifacts?path=${encodeURIComponent(transcript)}`);assert.equal(response.status(),200,await response.text());
    const data=await response.json(),available=data.artifacts.filter(a=>a.status==='available');
    assert.ok(available.length >= (live?12:6),JSON.stringify(data.artifacts.map(a=>({name:a.name,status:a.status,reason:a.reason}))));
    if(!live){ assert.deepEqual(data.documents.map(d=>d.name).sort(),['brief.md','notes.txt']); assert.equal(data.documents.find(d=>d.name==='brief.md').source,'created'); assert.equal(data.commits[0].shortHash,'abc1234'); assert.equal(data.artifacts.find(a=>a.name==='missing.png').status,'missing'); assert.notEqual(data.artifacts.find(a=>a.name==='not-an-image.png').status,'available'); }
    const imageResponse=await page.request.get(origin+available[0].previewUrl);assert.equal(imageResponse.status(),200);assert.match(imageResponse.headers()['content-type'],/^image\//);assert.match(imageResponse.headers()['content-security-policy'],/sandbox/);
    if(!live){const download=await page.request.get(origin+data.documents.find(d=>d.name==='brief.md').downloadUrl);assert.equal(download.status(),200);assert.equal(await download.text(),'# Created brief\n');assert.match(download.headers()['content-disposition'],/^attachment/);}
    const denied=await page.request.get(`${origin}/api/session/artifact?path=${encodeURIComponent(transcript)}&id=unrecorded`);assert.notEqual(denied.status(),200);
    await page.goto(origin+'/?view=sessions');
    const card=page.locator('.timeline-session-result').filter({hasText:title});await card.waitFor();
    await card.getByText('1 record in focus',{exact:true}).waitFor();
    if(!live){await card.getByRole('heading',{name:'Documents (2)',exact:true}).waitFor();await card.getByRole('heading',{name:'Commits (1)',exact:true}).waitFor();await card.getByText('brief.md',{exact:true}).waitFor();}
    await card.locator('.session-artifacts img').first().waitFor();
    await page.waitForFunction(()=>[...document.querySelectorAll('.session-card .session-artifacts img')].some(img=>img.complete&&img.naturalWidth>0));
    assert.equal(await card.locator('.session-artifacts img').count(),4);
    await card.getByRole('button',{name:`Show all ${available.length} images`,exact:true}).click();
    assert.equal(await card.locator('.session-artifacts img').count(),available.length);
    await card.getByRole('button',{name:'Show fewer images',exact:true}).click();
    assert.equal(await card.getByText('Open image ↗',{exact:true}).count(),0);
    assert.equal(await card.getByText('View transcript evidence',{exact:true}).count(),0);
    for(const icon of await card.locator('.session-artifact-icon').all()){ const box=await icon.boundingBox();if(box && await icon.isVisible()){assert.ok(box.width>=44&&box.height>=44,JSON.stringify({label:await icon.getAttribute('aria-label'),box}));assert.ok(await icon.getAttribute('aria-label'));} }
    if(!live){const sourceIcon=card.getByRole('link',{name:/View transcript evidence for graphic-/}).first(); await sourceIcon.click(); await page.waitForURL(url=>url.pathname.startsWith('/session/'));assert.ok(new URL(page.url()).searchParams.get('block'));await page.getByRole('button',{name:'back',exact:true}).click();await card.waitFor();}
    await card.evaluate(element => element.scrollIntoView({block:'start'}));
    await page.screenshot({path:path.join(artifacts,live?'actual-session-graphics.png':'session-graphics.png'),fullPage:true});
    for(const width of [581,390]){await page.setViewportSize({width,height:900});await page.waitForTimeout(50);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.screenshot({path:path.join(artifacts,`${live?'actual':'fixture'}-graphics-${width}.png`),fullPage:true});}
    await page.setViewportSize({width:1200,height:950});
    await card.getByRole('button',{name:'Inspect evidence',exact:true}).click();
    const inspector=page.getByRole('complementary',{name:'Evidence inspector'});await inspector.locator('.session-artifacts img').first().waitFor();
    await page.goto(`${origin}/session/${encodeURIComponent(transcript)}`);
    await page.locator('#transcript-viewer .session-artifacts img').first().waitFor();
    const summary=page.getByLabel('Session summary',{exact:true});
    await summary.waitFor();
    assert.equal(await page.locator('.tr-tool').count(),0,'Default review must not be a tool log');
    if(!live){await summary.getByText('The guide ties graphics to named evidence.',{exact:true}).waitFor();await summary.getByText('Review the phone layout.',{exact:true}).waitFor();await summary.getByRole('heading',{name:'Last response',exact:true}).waitFor();await summary.locator('strong').getByText('the brief',{exact:true}).waitFor();await summary.locator('code').getByText('source.md',{exact:true}).waitFor();await summary.getByRole('link',{name:/Visual evidence guide/}).waitFor();}
    await page.screenshot({path:path.join(artifacts,live?'actual-session-summary.png':'fixture-session-summary.png'),fullPage:true});
    const {captureCopy:summaryCopy,writeCopyReport:saveSummaryCopy}=require('./helpers/repeated-copy.cjs');
    const summaryReport=await summaryCopy(page,live?'actual-summary':'fixture-summary');
    saveSummaryCopy(path.join(artifacts,live?'actual-summary-copy.json':'fixture-summary-copy.json'),[summaryReport]);
    assert.ok(summaryReport.boilerplatePercent<=5,JSON.stringify(summaryReport));
    assert.deepEqual(summaryReport.glyphControls.filter(item=>item.issue),[]);
    await page.setViewportSize({width:390,height:900});
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
    await page.screenshot({path:path.join(artifacts,live?'actual-summary-390.png':'fixture-summary-390.png')});
    await page.setViewportSize({width:1200,height:950});
    if(interactionAudit){
      const directory=summary.locator('.path-context > summary').first();
      if(await directory.count()) { const type=await directory.evaluate(el=>({size:parseFloat(getComputedStyle(el).fontSize),weight:Number(getComputedStyle(el).fontWeight)}));assert.ok(type.size>=16 && type.weight>=500); }
      if(await directory.count()) interactionFindings.push({id:'IA-05',probe:'Shared-directory type size',observed:await directory.evaluate(el=>({fontSize:getComputedStyle(el).fontSize,fontWeight:getComputedStyle(el).fontWeight})),expected:'At least 16px / weight 500'});
      await page.getByRole('button',{name:'Conversation',exact:true}).click();
      await page.reload();
      await page.locator('#transcript-toolbar').waitFor();
      assert.equal(await page.getByRole('button',{name:'Conversation',exact:true}).getAttribute('aria-pressed'),'true');
      await page.getByRole('button',{name:'Summary',exact:true}).click();
      await page.goBack();
      assert.equal(await page.getByRole('button',{name:'Conversation',exact:true}).getAttribute('aria-pressed'),'true');
      interactionFindings.push({id:'IA-04',probe:'Conversation mode after reload',observed:await page.getByRole('button',{name:'Summary',exact:true}).getAttribute('aria-pressed')==='true'?'Summary':'Conversation',expected:'Conversation'});
    }
    await page.getByRole('button',{name:'Conversation',exact:true}).click();
    if(!live){
      const bundle=page.locator('.tr-web-results li').filter({hasText:'Visual evidence guide'});
      assert.equal(await bundle.getByRole('link',{name:/Visual evidence guide/}).getAttribute('href'),'https://example.com/guide');
      await bundle.locator('.tr-fetched-page > summary').click();
      await bundle.locator('.tr-fetch-content').getByText('Retrieved guide',{exact:true}).waitFor();
      assert.equal(await page.locator('a[href^=\"javascript:\"]').count(),0);
      assert.equal(await page.evaluate(()=>window.injected),undefined);
      await bundle.getByRole('button',{name:'View fetch evidence for Visual evidence guide'}).click();
      assert.ok(new URL(page.url()).searchParams.get('block').startsWith('web-fetch-result'));
      await page.getByRole('button',{name:'Review with search results ↑'}).click();
      assert.ok(new URL(page.url()).searchParams.get('block').startsWith('web-search-result'));
    }
    if(live){
      const searchLinks=page.locator('.tr-web-results a');
      assert.ok(await searchLinks.count()>0,'Recorded WebSearch results should be links');
      assert.equal(await page.locator('.tr-fetched-page').count(),2);
      assert.equal(await page.locator('.tr-fetched-page[data-error=true]').count(),1);
      assert.ok((await searchLinks.first().getAttribute('href')).startsWith('https://'));
      await searchLinks.first().scrollIntoViewIfNeeded();
      await page.screenshot({path:path.join(artifacts,'actual-search-links.png')});
      const retrieved=page.locator('.tr-fetched-page:not([data-error])');
      await retrieved.locator(':scope > summary').click();
      await retrieved.scrollIntoViewIfNeeded();
      await page.screenshot({path:path.join(artifacts,'actual-search-fetch-bundle.png')});
      await retrieved.locator(':scope > summary').click();
    }
    assert.equal(await page.locator('.tr-fetched-page:not([open]) .tr-fetch-expanded:visible').count(),0,'Closed fetch bundles must not repeat their expanded-state label');
    const {captureCopy,writeCopyReport}=require('./helpers/repeated-copy.cjs');
    writeCopyReport(path.join(artifacts,live?'actual-reader-copy.json':'fixture-reader-copy.json'),[await captureCopy(page,live?'actual-transcript':'fixture-transcript')]);
    const toolRows=page.locator('#transcript-viewer .tr-tool');
    assert.ok(await toolRows.count()>0);
    assert.equal(await toolRows.locator('summary').getByText('Result recorded',{exact:true}).count(),0);
    const namedTool=toolRows.filter({hasText: live ? 'Write ·' : 'Read ·'}).first();
    await namedTool.scrollIntoViewIfNeeded();
    await page.screenshot({path:path.join(artifacts,live?'actual-reader-evidence.png':'fixture-reader-evidence.png')});
    await page.setViewportSize({width:390,height:900});
    const backToConversation=page.getByRole('button',{name:'Back to conversation',exact:true});
    if(await backToConversation.isVisible())await backToConversation.click();
    await namedTool.scrollIntoViewIfNeeded();
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
    await page.screenshot({path:path.join(artifacts,live?'actual-reader-evidence-390.png':'fixture-reader-evidence-390.png')});

    if(!live){ const isolatedImage=await browser.newPage(); await isolatedImage.goto(origin+available[0].previewUrl); assert.equal(await isolatedImage.evaluate(()=>window.artifactRan),undefined); await isolatedImage.close(); }
    assert.equal(await page.evaluate(()=>window.artifactRan),undefined);assert.deepEqual(unwanted,[]);assert.deepEqual(errors,[]);
    if(!live){
      const commitsPage=await browser.newPage();await commitsPage.goto(origin+'/?view=sessions');
      const commitCard=commitsPage.locator('.timeline-session-result').filter({hasText:'Commit-only task'});
      await commitCard.getByRole('heading',{name:'Commits (1)',exact:true}).waitFor();
      assert.equal(await commitCard.locator('[data-artifact-kind=images]').count(),0);assert.equal(await commitCard.locator('[data-artifact-kind=documents]').count(),0);
      await commitCard.getByRole('link',{name:'View commit evidence for Canonical change',exact:true}).click();
      await commitsPage.waitForURL(url=>url.pathname==='/timeline'&&url.searchParams.get('q')==='canonical-commit');
      await commitsPage.getByText(/Canonical change/).first().waitFor();await commitsPage.close();
      const pairedPage=await browser.newPage({viewport:{width:1200,height:950}});
      await pairedPage.goto(origin+'/?view=sessions');
      const pairedCard=pairedPage.locator('.timeline-session-result').filter({hasText:'Paired commit sources'});
      await pairedCard.waitFor();
      await pairedCard.scrollIntoViewIfNeeded();
      await pairedCard.getByRole('heading',{name:'Commits (2)',exact:true}).waitFor();
      const pairedRows=pairedCard.locator('[data-artifact-kind=commits] .session-artifact-outputs > li');
      assert.equal(await pairedRows.count(),2);
      {
        const row=pairedRows.first(),details=row.locator('.session-artifact-references'),toggle=details.locator('summary');
        const bounds=await row.boundingBox(),target=await toggle.boundingBox();
        await row.locator('.session-artifact-output-title strong').click();
        const titleOpened=await details.evaluate(el=>el.open);
        if(titleOpened)await toggle.click();
        await row.click({position:{x:bounds.width/2,y:bounds.height/2}});
        const whitespaceOpened=await details.evaluate(el=>el.open);
        if(whitespaceOpened)await toggle.click();
        await toggle.locator('svg').click();
        const iconOpened=await details.evaluate(el=>el.open);
        await toggle.click();
        assert.ok(titleOpened && whitespaceOpened && iconOpened,'The whole commit header must activate its sole action');
        assert.ok(target.width*target.height/(bounds.width*bounds.height)>0.95,'At least 95% of the closed row must be actionable');
        await toggle.focus();await pairedPage.keyboard.press('Space');
        assert.equal(await details.evaluate(el=>el.open),true);
        await pairedPage.keyboard.press('Space');
        assert.equal(await details.evaluate(el=>el.open),false);
        assert.equal(await row.locator('a:visible,button:visible,summary:visible').count(),1);
        interactionFindings.push({id:'IA-01',probe:'Single-action commit row',observed:{titleOpened,whitespaceOpened,iconOpened,row:bounds,target,activeAreaPercent:Math.round(target.width*target.height/(bounds.width*bounds.height)*1000)/10},expected:'Title and row space activate the same disclosure as the icon'});
        await row.screenshot({path:path.join(artifacts,'audit-whole-commit-row.png')});
      }
      for(const row of await pairedRows.all()){
        const toggle=row.locator('.session-artifact-references > summary');
        await toggle.focus();await pairedPage.keyboard.press('Enter');
        await row.getByRole('link',{name:/Commit record for/}).waitFor();
        await row.getByRole('link',{name:/Git output for/}).waitFor();
        assert.deepEqual(await row.locator('.session-artifact-source-link').allTextContents(),['Commit record','Git output']);
        assert.equal(await row.locator('.session-artifact-ref-count:visible').count(),0);
        const bounds=await row.boundingBox(), list=await row.locator('.session-artifact-reference-list').boundingBox();
        assert.ok(Math.abs(bounds.x-list.x)<2 && list.width>bounds.width-24,'Expanded evidence must use the row width');
        assert.ok(bounds.height<180,'Two short evidence links should not create an oversized row');
      }
      await pairedCard.screenshot({path:path.join(artifacts,'expanded-commit-evidence.png')});
      await pairedPage.setViewportSize({width:390,height:900});
      assert.ok(await pairedPage.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
      const firstBounds=await pairedRows.first().boundingBox(),secondBounds=await pairedRows.nth(1).boundingBox();
      assert.ok(firstBounds.y+firstBounds.height<=secondBounds.y+1,'Expanded rows must not overlap');
      await pairedCard.screenshot({path:path.join(artifacts,'expanded-commit-evidence-390.png')});
      const eventHref=await pairedRows.first().getByRole('link',{name:/Commit record for/}).getAttribute('href');
      const outputHref=await pairedRows.first().getByRole('link',{name:/Git output for/}).getAttribute('href');
      assert.equal(new URL(eventHref,origin).searchParams.get('q'),'event-cafe123');
      assert.ok(new URL(outputHref,origin).searchParams.get('block').startsWith('result-cafe123'));
      await pairedRows.first().locator('summary').focus();await pairedPage.keyboard.press('Enter');
      assert.equal(await pairedRows.first().getByRole('link',{name:/Git output for/}).isVisible(),false);
      assert.equal(await pairedRows.nth(1).getByRole('link',{name:/Git output for/}).isVisible(),true);
      await pairedPage.goto(origin+outputHref);
      await pairedPage.locator('.tr-tool[data-active=true] pre').getByText('[main cafe123] Record launch variety',{exact:true}).waitFor();
      await pairedPage.goto(origin+eventHref);
      assert.equal(new URL(pairedPage.url()).searchParams.get('q'),'event-cafe123');
      await pairedPage.getByText(/Record launch variety/).first().waitFor();
      const eventGroup=pairedPage.locator('.event-group').filter({hasText:'Record launch variety'});
      assert.equal(await eventGroup.locator(':scope > button').getAttribute('aria-expanded'),'true');
      await eventGroup.locator(':scope > button').click();
      assert.equal(await pairedPage.getByText(/Record launch variety/).count(),0,'The source group must still be collapsible');
      await pairedPage.close();
      await page.goto(`${origin}/session/${encodeURIComponent(path.join(transcripts,'codex-review.jsonl'))}`);
      await page.getByLabel('Session summary',{exact:true}).getByText('The package declares Capacitor. Device validation remains pending.',{exact:true}).waitFor();
      assert.equal(await page.locator('.tr-tool').count(),0);
      await page.getByRole('button',{name:'Conversation',exact:true}).click();
      const command=page.locator('.tr-tool').filter({hasText:'Commands · rg -n Capacitor'});
      await command.locator(':scope > summary').click();
      await command.locator('.tr-tool-result pre').getByText('Capacitor dependency found in Package.swift',{exact:true}).waitFor();
      assert.equal(await command.getByRole('button',{name:/Go to result/}).count(),0);
      const structuredResult=page.locator('.tr-tool').filter({hasText:'validation'});
      await structuredResult.locator(':scope > summary').click();
      await structuredResult.locator('dt').getByText('passed',{exact:true}).waitFor();
      assert.equal(await structuredResult.locator('dd').first().innerText(),'3');
      assert.equal(await page.locator('.tr-tool[open] > summary .tr-tool-preview:visible').count(),0,'Expanded evidence replaces its preview');
      const rendered=await page.locator('#transcript-viewer').innerText();
      assert.doesNotMatch(rendered,/Promise\.allSettled|tools\.exec_command|chunk_id|wall_time_seconds|Script completed|inspect-dependency|\{"status"/);
      await page.screenshot({path:path.join(artifacts,'codex-rendered-evidence.png')});
      for(const file of ['empty-session.jsonl','missing-only.jsonl']){
        const source=path.join(transcripts,file);
        const settled=page.waitForResponse(response=>{const url=new URL(response.url());return url.pathname==='/api/session/artifacts'&&url.searchParams.get('path')===source;});
        await page.goto(`${origin}/session/${encodeURIComponent(source)}`);
        const evidence=page.locator('#transcript-toolbar').getByRole('button',{name:'Evidence',exact:true});
        await evidence.waitFor();
        if(await evidence.getAttribute('aria-pressed')!=='true')await evidence.click();
        await settled;
        await page.waitForFunction(()=>!document.querySelector('.session-artifacts'));
        assert.equal(await page.getByText(/(?:Images|Documents|Commits|Session graphics) \(0\)/).count(),0);
        assert.equal(await page.getByText(/No recorded image references|Transcript unavailable; image references/).count(),0);
        await page.screenshot({path:path.join(artifacts,`${file}-empty.png`)});
      }
    }
    if(interactionAudit){fs.writeFileSync(path.join(artifacts,'interaction-audit.json'),JSON.stringify(interactionFindings,null,2)+'\n');console.log('INTERACTION AUDIT '+JSON.stringify(interactionFindings));}
    console.log(`PASS: ${available.length} available graphics from a one-record session, card/inspector/reader previews, missing/unsafe files, inert SVG, 390/581 layout; artifacts: ${artifacts}`);
  } catch(error){if(page)await page.screenshot({path:path.join(artifacts,'failure.png'),fullPage:true}).catch(()=>{});console.error(output);throw error;}
  finally{if(browser)await browser.close();vite.kill('SIGTERM');await new Promise(r=>vite.once('exit',r));fs.rmSync(work,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
