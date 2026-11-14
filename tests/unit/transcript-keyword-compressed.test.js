/**
 * tests/unit/transcript-keyword-compressed.test.js
 *
 * `cartographer-search.sh --transcript` is the keyword needle-finder of last
 * resort: per-line grep over the transcript stores, the first 20 files that
 * hold the query. It matched `*.jsonl`, and Codex zstd-compresses a rollout in
 * place about a week after its session. Measured 2026-11-13
 * (docs/COMPRESSED_ROLLOUTS.md): 3,646 of 3,916 rollouts, 14.6 of 15.8 GiB of
 * Codex text, were out of its reach. Of the four --transcript queries in the
 * tool-use log, one ('Jarvis') filled 9 of its 20 slots while 15 compressed
 * rollouts held the needle.
 *
 * Nothing errored, so each test asserts on which files answered: the event
 * ids, the recorded paths and their spelling. `oldGlobHits()` is the control.
 * It applies the `*.jsonl` rule to the fixture and must find nothing, or these
 * tests would pass against the code that had the defect. Run in a
 * `git archive` export of the commit before the change, all 3 fail.
 *
 * Run with: node --test tests/unit/transcript-keyword-compressed.test.js
 */

// Pin the semantic leg off before anything reads it.
process.env.CARTOGRAPHER_SEMANTIC = '0';

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { OFFLINE_INDEX_ENV } from './helpers/offline-index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SEARCH = path.join(ROOT, 'scripts', 'cartographer-search.sh');

const has = (bin, PATH = process.env.PATH) => spawnSync('bash', ['-c', `command -v ${bin}`], { env: { ...process.env, PATH }, stdio: 'ignore' }).status === 0;
const nodeZstd = typeof zlib.zstdCompressSync === 'function';
// The scan is ripgrep's -z, which runs the zstd binary per file.
const needsScan = { skip: !(has('rg') && has('zstd')) && 'needs ripgrep and zstd on PATH' };

function compress(text) {
  if (nodeZstd) return zlib.zstdCompressSync(Buffer.from(text));
  if (has('zstd')) return spawnSync('zstd', ['-c'], { input: text }).stdout;
  return Buffer.from('not a zstd frame; a name-only fixture');
}

