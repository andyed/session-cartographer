import test from 'node:test';
import assert from 'node:assert/strict';
import { sessionMetricsAt } from '../../explorer/src/components/memory-metrics.js';

const minute = 60000;
const session = {
  events: [[0,'activity'],[5*minute,'edit'],[40*minute,'research'],[43*minute,'commit'],[55*minute,'lifecycle']],
  metrics: { tokens: { status: 'available', output: 30, input: 300, cacheRead: 100, cacheWrite: 0, total: 330, capturedUntil: 43*minute } },
  tokenSeries: [{ t:5*minute,output:10,input:100,cacheRead:0,cacheWrite:0,total:110 },{ t:43*minute,output:20,input:200,cacheRead:100,cacheWrite:0,total:220 }],
};

test('duration shows observed span and excludes long gaps from active periods', () => {
  const m = sessionMetricsAt(session,60*minute);
  assert.equal(m.spanMs,55*minute);
  assert.equal(m.activeMs,8*minute);
  assert.equal(m.counts.edit,1);
  assert.equal(m.eventCount,5);
  assert.equal(m.tokens.total,330,'Cached tokens already included in input');
});

test('replay metrics exclude later events, files, and token consumption', () => {
  const m = sessionMetricsAt(session,10*minute,[{edits:[{t:5*minute}]},{edits:[{t:40*minute}]}]);
  assert.equal(m.spanMs,5*minute);
  assert.equal(m.eventCount,2);
  assert.equal(m.tokens.output,10);
  assert.equal(m.tokens.capturedUntil,5*minute);
  assert.equal(m.fileCount,1);
});

test('missing usage stays unknown instead of zero, including before first record', () => {
  assert.equal(sessionMetricsAt(session,minute).tokens.output,null);
  assert.equal(sessionMetricsAt(session,minute).tokens.status,'missing');
  assert.equal(sessionMetricsAt({events:session.events},60*minute).tokens.total,null);
});
