import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';

// Opening a corpus-named file can block indefinitely. macOS privacy controls
// (TCC) guard ~/Downloads, ~/Desktop, ~/Documents, the Photos library, cloud
// storage and mounted volumes; a process with no grant parks in open(2) until
// someone answers the permission prompt, and a server started by launchd or a
// desktop app may never get one. Measured 2026-10-29: the first image wall
// build froze the whole Explorer, every route included, on
// ~/Downloads/…/filmstrip-contact.png, with 0% CPU and the main thread in __open.
// lstat(2) on the same path returned, so listing metadata is safe; opening is not.
//
// So every first open happens on a worker thread under a stall watchdog. A
// file that makes no progress is reported as blocked, its protected folder is
// skipped for RETRY_MS, and the remaining files continue on a fresh worker.
// The stuck thread is unref'd and left to finish whenever the kernel lets it
// go. A route then opens on its own thread only a file a worker has opened.
const STALL_MS = 5000;
const RETRY_MS = 10 * 60 * 1000;
const TRUST_MS = 10 * 60 * 1000;

/** The folder a privacy grant covers, so one stall skips its siblings; else the file itself. */
export function protectedRoot(file, home = os.homedir()) {
  const rel = path.relative(home, file).split(path.sep);
  if (rel[0] && rel[0] !== '..' && !path.isAbsolute(rel[0])) {
    if (['Desktop', 'Documents', 'Downloads', 'Movies', 'Music'].includes(rel[0])) return path.join(home, rel[0]);
    if (rel[0] === 'Library' && ['Mobile Documents', 'CloudStorage'].includes(rel[1]) && rel[2]) return path.join(home, ...rel.slice(0, 3));
    if (rel[0] === 'Pictures' && /\.photoslibrary$/.test(rel[1] || '')) return path.join(home, rel[0], rel[1]);
  }
  const volume = file.split(path.sep);
  if (volume[1] === 'Volumes' && volume[2]) return volume.slice(0, 3).join(path.sep);
  return file;
}

// A stall means a privacy prompt only on macOS; elsewhere it is usually an
// unreachable network drive, so the message names what was observed.
export function blockedMessage(root, home = os.homedir(), platform = process.platform) {
  const shown = root.startsWith(home + path.sep) ? `~${root.slice(home.length)}` : root;
  return platform === 'darwin' ? `macOS has not let the Explorer read ${shown}.` : `Opening files in ${shown} stalled, so the Explorer skipped them.`;
}

function spawnWorker(workerData) {
  return new Worker(new URL('./image-wall-worker.js', import.meta.url), { workerData });
}

export function createGuardedInspector({ stallMs = STALL_MS, retryMs = RETRY_MS, trustMs = TRUST_MS, spawn = spawnWorker, now = Date.now, home = os.homedir(), platform = process.platform } = {}) {
  const blocked = new Map(); // protected root → when it stalled
  const seen = new Map(); // `${kind}\0${file}` → { result, at }
  const blockedResult = root => ({ status: 'blocked', root, code: 503, reason: blockedMessage(root, home, platform) });
  const isBlocked = file => {
    const root = protectedRoot(file, home);
    const since = blocked.get(root);
    if (since === undefined) return false;
    if (now() - since < retryMs) return true;
    blocked.delete(root);
    return false;
  };

  /** files → Map(file → result), every file checked on a worker now. */
  function inspect(files, { kind = 'image' } = {}) {
    return new Promise(resolve => {
      const results = new Map();
      let queue = [], worker = null, next = 0, last = now(), timer = null;
      const settleBlocked = list => list.filter(file => {
        if (!isBlocked(file)) return true;
        results.set(file, blockedResult(protectedRoot(file, home)));
        return false;
      });
      const stop = () => { if (!worker) return; worker.removeAllListeners('message'); worker.removeAllListeners('error'); worker.removeAllListeners('exit'); worker.unref?.(); void worker.terminate?.(); worker = null; };
      const finish = () => {
        clearInterval(timer);
        stop();
        for (const file of queue.slice(next)) if (!results.has(file)) results.set(file, { status: 'unavailable', code: 503, reason: 'The file check stopped before this file.' });
        if (seen.size > 50_000) seen.clear();
        for (const [file, result] of results) seen.set(`${kind}\0${file}`, { result, at: now() });
        resolve(results);
      };
      const start = list => {
        queue = settleBlocked(list); next = 0; last = now();
        if (!queue.length) return finish();
        // An image whose fingerprint still matches keeps its measured size.
        const known = Object.fromEntries(queue.flatMap(file => {
          const previous = seen.get(`${kind}\0${file}`)?.result;
          return previous?.status === 'available' ? [[file, previous]] : [];
        }));
        worker = spawn({ mode: 'inspect', kind, files: queue, known });
        worker.on('message', message => {
          if (message.done) return finish();
          results.set(queue[message.index], message.result);
          next = message.index + 1; last = now();
        });
        worker.on('error', finish);
        worker.on('exit', finish);
      };
      timer = setInterval(() => {
        if (!worker || now() - last < stallMs) return;
        const stalled = queue[next];
        const root = protectedRoot(stalled, home);
        blocked.set(root, now());
        results.set(stalled, blockedResult(root));
        const rest = queue.slice(next + 1);
        stop();
        start(rest);
      }, Math.max(50, Math.min(1000, stallMs / 4)));
      start([...new Set(files)]);
    });
  }

  /**
   * Before a route opens `file` on its own thread: a worker opened it within
   * trustMs, or one checks it now. Only `blocked` stops the route; any other
   * outcome lets its own open run and raise its own error, which a file that
   * did not stall the worker will do promptly.
   */
  async function ensure(file, { kind = 'image' } = {}) {
    if (isBlocked(file)) return blockedResult(protectedRoot(file, home));
    const previous = seen.get(`${kind}\0${file}`);
    if (previous?.result.status === 'available' && now() - previous.at < trustMs) return previous.result;
    return (await inspect([file], { kind })).get(file);
  }

  return { inspect, ensure, isBlocked, blockedRoots: () => [...blocked.keys()].filter(root => now() - blocked.get(root) < retryMs) };
}
