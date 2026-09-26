/**
 * tests/unit/live-index-isolation.test.js
 *
 * Hook tests wrote their fixtures into the live Qdrant. Every hook that logs
 * an event backgrounds scripts/index-event.sh, and the indexer has no off
 * switch: it reads CARTOGRAPHER_QDRANT_URL and CARTOGRAPHER_EMBED_URL and
 * otherwise talks to localhost:6333 and :8890. Measured 2026-09-26, the
 * `session-cartographer` collection held 15 points from three test files,
 * each with a temp-dir cwd: 9 `testsess` from log-tool-use-git-commit, 5
 * `testsess` from log-tool-use-bash-edits, 1 `sess-real-0001` from
 * transcript-verified. Nothing errored; the hooks background the indexer and
 * the tests assert only on the JSONL logs.
 *
 * Pinning the URLs per file (efd626e) fixed one of those files. This file
 * makes the rule structural:
 *
 * 1. Which scripts can reach index-event.sh is derived from the code, not
 *    listed by hand. The derivation also finds a path that is easy to miss:
 *    cartographer-search.sh runs hooks/log-knowledge-gap.sh on a zero-result
 *    query that names an unknown file or event id, and that hook indexes.
 * 2. Every test file that runs one of those scripts must pin both URLs, via
 *    tests/unit/helpers/offline-index.js or its own values.
 * 3. Each indexing hook runs under a curl shim that records every request and
 *    refuses it without touching the network. Unpinned, each hook reaches
 *    localhost:6333, which is the leak made visible. Under OFFLINE_INDEX_ENV,
 *    it reaches only the dead port.
 *
 * Check 2 is static and file-level. It catches a file that never pins, but
 * not one spawn site left unpinned in a file that pins elsewhere.
 *
 * Run with: node --test tests/unit/live-index-isolation.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEAD_SERVICE_URL, OFFLINE_INDEX_ENV } from './helpers/offline-index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const HOOKS_DIR = path.join(ROOT, 'plugins', 'session-cartographer', 'hooks');
const TESTS_DIR = path.join(ROOT, 'tests', 'unit');
const SCRIPT_DIRS = ['scripts', 'plugins/session-cartographer/hooks', 'plugins/session-cartographer/scripts'];
const LIVE_QDRANT = 'http://localhost:6333';

// Comments and printed advice name a script without running it:
// `console.log('next: node scripts/embed-events.js')` is not a call. The shell
// rule is `#` alone, since a `*)` case branch is code.
const NOT_CODE_SH = /^\s*#/;
const NOT_CODE_JS = /^\s*(\/\/|\/\*|\*)|console\.(log|error|warn)\(/;
const codeLines = (file) => {
  const notCode = file.endsWith('.sh') ? NOT_CODE_SH : NOT_CODE_JS;
  return fs.readFileSync(file, 'utf8').split('\n').filter((l) => !notCode.test(l));
};

/** name -> the code line through which it reaches the indexer (fixpoint). */
function reachingScripts() {
  const files = SCRIPT_DIRS.flatMap((dir) => fs.readdirSync(path.join(ROOT, dir))
    .filter((f) => /\.(sh|js|mjs|cjs)$/.test(f))
    .map((f) => path.join(ROOT, dir, f)));
  const lines = new Map(files.map((f) => [f, codeLines(f)]));
  const reach = new Map([['index-event.sh', 'the indexer itself']]);
  for (let grew = true; grew;) {
    grew = false;
    for (const file of files) {
      const name = path.basename(file);
      if (reach.has(name)) continue;
      for (const target of reach.keys()) {
        const hit = lines.get(file).find((l) => l.includes(target));
        if (hit) { reach.set(name, `${target}: ${hit.trim()}`); grew = true; break; }
      }
    }
  }
  return reach;
}

const REACH = reachingScripts();
const SELF = path.basename(fileURLToPath(import.meta.url));

// Test files that name a reaching script only to read its source text.
const READS_ONLY = {
  'codex-memory-stale.test.js': 'reads cartographer-search.sh as text',
  'provider-adapters.test.js': 'reads cartographer-search.sh as text',
  'turbo-recall.test.js': 'reads cartographer-feed.sh as text',
  'worktree-project-attribution.test.js': 'reads record-investigation.sh as text',
};

const pinned = (code) => /\.\.\.OFFLINE_INDEX_ENV\b/.test(code)
  || (/\bCARTOGRAPHER_QDRANT_URL\s*:/.test(code) && /\bCARTOGRAPHER_EMBED_URL\s*:/.test(code));

function namedReachers(file) {
  const code = codeLines(path.join(TESTS_DIR, file)).join('\n');
  return { code, names: [...REACH.keys()].filter((name) => code.includes(name)) };
}

