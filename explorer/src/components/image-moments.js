// Image moments for the Timeline's event feed. A moment is the images one
// session wrote in one burst, placed in the feed at the newest of them, with a
// few chosen to stand for the rest.
//
// Bursts are the norm, not the exception: on 2026-11-03 one session wrote 39
// images in a window of 85, and render loops write the same frame under a new
// counter or timestamp each pass. Showing every file buries the feed; showing
// the newest four shows four takes of one frame. So a moment keeps the newest
// file of each name stem (a re-render supersedes the take before it), then
// spreads its picks across the burst, first to newest.

export const MOMENT_GAP_MS = 20 * 60 * 1000;
export const MOMENT_SHOWN = 4;
// Icons and favicons say little about the work; they stand in only when a
// moment has nothing larger.
const TINY_PX = 48;

const timeOf = image => Date.parse(image?.at);

/**
 * A file name without extension or dates, its trailing frame/version counters
 * folded to `#`: `t0440.png` and `t0600.png` share the stem `#`, `live-3440`
 * is `live#`. Folding rather than deleting keeps an all-counter name from
 * stemming to nothing.
 */
export function imageStem(name = '') {
  const plain = String(name).toLowerCase();
  const stem = plain
    .replace(/\.[a-z0-9]{2,5}$/, '')
    .replace(/\d{4}-\d{2}-\d{2}(?:[t_ -]?\d{2}[-:.]?\d{2}(?:[-:.]?\d{2})?(?:[-.]\d+)?z?)?/g, '')
    .replace(/[-_. ]+$/, '')
    .replace(/(?:[-_. ]*(?:v|t|f|frame|shot|step)?\d+)+$/, '#');
  // A name that is all date stems to nothing and stays itself.
  return stem || plain;
}

const tiny = image => {
  const side = Math.max(Number(image.width) || 0, Number(image.height) || 0);
  return side > 0 && side < TINY_PX;
};

// Evenly spaced over a time-ordered list, always keeping the first and the newest.
function spread(list, count) {
  if (list.length <= count) return list;
  if (count <= 0) return [];
  if (count === 1) return list.slice(-1);
  return [...new Set(Array.from({ length: count }, (_, i) => list[Math.round(i * (list.length - 1) / (count - 1))]))];
}

/**
 * Up to `count` images that stand for a burst, oldest first. Distinct stems
 * come first, each by its newest take; places they leave are filled from the
 * other takes, spread over the burst, so `render-0..2` all show and a frame
 * dump shows its progression rather than one frame.
 */
export function representatives(images, count = MOMENT_SHOWN) {
  const ordered = images.filter(image => Number.isFinite(timeOf(image))).sort((a, b) => timeOf(a) - timeOf(b));
  const sized = ordered.filter(image => !tiny(image));
  const pool = sized.length ? sized : ordered;
  const newestByStem = new Map();
  for (const image of pool) newestByStem.set(imageStem(image.name), image);
  // Position in the time-ordered pool breaks ties: one command often writes
  // several files within the same millisecond.
  const position = new Map(pool.map((image, index) => [image, index]));
  const byPosition = (a, b) => position.get(a) - position.get(b);
  const distinct = [...newestByStem.values()].sort(byPosition);
  if (distinct.length >= count) return spread(distinct, count);
  const chosen = new Set(distinct);
  const fill = spread(pool.filter(image => !chosen.has(image)), count - distinct.length);
  return [...distinct, ...fill].sort(byPosition);
}

