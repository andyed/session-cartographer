import { parentPort, workerData } from 'worker_threads';
import { buildInternalsSnapshotFromFiles } from './internals-aggregate.js';

try {
  const snapshot = buildInternalsSnapshotFromFiles({
    ...workerData,
    executionMode: 'worker',
  });
  parentPort.postMessage({ ok: true, snapshot });
} catch (error) {
  parentPort.postMessage({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  });
}
