import { useCallback, useEffect, useRef } from 'react';
import { resizeFocusRange, shiftFocusRange } from '../../shared/focus.js';
import { keyDelta } from './focus-gesture.js';

/**
 * Controlled focus-range gestures. `valueFromPointer` is sampled at pointer-down
 * together with range/bounds, so a live poll or layout change cannot bend a drag.
 */
export function useFocusGesture({ interval, bounds, onPreview, onCommit, disabled, valueFromPointer, orientation = 'horizontal' }) {
  const pointer = useRef(null);
  const keyboard = useRef(null);
  const latest = useRef(interval);
  latest.current = interval;

  const finishKeyboard = useCallback((commit = true) => {
    const tx = keyboard.current;
    if (!tx) return;
    keyboard.current = null;
    if (commit && (tx.draft.from !== tx.start.from || tx.draft.through !== tx.start.through)) onCommit(tx.draft);
    else onPreview(null);
  }, [onCommit, onPreview]);

  const cancelPointer = useCallback(() => {
    if (!pointer.current) return;
    pointer.current = null;
    onPreview(null);
  }, [onPreview]);

  useEffect(() => {
    const cancel = event => {
      if (event.key !== 'Escape') return;
      if (pointer.current) { event.preventDefault(); cancelPointer(); }
      if (keyboard.current) { event.preventDefault(); finishKeyboard(false); }
    };
    window.addEventListener('keydown', cancel, true);
    return () => window.removeEventListener('keydown', cancel, true);
  }, [cancelPointer, finishKeyboard]);

  const pointerHandlers = useCallback((operation) => ({
    onPointerDown(event) {
      if (disabled || event.button !== 0) return;
      event.preventDefault();
      const frozenBounds = { ...bounds }, start = { ...latest.current };
      const mapper = valueFromPointer(event, frozenBounds);
      pointer.current = { id: event.pointerId, operation, start, bounds: frozenBounds, mapper, origin: mapper(event) };
      event.currentTarget.setPointerCapture?.(event.pointerId);
    },
    onPointerMove(event) {
      const tx = pointer.current;
      if (!tx || tx.id !== event.pointerId) return;
      const value = tx.mapper(event);
      const draft = tx.operation === 'pan'
        ? shiftFocusRange(tx.start, value - tx.origin, tx.bounds)
        : resizeFocusRange(tx.start, tx.operation, value, tx.bounds);
      tx.draft = draft;
      onPreview(draft);
    },
    onPointerUp(event) {
      const tx = pointer.current;
      if (!tx || tx.id !== event.pointerId) return;
      pointer.current = null;
      if (tx.draft && (tx.draft.from !== tx.start.from || tx.draft.through !== tx.start.through)) onCommit(tx.draft);
      else onPreview(null);
      event.currentTarget.releasePointerCapture?.(event.pointerId);
    },
    onPointerCancel: cancelPointer,
    onLostPointerCapture() { if (pointer.current) cancelPointer(); },
  }), [bounds, cancelPointer, disabled, onCommit, onPreview, valueFromPointer]);

  const keyboardHandlers = useCallback((operation) => ({
    onKeyDown(event) {
      if (disabled) return;
      const delta = keyDelta(event, orientation);
      if (delta === null && event.key !== 'Home' && event.key !== 'End') return;
      event.preventDefault();
      if (!keyboard.current) keyboard.current = { operation, start: { ...latest.current }, draft: { ...latest.current }, bounds: { ...bounds } };
      const tx = keyboard.current;
      let draft;
      if (operation === 'pan') {
        const amount = event.key === 'Home' ? tx.bounds.from - tx.draft.from
          : event.key === 'End' ? tx.bounds.through - tx.draft.through : delta;
        draft = shiftFocusRange(tx.draft, amount, tx.bounds);
      } else {
        const value = event.key === 'Home' ? tx.bounds.from
          : event.key === 'End' ? tx.bounds.through : tx.draft[operation] + delta;
        draft = resizeFocusRange(tx.draft, operation, value, tx.bounds);
      }
      if (draft) { tx.draft = draft; onPreview(draft); }
    },
    onKeyUp(event) {
      if (keyDelta(event, orientation) !== null || event.key === 'Home' || event.key === 'End') finishKeyboard(true);
    },
    onBlur() { finishKeyboard(true); },
  }), [bounds, disabled, finishKeyboard, onPreview, orientation]);

  return { pointerHandlers, keyboardHandlers };
}
