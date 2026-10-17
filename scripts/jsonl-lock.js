#!/usr/bin/env node
// jsonl-lock.js — the rewrite lock the hooks and every in-place rewriter share,
// and the replace that runs under it.
//
// Hooks append to the logs all day; repair scripts occasionally replace them
// whole. A replace that reads the file, rewrites it, and writes it back loses
// every row appended in between, and a truncate-then-write lets an append land
// in the middle of the new copy. Nothing errors either way.
//
// Not flock(2): bash has no builtin for it and Node has no API for it, so
// honouring a real flock would cost every hook a process on every append
// (lockf(1) or flock(1), plus the cat it wraps), against a budget of 7
// processes for the whole tool-use hook. Two small files the hooks can read
// with builtins cost them none:
//
//   <log>.lock     O_EXCL, "<pid> <host> <iso time>". Rewriters only: it keeps
//                  two of them from replacing the same log at once.
//   <log>.rewrite  "held <pid> <gen> <host> <time>" while a rewrite runs,
//                  "released - <gen> <host> <time>" after; <gen> counts
//                  rewrites. Replaced by rename, so a reader sees one whole
//                  line. Kept between rewrites, so the count survives.
//
//   rewriter  takes the lock, says held, replaces the log by temp + rename,
//             says released, drops the lock, waits a grace period, then
//             appends the rows that reached the old file late and the spool.
//   appender  (cartographer_append in hooks/common.sh, appendJsonl here) reads
//             the state, appends to "<log>.spool" while a live pid holds it,
//             reads the state again, and writes the row again if it changed.
//
// The protocol does not depend on appenders seeing the state in time. A hook
// that read it before the rewrite began can still write to the log:
// replaceJsonl carries everything appended past the bytes the caller read into
// the new copy before renaming it, looks again just before the rename, and once
// more at the old file after the grace period. A row that reached the old file
// after all three looks is written again by its appender, whose second read of
// the state saw the rewrite (mustRewrite: anything but the next generation
// still holding). So delivery is at least once. A row
// whose write spanned a whole rewrite, or its release, can be both kept and
// written again; it appears twice, and every reader folds a repeated event_id.
// Late rows and spooled rows that the new copy already holds are not appended
// a second time. A held state whose pid is gone is ignored by
// appenders, its lock is reclaimed by the next rewriter, and that rewriter
// moves any spool the dead one left into the log first.
//
// Rows carried across are copied byte for byte, not transformed: a repair
// applies to the history it read, and rows written during it are new.
//
// CLI:
//   node scripts/jsonl-lock.js status <log>...       rewrite state and spooled rows
//   node scripts/jsonl-lock.js drain <log>...        append a dead rewriter's spool
//   node scripts/jsonl-lock.js snapshot <log> <out>  copy <log>'s complete rows
//   node scripts/jsonl-lock.js replace <log> <original> <body>
//        replace <log> with the file <body>, computed from the snapshot
//        <original> (its bytes as the caller read them); for shell rewriters.
//
// CARTOGRAPHER_REWRITE_GRACE_MS overrides the grace period (tests shorten it).
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

// How long after release to wait before the last look at the old file and the
// spool: long enough that a hook which saw the old state has written and, if it
// noticed the change, written again, so its row is found in the new copy rather
// than appended twice. A loss no longer depends on it; it bounds duplicates,
// and covers appenders older than the second read.
const graceEnv = Number(process.env.CARTOGRAPHER_REWRITE_GRACE_MS);
export const DEFAULT_GRACE_MS = Number.isFinite(graceEnv) && graceEnv >= 0 ? graceEnv : 1000;
export const DEFAULT_WAIT_MS = 30000;
const NL = Buffer.from('\n');
// Appender attempts before giving up on a state that keeps changing.
const APPEND_TRIES = 3;

export const lockPath = (file) => `${file}.lock`;
export const statePath = (file) => `${file}.rewrite`;
export const spoolPath = (file) => `${file}.spool`;

export class RewriteConflictError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RewriteConflictError';
  }
}

