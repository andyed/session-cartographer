import test from 'node:test';
import assert from 'node:assert/strict';
import { sessionReview, recordedSections } from '../../explorer/src/components/session-review.js';
const prose = (uuid, text, extra = {}) => ({ uuid, role: 'assistant', blocks: [{id:uuid+'-text',type:'text',text}], ...extra });

test('review retains earlier findings and later decisions with exact sources, without promoting tool errors to open issues', () => {
  const review = sessionReview([
    prose('early','## Findings\nThe release uses two repositories.\n## Next steps\nValidate the phone.'),
    prose('side','## Decisions\nIgnore the phone.',{isSidechain:true}),
    {uuid:'error',role:'user',blocks:[{id:'err',type:'tool_result',name:'Bash',isError:true,output:'Earlier attempt failed'}]},
    prose('late','**Decisions**\nKeep the existing navigation.\n## Validation\nPhone check passed.\n## Notes\nNot a conclusion category.'),
    prose('last','Ready for your review.'),
  ], {searches:new Map()});
  assert.deepEqual(review.sections.map(s=>[s.kind,s.text,s.messageId,s.blockId]),[
    ['findings','The release uses two repositories.','early','early-text'],
    ['next','Validate the phone.','early','early-text'],
    ['decisions','Keep the existing navigation.','late','late-text'],
    ['validation','Phone check passed.','late','late-text'],
  ]);
  assert.equal(review.conclusion.text,'Ready for your review.');
  assert.equal(review.failures.length,1);
  assert.equal('unresolved' in review,false);
});

test('literal headings only: fenced examples and unlabeled speculation are not conclusions; exact repeats retain latest provenance', () => {
  const items=[
    {messageId:'a',blockId:'a',text:'```md\n## Findings\nA fake example.\n```\nWe should probably ship.\n## Findings\nA recorded finding.'},
    {messageId:'b',blockId:'b',text:'## Findings\nA recorded finding.\n## Other\nExcluded.'},
  ];
  const original=JSON.stringify(items), sections=recordedSections(items);
  assert.equal(sections.length,1);
  assert.equal(sections[0].text,'A recorded finding.');
  assert.equal(sections[0].blockId,'b');
  assert.equal(JSON.stringify(items),original);
});
