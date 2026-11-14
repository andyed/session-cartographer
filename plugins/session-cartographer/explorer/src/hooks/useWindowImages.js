import { useEffect, useState } from 'react';
import { apiRequest, isDemoMode } from '../api.js';

const MINUTE = 60 * 1000;

/**
 * The images sessions wrote inside the focus window (/api/images/window).
 *
 * A live window advances with every snapshot (every few seconds while
 * sessions are busy), and each request re-reads the transcripts that grew, so
 * a live window refetches at most once a minute and asks the server for
 * "through now" rather than through the last snapshot. A fixed window
 * fetches once per window. The previous list stays up while the next loads.
 */
export default function useWindowImages({ interval, live, enabled }) {
  const [state, setState] = useState({ key: '', images: [], status: 'idle' });
  const from = interval?.from, through = interval?.through;
  const usable = enabled && !isDemoMode && Number.isFinite(from) && Number.isFinite(through) && through > from;
  const key = !usable ? '' : live ? `live:${Math.floor(from / MINUTE)}:${Math.round((through - from) / MINUTE)}` : `${from}:${through}`;
  useEffect(() => {
    if (!key) return undefined;
    const controller = new AbortController();
    const params = new URLSearchParams({ from: new Date(from).toISOString() });
    if (!live) params.set('through', new Date(through).toISOString());
    setState(previous => ({ ...previous, status: 'loading' }));
    apiRequest(`/api/images/window?${params}`, { signal: controller.signal })
      .then(data => {
        if (controller.signal.aborted) return;
        setState({ key, status: 'ready', images: Array.isArray(data.images) ? data.images : [], stats: data.stats || null });
      })
      .catch(error => {
        if (controller.signal.aborted) return;
        // An older backend has no route; the feed then simply has no images.
        if (error.status === 404) setState({ key, status: 'unsupported', images: [] });
        else setState(previous => ({ ...previous, status: 'error', error: error.message }));
      });
    return () => controller.abort();
    // `key` carries from/through/live at the granularity that should refetch.
  }, [key]);
  return usable ? state : { key: '', images: [], status: 'idle' };
}
