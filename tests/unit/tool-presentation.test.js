import test from 'node:test';
import assert from 'node:assert/strict';
import { toolPresentation, messagePresentation } from '../../explorer/src/components/tool-presentation.js';

test('collapsed tool evidence exposes specific work without inventing success', () => {
  const write = {type:'tool_call',name:'Write',input:{file_path:'/tmp/output.html',content:'x'.repeat(6000)},status:'returned'};
  assert.deepEqual(toolPresentation(write), {title:'Write · output.html',detail:'/tmp/output.html',status:''});
  const command = {type:'tool_call',name:'Bash',input:JSON.stringify({command:'magick source.png -resize 50% preview.png',description:'Render preview'}),status:'returned'};
  assert.match(toolPresentation(command).title, /Render preview/);
  assert.equal(toolPresentation(command).detail, '');
  assert.deepEqual(toolPresentation(command).cues.filter(cue=>cue.kind==='file').map(cue=>cue.text), ['source.png','preview.png']);
  const result = {type:'tool_result',name:'Bash',output:[{type:'text',text:'preview.png PNG 640x480'}],status:'returned'};
  assert.deepEqual(toolPresentation(result,command), {title:'Render preview · Response',detail:'preview.png PNG 640x480',status:'',cues:[]});
  assert.equal(toolPresentation({...result,status:'error'},command).status,'Error');
  assert.equal(toolPresentation({...command,status:'missing-result'}).status,'No result recorded');
  assert.equal(toolPresentation({...result,orphan:true}).status,'Call unavailable');
  assert.equal(write.input.content.length,6000);
});

test('transport-only results are not human messages and do not acquire prose expand buttons', () => {
  const blocks=[{type:'tool_result',output:'x'.repeat(6000)}];
  assert.deepEqual(messagePresentation({role:'user'},blocks),{toolOnly:true,textLength:0,role:'tool'});
  assert.deepEqual(messagePresentation({role:'user'},[...blocks,{type:'text',text:'Please revise.'}]),{toolOnly:false,textLength:14,role:'user'});
  assert.equal(messagePresentation({role:'assistant'},[{type:'thinking',text:'x'.repeat(6000)}]).textLength,0);
});

test('WebSearch turns recorded links into safe, deduplicated destinations', async () => {
  const {searchResultLinks}=await import('../../explorer/src/components/tool-presentation.js');
  const block={type:'tool_result',name:'WebSearch',output:'Web search results\nLinks: '+JSON.stringify([{title:'Title with ] bracket',url:'https://example.com/article'},{title:'Duplicate',url:'https://example.com/article'},{title:'bad',url:'javascript:alert(1)'},{title:'bad',url:'file:///etc/passwd'}])+'\nResult prose'};
  assert.deepEqual(searchResultLinks(block),[{title:'Title with ] bracket',url:'https://example.com/article',domain:'example.com'}]);
  assert.deepEqual(searchResultLinks({...block,output:'Links: [{"title":"Truncated", "url":"https://exa'}),[]);
  assert.deepEqual(searchResultLinks({...block,name:'Bash'}),[]);
});
