/**
 * The served-result ledger is telemetry, not part of retrieval correctness.
 * A sandboxed agent may read the global corpus while being unable to append to
 * its ledger, so search must degrade to uninstrumented output instead of
 * letting awk abort midway and falsely reporting "No results found."
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SEARCH = path.join(ROOT, 'scripts', 'cartographer-search.sh');

test('an unwritable served log does not suppress valid search results', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-telemetry-failure-'));
  const event = (i, summary) => JSON.stringify({
    event_id: `evt-telemetryfixture${String(i).padStart(2, '0')}`,
    timestamp: `2026-01-0${i}T00:00:00Z`,
    type: 'tool_bash',
    project: 'fixtureproject',
    cwd: '/tmp/fixtureproject',
    summary,
  });
  const corpus = [
    event(1, 'Ran: zztelemetry distinctive searchable fixture'),
    ...Array.from({ length: 7 }, (_, i) =>
      event(i + 2, `Ran: routine unrelated filler command number ${i + 2}`)),
  ];

  try {
    fs.writeFileSync(path.join(dir, 'changelog.jsonl'), `${corpus.join('\n')}\n`);
    fs.writeFileSync(path.join(dir, 'session-milestones.jsonl'), '');
    fs.writeFileSync(path.join(dir, 'research-log.jsonl'), '');

    const result = spawnSync('bash', [SEARCH, 'zztelemetry', '--limit', '1', '--all'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        CARTOGRAPHER_TURBO: '0',
        CARTOGRAPHER_DEV_DIR: dir,
        CARTOGRAPHER_SERVED_LOG: '/dev/null/served-log.jsonl',
        CARTOGRAPHER_SEARCH_CALL_LOG: '/dev/null/search-calls.jsonl',
        CARTOGRAPHER_ACCESS_LEDGER: path.join(dir, 'access-ledger.jsonl'),
        CARTOGRAPHER_TRANSCRIPTS_DIR: path.join(dir, 'no-transcripts'),
        CARTOGRAPHER_QDRANT_URL: 'http://127.0.0.1:1',
      },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /evt-telemetryfixture01/);
    assert.doesNotMatch(result.stdout, /No results found\./);
    assert.match(result.stderr, /cannot write served log/);
    assert.match(result.stderr, /cannot write search-call telemetry/);
    assert.doesNotMatch(result.stderr, /awk: can't open file/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
