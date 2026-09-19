import test from 'node:test';
import assert from 'node:assert/strict';
import { densityBins, densityStep, eventTimestamp, fromLocalDateTime, horizontalTime, keyDelta, normalizeDensityBins, toLocalDateTime, verticalTime } from '../../explorer/src/components/focus-gesture.js';
import { resizeFocusRange } from '../../explorer/shared/focus.js';

test('density is UTC-aligned, starts at 30 minutes, coarsens for long contexts, and includes both exact endpoints', () => {
  const halfHour = 30 * 60000;
  const bounds = { from: halfHour + 1000, through: 3 * halfHour + 5000 };
  const bins = densityBins([[bounds.from], { t: 2 * halfHour }, { timestamp: bounds.through }, bounds.from - 1, bounds.through + 1], bounds);
  assert.deepEqual(bins.map(bin => [bin.from, bin.through, bin.count]), [
    [halfHour, 2 * halfHour, 1], [2 * halfHour, 3 * halfHour, 1], [3 * halfHour, 4 * halfHour, 1],
  ]);
  assert.equal(densityStep({ from: 0, through: 2 * 24 * 3600000 }), halfHour);
  assert.equal(densityStep({ from: 0, through: 30 * 24 * 3600000 }), 12 * 3600000);
  assert.equal(eventTimestamp({ timestamp: new Date(3000).toISOString() }), 3000);
  assert.equal(eventTimestamp({ timestamp: 'bad' }), null);
  assert.deepEqual(normalizeDensityBins([{from:0,through:2,count:-1},{from:6,through:8,count:3}], {from:1,through:7}).map(bin=>bin.count), [0,3]);
});

test('horizontal and inverted vertical geometry clamp to frozen bounds', () => {
  const bounds = { from: 100, through: 1100 };
  const rect = { left: 20, top: 10, width: 200 };
  assert.equal(horizontalTime(120, rect, bounds), 600);
  assert.equal(horizontalTime(-20, rect, bounds), 100);
  const timeToY = time => 500 - (time - 100) / 2;
  assert.equal(verticalTime(260, rect, bounds, timeToY), 600);
  assert.equal(verticalTime(-100, rect, bounds, timeToY), 1100);
});

test('fractional pointer geometry produces integer timestamps accepted by range math', () => {
  const bounds = { from: 1_700_000_000_123, through: 1_700_086_401_357 };
  const rect = { left: 13.25, top: 7.75, width: 317.5 };
  const horizontal = horizontalTime(193.3, rect, bounds);
  const vertical = verticalTime(149.6, rect, bounds,
    time => 407.25 - (time - bounds.from) / (bounds.through - bounds.from) * 381.5);
  assert.equal(Number.isSafeInteger(horizontal), true);
  assert.equal(Number.isSafeInteger(vertical), true);
  const range = { from: bounds.from + 1000, through: bounds.through - 1000, lower: 'closed' };
  assert.ok(resizeFocusRange(range, 'from', horizontal, bounds));
  assert.ok(resizeFocusRange(range, 'through', vertical, bounds));
});

test('keyboard steps are five minutes, shift is one hour, and vertical arrows follow the inverted axis', () => {
  assert.equal(keyDelta({key:'ArrowRight',shiftKey:false}), 300000);
  assert.equal(keyDelta({key:'ArrowLeft',shiftKey:true}), -3600000);
  assert.equal(keyDelta({key:'ArrowUp',shiftKey:false}, 'vertical'), 300000);
  assert.equal(keyDelta({key:'ArrowDown',shiftKey:true}, 'vertical'), -3600000);
  assert.equal(keyDelta({key:'Home',shiftKey:false}), null);
});

test('exact datetime values round-trip in local time', () => {
  const value = '2026-09-18T14:35:17';
  assert.equal(toLocalDateTime(fromLocalDateTime(value)), value);
  assert.equal(fromLocalDateTime(''), null);
});
