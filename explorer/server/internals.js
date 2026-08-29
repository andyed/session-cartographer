import { performance } from 'perf_hooks';
import { Worker } from 'worker_threads';
import {
  buildInternalsSnapshotFromFiles,
  internalsSourceFingerprint,
  internalsSourcePaths,
  normalizeInternalsPurpose,
  normalizeInternalsWindow,
} from './internals-aggregate.js';

export {
  aggregateInternalsRecords,
  buildInternalsSnapshotFromFiles,
  internalsSourceFingerprint,
  internalsSourcePaths,
  normalizeInternalsPurpose,
  normalizeInternalsWindow,
  normalizeSourceLabel,
} from './internals-aggregate.js';

const snapshots = new Map();
const inFlight = new Map();
const DEFAULT_INLINE_MAX_BYTES = 4 * 1024 * 1024;
const MAX_CACHE_ENTRIES = 12;

function workerSnapshot(options) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./internals-worker.js', import.meta.url), {
      workerData: options,
      // `--input-type` is valid for eval/stdin entry points but not worker files.
      execArgv: process.execArgv.filter((arg) => !arg.startsWith('--input-type')),
    });
    let settled = false;
    worker.once('message', (message) => {
      settled = true;
      if (message?.ok) resolve(message.snapshot);
      else reject(new Error(message?.error || 'Internals worker failed'));
    });
    worker.once('error', (error) => {
      settled = true;
      reject(error);
    });
    worker.once('exit', (code) => {
      if (!settled && code !== 0) reject(new Error(`Internals worker exited with code ${code}`));
    });
  });
}

export function buildInternalsSnapshotInWorker(options = {}) {
  return workerSnapshot(options);
}

function responseWithRequestMeta(snapshot, cacheStatus, requestDurationMs) {
  return {
    ...snapshot,
    meta: {
      ...snapshot.meta,
      cacheStatus,
      requestDurationMs,
    },
  };
}

function trimCache() {
  while (snapshots.size > MAX_CACHE_ENTRIES) {
    snapshots.delete(snapshots.keys().next().value);
  }
}

export function clearInternalsCache() {
  snapshots.clear();
  inFlight.clear();
}

/**
 * Build or reuse one atomic snapshot. Small local telemetry logs are faster to
 * parse inline than through a worker; larger inputs automatically leave the
 * Express event loop. Set executionMode for tests/benchmarks.
 */
export async function getInternalsSnapshot({
  window = '30d',
  purpose = 'remember',
  refresh = false,
  paths = internalsSourcePaths(),
  nowMs = Date.now(),
  executionMode = 'auto',
  inlineMaxBytes = Number(process.env.CARTOGRAPHER_INTERNALS_INLINE_MAX_BYTES) || DEFAULT_INLINE_MAX_BYTES,
} = {}) {
  const requestStarted = performance.now();
  const normalizedWindow = normalizeInternalsWindow(window);
  const normalizedPurpose = normalizeInternalsPurpose(purpose);
  if (!normalizedWindow) throw new Error(`Unsupported internals window: ${window}`);
  if (!normalizedPurpose) throw new Error(`Unsupported internals purpose: ${purpose}`);
  if (!['auto', 'inline', 'worker'].includes(executionMode)) {
    throw new Error(`Unsupported internals execution mode: ${executionMode}`);
  }

  const fingerprint = internalsSourceFingerprint(paths);
  const cacheKey = `${fingerprint.value}:${normalizedWindow}:${normalizedPurpose}`;
  if (!refresh && snapshots.has(cacheKey)) {
    return responseWithRequestMeta(snapshots.get(cacheKey), 'hit', performance.now() - requestStarted);
  }

  if (inFlight.has(cacheKey)) {
    const snapshot = await inFlight.get(cacheKey);
    return responseWithRequestMeta(snapshot, 'coalesced', performance.now() - requestStarted);
  }

  const resolvedMode = executionMode === 'auto'
    ? (fingerprint.totalBytes > inlineMaxBytes ? 'worker' : 'inline')
    : executionMode;
  const options = {
    paths,
    fingerprint,
    window: normalizedWindow,
    purpose: normalizedPurpose,
    nowMs,
  };
  const build = resolvedMode === 'worker'
    ? buildInternalsSnapshotInWorker(options)
    : Promise.resolve().then(() => buildInternalsSnapshotFromFiles({ ...options, executionMode: 'inline' }));

  inFlight.set(cacheKey, build);
  try {
    const snapshot = await build;
    snapshots.set(cacheKey, snapshot);
    trimCache();
    return responseWithRequestMeta(snapshot, 'miss', performance.now() - requestStarted);
  } finally {
    inFlight.delete(cacheKey);
  }
}
