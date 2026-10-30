import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReviewBundles, fetchSummary } from '../../explorer/src/components/review-bundles.js';
const search=(id,url,agentId='')=>({uuid:id,agentId,blocks:[{id,type:'tool_result',name:'WebSearch',output:'Links: '+JSON.stringify([{title:'Page '+id,url}])}]});
const fetch=(id,url,agentId='',output='Retrieved article')=>[
  {uuid:id,agentId,blocks:[{id,type:'tool_call',name:'WebFetch',input:{url,prompt:'Find the quoted passage'},resultIds:[id+'-result']}]},
  {uuid:id+'-reply',agentId,blocks:[{id:id+'-result',messageId:id+'-reply',type:'tool_result',name:'WebFetch',callBlockId:id,output}]},
];
test('review bundles attach subsequent fetches and retries to the nearest preceding matching search',()=>{
 const url='https://example.com/article?q=one';
 const messages=[...fetch('before',url),search('first',url),...fetch('one',url+'#quote'),...fetch('retry',url,'','The server returned HTTP 403 Forbidden.'),search('second',url),...fetch('two',url),...fetch('other-query','https://example.com/article?q=two'),...fetch('other-agent',url,'sidechain')];
 const original=JSON.stringify(messages), bundles=buildReviewBundles(messages);
 assert.deepEqual(bundles.searches.get('first')[0].fetches.map(f=>f.call.id),['one','retry']);
 assert.deepEqual(bundles.searches.get('second')[0].fetches.map(f=>f.call.id),['two']);
 assert.equal(bundles.memberships.get('one-result').searchBlockId,'first');
 for(const id of ['before','other-query','other-agent'])assert.equal(bundles.memberships.has(id),false);
 assert.equal(fetchSummary(bundles.searches.get('first')[0].fetches[1].results[0]).error,true);
 assert.equal(JSON.stringify(messages),original,'A review view must not rewrite the transcript');
});
test('missing fetch results remain attempts, not success or an unrelated attachment',()=>{
 const url='https://example.com/page';
 const call=fetch('pending',url)[0];
 call.blocks[0].resultIds=[];
 const bundle=buildReviewBundles([search('s',url),call]);
 assert.equal(bundle.searches.get('s')[0].fetches[0].results.length,0);
});
