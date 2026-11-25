/**
 * tests/unit/repair-transcript-paths-compressed.test.js
 *
 * repair-transcript-paths.js rewrites a Codex transcript_path that went stale
 * when its session was archived, and counts what it cannot place. It knew one
 * spelling. Codex zstd-compresses a rollout in place about a week after its
 * session, so on 2026-11-13 the dry run reported 194,747 records "missing and
 * unresolved" where 212 were: the other 194,535 named a rollout that was on
 * disk as .jsonl.zst, which resolve-transcript.sh reads
 * (docs/COMPRESSED_ROLLOUTS.md).
 *
 * The script was not wrong to leave those records alone, and still does. The
 * defect was the count, so the count is what is asserted, per class, along
 * with the bytes of every row a --write must not touch. `oldUnresolved()` is
 * the control: the classification before the change, applied to the fixture,
 * must put the compressed records in "unresolved". Against the commit before
 * the change the first test fails. The second holds on both sides: it guards
 * the decision not to write .zst paths into the logs.
 *
 * Run with: node --test tests/unit/repair-transcript-paths-compressed.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OFFLINE_INDEX_ENV } from './helpers/offline-index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = path.join(ROOT, 'scripts', 'repair-transcript-paths.js');

const rolloutName = (tag) => `rollout-2026-10-01T09-00-00-01a10000-${tag}-7000-8000-000000000000.jsonl`;

/**
 * One record per case, each stamped with the live-tree path the hook saw:
 *   kept      still where it was recorded
 *   archived  moved to the archive, plain: the one repairable record
 *   inplace   compressed where it was recorded
 *   archzst   moved to the archive and compressed there
 *   gone      on disk in no spelling
 */
function fixture() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'carto-repair-zst-')));
  const dev = path.join(dir, 'dev');
  const live = path.join(dir, '.codex', 'sessions', '2026', '10', '01');
  const archived = path.join(dir, '.codex', 'archived_sessions');
  for (const d of [dev, live, archived]) fs.mkdirSync(d, { recursive: true });

  const recorded = (tag) => path.join(live, rolloutName(tag));
  fs.writeFileSync(recorded('aaaa'), '{}\n');
  fs.writeFileSync(path.join(archived, rolloutName('bbbb')), '{}\n');
  // The script never opens a rollout, so the bytes do not have to be zstd.
  fs.writeFileSync(`${recorded('cccc')}.zst`, 'compressed');
  fs.writeFileSync(path.join(archived, `${rolloutName('dddd')}.zst`), 'compressed');

  const cases = { kept: 'aaaa', archived: 'bbbb', inplace: 'cccc', archzst: 'dddd', gone: 'eeee' };
  const rows = Object.entries(cases).map(([name, tag]) => JSON.stringify({
    event_id: `evt-${name}`, timestamp: '2026-10-01T09:00:00Z', provider: 'codex', summary: name, transcript_path: recorded(tag),
  }));
  const log = path.join(dev, 'changelog.jsonl');
  fs.writeFileSync(log, rows.join('\n') + '\n');

  const env = { ...process.env, ...OFFLINE_INDEX_ENV };
  for (const key of ['CARTOGRAPHER_SESSION_ID', 'CLAUDE_SESSION_ID', 'CLAUDE_CODE_SESSION_ID', 'CODEX_SESSION_ID', 'ANTIGRAVITY_CONVERSATION_ID', 'ANTIGRAVITY_AGENT']) delete env[key];
  Object.assign(env, {
    CARTOGRAPHER_DEV_DIR: dev,
    CARTOGRAPHER_CODEX_TRANSCRIPTS_DIR: path.join(dir, '.codex', 'sessions'),
    CARTOGRAPHER_CODEX_ARCHIVED_DIR: archived,
  });
  const run = (...args) => spawnSync('node', [SCRIPT, ...args], { env, encoding: 'utf8' });
  const logRows = () => Object.fromEntries(fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((line) => [JSON.parse(line).event_id, line]));
  return { archived, recorded, rows, run, logRows };
}

/** The classification before the change: missing, and no plain file of that name in the archive. */
function oldUnresolved(f) {
  const plainArchive = new Set(fs.readdirSync(f.archived).filter((name) => name.endsWith('.jsonl')));
  return f.rows.map((line) => JSON.parse(line))
    .filter((row) => !fs.existsSync(row.transcript_path) && !plainArchive.has(path.basename(row.transcript_path)))
    .map((row) => row.event_id);
}

test('a compressed rollout is counted as on disk, not as unresolved', () => {
  const f = fixture();
  assert.deepEqual(oldUnresolved(f), ['evt-inplace', 'evt-archzst', 'evt-gone'], 'control: the old rule could not tell these three apart');

  const r = f.run('--json');

  assert.equal(r.status, 0, r.stdout + r.stderr);
  const { stats, wrote } = JSON.parse(r.stdout);
  assert.equal(wrote, false);
  assert.deepEqual(
    { scanned: stats.scanned, ok: stats.ok, repaired: stats.repaired, compressed: stats.compressed, unresolved: stats.unresolved },
    { scanned: 5, ok: 1, repaired: 1, compressed: 2, unresolved: 1 },
  );
  // The five classes account for every record, so none is counted twice.
  assert.equal(stats.ok + stats.repaired + stats.compressed + stats.unresolved + stats.claudeMissing, stats.scanned);

  const text = f.run();
  assert.match(text.stdout, /codex, on disk as \.jsonl\.zst\s+: 2 /);
  assert.match(text.stdout, /codex, missing and unresolved\s+: 1$/m);
});

test('--write repairs the archived record and leaves the compressed ones byte for byte', () => {
  const f = fixture();
  const before = f.logRows();

  const r = f.run('--write', '--json');

  assert.equal(r.status, 0, r.stdout + r.stderr);
  const after = f.logRows();
  assert.equal(JSON.parse(after['evt-archived']).transcript_path, path.join(f.archived, rolloutName('bbbb')));
  // No .zst path is written: the recorded name plus the resolver is enough,
  // and a rewrite would be stale the next time Codex compresses.
  for (const id of ['evt-kept', 'evt-inplace', 'evt-archzst', 'evt-gone']) assert.equal(after[id], before[id], `${id} was rewritten`);
  assert.doesNotMatch(Object.values(after).join('\n'), /\.jsonl\.zst/);
});
