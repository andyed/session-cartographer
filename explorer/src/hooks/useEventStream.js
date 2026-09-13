import { useEffect, useRef, useState } from 'react';
import { isDemoMode } from '../api';
import { initialEventStreamStatus, transitionEventStreamStatus } from './event-stream-state';

export function useEventStream(onEvent) {
  const sourceRef = useRef(null);
  const onEventRef = useRef(onEvent);
  const [status, setStatus] = useState(() => initialEventStreamStatus(isDemoMode));
  onEventRef.current = onEvent;

  useEffect(() => {
    // No live streaming in demo mode
    if (isDemoMode) return;

    const source = new EventSource('/api/stream');
    sourceRef.current = source;

    source.onopen = () => {
      setStatus(current => transitionEventStreamStatus(current, 'open', source.readyState));
    };

    source.onmessage = (e) => {
      setStatus(current => transitionEventStreamStatus(current, 'message', source.readyState));
      try {
        const event = JSON.parse(e.data);
        onEventRef.current(event);
      } catch {}
    };

    source.onerror = () => {
      // Native EventSource owns the retry schedule. Expose that lifecycle so a
      // quiet feed is not indistinguishable from a broken connection.
      setStatus(current => transitionEventStreamStatus(current, 'error', source.readyState));
    };

    return () => {
      source.close();
    };
  }, []);

  return status;
}
