/**
 * tests/unit/codex-memory-stale.test.js
 *
 * Four recall paths drop superseded Codex memory versions by reading one
 * derived id list. If any reader looks in a different place, replaced claims
 * silently come back in that path only. The JS readers share
 * codex-memory-stale.js; the awk step in cartographer-search.sh keeps a
 * literal, pinned here.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import {
  CODEX_MEMORY_STALE_RELATIVE, codexMemoryStalePath, cachedCodexMemoryStale,
} from '../../scripts/codex-memory-stale.js';

const repo = resolve(import.meta.dirname, '../..');

test('cartographer-search.sh reads the same stale-id path as the JS readers', () => {
  const shell = readFileSync(join(repo, 'scripts/cartographer-search.sh'), 'utf8');
  assert.ok(
    shell.includes(`codex_memory_stale="$DEV/${CODEX_MEMORY_STALE_RELATIVE}"`),
    'the awk -v codex_memory_stale path drifted from codex-memory-stale.js',
  );
});

test('no reader rebuilds the path by hand', () => {
  for (const file of ['explorer/server/search.js', 'scripts/build-profile.js', 'scripts/backfill-codex-memories.js']) {
    const source = readFileSync(join(repo, file), 'utf8');
    assert.ok(!source.includes('codex-memory-stale-ids.txt'), `${file} hard-codes the stale-id filename`);
  }
});

test('cached reader re-reads only when the file is replaced', () => {
  const dev = mkdtempSync(join(tmpdir(), 'carto-stale-'));
  try {
    const file = codexMemoryStalePath(dev);
    assert.equal(cachedCodexMemoryStale(file).size, 0, 'missing file reads as empty');

    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, 'a\nb\n');
    const first = cachedCodexMemoryStale(file);
    assert.deepEqual([...first].sort(), ['a', 'b']);
    assert.equal(cachedCodexMemoryStale(file), first, 'unchanged file is served from cache');

    // The importer writes a temp file and renames it into place.
    writeFileSync(`${file}.tmp`, 'a\nb\nc\n');
    renameSync(`${file}.tmp`, file);
    assert.deepEqual([...cachedCodexMemoryStale(file)].sort(), ['a', 'b', 'c']);

    rmSync(file);
    assert.equal(cachedCodexMemoryStale(file).size, 0, 'a removed file is not served from cache');
  } finally {
    rmSync(dev, { recursive: true, force: true });
  }
});
