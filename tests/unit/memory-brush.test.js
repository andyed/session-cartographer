import test from 'node:test';
import assert from 'node:assert/strict';
import { brushHits, normalizeBrush, semanticLevel, zoomCameraAt } from '../../explorer/src/components/memory-brush.js';

test('brushing preserves the exact selected session IDs in all drag directions, including edges', () => {
  const points = [
    { id: 'bottom-right', x: 30, y: 40 }, { id: 'top-left', x: 10, y: 20 },
    { id: 'center', x: 20, y: 30 }, { id: 'center', x: 21, y: 31 },
    { id: 'outside-left', x: 9.99, y: 30 }, { id: 'outside-bottom', x: 20, y: 40.01 },
    { id: 'invalid', x: NaN, y: 30 }, { id: 'infinite', x: 20, y: Infinity },
  ];
  for (const rect of [
    { x0: 10, y0: 20, x1: 30, y1: 40 }, { x0: 30, y0: 40, x1: 10, y1: 20 },
    { x0: 10, y0: 40, x1: 30, y1: 20 }, { x0: 30, y0: 20, x1: 10, y1: 40 },
  ]) assert.deepEqual(brushHits(points, rect), ['bottom-right', 'center', 'top-left']);
  assert.deepEqual(brushHits(points, { x0: 20, y0: 30, x1: 20, y1: 30 }), ['center']);
  assert.deepEqual(brushHits(points, { x0: 0, y0: 0, x1: Infinity, y1: 50 }), []);
  assert.deepEqual(brushHits(points, null), []);
});

test('brush route normalization is stable, bounded, and drops malformed IDs without altering input', () => {
  const input = Object.freeze(['z-1', 'a_2', 'z-1', '', '../escape', ' space ', null, 12, 'a,b', 'x'.repeat(257)]);
  assert.deepEqual(normalizeBrush(input), ['a_2', 'space', 'z-1']);
  assert.deepEqual(normalizeBrush('z-1,a_2,z-1'), ['a_2', 'z-1']);
  assert.equal(normalizeBrush(['../escape', null]), null);
  assert.equal(normalizeBrush(undefined), null);
  const many = Array.from({ length: 105 }, (_, i) => `id-${String(104 - i).padStart(3, '0')}`);
  const result = normalizeBrush(many);
  assert.equal(result.length, 100);
  assert.equal(result[0], 'id-000');
  assert.equal(result.at(-1), 'id-099');
  assert.deepEqual(normalizeBrush(result.join(',')), result);
});

test('semantic zoom switches detail at the two exact scale boundaries', () => {
  assert.equal(semanticLevel(0.4), 'projects');
  assert.equal(semanticLevel(0.84999), 'projects');
  assert.equal(semanticLevel(0.85), 'sessions');
  assert.equal(semanticLevel(2.19999), 'sessions');
  assert.equal(semanticLevel(2.2), 'artifacts');
  assert.equal(semanticLevel(8), 'artifacts');
  assert.equal(semanticLevel(NaN), 'sessions');
});

test('camera zoom preserves the world point beneath the cursor even when clamped', () => {
  const camera = Object.freeze({ x: 17, y: -31, scale: 1.5 });
  const cursor = Object.freeze({ x: 213, y: 179 });
  const world = { x: (cursor.x - camera.x) / camera.scale, y: (cursor.y - camera.y) / camera.scale };
  for (const factor of [0.001, 0.7, 1, 2, 1000]) {
    const next = zoomCameraAt(camera, cursor, factor);
    assert.ok(next.scale >= 0.4 && next.scale <= 8);
    assert.ok(Math.abs((cursor.x - next.x) / next.scale - world.x) < 1e-10);
    assert.ok(Math.abs((cursor.y - next.y) / next.scale - world.y) < 1e-10);
  }
  assert.deepEqual(camera, { x: 17, y: -31, scale: 1.5 });
  const limit = zoomCameraAt(camera, cursor, 1000);
  assert.deepEqual(zoomCameraAt(limit, cursor, 2), limit);
  const roundTrip = zoomCameraAt(zoomCameraAt(camera, cursor, 2), cursor, 0.5);
  assert.deepEqual(roundTrip, camera);
});