function sleepSync(ms) {
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// EPERM means the process exists and belongs to someone else: alive.
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

/** Who holds <file>'s lock: {pid, host, since, live}, or null when unlocked. */
export function lockHolder(file) {
  let text;
  try {
    text = fs.readFileSync(lockPath(file), 'utf8');
  } catch {
    return null;
  }
  const [pidText = '', host = '', since = ''] = text.trim().split(/\s+/);
  const pid = Number(pidText);
  return { pid, host, since, live: pidAlive(pid), token: text };
}

// The first line of <file>.rewrite, as `read -r` gives it to the hooks.
function readState(file) {
  try {
    return fs.readFileSync(statePath(file), 'utf8').split('\n')[0];
  } catch {
    return '';
  }
}

// {kind, pid, gen} of a state line; gen is 0 before any rewrite, NaN if garbled.
function parseState(line) {
  const [kind = '', pid = '', gen = ''] = line.trim().split(/\s+/);
  return { kind, pid: Number(pid), gen: line.trim() === '' ? 0 : (/^\d+$/.test(gen) ? Number(gen) : NaN) };
}

function writeState(file, line) {
  const temporary = `${statePath(file)}.${process.pid}`;
  fs.writeFileSync(temporary, `${line}\n`);
  fs.renameSync(temporary, statePath(file));
}

const heldLive = (state) => {
  const { kind, pid } = parseState(state);
  return kind === 'held' && pidAlive(pid);
};

// Where an appender's row goes under <state>: the spool while a live pid holds
// the log, the log otherwise.
const targetFor = (file, state) => (heldLive(state) ? spoolPath(file) : file);

/**
 * Whether a row written under state <before>, read again as <after>, needs
 * writing again. Not when nothing changed, and not when the next rewrite (one
 * generation on) began since and still holds the log: it has not made its last
 * look at the old file, so a row that went to the log is in hand. Any other
 * change may mean a rewrite finished reading wherever the row went, including
 * a whole rewrite inside one write with another begun after it.
 */
export function mustRewrite(before, after) {
  if (before === after) return false;
  if (!heldLive(before) && heldLive(after) && parseState(after).gen === parseState(before).gen + 1) return false;
  return true;
}

/**
 * Take <file>'s rewrite lock, waiting up to `waitMs` for a live holder, and
 * mark the log held. A lock whose holder is dead is moved aside and taken.
 * Moving it aside, rather than unlinking it, means two scripts reclaiming at
 * once cannot each delete the lock the other has just taken: the one whose
 * rename picks up a lock it did not judge stale puts it back and keeps waiting.
 */
export function acquireRewriteLock(file, { waitMs = DEFAULT_WAIT_MS } = {}) {
  const lock = lockPath(file);
  const host = os.hostname();
  const token = `${process.pid} ${host} ${new Date().toISOString()}\n`;
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      fs.writeFileSync(lock, token, { flag: 'wx', mode: 0o644 });
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    const holder = lockHolder(file);
    if (holder && !holder.live) {
      const aside = `${lock}.stale-${process.pid}`;
      try {
        fs.renameSync(lock, aside);
        if (fs.readFileSync(aside, 'utf8') === holder.token) fs.unlinkSync(aside);
        else fs.renameSync(aside, lock);
      } catch {}
      continue;
    }
    if (Date.now() >= deadline) {
      const who = holder ? `pid ${holder.pid} since ${holder.since}` : 'another process';
      throw new Error(`${file} is being rewritten by ${who}; retry when it finishes (${lock})`);
    }
    sleepSync(100);
  }
  // The lock makes this read-increment-write safe: no other rewriter runs.
  const previous = parseState(readState(file)).gen;
  const gen = Number.isFinite(previous) ? previous + 1 : 1;
  const handle = { file, lock, token, host, gen };
  try {
    writeState(file, `held ${process.pid} ${gen} ${host} ${new Date().toISOString()}`);
  } catch (error) {
    releaseRewriteLock(handle);
    throw error;
  }
  return handle;
}

/** Mark the log released and drop the lock, if it is still ours. */
export function releaseRewriteLock(handle) {
  try {
    if (fs.readFileSync(handle.lock, 'utf8') !== handle.token) return;
  } catch {
    return;
  }
  try {
    writeState(handle.file, `released - ${handle.gen} ${handle.host} ${new Date().toISOString()}`);
  } finally {
    try { fs.unlinkSync(handle.lock); } catch {}
  }
}

/**
 * Append <data> to <file> in one write(2): fs.appendFileSync hands the whole
 * buffer to a single write on a regular file. A missing final newline is
 * added, so the next writer's row cannot join this one. The rewrite state is
 * honoured as cartographer_append honours it: rows go to the spool while a
 * live rewriter holds the log, and are written again if the state changed
 * while they were being written.
 */