test('the derivation finds every known path to the indexer', () => {
  // Without this, a refactor that hides a call behind a variable empties the
  // set and every check below passes against nothing.
  for (const name of [
    'log-tool-use.sh', 'log-session-milestones.sh', 'log-research.sh',
    'log-compact-summary.sh', 'log-knowledge-gap.sh', 'start-transcript-catch-up.sh',
    'cartographer-search.sh', 'retro-index.sh', 'record-wrapup.sh', 'backfill-git-history.sh',
  ]) {
    assert.ok(REACH.has(name), `${name} reaches index-event.sh but the derivation missed it`);
  }
  assert.match(REACH.get('cartographer-search.sh'), /log-knowledge-gap\.sh/);
});

test('every test file that runs an indexer-reaching script pins both service URLs', () => {
  const offenders = [];
  for (const file of fs.readdirSync(TESTS_DIR).filter((f) => f.endsWith('.test.js'))) {
    // This file's unpinned runs go through the curl stand-in below.
    if (READS_ONLY[file] || file === SELF) continue;
    const { code, names } = namedReachers(file);
    if (names.length && !pinned(code)) offenders.push(`${file} (runs ${names.join(', ')})`);
  }
  assert.deepEqual(offenders, [],
    'these files can write fixtures into the live Qdrant; spread OFFLINE_INDEX_ENV from '
    + `tests/unit/helpers/offline-index.js into each spawn's env:\n  ${offenders.join('\n  ')}`);
});

test('each read-only exemption still names a reaching script', () => {
  for (const file of Object.keys(READS_ONLY)) {
    assert.ok(fs.existsSync(path.join(TESTS_DIR, file)), `${file} is gone; drop its exemption`);
    assert.notDeepEqual(namedReachers(file).names, [], `${file} no longer names a reaching script; drop its exemption`);
  }
});

// A stand-in curl that logs each URL it is handed and refuses the connection.
// It never calls the real curl, so an unpinned run below cannot reach the
// network either. If a request ever escaped it (a curl called by absolute
// path, say), it would name a collection that does not exist, and the
// indexer's health probe would stop there, before it embeds or writes.
const NO_SUCH_COLLECTION = 'carto-tripwire-never-created';

function tripwire() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-tripwire-'));
  const bin = path.join(dir, 'bin');
  const dev = path.join(dir, 'dev');
  const log = path.join(dir, 'curl-urls');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'curl'), [
    '#!/bin/sh',
    'for a in "$@"; do case "$a" in http://*|https://*) printf \'%s\\n\' "$a" >> "$TRIPWIRE_LOG" ;; esac; done',
    'exit 7',
    '',
  ].join('\n'), { mode: 0o755 });

  const env = (pins) => {
    const base = { ...process.env };
    for (const key of [
      'CARTOGRAPHER_QDRANT_URL', 'CARTOGRAPHER_EMBED_URL', 'CARTOGRAPHER_COLLECTION', 'CARTOGRAPHER_ROOT',
      'CARTOGRAPHER_SESSION_ID', 'CLAUDE_SESSION_ID', 'CLAUDE_CODE_SESSION_ID', 'CODEX_SESSION_ID',
    ]) delete base[key];
    return {
      ...base,
      ...pins,
      PATH: `${bin}:${process.env.PATH}`,
      TRIPWIRE_LOG: log,
      CARTOGRAPHER_COLLECTION: NO_SUCH_COLLECTION,
      CARTOGRAPHER_DEV_DIR: dev,
      CARTOGRAPHER_LOG_TOOL_USE: 'true',
      // Catch-up runs retro-index.sh over the real transcript stores.
      CARTOGRAPHER_POSTCOMPACT_CATCHUP: '0',
    };
  };

  // Each run starts from an empty corpus. A second run over the first one's
  // logs is not a repeat: the compact hook drops a summary it has already
  // logged, and a gap event puts the "unknown" id into the changelog.
  const fresh = () => {
    fs.rmSync(log, { force: true });
    fs.rmSync(dev, { recursive: true, force: true });
    fs.mkdirSync(dev);
    return dev;
  };

  // log-compact-summary.sh detaches the indexer with nohup, so it can land
  // after the hook exits. The others hold the hook's stdout until they finish.
  const urls = async () => {
    for (let waited = 0; waited < 5000; waited += 50) {
      if (fs.existsSync(log)) return fs.readFileSync(log, 'utf8').split('\n').filter(Boolean);
      await sleep(50);
    }
    return [];
  };

  return { dir, env, fresh, urls };
}

const payload = (wire, extra) => JSON.stringify({
  session_id: 'tripwire', cwd: wire.dir, transcript_path: path.join(wire.dir, 't.jsonl'), ...extra,
});

