import { useEffect, useRef, useCallback } from 'react';

export function useEventStream(onEvent) {
  const sourceRef = useRef(null);
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  useEffect(() => {
    const source = new EventSource('/api/stream');
    sourceRef.current = source;

    source.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data);
        onEventRef.current(event);
      } catch {}
    };

    source.onerror = () => {
      // EventSource auto-reconnects
    };

    return () => {
      source.close();
    };
  }, []);
}
