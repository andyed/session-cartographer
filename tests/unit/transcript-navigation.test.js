import test from 'node:test';
import assert from 'node:assert/strict';
import { transcriptMatches, resolveTranscriptLocation, safeTranscriptReturn } from '../../explorer/src/components/transcript-navigation.js';
const messages = [
  { uuid: 'u', sourceUuid: 'source', role: 'user', blocks: [{ id: 'u:0', type: 'text', text: 'find C++ and E2' }] },
  { uuid: 'a', role: 'assistant', blocks: [{ id: 'a:0', type: 'tool_call', name: 'Bash', input: { command: 'E2' } }] },
  { uuid: 'r', role: 'tool', blocks: [{ id: 'r:0', type: 'tool_result', name: 'Bash', output: 'x'.repeat(2000) + 'E2 failure' }] },
];
test('literal short queries cover text, input and untruncated output in chronology', () => {
  const hits = transcriptMatches(messages, 'e2');
  assert.deepEqual(hits.map(hit => hit.blockId), ['u:0', 'a:0', 'r:0']);
  assert.match(hits[2].snippet, /E2 failure/);
  assert.equal(transcriptMatches(messages, 'C++').length, 1);
  assert.equal(transcriptMatches(messages, ' ').length, 0);
});
test('legacy plain messages stay searchable and source IDs resolve without DOM collisions', () => {
  assert.equal(transcriptMatches([{uuid:'legacy',content:'old conversation'}], 'old')[0].blockId, 'legacy-text');
  assert.deepEqual(resolveTranscriptLocation(messages, 'source', 'u:0'), {messageId:'u',blockId:'u:0'});
  assert.deepEqual(resolveTranscriptLocation(messages, 'unknown', 'r:0'), {messageId:'r',blockId:'r:0'});
  assert.equal(resolveTranscriptLocation(messages, 'missing'), null);
});
test('unrecognized retained metadata remains searchable', () => {
  const hits = transcriptMatches([{uuid:'meta', blocks:[{id:'meta:0',type:'attachment',label:'Unknown record',metadata:{status:'pending evidence'}}]}], 'pending');
  assert.equal(hits[0].blockId, 'meta:0');
});
test('return URLs preserve local scope but reject external or malformed destinations', () => {
  assert.equal(safeTranscriptReturn('/memory?project=carto&from=12'), '/memory?project=carto&from=12');
  assert.equal(safeTranscriptReturn('/explorer/timeline?session=a', '/explorer/'), '/explorer/timeline?session=a');
  for (const value of ['https://elsewhere.test', '//elsewhere.test', '/\\elsewhere.test', '/session/x', '/memory/../../bad']) assert.equal(safeTranscriptReturn(value), null);
});

test('an absent navigation target must not select an anonymous Codex source record',()=>{
  assert.equal(resolveTranscriptLocation([{uuid:'generated',sourceUuid:''}], '', null),null);
  assert.equal(resolveTranscriptLocation([{uuid:'generated'}], undefined, null),null);
});

test('operation bundles retain exact result anchors without folding orphan, filtered or research evidence', async () => {
  const {operationBundles}=await import('../../explorer/src/components/transcript-navigation.js');
  const call={uuid:'call-message',blocks:[{id:'call',type:'tool_call',name:'Bash',resultIds:['one','two','missing']}]};
  const result={uuid:'result-message',blocks:[{id:'one',type:'tool_result',callBlockId:'call',output:'ok'},{id:'two',type:'tool_result',callBlockId:'call',isError:true,output:'failed'},{id:'orphan',type:'tool_result',output:'unpaired'}]};
  const bundled=operationBundles([call,result]);
  assert.deepEqual([...bundled.owners.keys()],['one','two']);
  assert.equal(bundled.results.get('call')[1].messageId,'result-message');
  assert.equal(bundled.results.get('call')[1].isError,true);
  assert.equal(operationBundles([result]).owners.size,0,'Filtering out a call must not hide its results');
  assert.equal(operationBundles([call,result],{searches:new Map([['one',[]]]),memberships:new Map([['two',{}]])}).owners.size,0);
});
