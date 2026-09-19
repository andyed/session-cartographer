import { useCallback, useRef } from 'react';
import { verticalTime } from './focus-gesture.js';
import { useFocusGesture } from './useFocusGesture.js';
import '../styles/focus-timeline.css';

/**
 * Controlled newest-at-top overlay for ConcurrentTimeline. `timeToY` returns
 * content-space Y. `height` is the chart content height. `gutter` is
 * `{left,width}` in content coordinates. Only gutter controls receive pointers;
 * the band and saved outline remain transparent to session bars.
 */
export default function FocusRangeOverlay({ interval, bounds, savedInterval = null, onPreview, onCommit, disabled = false, timeToY, height, gutter = { left: 0, width: 64 } }) {
  const root = useRef(null);
  const valueFromPointer = useCallback((event, frozenBounds) => {
    const rect = root.current?.getBoundingClientRect();
    return next => verticalTime(next.clientY, rect, frozenBounds, timeToY);
  }, [timeToY]);
  const { pointerHandlers, keyboardHandlers } = useFocusGesture({ interval, bounds, onPreview, onCommit, disabled, valueFromPointer, orientation: 'vertical' });
  if (!interval || !bounds || !(bounds.through > bounds.from) || typeof timeToY !== 'function') return null;
  const yThrough = timeToY(interval.through), yFrom = timeToY(interval.from);
  const top = Math.min(yThrough, yFrom), bandHeight = Math.max(1, Math.abs(yFrom - yThrough));
  const crowded = bandHeight < 132;
  const chartHeight = Number.isFinite(height) ? height : Math.max(yThrough, yFrom, 400);
  const controlY = value => Math.max(22, Math.min(chartHeight - 22, value));
  const stackTop = Math.max(22, Math.min(chartHeight - 118, top + bandHeight / 2 - 48));
  const throughControlY = controlY(crowded ? stackTop : yThrough);
  const gripControlY = controlY(crowded ? stackTop + 48 : top + bandHeight / 2);
  const fromControlY = controlY(crowded ? stackTop + 96 : yFrom);
  const savedTop = savedInterval ? Math.min(timeToY(savedInterval.through), timeToY(savedInterval.from)) : 0;
  const savedHeight = savedInterval ? Math.max(1, Math.abs(timeToY(savedInterval.from) - timeToY(savedInterval.through))) : 0;
  const gutterStyle = { left: gutter.left, width: gutter.width };
  return <div className="focus-range-overlay" ref={root} style={{ height }} aria-label="Timeline focus interval">
    {savedInterval && <div className="focus-range-saved" style={{ top: savedTop, height: savedHeight }} aria-hidden="true" />}
    <div className="focus-range-band" style={{ top, height: bandHeight }} aria-hidden="true" />
    <button type="button" className="focus-range-handle focus-range-through" data-crowded={crowded || undefined} style={{ ...gutterStyle, top: throughControlY }} aria-label="Adjust focus through time" disabled={disabled} {...pointerHandlers('through')} {...keyboardHandlers('through')}><span>Through</span></button>
    <button type="button" className="focus-range-grip" style={{ ...gutterStyle, top: gripControlY }} aria-label="Move focus interval" disabled={disabled} {...pointerHandlers('pan')} {...keyboardHandlers('pan')}><span>Move</span></button>
    <button type="button" className="focus-range-handle focus-range-from" data-crowded={crowded || undefined} style={{ ...gutterStyle, top: fromControlY }} aria-label="Adjust focus from time" disabled={disabled} {...pointerHandlers('from')} {...keyboardHandlers('from')}><span>From</span></button>
  </div>;
}
