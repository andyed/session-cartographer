import test from 'node:test';
import assert from 'node:assert/strict';
import { groupSearchResults, visibleSearchMembers } from '../../explorer/src/components/search-results.js';
import { eventTranscriptHref, eventTranscriptHighlight } from '../../explorer/src/components/event-navigation.js';

test('same prefixes do not merge distinct full text; equal text retains all source identities and ranks', () => {
  const prefix='A shared prefix '.repeat(12);
  const rows=[
    {event_id:'first',summary:prefix+'one',session_id:'a',uuid:'first-source'},
    {event_id:'second',summary:prefix+'two',session_id:'b'},
    {event_id:'third',summary:prefix+'one',session_id:'c',uuid:'third-source'},
    {event_id:'no-text-a'}, {event_id:'no-text-b'},
  ];
  const original=JSON.stringify(rows), groups=groupSearchResults(rows);
  assert.equal(groups.length,4);
  assert.deepEqual(groups[0].members.map(m=>[m.event.event_id,m.event.session_id,m.rank]),[['first','a',1],['third','c',3]]);
  assert.deepEqual(visibleSearchMembers(groups,new Set()).map(m=>m.event.event_id),['first','second','no-text-a','no-text-b']);
  assert.deepEqual(visibleSearchMembers(groups,new Set([groups[0].key])).map(m=>m.event.event_id),['first','third','second','no-text-a','no-text-b']);
  assert.deepEqual(groups.flatMap(group=>group.members).map(m=>m.rank).sort((a,b)=>a-b),[1,2,3,4,5]);
  assert.equal(JSON.stringify(rows),original);
  assert.deepEqual(groupSearchResults([rows[2],rows[4]],new Map(rows.map((row,index)=>[row,index+1]))).map(g=>g.members[0].rank),[3,5],'Filtering must not invent new retrieval ranks');
});

test('group identity does not normalize differing text, and missing event IDs still get unique UI keys', () => {
  const groups=groupSearchResults([{summary:'Same'},{summary:'same'},{summary:'Same'},{summary:'Same '}]);
  assert.equal(groups.length,3);
  assert.equal(new Set(groups.flatMap(g=>g.members.map(m=>m.key))).size,4);
  assert.equal(groupSearchResults([{display:'First visible account',summary:'same metadata'},{display:'Second visible account',summary:'same metadata'}]).length,2,'Display takes priority over summary, matching EventCard');
});

test('native transcript destinations encode paths and preserve exact sources and return scope', () => {
  const event={transcript_path:'/tmp/a?#file.jsonl',uuid:'message',block_id:'message--block-2',summary:'An unrelated summary'};
  const url=new URL(eventTranscriptHref(event,'/memory?project=one&session=s'), 'http://127.0.0.1:2527');
  assert.equal(url.origin,'http://127.0.0.1:2527');
  assert.equal(decodeURIComponent(url.pathname.slice('/session/'.length)),event.transcript_path);
  assert.equal(url.searchParams.get('uuid'),'message');
  assert.equal(url.searchParams.get('block'),'message--block-2');
  assert.equal(url.searchParams.get('return'),'/memory?project=one&session=s');
  assert.equal(url.searchParams.get('reader'),'conversation');
  assert.equal(url.searchParams.has('highlight'),false,'An exact source must not be replaced by a guessed highlight');
  assert.equal(eventTranscriptHref({},'/memory'),null);
  assert.ok(eventTranscriptHref({transcript_path:'https://evil.test/x'},'/memory').startsWith('/session/https%3A%2F%2F'));
  assert.equal(eventTranscriptHighlight({summary:'x'.repeat(100)}).length,80);
});