function mostCommon(values) {
  const counts = new Map();
  for (const value of values) if (value) counts.set(value, (counts.get(value) || 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] || '';
}

/**
 * Group window images into moments, newest first. Images more than `gapMs`
 * apart start a new moment even within one session, so a session that wrote
 * in the morning and again at night appears at both times.
 */
export function imageMoments(images, { gapMs = MOMENT_GAP_MS, shown = MOMENT_SHOWN } = {}) {
  const bySession = new Map();
  for (const image of images || []) {
    if (!Number.isFinite(timeOf(image))) continue;
    const key = image.sessionId || image.transcript || 'unattributed';
    if (!bySession.has(key)) bySession.set(key, []);
    bySession.get(key).push(image);
  }
  const moments = [];
  for (const [sessionKey, list] of bySession) {
    list.sort((a, b) => timeOf(a) - timeOf(b));
    let current = null;
    for (const image of list) {
      const t = timeOf(image);
      if (!current || t - current.end > gapMs) {
        current = { sessionKey, images: [], start: t, end: t };
        moments.push(current);
      }
      current.images.push(image);
      current.end = t;
    }
  }
  return moments.map(moment => {
    const newest = moment.images.at(-1);
    return {
      // The first image's id keeps the key stable while the burst grows.
      key: `${moment.sessionKey}:${moment.images[0].id}`,
      sessionId: newest.sessionId || '',
      session: newest.session || '',
      provider: newest.provider || '',
      project: mostCommon(moment.images.map(image => image.project)),
      start: moment.start,
      t: moment.end,
      newest,
      images: moment.images,
      representatives: representatives(moment.images, shown),
    };
  }).sort((a, b) => b.t - a.t || a.key.localeCompare(b.key));
}

const recordTime = record => (Number.isFinite(record?.t) ? record.t : Date.parse(record?.timestamp));

function groupTime(group) {
  const times = (group.events || []).map(recordTime).filter(Number.isFinite);
  return times.length ? Math.max(...times) : NaN;
}

/**
 * The times that bound one page of the feed, so each moment lands on exactly
 * one page: after the previous page's last event, down to this page's last.
 */
export function pageBounds(events, offset, pageSize) {
  const upper = offset > 0 ? recordTime(events[offset - 1]) : Infinity;
  const lower = offset + pageSize < events.length ? recordTime(events[offset + pageSize - 1]) : -Infinity;
  return { upper: Number.isFinite(upper) ? upper : Infinity, lower: Number.isFinite(lower) ? lower : -Infinity };
}

/**
 * The page offset whose bounds hold this moment: the same test placeMoments
 * applies, so a jump lands on the page that renders it.
 */
export function momentOffset(events, moment, pageSize) {
  for (let offset = 0; offset < Math.max(events.length, 1); offset += pageSize) {
    const { upper, lower } = pageBounds(events, offset, pageSize);
    if (moment.t <= upper && moment.t > lower) return offset;
  }
  return 0;
}

export const OVERVIEW_SHOWN = 8;

/**
 * Moments that stand for the whole focus window, newest first. A long window
 * spreads its moments over dozens of feed pages (3,345 events on 34 pages for
 * one 24-hour window), so the feed's first page alone shows almost none. Every
 * session that wrote images gets its largest moment first; larger moments
 * fill the remaining places. Each pick carries the moment's newest
 * representative, the state the burst ended in.
 */
export function overviewPicks(moments, limit = OVERVIEW_SHOWN) {
  const bySize = [...(moments || [])].sort((a, b) => b.images.length - a.images.length || b.t - a.t);
  const chosen = [];
  const sessions = new Set();
  for (const moment of bySize) {
    if (chosen.length >= limit) break;
    if (sessions.has(moment.sessionId)) continue;
    sessions.add(moment.sessionId);
    chosen.push(moment);
  }
  for (const moment of bySize) {
    if (chosen.length >= limit) break;
    if (!chosen.includes(moment)) chosen.push(moment);
  }
  return chosen.sort((a, b) => b.t - a.t).map(moment => ({ moment, image: moment.representatives.at(-1) }));
}

/**
 * Interleave moments with a page of event groups, newest first: a moment sits
 * before the first group older than it, and one older than every group on the
 * page closes it.
 */
export function placeMoments(groups, moments, { upper = Infinity, lower = -Infinity } = {}) {
  const pending = (moments || []).filter(moment => moment.t <= upper && moment.t > lower).sort((a, b) => b.t - a.t);
  const items = [];
  let next = 0;
  for (const group of groups) {
    const top = groupTime(group);
    while (next < pending.length && pending[next].t > top) items.push({ kind: 'images', moment: pending[next++] });
    items.push({ kind: 'events', group });
  }
  while (next < pending.length) items.push({ kind: 'images', moment: pending[next++] });
  return items;
}
