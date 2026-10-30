import test from 'node:test';
import assert from 'node:assert/strict';
import {commandReview} from '../../explorer/src/components/command-review.js';
import {toolPresentation,toolInput} from '../../explorer/src/components/tool-presentation.js';
const root='/Users/fixture/Documents/dev/worktrees/renderer-thermal-perf';
const command=`cd ${root} && grep -rn -E 'film=original|film=|solverAB|potential dispatches' --include=*.swift . | head; git status --short`;

test('deep search subjects survive long checkout prefixes without shell preview',()=>{
  const input={command,description:'Locate the solver A/B harness source'};
  const shown=toolPresentation({type:'tool_call',name:'Bash',input});
  assert.equal(shown.title,input.description);assert.equal(shown.detail,'');
  for(const term of ['film=original','solverAB','potential dispatches','*.swift','Git status']) assert.ok(shown.cues.some(c=>c.text===term),term);
  assert.doesNotMatch(JSON.stringify(shown),/Users|head|--include|&&/);
  assert.equal(input.command,command);
  assert.ok(toolPresentation({type:'tool_call',name:'Bash',input:command}).cues.some(c=>c.text==='solverAB'));
  assert.equal(toolPresentation({type:'tool_call',name:'Bash',input:command}).detail,'');
  assert.deepEqual(commandReview({...input,command:command.replace(root,root+'/much/longer/directory')}),commandReview(input));
});
test('quoted operators and regex syntax expose literal anchors, with exact pattern retained',()=>{
  const shown=commandReview({cmd:`sed -n 20,40p App/ShowRenderer.swift; grep -n -E 'framesPerSecond\\s*=|"fps"|forK' App/ShowRenderer.swift`});
  assert.equal(shown.title,'Read');
  for(const term of ['framesPerSecond','fps','forK','App/ShowRenderer.swift','Search']) assert.ok(shown.cues.some(c=>c.text===term),term);
  assert.match(shown.cues.find(c=>c.text==='framesPerSecond').source,/\\s/);
  assert.ok(!shown.cues.some(c=>['n','E','s','20,40p'].includes(c.text)));
});
test('search options consume their values without swallowing or inventing a query',()=>{
  const shown=commandReview({cmd:`rg -g '*.swift' -C 3 --regexp='solverAB|film' -- src/ShowRenderer.swift`});
  assert.deepEqual(shown.cues.filter(c=>c.kind==='term').map(c=>c.text),['solverAB','film']);
  assert.equal(commandReview({cmd:'rg --files -g "*.swift"'}).cues.filter(c=>c.kind==='term').length,0);
  assert.equal(commandReview({cmd:'grep --color always -e solverAB -- *.swift'}).cues.find(c=>c.kind==='term').text,'solverAB');
});
test('wrapped exec uses the same cues and preserves exact requests',()=>{
  const raw=`text(await tools.exec_command(${JSON.stringify({cmd:command,workdir:root})}));`;
  const input=toolInput({input:raw});
  assert.equal(input[0].Command,command);
  assert.ok(toolPresentation({type:'tool_call',name:'functions.exec',input:raw}).cues.some(c=>c.text==='solverAB'));
});
test('ambiguous or dynamic input does not become an invented literal subject',()=>{
  assert.equal(commandReview({cmd:'rg "$PATTERN" "$FILE"'}).cues.filter(c=>c.kind==='term').length,0);
  assert.equal(commandReview({cmd:"grep 'unterminated solverAB"}).cues.length,0);
  assert.equal(commandReview({cmd:'cd /private/worktree; pwd; head -n 2'}).title,'Command');
  assert.equal(commandReview({query:'solverAB'}),null);
});
test('same-named files from different worktrees remain distinguishable',()=>{
  const shown=commandReview({cmd:'cat /work/alpha/App/ShowRenderer.swift /work/beta/App/ShowRenderer.swift'});
  assert.deepEqual(shown.cues.filter(c=>c.kind==='file').map(c=>c.text),['alpha/App/ShowRenderer.swift','beta/App/ShowRenderer.swift']);
});
