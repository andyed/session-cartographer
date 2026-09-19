import { useCallback, useId, useMemo, useRef } from 'react';
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
  const helpId = useId();
  const valueFromPointer = useCallback((event, frozenBounds) => {
    const rect = track.current?.getBoundingClientRect();
    return next => horizontalTime(next.clientX, rect, frozenBounds);
  }, []);
  const { pointerHandlers, keyboardHandlers } = useFocusGesture({ interval, bounds, onPreview, onCommit, disabled, valueFromPointer });
  const density = useMemo(() => bins ? normalizeDensityBins(bins, bounds) : densityBins(events, bounds), [bins, events, bounds]);
  const max = Math.max(1, ...density.map(bin => bin.count));
  if (!interval || !bounds || !(bounds.through > bounds.from)) return null;
  const canMove = interval.through - interval.from < bounds.through - bounds.from;
  const slider = (name, value, from = bounds.from, through = bounds.through) => ({
    role: 'slider', tabIndex: disabled ? -1 : 0, 'aria-label': name, 'aria-disabled': disabled || undefined,
    'aria-orientation': 'horizontal', 'aria-valuemin': from, 'aria-valuemax': through,
    'aria-valuenow': value, 'aria-valuetext': stamp(value), 'aria-describedby': helpId,
  });
  return <section className="focus-timeline" aria-label="Focus interval">
    <div className="focus-timeline-track" ref={track} {...pointerHandlers('select')}>
      <div className="focus-density" aria-hidden="true">{density.map((bin, index) => { const from = Math.max(bin.from, bounds.from), through = Math.min(bin.through, bounds.through); return <i key={`${bin.from}-${index}`} style={{ left: percent(from, bounds), width: `${Math.max(0, through-from)/(bounds.through-bounds.from)*100}%`, height: `${Math.max(4, bin.count/max*100)}%` }} />; })}</div>
      {savedInterval && <div className="focus-saved-range" style={{ left: percent(savedInterval.from, bounds), right: `${100 - parseFloat(percent(savedInterval.through, bounds))}%` }} aria-hidden="true" />}
      <div className="focus-active-range" style={{ left: percent(interval.from, bounds), right: `${100 - parseFloat(percent(interval.through, bounds))}%` }} aria-hidden="true" />
      {canMove && <div className="focus-pan" {...slider('Move focus interval', interval.from, bounds.from, bounds.through - (interval.through - interval.from))} style={{ left: `min(${percent(interval.from, bounds)}, calc(100% - 44px))`, right: `${100 - parseFloat(percent(interval.through, bounds))}%` }} {...pointerHandlers('pan')} {...keyboardHandlers('pan')} />}
      <div className="focus-handle focus-handle-from" {...slider('Adjust focus start', interval.from, bounds.from, interval.through)} title="Drag to change the start time" style={{ left: percent(interval.from, bounds) }} {...pointerHandlers('from')} {...keyboardHandlers('from')} />
      <div className="focus-handle focus-handle-through" {...slider('Adjust focus end', interval.through, interval.from, bounds.through)} title="Drag to change the end time" style={{ left: percent(interval.through, bounds) }} {...pointerHandlers('through')} {...keyboardHandlers('through')} />
    </div>
    <p id={helpId} className="focus-timeline-help">{canMove ? 'Drag the selection to move it, or its edges to resize.' : 'Drag across the activity to select a time range.'}<span className="md-sr"> Arrow keys adjust a focused handle. Shift adjusts by an hour. Escape cancels a drag.</span></p>
  </section>;
}