// One run per hook that backgrounds index-event.sh itself.
const HOOK_RUNS = {
  'log-tool-use.sh': (w) => ({ input: payload(w, { tool_name: 'Bash', tool_input: { command: 'node build.js' } }) }),
  'log-session-milestones.sh': (w) => ({ input: payload(w, { hook_event_name: 'PreCompact', trigger: 'manual' }) }),
  'log-research.sh': (w) => ({ input: payload(w, { tool_name: 'WebFetch', tool_input: { url: 'https://example.com/tripwire', prompt: 'p' } }) }),
  'log-compact-summary.sh': (w) => ({ input: payload(w, { hook_event_name: 'PostCompact', trigger: 'manual', compact_summary: 'tripwire summary' }) }),
  'log-knowledge-gap.sh': () => ({ args: ['--query', 'evt-tripwire', '--entities', 'evt-tripwire'] }),
};

test('the runtime check drives every hook that calls the indexer', () => {
  const direct = fs.readdirSync(HOOKS_DIR)
    .filter((f) => f.endsWith('.sh') && codeLines(path.join(HOOKS_DIR, f)).some((l) => l.includes('index-event.sh')))
    .sort();
  assert.deepEqual(Object.keys(HOOK_RUNS).sort(), direct,
    'a hook that indexes needs a run in HOOK_RUNS, or its path to the live index goes unchecked');
});

for (const [hook, spec] of Object.entries(HOOK_RUNS)) {
  test(`${hook} reaches the live Qdrant unpinned and only the dead port under OFFLINE_INDEX_ENV`, async () => {
    const wire = tripwire();
    try {
      const run = async (pins) => {
        wire.fresh();
        const { input = '', args = [] } = spec(wire);
        const res = spawnSync('bash', [path.join(HOOKS_DIR, hook), ...args],
          { input, env: wire.env(pins), encoding: 'utf8', timeout: 20000 });
        assert.equal(res.status, 0, res.stderr);
        return wire.urls();
      };

      // Without this, the pinned assertion also passes for a hook that never
      // reaches the indexer, and says nothing about the leak.
      const unpinned = await run({});
      assert.ok(unpinned.some((u) => u.startsWith(LIVE_QDRANT)),
        `unpinned, ${hook} should reach ${LIVE_QDRANT}; the stand-in curl saw ${JSON.stringify(unpinned)}`);

      const offline = await run(OFFLINE_INDEX_ENV);
      assert.ok(offline.length > 0, `${hook} never reached the indexer under OFFLINE_INDEX_ENV`);
      assert.deepEqual(offline.filter((u) => !u.startsWith(DEAD_SERVICE_URL)), [],
        `${hook} sent a request somewhere other than the dead port`);
    } finally {
      fs.rmSync(wire.dir, { recursive: true, force: true });
    }
  });
}

test('a zero-result search that names an unknown event id reaches the indexer through the knowledge-gap hook', async () => {
  const wire = tripwire();
  try {
    const none = path.join(wire.dir, 'no-transcripts');
    const run = async (pins) => {
      const dev = wire.fresh();
      for (const log of ['changelog', 'research-log', 'session-milestones', 'tool-use-log', 'prompt-history']) {
        fs.writeFileSync(path.join(dev, `${log}.jsonl`), '');
      }
      const res = spawnSync('bash', [path.join(ROOT, 'scripts', 'cartographer-search.sh'),
        'where is evt-tripwire0001', '--limit', '3', '--no-turbo'], {
        env: {
          ...wire.env(pins),
          // The semantic leg would also probe Qdrant; keep the only caller the indexer.
          CARTOGRAPHER_SEMANTIC: '0',
          CARTOGRAPHER_TURBO: '0',
          CARTOGRAPHER_SERVED_LOG: '/dev/null',
          CARTOGRAPHER_ACCESS_LEDGER: '/dev/null',
          CARTOGRAPHER_CLAUDE_TRANSCRIPTS_DIR: none,
          CARTOGRAPHER_CODEX_TRANSCRIPTS_DIR: none,
          CARTOGRAPHER_CODEX_ARCHIVED_DIR: none,
        },
        encoding: 'utf8',
        timeout: 30000,
      });
      assert.equal(res.status, 0, res.stderr);
      assert.ok(fs.existsSync(path.join(dev, 'knowledge-gaps.jsonl')),
        `the query must trip the knowledge-gap path, or this test checks nothing:\n${res.stdout}`);
      return wire.urls();
    };

    const unpinned = await run({});
    assert.ok(unpinned.some((u) => u.startsWith(LIVE_QDRANT)),
      `unpinned, the gap hook should reach ${LIVE_QDRANT}; saw ${JSON.stringify(unpinned)}`);

    const offline = await run(OFFLINE_INDEX_ENV);
    assert.ok(offline.length > 0, 'the gap hook never reached the indexer under OFFLINE_INDEX_ENV');
    assert.deepEqual(offline.filter((u) => !u.startsWith(DEAD_SERVICE_URL)), []);
  } finally {
    fs.rmSync(wire.dir, { recursive: true, force: true });
  }
});
