/**
 * Transcript evidence for the Memory Desk's Recall view: which Codex session
 * made a recall call that was recorded without one (scripts/codex-call-evidence.js
 * says what counts as evidence; scripts/recall-join.js says what it means).
 *
 * Rollouts are read on worker threads and remembered per file version. A
 * 30-day window is ~1,700 rollouts, 1,400 of them zstd-compressed, and ~20 s
 * of reading on one core (measured 2026-11-13), which is no work for the
 * request thread and too long for one request. So a request waits a bounded
 * time: if the rollouts it needs are not all read by then it is answered from
 * the record alone and says "scanning", and the scan carries on for the next
 * one. A compressed rollout never changes, so it is read once per process.
 *
 * Evidence is all or nothing for a request. "Minted in exactly one rollout"
 * cannot be said while a rollout that could hold a second mint is unread, so
 * a partial scan attributes no call.
 *
 * Read-only: nothing here writes a log, and nothing is persisted.
 */
import os from 'node:os';
import { Worker } from 'node:worker_threads';
import { foldCallEvidence, listCodexRollouts } from '../../scripts/codex-call-evidence.js';

export const CALL_EVIDENCE_BUDGET_MS = 4000;
const LIST_TTL_MS = 5000;

function runWorker(files) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./call-evidence-worker.js', import.meta.url), { workerData: { files } });
    let settled = false;
    worker.once('message', (message) => { settled = true; resolve(message); });
    worker.once('error', (error) => { settled = true; reject(error); });
    worker.once('exit', (code) => { if (!settled) reject(new Error(`Rollout scan worker exited with code ${code}`)); });
  });
}

/** Split by bytes across a few workers, as the image wall does: the machine is usually busy. */
export async function scanRolloutsInWorkers(rollouts, { workers = Math.max(1, Math.min(3, os.availableParallelism() - 1)) } = {}) {
  if (!rollouts.length) return [];
  const shards = Array.from({ length: Math.min(workers, rollouts.length) }, () => ({ files: [], bytes: 0 }));
  for (const rollout of [...rollouts].sort((a, b) => b.size - a.size)) {
    const shard = shards.reduce((a, b) => (b.bytes < a.bytes ? b : a));
    shard.files.push(rollout.file);
    shard.bytes += rollout.size;
  }
  return (await Promise.all(shards.map((shard) => runWorker(shard.files)))).flat();
}

const identityOf = (rollout) => `${rollout.ino}:${rollout.size}:${rollout.mtimeMs}`;

export function createCallEvidenceSource({ list = listCodexRollouts, scan = scanRolloutsInWorkers, budgetMs = CALL_EVIDENCE_BUDGET_MS, listTtlMs = LIST_TTL_MS } = {}) {
  const scans = new Map(); // file → { identity, scan }
  let listing = null;
  let running = null;
  let folded = null; // rebuilt only after a scan lands, so its identity is a version

  function rollouts() {
    if (listing && Date.now() - listing.at <= listTtlMs) return listing.files;
    const files = list();
    // A rollout archived or compressed since the last walk is read again at
    // its new path; drop the old one rather than let the cache grow.
    const present = new Set(files.map((rollout) => rollout.file));
    for (const file of scans.keys()) if (!present.has(file)) { scans.delete(file); folded = null; }
    listing = { at: Date.now(), files };
    return files;
  }

  const unread = (files) => files.filter((rollout) => scans.get(rollout.file)?.identity !== identityOf(rollout));

  async function read(files) {
    let results = [];
    try {
      results = await scan(files);
    } catch {
      // A worker that died read nothing. Its files are recorded as unreadable
      // so the next request reports them instead of scanning forever.
    }
    const byFile = new Map(results.map((result) => [result.file, result]));
    for (const rollout of files) {
      scans.set(rollout.file, {
        identity: identityOf(rollout),
        scan: byFile.get(rollout.file) || { file: rollout.file, session_id: rollout.session_id, readable: false, reason: 'scan', minted: [], named: [], foreign_rows: 0 },
      });
    }
    folded = null;
  }

  /** True once every one of `files` is read at its current version; false when the budget ran out first. */
  async function settle(files) {
    const deadline = Date.now() + budgetMs;
    for (;;) {
      const pending = unread(files);
      if (!pending.length) return true;
      if (!running) running = read(pending).finally(() => { running = null; });
      const left = deadline - Date.now();
      if (left <= 0) return false;
      let timer;
      const done = await Promise.race([
        running.then(() => true),
        new Promise((resolve) => { timer = setTimeout(() => resolve(false), left); }),
      ]);
      clearTimeout(timer);
      if (!done) return false;
    }
  }

  return {
    /**
     * Evidence from every rollout written at or after `since`: enough to
     * attribute any call made at or after it. The fold covers every rollout
     * read so far, which only makes the "exactly one" test stricter.
     */
    async since(since) {
      const files = rollouts().filter((rollout) => rollout.mtimeMs >= since);
      if (!(await settle(files))) return { status: 'scanning', evidence: null, rollouts: files.length, pending: unread(files).length };
      folded ||= foldCallEvidence([...scans.values()].map((entry) => entry.scan));
      const unreadable = files.filter((rollout) => !scans.get(rollout.file).scan.readable).length;
      return { status: 'complete', evidence: folded, rollouts: files.length, pending: 0, unreadable };
    },

    /**
     * The call ids minted in one session's own rollout: where a session-wide
     * request starts, since the record does not say which calls are its.
     * Null when the id is not a Codex rollout, which costs one cached listing.
     */
    async sessionMinted(sessionId) {
      const files = rollouts().filter((rollout) => rollout.session_id === sessionId);
      if (!files.length) return null;
      if (!(await settle(files))) return { status: 'scanning', minted: [] };
      return { status: 'complete', minted: [...new Set(files.flatMap((rollout) => scans.get(rollout.file).scan.minted))] };
    },
  };
}
