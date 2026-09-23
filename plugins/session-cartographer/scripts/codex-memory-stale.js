/**
 * codex-memory-stale.js — the one definition of where the Codex memory
 * stale-id list lives and how readers load it.
 *
 * backfill-codex-memories.js appends every revision of a Codex memory entry to
 * the changelog and writes the superseded event ids here. Every recall path
 * must drop those ids before ranking, so the location cannot drift between
 * them. JS readers import this module. cartographer-search.sh cannot import it
 * from awk and should not pay a node spawn per search for a constant, so it
 * keeps the literal; tests/unit/codex-memory-stale.test.js pins the two
 * together.
 */
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const CODEX_MEMORY_STALE_RELATIVE = '.carto/codex-memory-stale-ids.txt';

/** Resolve the list under the corpus root. Reads env at call time for tests. */
export function codexMemoryStalePath(dev = process.env.CARTOGRAPHER_DEV_DIR || join(homedir(), 'Documents', 'dev')) {
  return join(dev, CODEX_MEMORY_STALE_RELATIVE);
}

/** Read the list once. A missing file means no import has run: empty set. */
export function readCodexMemoryStale(file = codexMemoryStalePath()) {
  try {
    return new Set(readFileSync(file, 'utf8').split('\n').filter(Boolean));
  } catch {
    return new Set();
  }
}

/**
 * Cached read for long-lived processes (Turbo, the Explorer API). A stat per
 * query replaces a full read per query; the file is re-read only when its
 * identity changes. The importer replaces it by rename, so inode is part of
 * the signature alongside mtime and size.
 */
const cache = new Map();
export function cachedCodexMemoryStale(file = codexMemoryStalePath()) {
  let signature;
  try {
    const st = statSync(file);
    signature = `${st.ino}:${st.mtimeMs}:${st.size}`;
  } catch {
    cache.delete(file);
    return new Set();
  }
  const hit = cache.get(file);
  if (hit && hit.signature === signature) return hit.ids;
  const ids = readCodexMemoryStale(file);
  cache.set(file, { signature, ids });
  return ids;
}