export function appendJsonl(file, data) {
  let bytes = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
  if (bytes.length === 0) return;
  if (bytes[bytes.length - 1] !== 0x0a) bytes = Buffer.concat([bytes, NL]);
  for (let attempt = 0; attempt < APPEND_TRIES; attempt += 1) {
    const before = readState(file);
    fs.appendFileSync(targetFor(file, before), bytes);
    if (!mustRewrite(before, readState(file))) return;
  }
}

function readRange(fd, start, length) {
  const buffer = Buffer.alloc(Math.max(0, length));
  let done = 0;
  while (done < buffer.length) {
    const n = fs.readSync(fd, buffer, done, buffer.length - done, start + done);
    if (n === 0) break;
    done += n;
  }
  return buffer.subarray(0, done);
}

function writeAll(fd, buffer) {
  let done = 0;
  while (done < buffer.length) done += fs.writeSync(fd, buffer, done, buffer.length - done);
}

// Through the last newline: a row still being written when we look is left
// for a later look, which reads it whole.
function completeRows(buffer) {
  return buffer.subarray(0, buffer.lastIndexOf(0x0a) + 1);
}

/**
 * <file>'s complete rows, as a rewriter should read them: through the last
 * newline. A row still being written when the read lands is left out and
 * arrives whole with the rows replaceJsonl carries, where a read that kept the
 * fragment would put the rewriter's copy of it beside the writer's remainder.
 */
export function snapshotJsonl(file) {
  return completeRows(fs.readFileSync(file));
}

const linesOf = (buffer) => buffer.toString('utf8').split('\n').filter((line) => line.trim());

// <data>'s rows that are not in <known>, as one buffer.
function unseen(data, known) {
  const fresh = linesOf(data).filter((line) => !known.has(line));
  return { rows: fresh.length, bytes: fresh.length ? Buffer.from(`${fresh.join('\n')}\n`) : Buffer.alloc(0) };
}

/**
 * Append the rows diverted to <file>'s spool and remove it. Does nothing while
 * a live rewriter holds the lock, since its own drain will take them. Rows in
 * <known> (already in the log) are not appended again. Returns how many moved.
 */
export function drainSpool(file, known = new Set()) {
  if (lockHolder(file)?.live) return 0;
  return moveSpool(file, known, (data) => appendJsonl(file, data));
}

// Renamed first, so a hook that opens the spool after this point creates a
// fresh one rather than writing into a file about to be unlinked.
function moveSpool(file, known, append) {
  const spool = spoolPath(file);
  if (!fs.existsSync(spool)) return 0;
  const draining = `${spool}.draining-${process.pid}`;
  try {
    fs.renameSync(spool, draining);
  } catch {
    return 0;
  }
  const { rows, bytes } = unseen(fs.readFileSync(draining), known);
  if (rows) append(bytes);
  fs.unlinkSync(draining);
  return rows;
}

/**
 * Replace <file> with <body>, a rewrite of <original>: the bytes the caller
 * read from it earlier with snapshotJsonl (pass that Buffer; a string is
 * encoded as UTF-8). A body that drops the original's final newline gets it
 * back before the carried rows. Under the lock it checks that the file still
 * begins with <original>, so a second rewriter's work is never overwritten
 * (RewriteConflictError), carries every complete row appended since into the
 * new copy, writes the copy beside the log with the log's mode, and renames it
 * over. After releasing and the grace period it appends the rows that reached
 * the old file late, then drains the spool, skipping rows the log now holds.
 *
 * @returns {{carried_rows: number, late_rows: number, spooled_rows: number}}
 */
