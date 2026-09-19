import { useCallback, useMemo, useRef } from 'react';
import { densityBins, horizontalTime, normalizeDensityBins } from './focus-gesture.js';
import { useFocusGesture } from './useFocusGesture.js';
import '../styles/focus-timeline.css';

const percent = (time, bounds) => `${Math.max(0, Math.min(100, (time - bounds.from) / (bounds.through - bounds.from) * 100))}%`;
const stamp = time => new Date(time).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

/**
 * Compact horizontal focus selector. Events may be `[timestamp, …]` tuples or
 * objects with `t`/`timestamp`; callers may instead supply `{from,through,count}` bins.
 * This component performs no fetching, persistence, or history writes.
 */
export default function FocusTimeline({ interval, bounds, savedInterval = null, events = [], bins = null, onPreview, onCommit, disabled = false }) {
  const track = useRef(null);
  const valueFromPointer = useCallback((event, frozenBounds) => {
    const rect = track.current?.getBoundingClientRect();
    return next => horizontalTime(next.clientX, rect, frozenBounds);
  }, []);
  const { pointerHandlers, keyboardHandlers } = useFocusGesture({ interval, bounds, onPreview, onCommit, disabled, valueFromPointer });
  const density = useMemo(() => bins ? normalizeDensityBins(bins, bounds) : densityBins(events, bounds), [bins, events, bounds]);
  const max = Math.max(1, ...density.map(bin => bin.count));
  if (!interval || !bounds || !(bounds.through > bounds.from)) return null;
  return <section className="focus-timeline" aria-label="Focus interval">
    <div className="focus-timeline-track" ref={track}>
      <div className="focus-density" aria-hidden="true">{density.map((bin, index) => { const from = Math.max(bin.from, bounds.from), through = Math.min(bin.through, bounds.through); return <i key={`${bin.from}-${index}`} style={{ left: percent(from, bounds), width: `${Math.max(0, through-from)/(bounds.through-bounds.from)*100}%`, height: `${Math.max(4, bin.count/max*100)}%` }} />; })}</div>
      {savedInterval && <div className="focus-saved-range" style={{ left: percent(savedInterval.from, bounds), right: `${100 - parseFloat(percent(savedInterval.through, bounds))}%` }} aria-hidden="true" />}
      <div className="focus-active-range" style={{ left: percent(interval.from, bounds), right: `${100 - parseFloat(percent(interval.through, bounds))}%` }} aria-hidden="true" />
      <button type="button" className="focus-handle focus-handle-from" aria-label="Adjust focus start" disabled={disabled} style={{ left: percent(interval.from, bounds) }} {...pointerHandlers('from')} {...keyboardHandlers('from')}><span>From</span></button>
      <button type="button" className="focus-pan" aria-label="Move focus interval" disabled={disabled} style={{ left: `min(${percent(interval.from, bounds)}, calc(100% - 88px))`, right: `${100 - parseFloat(percent(interval.through, bounds))}%` }} {...pointerHandlers('pan')} {...keyboardHandlers('pan')}><span>{stamp(interval.from)} – {stamp(interval.through)}</span></button>
      <button type="button" className="focus-handle focus-handle-through" aria-label="Adjust focus end" disabled={disabled} style={{ left: percent(interval.through, bounds) }} {...pointerHandlers('through')} {...keyboardHandlers('through')}><span>Through</span></button>
    </div>
  </section>;
}