const NEEDLE = 'quuxneedle';
const sid = (n) => `01a10000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const rolloutName = (id) => `rollout-2026-10-01T09-00-00-${id}.jsonl`;
const body = (id) => [
  { timestamp: '2026-10-01T09:00:00.000Z', type: 'session_meta', payload: { id, cwd: '/workspace/widget-web' } },
  { timestamp: '2026-10-01T09:00:01.000Z', type: 'event_msg', payload: { type: 'user_message', message: `where is the ${NEEDLE} loaded` } },
].map((row) => JSON.stringify(row)).join('\n') + '\n';

function sandbox() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'carto-keyword-zst-')));
  const dev = path.join(dir, 'dev');
  const live = path.join(dir, 'sessions', '2026', '10', '01');
  const archived = path.join(dir, 'archived_sessions');
  const claude = path.join(dir, 'claude');
  for (const d of [path.join(dev, '.carto'), live, archived, claude]) fs.mkdirSync(d, { recursive: true });
  // One event row that does not hold the needle, so the logs exist and the
  // only thing that can answer is a transcript.
  fs.writeFileSync(path.join(dev, 'changelog.jsonl'), JSON.stringify({ event_id: 'evt-unrelated', timestamp: '2026-10-01T09:00:00Z', type: 'note', summary: 'an unrelated row', project: 'widget-web' }) + '\n');

  const env = { ...process.env, ...OFFLINE_INDEX_ENV };
  for (const key of ['CARTOGRAPHER_SESSION_ID', 'CLAUDE_SESSION_ID', 'CLAUDE_CODE_SESSION_ID', 'CODEX_SESSION_ID']) delete env[key];
  Object.assign(env, {
    CARTOGRAPHER_SEMANTIC: '0',
    CARTOGRAPHER_DEV_DIR: dev,
    CARTOGRAPHER_CLAUDE_TRANSCRIPTS_DIR: claude,
    CARTOGRAPHER_CODEX_TRANSCRIPTS_DIR: path.join(dir, 'sessions'),
    CARTOGRAPHER_CODEX_ARCHIVED_DIR: archived,
  });

  return {
    dir, live, archived,
    put(where, id, { compressed = false } = {}) {
      const file = path.join(where, rolloutName(id) + (compressed ? '.zst' : ''));
      fs.writeFileSync(file, compressed ? compress(body(id)) : body(id));
      return file;
    },
    search(extraEnv = {}) {
      const r = spawnSync('bash', [SEARCH, NEEDLE, '--transcript', '--no-turbo', '--format', 'jsonl', '--all', '--limit', '100'], { env: { ...env, ...extraEnv }, encoding: 'utf8' });
      const rows = r.stdout.split('\n').filter((line) => line.startsWith('{')).map((line) => JSON.parse(line)).filter((row) => row.source === 'transcript');
      return { ...r, rows, files: rows.map((row) => /\|transcript:(.*)$/.exec(row.extras)[1]) };
    },
  };
}

/** Files the old `--glob '*.jsonl'` rule could have matched, whatever they hold. */
function oldGlobHits(s) {
  const out = [];
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.jsonl') && fs.readFileSync(full, 'utf8').includes(NEEDLE)) out.push(full);
    }
  };
  walk(s.dir);
  return out;
}

test('a needle that exists only in compressed rollouts is found, in the live tree and the archive', needsScan, () => {
  const s = sandbox();
  const liveFile = s.put(s.live, sid(1), { compressed: true });
  const archivedFile = s.put(s.archived, sid(2), { compressed: true });
  assert.deepEqual(oldGlobHits(s), [], 'control: no *.jsonl file holds the needle');

  const r = s.search();

  assert.equal(r.status, 0, r.stdout + r.stderr);
  // Line 2 of each rollout holds the needle; the id is the session_meta id,
  // read out of the decompressed rows, not the file name.
  assert.deepEqual(r.rows.map((row) => row.event_id).sort(), [`transcript-codex-${sid(1)}-2`, `transcript-codex-${sid(2)}-2`]);
  assert.deepEqual([...r.files].sort(), [archivedFile, liveFile].sort(), 'the recorded path is the one on disk');
  for (const row of r.rows) {
    assert.equal(row.project, 'widget-web');
    assert.match(row.summary, new RegExp(`where is the ${NEEDLE} loaded`), 'the matched line is the decompressed row');
  }
});

test('compressed rollouts take only the slots plain transcripts left', needsScan, () => {
  // 19 plain hits leave one slot for two compressed candidates.
  const s = sandbox();
  for (let n = 1; n <= 19; n++) s.put(s.live, sid(n));
  s.put(s.archived, sid(20), { compressed: true });
  s.put(s.archived, sid(21), { compressed: true });

  const short = s.search();

  assert.equal(short.files.length, 20);
  assert.equal(short.files.filter((file) => file.endsWith('.jsonl.zst')).length, 1);

  // A twentieth plain hit fills the page: a week-old rollout displaces nothing.
  s.put(s.live, sid(22));
  const full = s.search();

  assert.equal(full.files.length, 20);
  assert.deepEqual(full.files.filter((file) => file.endsWith('.jsonl.zst')), []);
});

// A PATH with jq and the usual tools but neither scanner. /usr/bin holds that
// on macOS; where it holds both ripgrep and zstd there is nothing to observe.
const BARE_PATH = '/usr/bin:/bin';
const canGoWithout = has('jq', BARE_PATH) && !(has('rg', BARE_PATH) && has('zstd', BARE_PATH));

test('without ripgrep and zstd the compressed rollouts are counted, not passed over', { skip: !canGoWithout && 'no PATH here that lacks the scanners and keeps jq' }, () => {
  const s = sandbox();
  s.put(s.live, sid(1), { compressed: true });
  s.put(s.archived, sid(2), { compressed: true });
  const plainFile = s.put(s.live, sid(3));

  const r = s.search({ PATH: BARE_PATH });

  assert.deepEqual(r.files, [plainFile], 'the plain rollout still answers through the grep path');
  assert.match(r.stderr, /\(2 compressed Codex rollouts not searched: that needs ripgrep and zstd\)/);
});
