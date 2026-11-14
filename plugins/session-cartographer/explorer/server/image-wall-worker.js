import { parentPort, workerData } from 'node:worker_threads';
import { scanTranscriptImages } from './image-wall.js';
import { inspectDocument, inspectImage } from './session-artifacts.js';

if (workerData.mode === 'inspect') {
  // One message per file, so the parent's watchdog can tell which open stalled.
  const check = workerData.kind === 'document' ? file => inspectDocument(file) : file => inspectImage(file, workerData.known?.[file]);
  workerData.files.forEach((file, index) => parentPort.postMessage({ index, result: check(file) }));
  parentPort.postMessage({ done: true });
} else {
  // One failed transcript must not blank the wall: report it and carry on.
  parentPort.postMessage(workerData.files.map(file => {
    try { return { file, record: scanTranscriptImages(file) }; }
    catch (error) { return { file, error: error instanceof Error ? error.message : String(error) }; }
  }));
}
