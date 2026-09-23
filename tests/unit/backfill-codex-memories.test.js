import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

const repo = resolve(import.meta.dirname, '../..');
const importer = join(repo, 'scripts/backfill-codex-memories.js');
const search = join(repo, 'scripts/cartographer-search.sh');
const fixture = mkdtempSync(join(tmpdir(), 'carto-codex-memory-'));
const memories = join(fixture, 'memories');
const dev = join(fixture, 'dev');
mkdirSync(join(memories, 'rollout_summaries'), { recursive: true });
mkdirSync(dev);

const env = {
  ...process.env,
  CARTOGRAPHER_CODEX_MEMORIES_DIR: memories,
  CARTOGRAPHER_DEV_DIR: dev,
  CARTOGRAPHER_QDRANT_URL: 'http://127.0.0.1:1',
  CARTOGRAPHER_EMBED_URL: 'http://127.0.0.1:1/v1/embeddings',
  CARTOGRAPHER_SERVED_LOG: '/dev/null',
  CARTOGRAPHER_ACCESS_LEDGER: '/dev/null',
  CARTOGRAPHER_SEARCH_CALL_LOG: '/dev/null',
  CARTOGRAPHER_TURBO: '0',
};
function run(command, args) {
  const result = spawnSync(command, args, { cwd: repo, env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}
function events() {
  return readFileSync(join(dev, 'changelog.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
}

test('Codex registry, overview, and rollouts are searchable and revisions retire old claims', async () => {
  try {
    const registry = join(memories, 'MEMORY.md');
    const rollout = join(memories, 'rollout_summaries', 'example.md');
    writeFileSync(registry, `# Task Group: Search authority\n\nscope: Check the oldtoken route.\napplies_to: cwd=/work/session-cartographer\n\n## Reusable knowledge\n\n- The oldtoken path was selected.\n`);
    writeFileSync(join(memories, 'memory_summary.md'), `v1\n\n## User Profile\n\nPrefers evidence-backed recall.\n\n## User preferences\n\n- Keep corrections visible across sessions.\n\n## What's in Memory\n\nUnrelated list.\n`);
    writeFileSync(rollout, `thread_id: example\ncwd: /work/session-cartographer\n\n# A checked decision\n\n## Task 1\n\nOutcome: success\n\nReusable knowledge:\n- A unique rolloutclaim survived.\n`);
    // Pad the small corpus so BM25's common-term clamp cannot mask the test.
    writeFileSync(join(dev, 'changelog.jsonl'), Array.from({ length: 6 }, (_, i) => JSON.stringify({ event_id: `pad-${i}`, timestamp: '2026-09-01T00:00:00Z', project: 'other', summary: `unrelated filler ${i}` })).join('\n') + '\n');

    const first = run(process.execPath, [importer]);
    assert.match(first, /4 current entries, 4 changes/);
    const created = events().filter((event) => event.memory_key);
    assert.deepEqual(created.map((event) => event.memory_type).sort(), ['overview', 'overview', 'registry', 'rollout']);
    assert.ok(created.every((event) => event.provider === 'codex' && event.memory_path.startsWith(memories)));
    const old = created.find((event) => event.memory_type === 'registry');
    assert.equal(old.project, 'session-cartographer');
    assert.match(run('bash', [search, 'oldtoken', '--no-turbo', '--all', '--format', 'jsonl']), /memory_codex_registry/);

    assert.match(run(process.execPath, [importer]), /0 changes/);
    assert.equal(events().filter((event) => event.memory_key).length, 4);
    assert.match(run(process.execPath, [importer, '--project', 'unrelated-project']), /0 current entries, 0 changes/);
    assert.equal(events().filter((event) => event.memory_key).length, 4);

    writeFileSync(registry, readFileSync(registry, 'utf8').replaceAll('oldtoken', 'newtoken'));
    rmSync(rollout);
    assert.match(run(process.execPath, [importer]), /2 changes/);
    const updated = events().filter((event) => event.memory_key);
    assert.equal(updated.length, 6);
    assert.equal(updated.find((event) => event.type === 'memory_codex_deleted').supersedes, created.find((event) => event.memory_type === 'rollout').event_id);
    const stale = readFileSync(join(dev, '.carto', 'codex-memory-stale-ids.txt'), 'utf8');
    assert.ok(stale.includes(old.event_id));
    assert.ok(stale.includes(created.find((event) => event.memory_type === 'rollout').event_id));
    assert.doesNotMatch(run('bash', [search, 'oldtoken', '--no-turbo', '--all', '--format', 'jsonl']), /memory_codex_registry/);
    assert.match(run('bash', [search, 'newtoken', '--no-turbo', '--all', '--format', 'jsonl']), /memory_codex_registry/);
    process.env.CARTOGRAPHER_DEV_DIR = dev;
    process.env.CARTOGRAPHER_SEMANTIC = '0';
    const { buildIndex } = await import('../../explorer/server/bm25.js');
    const { hybridSearch } = await import('../../explorer/server/search.js');
    const index = buildIndex(updated);
    assert.equal((await hybridSearch(index, 'oldtoken')).items.some((item) => item.event_id === old.event_id), false);
    assert.equal((await hybridSearch(index, 'newtoken')).items.some((item) => item.memory_type === 'registry'), true);
    const profile = JSON.parse(run(process.execPath, [join(repo, 'scripts/build-profile.js'), '--json', '--no-write']));
    assert.ok(profile.preferences.some((entry) => entry.summary.includes('Keep corrections visible')));
    assert.equal(profile.preferences.some((entry) => entry.summary.includes('Prefers evidence-backed recall')), false);
    rmSync(registry);
    rmSync(join(memories, 'memory_summary.md'));
    const empty = spawnSync(process.execPath, [importer], { cwd: repo, env, encoding: 'utf8' });
    assert.equal(empty.status, 2);
    assert.match(empty.stderr, /refusing to retire/);
    assert.equal(events().filter((event) => event.memory_key).length, 6);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
