import test from 'node:test';
import assert from 'node:assert/strict';
import copy from '../browser/helpers/repeated-copy.cjs';
test('boilerplate metric counts excess repeated UI words without diluting them with source prose',()=>{
  const rows=[...Array.from({length:4},()=>({text:'Result recorded',content:false,selector:'span'})),{text:'Different useful label',content:false},{text:'Source text '.repeat(500),content:true}];
  const score=copy.scoreCopy(rows);
  assert.equal(score.excessWords,6);
  assert.equal(score.interfaceWords,11);
  assert.equal(score.boilerplatePercent,54.55);
  assert.equal(copy.scoreCopy(rows.slice(0,1)).boilerplatePercent,0);
  assert.equal(copy.scoreCopy([{text:'Open image',content:false},{text:'Open   image',content:false}]).excessWords,2);
});
