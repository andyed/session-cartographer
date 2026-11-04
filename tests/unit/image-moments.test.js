import test from 'node:test';
import assert from 'node:assert/strict';
import { imageMoments, imageStem, pageBounds, placeMoments, representatives } from '../../explorer/src/components/image-moments.js';

const T0 = Date.parse('2026-11-03T10:00:00Z');
const MIN = 60 * 1000;
let seq = 0;
const image = (name, minute, extra = {}) => ({ id: `img-${seq++}`, name, at: new Date(T0 + minute * MIN).toISOString(), sessionId: 's1', session: 'render the plates', provider: 'codex', project: 'liquid-light-warp', width: 1600, height: 900, ...extra });

test('stems drop extensions, dates and frame counters, and keep distinct names apart', () => {
  // Names from a real 24-hour window on 2026-11-03.
  assert.equal(imageStem('t0440.png'), imageStem('t0600.png'), 'an all-counter name still shares a stem with its siblings');
  assert.equal(imageStem('pour1-1-t0440.png'), 'pour#');
  assert.equal(imageStem('live-3440.png'), 'live#');
  assert.notEqual(imageStem('live-3440.png'), imageStem('live.png'), 'a numbered take is not the unnumbered original');
  assert.equal(imageStem('tilt-spin.png'), imageStem('tilt-spin.svg'));
  assert.equal(imageStem('site__mode_0_2026-11-04T04-18-49-874Z.png'), imageStem('site__mode_0_2026-11-04T05-01-02-003Z.png'));
  assert.notEqual(imageStem('folio-mobile.png'), imageStem('folio-desktop.png'));
  assert.notEqual(imageStem('protoplasm-audio-footer-refined.png'), imageStem('protoplasm-audio-B-live.png'));
  assert.equal(imageStem('2026-11-04.png'), '2026-11-04.png', 'a name that is all date stays itself rather than collapsing to empty');
});

test('representatives keep the newest take of each stem, spread first to newest', () => {
  // Distinct names outrank takes: two places, one stem with five takes and one other name.
  const mixed = [1, 2, 3, 4, 5].map(n => image(`frame-00${n}.png`, n)).concat(image('contact-sheet.png', 3.5));
  assert.deepEqual(representatives(mixed, 2).map(i => i.name), ['contact-sheet.png', 'frame-005.png'], 'not frame-001 and frame-005');

  // Places distinct names leave empty are filled from the other takes, spread.
  const takes = [1, 2, 3, 4, 5, 6].map(n => image(`frame-00${n}.png`, n));
  assert.deepEqual(representatives(takes).map(i => i.name), ['frame-001.png', 'frame-003.png', 'frame-005.png', 'frame-006.png']);
  const variants = [0, 1, 2].map(n => image(`render-${n}.svg`, 0.1 * n));
  assert.equal(representatives(variants).length, 3, 'a burst smaller than the strip shows whole');
  // One command writes several files in the same millisecond; ties keep list order.
  const sameInstant = [0, 1, 2].map(n => image(`render-${n}.svg`, 7));
  assert.deepEqual(representatives(sameInstant).map(i => i.name), ['render-0.svg', 'render-1.svg', 'render-2.svg']);

  const burst = Array.from({ length: 12 }, (_, i) => image(`shot-${String.fromCharCode(97 + i)}.png`, i));
  const picked = representatives(burst, 4);
  assert.equal(picked.length, 4);
  assert.equal(picked[0].name, 'shot-a.png', 'the first image opens the strip');
  assert.equal(picked.at(-1).name, 'shot-l.png', 'the newest image closes it');
  assert.deepEqual(picked.map(i => i.name), ['shot-a.png', 'shot-e.png', 'shot-h.png', 'shot-l.png']);
});

test('icons stand in only when a moment has nothing larger', () => {
  const icon = image('favicon.png', 0, { width: 32, height: 32 });
  assert.deepEqual(representatives([icon, image('hero.png', 1)]).map(i => i.name), ['hero.png']);
  assert.deepEqual(representatives([icon]).map(i => i.name), ['favicon.png']);
  // Unknown dimensions are not "tiny".
  assert.deepEqual(representatives([image('vector.svg', 0, { width: undefined, height: undefined })]).length, 1);
});

test('moments split by session and by gaps, newest first, with stable keys as a burst grows', () => {
  const morning = [image('a.png', 0), image('b.png', 5)];
  const night = [image('c.png', 600)];
  const other = [image('d.png', 3, { sessionId: 's2', session: 'muriel audit', provider: 'claude', project: 'muriel' })];
  const moments = imageMoments([...night, ...other, ...morning]);
  assert.deepEqual(moments.map(m => [m.sessionId, m.images.map(i => i.name)]), [
    ['s1', ['c.png']],
    ['s1', ['a.png', 'b.png']],
    ['s2', ['d.png']],
  ]);
  const [, first] = moments;
  assert.equal(first.t, T0 + 5 * MIN, 'a moment is placed at its newest image');
  assert.equal(first.start, T0);
  assert.equal(first.project, 'liquid-light-warp');

  const grown = imageMoments([...morning, image('e.png', 9)]);
  assert.equal(grown[0].key, first.key, 'a later image in the same burst does not re-key the moment');
  assert.equal(imageMoments([{ ...morning[0], at: 'not a time' }]).length, 0, 'an image without a time is not placed');
});

test('placement interleaves by time, and page bounds put each moment on exactly one page', () => {
  const ev = (id, minute) => ({ event_id: id, t: T0 + minute * MIN, timestamp: new Date(T0 + minute * MIN).toISOString() });
  const events = [ev('e9', 90), ev('e8', 80), ev('e5', 50), ev('e4', 40), ev('e2', 20), ev('e1', 10)];
  const moment = (minute, key) => ({ key, t: T0 + minute * MIN });
  const moments = [moment(95, 'newest'), moment(45, 'middle'), moment(40, 'tie'), moment(5, 'oldest')];
  const pages = [0, 2, 4].map(offset => {
    const groups = events.slice(offset, offset + 2).map(event => ({ events: [event] }));
    return placeMoments(groups, moments, pageBounds(events, offset, 2))
      .map(item => (item.kind === 'images' ? `[${item.moment.key}]` : item.group.events[0].event_id));
  });
  // A moment tied with an event sorts after it; at a page edge that is the
  // top of the next page.
  assert.deepEqual(pages, [
    ['[newest]', 'e9', 'e8'],
    ['e5', '[middle]', 'e4'],
    ['[tie]', 'e2', 'e1', '[oldest]'],
  ]);
  assert.equal(pages.flat().filter(item => item.startsWith('[')).length, moments.length, 'no moment is dropped or repeated across pages');
});