test('camera zoom rejects invalid controls and recovers invalid camera values without mutation', () => {
  const identity = { x: 0, y: 0, scale: 1 };
  for (const factor of [0, -1, NaN, Infinity, '2']) {
    assert.deepEqual(zoomCameraAt(identity, { x: 100, y: 100 }, factor), identity);
  }
  assert.deepEqual(zoomCameraAt(null, { x: 20, y: 30 }, 2), { x: -20, y: -30, scale: 2 });
  assert.deepEqual(zoomCameraAt({ x: NaN, y: Infinity, scale: 0 }, { x: 0, y: 0 }, 2), { x: 0, y: 0, scale: 2 });
  assert.deepEqual(zoomCameraAt(identity, { x: Infinity, y: 0 }, 2), identity);
  assert.equal(zoomCameraAt(identity, { x: 0, y: 0 }, 100, 0.5, 3).scale, 3);
  assert.equal(zoomCameraAt(identity, { x: 0, y: 0 }, 0.01, 0.5, 3).scale, 0.5);
});

// Shared activity and secondary selection use the same relationship evidence
// as the rendered connections; a neighbour must not silently replace a cohort.
test('secondary brush retains the exact primary cohort and only inspects shared activity', async () => {
  const {resolveBrushFocus, projectAffinity} = await import('../../explorer/src/components/memory-brush.js');
  const make = (id, projects, t=10) => Object.freeze({id, projects, count:Object.values(projects).reduce((a,b)=>a+b,0), events:[[t,'activity']]});
  const sessions = [make('a',{player:80,dev:20}),make('b',{player:5}),make('c',{canvas:10}),make('d',{player:10}),make('future',{player:10},100)];
  const primary = Object.freeze(['a','c']);
  const focus = resolveBrushFocus(sessions,primary,'b',50);
  assert.deepEqual(focus,{primary:['a','c'],preview:'b',secondary:'b',anchors:['a'],projects:['player']});
  assert.deepEqual(primary,['a','c']);
  assert.deepEqual(resolveBrushFocus(sessions,['a'],'c',50),{primary:['a'],preview:null,secondary:null,anchors:[],projects:[]});
  assert.equal(resolveBrushFocus(sessions,['a'],'future',50).secondary,null,'future activity cannot supply a visible neighbour');
  assert.equal(resolveBrushFocus(sessions,['a'],'missing',50).preview,null);
  assert.equal(resolveBrushFocus(sessions,['a'],null,50).secondary,null);
  assert.deepEqual(resolveBrushFocus(sessions,['a','d'],'b',50).anchors,['a','d']);
  assert.equal(resolveBrushFocus(sessions,['a'],'a',50).secondary,null,'focusing the primary alone is not a secondary brush');
  assert.equal(resolveBrushFocus(sessions,[],'c',50).preview,'c','unselected exploration remains available');
  assert.equal(projectAffinity(make('generic',{dev:10}),make('also-generic',{dev:5})),0);
  assert.equal(projectAffinity(make('many',{player:100}),make('few',{player:5})),1,'project proportions, not equal event volume');
});

test('secondary brush cannot promote a neighbour through another neighbour or a weak shared project', async () => {
  const {resolveBrushFocus} = await import('../../explorer/src/components/memory-brush.js');
  const sessions = [
    {id:'a',projects:{player:100},count:100,events:[[1]]},
    {id:'bridge',projects:{player:50,canvas:50},count:100,events:[[1]]},
    {id:'indirect',projects:{canvas:100},count:100,events:[[1]]},
    {id:'weak',projects:{player:1,canvas:99},count:100,events:[[1]]},
  ];
  assert.equal(resolveBrushFocus(sessions,['a'],'bridge').secondary,'bridge');
  assert.equal(resolveBrushFocus(sessions,['a'],'indirect').preview,null);
  assert.equal(resolveBrushFocus(sessions,['a'],'weak').preview,null);
});

test('connection brushing follows the drawn curve rather than its bounding box', async () => {
  const {connectionDistance} = await import('../../explorer/src/components/memory-brush.js');
  const edge = {ax:0,ay:0,cx:50,cy:40,bx:100,by:0};
  assert.equal(connectionDistance({x:50,y:20},edge),0);
  assert.ok(connectionDistance({x:50,y:0},edge)>15,'inside the bounding box but outside the actual curve');
  assert.equal(connectionDistance({x:0,y:0},edge),0);
  assert.equal(connectionDistance({x:100,y:0},edge),0);
  assert.ok(Math.abs(connectionDistance({x:50,y:25},edge)-5)<.01);
  assert.equal(connectionDistance({x:NaN,y:20},edge),Infinity);
});
