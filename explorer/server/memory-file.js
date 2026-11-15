import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Worker } from 'node:worker_threads';
import { FileReadError } from './memory-file-text.js';

export { FILE_READ_LIMIT, fileVersion } from './memory-file-text.js';

const execFileAsync = promisify(execFile);
// A read that makes no answer in this long is a stall (a privacy prompt, a
// network volume), not a slow file: 32 MiB decodes and indexes in well under 1 s.
const STALL_MS = 10_000;

const spawnWorker = () => new Worker(new URL('./memory-file-worker.js', import.meta.url));

/**
 * One long-lived worker answers page and search requests in order. A stalled
 * request terminates it, fails everything queued on it, and the next request
 * starts a fresh one, so one stuck file never holds the reader shut.
 */
export function createFileReader({ spawn = spawnWorker, stallMs = STALL_MS } = {}) {
  let worker = null, nextId = 1;
  const pending = new Map();
  const failAll = error => {
    for (const { reject, timer } of pending.values()) { clearTimeout(timer); reject(error); }
    pending.clear();
  };
  const retire = error => {
    const current = worker;
    worker = null;
    if (current) { current.removeAllListeners(); current.unref?.(); void current.terminate?.(); }
    failAll(error);
  };
  const ensure = () => {
    if (worker) return worker;
    worker = spawn();
    worker.unref?.();
    worker.on('message', ({ id, result, error }) => {
      const request = pending.get(id);
      if (!request) return;
      pending.delete(id);
      clearTimeout(request.timer);
      if (error) request.reject(new FileReadError(error.status, error.message));
      else request.resolve(result);
    });
    worker.on('error', () => retire(new FileReadError(500, 'Unable to read this file.')));
    worker.on('exit', () => { if (worker) retire(new FileReadError(500, 'Unable to read this file.')); });
    return worker;
  };
  function read(request) {
    return new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => retire(new FileReadError(503, 'Reading this file stalled. Try again, or open it in your editor.')), stallMs);
      pending.set(id, { resolve, reject, timer });
      ensure().postMessage({ id, ...request });
    });
  }
  return { read, close: () => retire(new FileReadError(503, 'The file reader closed.')) };
}

/**
 * How "Open in editor" launches: CARTOGRAPHER_EDITOR names a command that takes
 * the file as its one argument (`cursor`, `code`, `/usr/local/bin/subl`);
 * otherwise macOS opens it in the default text editor. Elsewhere, without the
 * variable, there is nothing to launch and the button is not offered.
 */
export function editorLauncher({ env = process.env, platform = process.platform, run = execFileAsync } = {}) {
  const command = env.CARTOGRAPHER_EDITOR?.trim();
  if (command) return file => run(command, [file], { timeout: 5000, maxBuffer: 65536 });
  if (platform === 'darwin') return file => run('/usr/bin/open', ['-t', '--', file], { timeout: 5000, maxBuffer: 65536 });
  return null;
}
