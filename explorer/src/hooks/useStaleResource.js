import { useCallback, useEffect, useRef, useState } from 'react';

const CACHE_PREFIX = 'cartographer:internals:v1:';
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function readCache(key, maxAgeMs) {
  try {
    const entry = JSON.parse(localStorage.getItem(`${CACHE_PREFIX}${key}`));
    if (!entry || typeof entry !== 'object' || !('data' in entry)) return null;
    if (!Number.isFinite(entry.cachedAt) || Date.now() - entry.cachedAt > maxAgeMs) return null;
    return entry;
  } catch {
    return null;
  }
}

function writeCache(key, data) {
  try {
    localStorage.setItem(`${CACHE_PREFIX}${key}`, JSON.stringify({ data, cachedAt: Date.now() }));
  } catch {
    // Persistence is best-effort. A full/quarantined localStorage must not block telemetry.
  }
}

/**
 * Render a recent persistent snapshot immediately, then replace it atomically
 * when the fresh request completes. The loader receives { signal, refresh }.
 */
export function useStaleResource(key, loader, { enabled = true, maxAgeMs = DEFAULT_MAX_AGE_MS } = {}) {
  const [state, setState] = useState({
    data: null,
    error: null,
    refreshing: false,
    stale: false,
    cachedAt: null,
  });
  const controllerRef = useRef(null);
  const generationRef = useRef(0);

  const run = useCallback(async ({ force = false, seedFromCache = false } = {}) => {
    const generation = ++generationRef.current;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;

    const cached = seedFromCache ? readCache(key, maxAgeMs) : null;
    setState(previous => ({
      data: seedFromCache ? (cached?.data ?? null) : previous.data,
      error: null,
      refreshing: true,
      stale: seedFromCache ? Boolean(cached) : previous.stale,
      cachedAt: seedFromCache ? (cached?.cachedAt ?? null) : previous.cachedAt,
    }));

    try {
      const data = await loader({ signal: controller.signal, refresh: force });
      if (controller.signal.aborted || generation !== generationRef.current) return data;
      writeCache(key, data);
      setState({ data, error: null, refreshing: false, stale: false, cachedAt: Date.now() });
      return data;
    } catch (error) {
      if (controller.signal.aborted || generation !== generationRef.current) return null;
      setState(previous => ({ ...previous, error, refreshing: false }));
      return null;
    }
  }, [key, loader, maxAgeMs]);

  useEffect(() => {
    if (!enabled) return undefined;
    run({ seedFromCache: true });
    return () => controllerRef.current?.abort();
  }, [enabled, run]);

  const refresh = useCallback(() => run({ force: true }), [run]);

  return { ...state, refresh };
}