export function replaceJsonl(file, { original, body, graceMs = DEFAULT_GRACE_MS, waitMs } = {}) {
  const before = Buffer.isBuffer(original) ? original : Buffer.from(String(original ?? ''), 'utf8');
  if (before.length && before[before.length - 1] !== 0x0a) {
    throw new TypeError(`${file}: the original must end at a row boundary; read it with snapshotJsonl()`);
  }
  let bytes = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
  const handle = acquireRewriteLock(file, { waitMs });
  const temporary = `${file}.rewrite-${process.pid}`;
  let fd;
  let position;
  let renamedSize;
  let carried = Buffer.alloc(0);
  try {
    // Rows a dead rewriter diverted and never drained. Appended straight to
    // the log (we hold it, so appendJsonl would only spool them again), they
    // are an append like any other and are carried below.
    moveSpool(file, new Set(), (data) => fs.appendFileSync(file, data));
    fd = fs.openSync(file, 'r');
    const stat = fs.fstatSync(fd);
    if (stat.size < before.length || !readRange(fd, 0, before.length).equals(before)) {
      throw new RewriteConflictError(`${file} changed in a way that is not an append since it was read; nothing written`);
    }
    carried = completeRows(readRange(fd, before.length, stat.size - before.length));
    position = before.length + carried.length;
    if (carried.length && bytes.length && bytes[bytes.length - 1] !== 0x0a) bytes = Buffer.concat([bytes, NL]);

    const out = fs.openSync(temporary, 'w', stat.mode & 0o7777);
    try {
      writeAll(out, bytes);
      writeAll(out, carried);
      // A last look, for rows from appenders that read the state before the
      // rewrite began and wrote while the copy was being written.
      const late = completeRows(readRange(fd, position, fs.fstatSync(fd).size - position));
      writeAll(out, late);
      carried = Buffer.concat([carried, late]);
      position += late.length;
      fs.fsyncSync(out);
    } finally {
      fs.closeSync(out);
    }
    fs.chmodSync(temporary, stat.mode & 0o7777);
    renamedSize = bytes.length + carried.length;
    fs.renameSync(temporary, file);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch {}
    if (fd !== undefined) fs.closeSync(fd);
    releaseRewriteLock(handle);
    throw error;
  }
  releaseRewriteLock(handle);

  // The old inode stays open: whatever reached it after the last look is still
  // readable. Its appender has probably written it again by now; whatever the
  // new copy holds already, carried or written again since the rename, is not
  // appended twice.
  sleepSync(graceMs);
  let late = Buffer.alloc(0);
  try {
    late = readRange(fd, position, fs.fstatSync(fd).size - position);
  } finally {
    fs.closeSync(fd);
  }
  const known = new Set(linesOf(carried));
  try {
    const now = fs.openSync(file, 'r');
    try {
      for (const line of linesOf(readRange(now, renamedSize, fs.fstatSync(now).size - renamedSize))) known.add(line);
    } finally {
      fs.closeSync(now);
    }
  } catch {}
  const fresh = unseen(late, known);
  if (fresh.rows) appendJsonl(file, fresh.bytes);
  for (const line of linesOf(fresh.bytes)) known.add(line);
  const spooled = drainSpool(file, known);
  return { carried_rows: linesOf(carried).length, late_rows: fresh.rows, spooled_rows: spooled };
}

/** Rewrite state and spooled-row count for <file>, for health and the CLI. */
export function lockStatus(file) {
  const holder = lockHolder(file);
  const state = readState(file);
  let spooled = 0;
  try {
    spooled = linesOf(fs.readFileSync(spoolPath(file))).length;
  } catch {}
  return {
    lock: holder ? { pid: holder.pid, since: holder.since, live: holder.live } : null,
    state: state || null,
    spooled_rows: spooled,
  };
}

function main(argv) {
  const [verb, ...rest] = argv;
  if (verb === 'status' && rest.length) {
    console.log(JSON.stringify(Object.fromEntries(rest.map((file) => [file, lockStatus(file)])), null, 2));
    return 0;
  }
  if (verb === 'drain' && rest.length) {
    for (const file of rest) {
      const holder = lockHolder(file);
      if (holder?.live) {
        console.error(`${file}: pid ${holder.pid} holds the lock; it drains its own spool`);
        continue;
      }
      console.log(`${file}: ${drainSpool(file)} spooled row(s) appended`);
    }
    return 0;
  }
  if (verb === 'snapshot' && rest.length === 2) {
    const [file, out] = rest;
    fs.writeFileSync(out, snapshotJsonl(file));
    return 0;
  }
  if (verb === 'replace' && rest.length === 3) {
    const [file, original, body] = rest;
    const result = replaceJsonl(file, { original: fs.readFileSync(original), body: fs.readFileSync(body) });
    console.log(JSON.stringify(result));
    return 0;
  }
  console.error('usage: jsonl-lock.js status <log>... | drain <log>... | snapshot <log> <out> | replace <log> <original> <body>');
  return 2;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(`jsonl-lock: ${error.message}`);
    process.exitCode = error instanceof RewriteConflictError ? 3 : 1;
  }
}
