import { parentPort, workerData } from 'node:worker_threads';
import { scanRollout } from '../../scripts/codex-call-evidence.js';

// scanRollout reports an unreadable file instead of throwing, so one bad
// rollout cannot cost the others their evidence.
const results = [];
for (const file of workerData.files) results.push(await scanRollout(file));
parentPort.postMessage(results);
