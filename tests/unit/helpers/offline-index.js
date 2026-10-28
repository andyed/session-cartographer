import { fileURLToPath } from 'node:url';

// Service URLs for any test that spawns a script able to reach
// scripts/index-event.sh.
//
// Every hook that logs an event backgrounds index-event.sh, and
// cartographer-search.sh reaches it too, through hooks/log-knowledge-gap.sh on
// a zero-result query that names an unknown file or event id. The indexer has
// no off switch: it reads CARTOGRAPHER_QDRANT_URL and CARTOGRAPHER_EMBED_URL
// and otherwise talks to localhost:6333 and :8890. A test that spawns one of
// these without both variables writes its fixture rows into the live
// collection. Measured 2026-09-26: 15 points from three hook test files
// (`session: testsess`, `sess-real-0001`), each with a temp-dir cwd.
//
// Port 1 refuses at once, so the indexer fails its health probe and exits,
// recording `qdrant_unavailable` under CARTOGRAPHER_DEV_DIR/.carto. Spread this
// after process.env and before any per-test override, so a test that runs its
// own recorder still wins:
//
//   env: { ...process.env, ...OFFLINE_INDEX_ENV, CARTOGRAPHER_DEV_DIR: dev }
//
// tests/unit/live-index-isolation.test.js fails any test file that runs one of
// these scripts without pinning both URLs.
export const DEAD_SERVICE_URL = 'http://127.0.0.1:1';

export const OFFLINE_INDEX_ENV = Object.freeze({
  CARTOGRAPHER_QDRANT_URL: DEAD_SERVICE_URL,
  CARTOGRAPHER_EMBED_URL: `${DEAD_SERVICE_URL}/v1/embeddings`,
});

// For a hook test that is not about indexing: the same pins, plus a
// CARTOGRAPHER_ROOT whose scripts/index-event.sh reads the event and does
// nothing. The hooks resolve the indexer through cartographer_script, which
// tries CARTOGRAPHER_ROOT first and falls through to the plugin for every
// other script (diff-shape.sh still runs for real).
//
// The hooks detach the indexer from their stdout and stderr, so spawnSync no
// longer waits for it: the real one, failing against the dead port, outlives
// the hook and writes .carto/index-errors.jsonl into CARTOGRAPHER_DEV_DIR. A
// test that removed its temp dir right after the hook raced that write, and
// CI failed in cleanup with ENOTEMPTY (log-tool-use-git-commit.test.js,
// 2026-10-17). A no-op indexer leaves nothing running to race.
export const NO_INDEXER_ROOT = fileURLToPath(new URL('../../fixtures/no-indexer', import.meta.url));

export const NO_INDEXER_ENV = Object.freeze({
  ...OFFLINE_INDEX_ENV,
  CARTOGRAPHER_ROOT: NO_INDEXER_ROOT,
});
