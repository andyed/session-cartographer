import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_FOCUS_DURATION_MS, advanceFocusRange, containsTimestamp, getFocusRange,
  normalizeFocusRange, resizeFocusRange, shiftFocusRange,
} from '../../explorer/shared/focus.js';

const hour = 60 * 60 * 1000;
const from = Date.parse('2026-09-01T12:00:00.123Z');
const through = from + 2 * hour;

test('focus membership preserves exact milliseconds and lower-bound semantics', () => {
  const closed = { from, through, lower: 'closed' };
  assert.equal(containsTimestamp(from - 1, closed), false);
  assert.equal(containsTimestamp(from, closed), true);
  assert.equal(containsTimestamp(through, closed), true);
  assert.equal(containsTimestamp(through + 1, closed), false);
  assert.equal(containsTimestamp(from, { ...closed, lower: 'open' }), false);
  assert.equal(containsTimestamp(from + 1, { ...closed, lower: 'open' }), true);
  assert.equal(normalizeFocusRange({ from: through, through: from }), null);
});

test('legacy focus links resolve only when their source time is known', () => {
  assert.equal(getFocusRange({ hours: 24, catchup: 'day' }), null);
  assert.deepEqual(getFocusRange(
    { hours: 24, catchup: 'day' },
    { from: from - 48 * hour, through },
  ), { from: through - 24 * hour, through, lower: 'closed' });
  assert.deepEqual(getFocusRange(
    { hours: 24, catchup: 'return', checkpoint: from },
    { through },
  ), { from, through, lower: 'open' });
  assert.deepEqual(getFocusRange(
    { hours: 24, catchup: 'hour', catchupExplicit: false },
    { snapshotAt: through, end: through - hour, availableEnd: through - 2 * hour },
  ), { from: through - 24 * hour, through, lower: 'closed' }, 'a bare normalized route starts at 24h and uses snapshot time during quiet periods');
  assert.deepEqual(getFocusRange(
    { hours: 24, catchup: 'hour', catchupExplicit: true },
    { snapshotAt: through },
  ), { from: through - hour, through, lower: 'closed' }, 'an explicit old hourly catch-up link retains its meaning');
});

test('shift and resize preserve duration, clamp to bounds, and never cross', () => {
  const range = { from, through, lower: 'closed' };
  const bounds = { from: from - hour, through: through + hour };
  assert.deepEqual(shiftFocusRange(range, -10 * hour, bounds),
    { from: from - hour, through: through - hour, lower: 'closed' });
  assert.deepEqual(shiftFocusRange(range, 10 * hour, bounds),
    { from: from + hour, through: through + hour, lower: 'closed' });
  assert.deepEqual(resizeFocusRange(range, 'from', through + hour, bounds),
    { from: through, through, lower: 'closed' });
  assert.deepEqual(resizeFocusRange(range, 'through', from - hour, bounds),
    { from, through: from, lower: 'closed' });
  assert.equal(shiftFocusRange(range, hour, { from, through: from + hour }), null);
  assert.equal(resizeFocusRange(range, 'middle', from, bounds), null);
});

test('fixed, rolling, and since-saved transitions advance the intended edges', () => {
  const range = { from, through, lower: 'closed' };
  const now = through + hour;
  assert.deepEqual(advanceFocusRange(range, 'fixed', null, now), range);
  assert.deepEqual(advanceFocusRange(range, 'rolling', 2 * hour, now),
    { from: now - 2 * hour, through: now, lower: 'closed' });
  assert.deepEqual(advanceFocusRange(range, 'since-saved', null, now),
    { from, through: now, lower: 'open' });
  assert.equal(advanceFocusRange(range, 'rolling', MAX_FOCUS_DURATION_MS + 1, now), null);
  assert.equal(advanceFocusRange(range, 'bogus', hour, now), null);
});
