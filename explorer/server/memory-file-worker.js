import fs from 'node:fs';
import { parentPort } from 'node:worker_threads';
import { FILE_READ_LIMIT, FileReadError, decodeText, fileVersion, indexLines, readPage, searchText } from './memory-file-text.js';

// Opens, reads and searches a reviewed file off the Explorer's main thread: an
// open(2) can park on a macOS privacy prompt, and a 32 MiB read and scan is
// long enough to stall every other route. The main thread already checked that
// the session recorded the file and that it resolves inside the corpus root.
//
// Two decoded files stay cached, keyed by path and version, so paging through
// a file reads it once. A changed version is a 409, not a silent re-read: the
// client's line numbers and find results belong to the version it opened.
const cache = new Map();
const CACHE_FILES = 2;

function load(file, expected) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new FileReadError(403, 'Only regular files can be reviewed.');
    const version = fileVersion(stat);
    if (expected && expected !== version) throw new FileReadError(409, 'This file changed since it was opened.');
    const hit = cache.get(file);
    if (hit?.version === version) {
      cache.delete(file); cache.set(file, hit);
      return hit;
    }
    if (stat.size > FILE_READ_LIMIT) throw new FileReadError(413, 'Paging and search cover files up to 32 MiB.');
    const bytes = Buffer.alloc(stat.size);
    let read = 0;
    while (read < bytes.length) {
      const count = fs.readSync(fd, bytes, read, bytes.length - read, read);
      if (!count) break;
      read += count;
    }
    if (read !== stat.size || fileVersion(fs.fstatSync(fd)) !== version) throw new FileReadError(409, 'This file changed while it was being read.');
    const entry = { version, bytes: stat.size, doc: indexLines(decodeText(bytes)) };
    cache.set(file, entry);
    while (cache.size > CACHE_FILES) cache.delete(cache.keys().next().value);
    return entry;
  } catch (error) {
    if (error instanceof FileReadError) throw error;
    if (error.code === 'ELOOP') throw new FileReadError(403, 'File is no longer available inside this workspace.');
    if (error.code === 'ENOENT') throw new FileReadError(404, 'This file no longer exists.');
    if (error.code === 'EPERM' || error.code === 'EACCES') throw new FileReadError(403, 'The Explorer is not allowed to read this file.');
    throw error;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

parentPort.on('message', ({ id, file, version, action, line, query }) => {
  try {
    const entry = load(file, version);
    const result = action === 'search' ? searchText(entry.doc, query) : readPage(entry.doc, line);
    parentPort.postMessage({ id, result: { version: entry.version, totalBytes: entry.bytes, ...result } });
  } catch (error) {
    parentPort.postMessage({ id, error: { status: error.status || 500, message: error.status ? error.message : 'Unable to read this file.' } });
  }
});
