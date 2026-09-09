// The fifth searched log. `prompt-history.jsonl` is a projection of the user's
// prompts with stable event_ids, written under CARTOGRAPHER_DEV_DIR by
// scripts/build-prompt-history.js. It replaces the former `claude-history`
// entry, which read ~/.claude/history.jsonl directly: 18,103 rows with no
// event_id, which recall.js had to discard at the contract boundary and which
// would now be a second, id-less copy of the same prompts.
//
// Everything here runs against a temp CARTOGRAPHER_DEV_DIR. LOG_FILES is
// resolved at module load, so the tests that exercise the DEFAULT map have to
// set the env var in a child process — importing jsonl.js in this process would
// bind it to the real corpus.
process.env.CARTOGRAPHER_SEMANTIC = '0';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { readAllEvents, watchFiles, LOG_FILES, CORPUS_ROOT } from '../../explorer/server/jsonl.js';
import { buildIndex } from '../../explorer/server/bm25.js';
import { hybridSearch } from '../../explorer/server/search.js';
import { executeRecall } from '../../explorer/server/recall.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const jsonlModule = path.join(repo, 'explorer', 'server', 'jsonl.js');

// fs.watch needs a moment to arm, and handleChange debounces 100ms.
const settle = (ms = 900) => new Promise((r) => setTimeout(r, ms));

function tempDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `carto-prompts-${tag}-`));
}

function writeJsonl(filePath, rows) {
  fs.writeFileSync(filePath, `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`);
}

function promptRow(overrides = {}) {
  return {
    event_id: 'evt-ab12cd34ef56',
    timestamp: '2026-09-07T13:00:00Z',
    type: 'prompt',
    provider: 'claude',
    summary: 'zebraprobe the warm index over prompt history',
    project: 'session-cartographer',
    cwd: '/Users/andyed/Documents/dev/session-cartographer',
    session_id: '5834cb0a-5c1b-456e-9161-47209ddb716c',
    transcript_path: '/dev/null',
    salience: 0.6,
    ...overrides,
  };
}

// Run a snippet against jsonl.js with CARTOGRAPHER_DEV_DIR pointed at `dir`, so
// the DEFAULT LOG_FILES map is the thing under test rather than an argument we
// hand-built to match our own expectations.
function inDevDir(dir, body) {
  const source = `import { readAllEvents, LOG_FILES, CORPUS_ROOT } from ${JSON.stringify(jsonlModule)};\n${body}`;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', source], {
    env: { ...process.env, CARTOGRAPHER_DEV_DIR: dir },
    encoding: 'utf8',
    timeout: 60000,
  });
  return JSON.parse(out.trim().split('\n').pop());
}

