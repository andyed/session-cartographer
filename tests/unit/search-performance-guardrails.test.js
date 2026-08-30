/**
 * The CLI search must stay bounded as event logs grow. A broad query once sent
 * every BM25 match (48k rows on the maintainer corpus) into two insertion
 * sorts, turning an otherwise linear fallback into a multi-minute hang.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BM25 = path.join(ROOT, 'scripts', 'bm25-search.awk');
const SEARCH = path.join(ROOT, 'scripts', 'cartographer-search.sh');
const PLUGIN = path.join(ROOT, 'plugins', 'session-cartographer', 'scripts');

function event(i, summary) {
  return JSON.stringify({
    event_id: `evt-perf-${String(i).padStart(5, '0')}`,
    timestamp: '2026-01-01T00:00:00Z',
    type: 'test_event',
    project: 'fixtureproject',
    cwd: '/tmp/fixtureproject',
    summary,
  });
}

test('BM25 emits only the requested top candidate window', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-bm25-cap-'));
  const corpus = path.join(dir, 'events.jsonl');
  const rows = [
    event(0, 'zzperftoken zzperftoken zzperftoken zzperftoken strongest match'),
    ...Array.from({ length: 599 }, (_, i) =>
      event(i + 1, `zzperftoken ordinary matching event ${i + 1}`)),
    ...Array.from({ length: 1200 }, (_, i) =>
      event(i + 600, `unrelated filler event ${i + 600}`)),
  ];
  fs.writeFileSync(corpus, `${rows.join('\n')}\n`);

  try {
    const result = spawnSync('awk', [
      '-f', BM25,
      '-v', 'query=zzperftoken',
      '-v', 'src=changelog',
      '-v', 'proj_filter=',
      '-v', 'max_results=50',
      corpus, corpus,
    ], { encoding: 'utf8' });

    assert.equal(result.status, 0, result.stderr);
    const output = result.stdout.trim().split('\n').filter(Boolean);
    assert.equal(output.length, 50, 'the per-source fusion window must be a hard cap');
    assert.deepEqual(output.map((line) => Number(line.split('\t')[1])),
      Array.from({ length: 50 }, (_, i) => i + 1),
      'surviving candidates must be renumbered for RRF');
    assert.match(output[0], /evt-perf-00000/, 'the strongest BM25 result must survive the cap');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the CLI keeps all three corpus-growth guardrails', () => {
  const search = fs.readFileSync(SEARCH, 'utf8');
  assert.match(search, /-v max_results="\$FUSION_DEPTH"/,
    'each keyword source must be bounded before fusion');
  assert.match(search, /function merge_sort_order\(/,
    'fusion must use a non-quadratic ordering algorithm');
  assert.doesNotMatch(search, /Sort by RRF score \(insertion sort/,
    'the unbounded insertion-sort implementation must not return');
  assert.match(search, /keyword_pids\+=\("\$!"\)/,
    'independent source scans must remain concurrent');
  assert.match(search, /grep -inE "\$BM25_CANDIDATE_QUERY"/,
    'pass 2 must avoid retokenizing rows that cannot contain a query term');
  assert.match(search, /-v candidate_numbered=1/,
    'candidate filtering must preserve original source line numbers');
});

test('canonical and packaged search runtimes remain byte-identical', () => {
  for (const name of ['cartographer-search.sh', 'bm25-search.awk']) {
    assert.deepEqual(
      fs.readFileSync(path.join(ROOT, 'scripts', name)),
      fs.readFileSync(path.join(PLUGIN, name)),
      `${name} drifted from its packaged plugin mirror`,
    );
  }
});

test('duplicate rows in one source contribute to RRF only once', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-rrf-dedupe-'));
  const emptyTranscripts = path.join(dir, 'transcripts');
  const servedLog = path.join(dir, 'served.jsonl');
  const accessLedger = path.join(dir, 'access.jsonl');
  fs.mkdirSync(emptyTranscripts);
  fs.writeFileSync(accessLedger, '');

  const duplicate = event(1, 'rrfdedupetoken duplicated historical row');
  const unrelated = Array.from({ length: 8 }, (_, i) => event(i + 2, `unrelated fixture row ${i}`));
  fs.writeFileSync(path.join(dir, 'changelog.jsonl'), `${[duplicate, duplicate, ...unrelated].join('\n')}\n`);
  for (const name of ['research-log.jsonl', 'session-milestones.jsonl', 'tool-use-log.jsonl']) {
    fs.writeFileSync(path.join(dir, name), '');
  }

  try {
    const result = spawnSync('bash', [
      SEARCH, 'rrfdedupetoken', '--limit', '5', '--format', 'jsonl', '--all',
    ], {
      encoding: 'utf8',
      env: {
        ...process.env,
        CARTOGRAPHER_TURBO: '0',
        CARTOGRAPHER_DEV_DIR: dir,
        CARTOGRAPHER_SERVED_LOG: servedLog,
        CARTOGRAPHER_ACCESS_LEDGER: accessLedger,
        CARTOGRAPHER_CLAUDE_TRANSCRIPTS_DIR: emptyTranscripts,
        CARTOGRAPHER_CODEX_TRANSCRIPTS_DIR: emptyTranscripts,
        CARTOGRAPHER_QDRANT_URL: 'http://127.0.0.1:1',
        CARTOGRAPHER_EMBED_URL: 'http://127.0.0.1:1/v1/embeddings',
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const rows = result.stdout.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
    assert.equal(rows.length, 1, 'a duplicated event_id must remain one fused result');
    assert.equal(rows[0].source, 'changelog', 'one source must contribute at most once');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('candidate-filtered pass 2 preserves fallback ids from the source file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-candidate-lines-'));
  const emptyTranscripts = path.join(dir, 'transcripts');
  const servedLog = path.join(dir, 'served.jsonl');
  const accessLedger = path.join(dir, 'access.jsonl');
  fs.mkdirSync(emptyTranscripts);
  fs.writeFileSync(accessLedger, '');

  const rows = Array.from({ length: 12 }, (_, i) => JSON.stringify({
    timestamp: '2026-01-01T00:00:00Z',
    type: 'legacy_fixture',
    project: 'fixtureproject',
    summary: i === 7 ? 'originalidtoken selective match' : `unrelated legacy row ${i}`,
  }));
  fs.writeFileSync(path.join(dir, 'changelog.jsonl'), `${rows.join('\n')}\n`);
  for (const name of ['research-log.jsonl', 'session-milestones.jsonl', 'tool-use-log.jsonl']) {
    fs.writeFileSync(path.join(dir, name), '');
  }

  try {
    const result = spawnSync('bash', [
      SEARCH, 'originalidtoken', '--limit', '5', '--format', 'jsonl', '--all',
    ], {
      encoding: 'utf8',
      env: {
        ...process.env,
        CARTOGRAPHER_TURBO: '0',
        CARTOGRAPHER_DEV_DIR: dir,
        CARTOGRAPHER_SERVED_LOG: servedLog,
        CARTOGRAPHER_ACCESS_LEDGER: accessLedger,
        CARTOGRAPHER_CLAUDE_TRANSCRIPTS_DIR: emptyTranscripts,
        CARTOGRAPHER_CODEX_TRANSCRIPTS_DIR: emptyTranscripts,
        CARTOGRAPHER_QDRANT_URL: 'http://127.0.0.1:1',
        CARTOGRAPHER_EMBED_URL: 'http://127.0.0.1:1/v1/embeddings',
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const output = result.stdout.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
    assert.equal(output.length, 1);
    assert.equal(output[0].event_id, 'changelog-8');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
