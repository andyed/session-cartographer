import test from 'node:test';
import assert from 'node:assert/strict';
import {displayValue,readableText} from '../../explorer/src/components/evidence-content.js';
import {toolInput,toolPresentation} from '../../explorer/src/components/tool-presentation.js';
import {literalToolInputs} from '../../explorer/shared/literal-tool-inputs.js';
import {sessionReview} from '../../explorer/src/components/session-review.js';

test('Codex script and Promise envelopes preserve useful output without transport',()=>{
  const raw='Script completed\nWall time 4.9 seconds\nOutput: '+JSON.stringify({status:'fulfilled',value:{chunk_id:'abc',wall_time_seconds:4.9,exit_code:0,original_token_count:1943,output:'Package.swift\nCapacitor.swiftmodule'}});
  assert.equal(displayValue(raw),'Package.swift\nCapacitor.swiftmodule');
  assert.deepEqual(displayValue({output:'failure',exit_code:3}),{'Exit code':3,Response:'failure'});
  assert.deepEqual(displayValue({status:'rejected',reason:{message:'Network unavailable'}}),{Error:{message:'Network unavailable'}});
  assert.deepEqual(displayValue('{"output":"one"}\n{"output":"two"}'),['one','two']);
  assert.equal(displayValue('Script completed\nOutput: {"chunk_id":"abc", "output":"clipped'),null);
  assert.deepEqual(displayValue({file_path:'/tmp/brief.md',content:'The brief'}),{file_path:'/tmp/brief.md',content:'The brief'});
  assert.deepEqual(displayValue({isError:true,content:'Permission denied'}),{Error:'Permission denied'});
  assert.deepEqual(displayValue('Counts: {"passed":3,"failed":0} Done.'),['Counts:',{passed:3,failed:0},'Done.']);
  assert.deepEqual(displayValue('```json\n{"passed":3}\n```'),[{passed:3}]);
  assert.equal(displayValue('[main abc1234] Commit subject'),'[main abc1234] Commit subject');
  assert.deepEqual(displayValue('{"passed":3,"failures":0}'),{passed:3,failures:0});
  assert.equal(readableText({content:[{type:'text',text:'Found the dependency'},{type:'image',data:'opaque'}]}),'Found the dependency');
});

test('orchestration is decoded, never evaluated or printed; backend still requires workdir',()=>{
  const input='for (const r of await Promise.allSettled([tools.exec_command({cmd:"rg -n Capacitor Package.swift"}),tools.exec_command({cmd:"ls apps/capacitor"})])) text(r);';
  assert.deepEqual(toolInput({input}),[{Command:'rg -n Capacitor Package.swift'},{Command:'ls apps/capacitor'}]);
  assert.deepEqual(literalToolInputs(input),[]);
  const presentation=toolPresentation({type:'tool_call',name:'exec',input});
  assert.doesNotMatch(presentation.title+presentation.detail,/Promise|tools\.|text\(|\{"/);
  assert.match(presentation.title,/rg -n Capacitor/);
  assert.equal(displayValue('text(await tools.exec_command({cmd:"ls"}))'),null);
});

test('summary selects main human prose, deduplicates research and retains failures without declaring them unresolved',()=>{
  const messages=[{uuid:'request',role:'user',blocks:[{id:'q',type:'text',text:'Create a report'}]},
    {uuid:'done',role:'assistant',blocks:[{id:'a',type:'text',text:'Report drafted; review still required.'}]},
    {uuid:'tool',role:'user',blocks:[{id:'r',type:'tool_result',status:'error',output:{exit_code:2,output:'Permission denied'}}]},
    {uuid:'side',role:'assistant',isSidechain:true,blocks:[{id:'s',type:'text',text:'Side task finished'}]},
    {uuid:'noise',role:'assistant',noise:'system',blocks:[{id:'n',type:'text',text:'Boilerplate'}]}];
  const review=sessionReview(messages,{searches:new Map([['q',[{url:'https://example.com',title:'A',fetches:[]}]],['a',[{url:'https://example.com',title:'B',fetches:[]}] ]])});
  assert.equal(review.conclusion.blockId,'a');assert.equal(review.request.blockId,'q');
  assert.equal(review.pages.length,1);assert.equal(review.pages[0].blockId,'a');
  assert.equal(review.failures.length,1);assert.match(review.failures[0].text,/Permission denied/);
});