test('prompt-history.jsonl is read by the default log map and tagged _source: prompts', () => {
  const dir = tempDir('tagged');
  try {
    writeJsonl(path.join(dir, 'prompt-history.jsonl'), [
      promptRow(),
      promptRow({ event_id: 'evt-ff00ff00ff00', summary: 'a second prompt row', timestamp: '2026-09-07T14:00:00Z' }),
    ]);
    writeJsonl(path.join(dir, 'changelog.jsonl'), [
      { event_id: 'evt-change-1', timestamp: '2026-09-07T12:00:00Z', summary: 'a changelog row' },
    ]);

    const result = inDevDir(dir, `
      const events = readAllEvents();
      console.log(JSON.stringify({
        total: events.length,
        prompts: events.filter((e) => e._source === 'prompts').map((e) => e.event_id).sort(),
        sources: [...new Set(events.map((e) => e._source))].sort(),
        promptsPath: LOG_FILES.prompts,
        corpusRoot: CORPUS_ROOT,
      }));
    `);

    assert.equal(result.total, 3);
    assert.deepEqual(result.prompts, ['evt-ab12cd34ef56', 'evt-ff00ff00ff00']);
    assert.deepEqual(result.sources, ['changelog', 'prompts']);
    assert.equal(result.promptsPath, path.join(dir, 'prompt-history.jsonl'));
    // The source must live inside the swappable corpus, not beside it. A path
    // outside CORPUS_ROOT cannot be redirected by CARTOGRAPHER_DEV_DIR, which
    // is exactly how claude-history leaked the real machine's history into
    // every temp-corpus test.
    assert.equal(result.promptsPath.startsWith(result.corpusRoot), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a missing prompt-history.jsonl is a no-op, not an error', () => {
  const dir = tempDir('absent');
  try {
    writeJsonl(path.join(dir, 'changelog.jsonl'), [
      { event_id: 'evt-change-1', timestamp: '2026-09-07T12:00:00Z', summary: 'a changelog row' },
    ]);
    assert.equal(fs.existsSync(path.join(dir, 'prompt-history.jsonl')), false);

    const result = inDevDir(dir, `
      const events = readAllEvents();
      console.log(JSON.stringify({
        total: events.length,
        prompts: events.filter((e) => e._source === 'prompts').length,
      }));
    `);

    assert.equal(result.total, 1);
    assert.equal(result.prompts, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('watchFiles tolerates an absent prompt-history.jsonl and picks it up once written', async () => {
  const dir = tempDir('watch-absent');
  const promptsPath = path.join(dir, 'prompt-history.jsonl');
  const changelogPath = path.join(dir, 'changelog.jsonl');
  writeJsonl(changelogPath, [{ event_id: 'evt-seed', timestamp: '2026-09-07T12:00:00Z', summary: 'seed' }]);

  // Registering a watcher on a file that does not exist must not throw and must
  // not stop the other four logs from being watched.
  let stop = () => {};
  try {
    const seen = [];
    stop = watchFiles((events) => seen.push(...events), null, {
      changelog: changelogPath,
      prompts: promptsPath,
    });

    await settle(300); // let the watchers arm before touching the file
    fs.appendFileSync(changelogPath, `${JSON.stringify({ event_id: 'evt-appended', timestamp: '2026-09-07T15:00:00Z', summary: 'appended' })}\n`);
    await settle();

    assert.equal(seen.length, 1);
    assert.equal(seen[0].event_id, 'evt-appended');
    assert.equal(seen[0]._source, 'changelog');
  } finally {
    stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('appends to prompt-history.jsonl reach the incremental watcher tagged as prompts', async () => {
  const dir = tempDir('watch-append');
  const promptsPath = path.join(dir, 'prompt-history.jsonl');
  writeJsonl(promptsPath, [promptRow()]);

  let stop = () => {};
  try {
    const seen = [];
    stop = watchFiles((events) => seen.push(...events), null, { prompts: promptsPath });

    await settle(300);
    fs.appendFileSync(promptsPath, `${JSON.stringify(promptRow({ event_id: 'evt-new-prompt', summary: 'freshly typed prompt' }))}\n`);
    await settle();

    assert.equal(seen.length, 1);
    assert.equal(seen[0].event_id, 'evt-new-prompt');
    assert.equal(seen[0]._source, 'prompts');
  } finally {
    stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an in-place rewrite of prompt-history.jsonl raises onRewrite, not a phantom append', async () => {
  // The projector rebuilds the file rather than only appending. A rewrite that
  // also grows the file would otherwise read the shifted tail as fresh appends
  // while every already-indexed row silently kept its stale value.
  const dir = tempDir('watch-rewrite');
  const promptsPath = path.join(dir, 'prompt-history.jsonl');
  writeJsonl(promptsPath, [
    promptRow({ event_id: 'evt-one', summary: 'short' }),
    promptRow({ event_id: 'evt-two', summary: 'short' }),
  ]);

  let stop = () => {};
  try {
    const appended = [];
    const rewritten = [];
    stop = watchFiles(
      (events) => appended.push(...events),
      (source) => rewritten.push(source),
      { prompts: promptsPath },
    );

    await settle(300);
    // Same rows, longer summaries: bytes before the offset change AND the file
    // grows, which the size check alone cannot distinguish from an append.
    writeJsonl(promptsPath, [
      promptRow({ event_id: 'evt-one', summary: 'a considerably longer rewritten summary' }),
      promptRow({ event_id: 'evt-two', summary: 'a considerably longer rewritten summary' }),
    ]);
    await settle();

    assert.deepEqual(rewritten, ['prompts']);
    assert.equal(appended.length, 0);
  } finally {
    stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('claude-history is no longer a searched source', () => {
  // Two assertions, because either alone is weak: the key could be renamed
  // while still pointing at the same file, or the path could change while the
  // file is still read under another key.
  assert.deepEqual(Object.keys(LOG_FILES).sort(), ['changelog', 'milestones', 'prompts', 'research', 'tool-use']);
  const claudeHistory = path.join(os.homedir(), '.claude', 'history.jsonl');
  for (const [source, filePath] of Object.entries(LOG_FILES)) {
    assert.notEqual(filePath, claudeHistory, `${source} still points at ~/.claude/history.jsonl`);
    assert.equal(
      filePath.startsWith(CORPUS_ROOT),
      true,
      `${source} escapes CORPUS_ROOT and cannot be redirected by CARTOGRAPHER_DEV_DIR`,
    );
  }
});

test('a temp corpus contains no rows from ~/.claude/history.jsonl', () => {
  // The behavioural form of the assertion above: with CARTOGRAPHER_DEV_DIR
  // pointed at an empty directory the warm index must be empty. While
  // claude-history was in the map it was 18,103 rows deep here.
  const dir = tempDir('isolation');
  try {
    const result = inDevDir(dir, `
      const events = readAllEvents();
      console.log(JSON.stringify({ total: events.length, sources: [...new Set(events.map((e) => e._source))] }));
    `);
    assert.equal(result.total, 0);
    assert.deepEqual(result.sources, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('prompts fuse as their own RRF ladder rather than merging into another source', async () => {
  // bucketBySource keys on the ingest-time `_source` tag, so a prompt that is
  // best-among-prompts contributes 1/(60+1) even when a flood of tool-use rows
  // outranks it globally. This fixture is built so the two strategies disagree:
  // the prompt row scores WORST of the nine matching documents, so a single
  // global ladder puts it dead last, while per-source laddering makes it rank 1
  // of its own bucket. Salience is uniform, so ordering here is laddering alone.
  // BM25's IDF term goes negative once a term appears in more than half the
  // corpus, which drops the whole ladder. Nine of these documents match, so the
  // fixture needs enough non-matching ballast to keep IDF positive.
  const noise = Array.from({ length: 16 }, (_, i) => ({
    event_id: `evt-noise-${i}`,
    _source: 'changelog',
    timestamp: `2026-08-${String(i + 1).padStart(2, '0')}T09:00:00Z`,
    project: 'alpha',
    summary: `unrelated entry number ${i} about glaciers copper meadows and lanterns`,
    salience: 0.5,
  }));
  const tools = Array.from({ length: 8 }, (_, i) => ({
    event_id: `evt-tool-${i}`,
    _source: 'tool-use',
    timestamp: `2026-09-0${(i % 7) + 1}T09:00:00Z`,
    project: 'alpha',
    // Repeated term: every tool row beats the single-mention prompt row on TF.
    summary: `zebraprobe zebraprobe zebraprobe zebraprobe tool invocation ${i}`,
    salience: 0.5,
  }));
  const prompt = {
    event_id: 'evt-prompt',
    _source: 'prompts',
    timestamp: '2026-09-07T13:00:00Z',
    project: 'alpha',
    summary: 'zebraprobe asked once about the warm index over a fairly long prompt line that dilutes term frequency further',
    salience: 0.5,
  };
  const events = [prompt, ...tools, ...noise];

  const results = await hybridSearch(buildIndex(events), 'zebraprobe', {});
  const order = results.items.map((item) => item.event_id);
  const at = order.indexOf('evt-prompt');
  assert.notEqual(at, -1, 'the prompt event fell out of the fused result set entirely');
  const fused = results.items[at];
  assert.equal((fused._sources || '').split('+').includes('prompts'), true);
  // Rank 1 of the prompts ladder. Merged into the tool-use ladder it would be
  // last of nine; here it must sit at the top alongside the best tool row.
  assert.ok(at <= 1, `prompts did not get their own ladder: evt-prompt landed at ${at} in ${JSON.stringify(order)}`);
});

test('the id-less guard is intact and reports 0 with prompts as the fifth source', async () => {
  const noise = Array.from({ length: 5 }, (_, i) => ({
    event_id: `evt-noise-${i}`,
    _source: 'changelog',
    timestamp: `2026-08-2${i}T09:00:00Z`,
    project: 'alpha',
    summary: `unrelated ${['glacier', 'copper', 'meadow', 'river', 'lantern'][i]} entry`,
  }));
  const events = [
    { event_id: 'evt-prompt', _source: 'prompts', timestamp: '2026-09-07T13:00:00Z', project: 'alpha', summary: 'zebraprobe recall over prompt history', salience: 0.6 },
    { event_id: 'evt-change', _source: 'changelog', timestamp: '2026-09-06T13:00:00Z', project: 'alpha', summary: 'zebraprobe changelog row', salience: 0.5 },
    ...noise,
  ];
  const request = {
    contract_version: 1,
    call_id: 'call-prompts',
    query: 'zebraprobe',
    project: '',
    since: '',
    before: '',
    limit: 10,
    purpose: 'remember',
    session_id: 'session-test',
    provider: 'claude',
    excluded_event_ids: [],
  };

  const clean = await executeRecall({ events, index: buildIndex(events) }, request);
  assert.equal(clean.meta.unidentified_count, 0);
  assert.deepEqual(clean.results.map((r) => r.event_id).sort(), ['evt-change', 'evt-prompt']);

  // The guard is the contract boundary, not a workaround for one source: a
  // future writer that omits event_id must still be dropped and counted.
  const withIdless = [...events, { _source: 'prompts', timestamp: '2026-09-05T13:00:00Z', project: 'alpha', summary: 'zebraprobe row with no id' }];
  const dirty = await executeRecall({ events: withIdless, index: buildIndex(withIdless) }, request);
  assert.equal(dirty.meta.unidentified_count, 1);
  assert.equal(dirty.results.every((r) => typeof r.event_id === 'string' && r.event_id !== ''), true);
});
