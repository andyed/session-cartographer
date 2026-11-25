/**
 * tests/unit/retro-index-compressed.test.js
 *
 * Codex zstd-compresses a rollout in place about a week after its session
 * (rollout-<ts>-<id>.jsonl becomes rollout-<ts>-<id>.jsonl.zst, mtime kept),
 * and moves a finished session to archived_sessions/. retro-index.sh matched
 * `*.jsonl` under the live tree only. Measured 2026-11-13
 * (docs/COMPRESSED_ROLLOUTS.md): 3,646 of 3,916 rollouts were compressed, so a
 * `--fresh` reindex would have passed over 93% of the Codex history, and 241
 * of the 641 archived rollouts were not indexed at their last write.
 *
 * Both defects are absences, and the script exited 0 through each. So these
 * tests assert on what was shipped to the indexer, never that a run finished:
 * the exact turn ids, payloads equal to an uncompressed twin's, the checkpoint
 * line, and which rollouts the project inferer was asked about.
 *
 * retro-index.sh calls index-event.sh from its own directory, so each run uses
 * a copy of the script beside a stand-in that records every payload it is
 * handed. The inferer is the real one behind a recorder.
 *
 * Controls: `oldWalk()` applies the rule the indexer used to each fixture and
 * must come back empty, or a test would pass against the code that had the
 * defect. Run in a `git archive` export of the commit before the change, all
 * 11 fail (the twin test only on its printed line: that code read the plain
 * file too, by never seeing the other).
 *
 * Run with: node --test tests/unit/retro-index-compressed.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { OFFLINE_INDEX_ENV } from './helpers/offline-index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPTS = path.join(ROOT, 'scripts');
const INFERER = path.join(SCRIPTS, 'infer-codex-project.js');

// The indexer reads a compressed rollout with the zstd binary. Fixtures are
// compressed with Node's zlib (22.15 or newer) or, failing that, the binary.
const hasZstdBin = spawnSync('zstd', ['--version'], { stdio: 'ignore' }).status === 0;
const nodeZstd = typeof zlib.zstdCompressSync === 'function';
const needsZstdBin = { skip: !hasZstdBin && 'no zstd binary on PATH' };
const needsNodeZstd = { skip: !nodeZstd && 'this Node has no zlib zstd' };

function compress(text) {
  if (nodeZstd) return zlib.zstdCompressSync(Buffer.from(text));
  if (hasZstdBin) return spawnSync('zstd', ['-c'], { input: text }).stdout;
  // Enough for the tests that never open the file: the checkpoint skip and
  // the missing-binary skip both decide from the name.
  return Buffer.from('not a zstd frame; a name-only fixture');
}

const SID = '01a10000-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
const OTHER = '01a10000-bbbb-7bbb-8bbb-bbbbbbbbbbbb';
const PROJECT = 'widget-web';
const rolloutName = (id) => `rollout-2026-10-01T09-00-00-${id}.jsonl`;

/**
 * A two-turn rollout. Its cwd is the workspace root, as a Codex Desktop
 * session reports it, so the project has to come from the tool workdirs: the
 * inferer must read past the first row of a compressed rollout too.
 */
function rolloutBody(id, dev) {
  const at = (s) => `2026-10-01T09:00:${String(s).padStart(2, '0')}.000Z`;
  const rows = [
    { timestamp: at(0), type: 'session_meta', payload: { id, cwd: dev } },
    { timestamp: at(1), type: 'event_msg', payload: { type: 'user_message', message: 'make the widget render' } },
    { timestamp: at(2), type: 'response_item', payload: { type: 'custom_tool_call', input: JSON.stringify({ workdir: path.join(dev, PROJECT) }) } },
    { timestamp: at(3), type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Rendered the widget.' }] } },
    { timestamp: at(4), type: 'event_msg', payload: { type: 'user_message', message: 'now add the palette' } },
    { timestamp: at(5), type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Palette added.' }] } },
  ];
  return rows.map((row) => JSON.stringify(row)).join('\n') + '\n';
}

/** An isolated dev dir, both Codex stores, and a copy of the indexer beside a recorder. */
function sandbox() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'carto-retro-zst-')));
  const dev = path.join(dir, 'dev');
  const scripts = path.join(dir, 'scripts');
  const live = path.join(dir, 'sessions', '2026', '10', '01');
  const archived = path.join(dir, 'archived_sessions');
  for (const d of [path.join(dev, '.carto'), scripts, live, archived, path.join(dir, 'claude')]) fs.mkdirSync(d, { recursive: true });

  for (const name of ['retro-index.sh', 'transcript-to-turns.awk', 'codex-transcript-to-turns.awk']) {
    fs.copyFileSync(path.join(SCRIPTS, name), path.join(scripts, name));
  }
  // Stands in for index-event.sh: one payload per call on stdin, kept verbatim.
  const shipped = path.join(dev, 'shipped.jsonl');
  fs.writeFileSync(path.join(scripts, 'index-event.sh'), '#!/usr/bin/env bash\ncat >> "$CARTOGRAPHER_DEV_DIR/shipped.jsonl"\n', { mode: 0o755 });

  // The real inferer, behind a line per invocation.
  const calls = path.join(dir, 'inferer-calls');
  const inferer = path.join(dir, 'infer-recorder.mjs');
  fs.writeFileSync(inferer, [
    "import { appendFileSync } from 'node:fs';",
    `appendFileSync(${JSON.stringify(calls)}, process.argv.slice(2).join('\\t') + '\\n');`,
    `await import(${JSON.stringify(pathToFileURL(INFERER).href)});`,
    '',
  ].join('\n'));

  const progress = path.join(dev, '.carto', 'retro-index-progress');
  const env = { ...process.env, ...OFFLINE_INDEX_ENV };
  for (const key of ['CARTOGRAPHER_SESSION_ID', 'CLAUDE_SESSION_ID', 'CLAUDE_CODE_SESSION_ID', 'CODEX_SESSION_ID', 'ANTIGRAVITY_CONVERSATION_ID', 'ANTIGRAVITY_AGENT', 'CARTOGRAPHER_ZSTD']) delete env[key];
  Object.assign(env, {
    CARTOGRAPHER_DEV_DIR: dev,
    CARTOGRAPHER_CLAUDE_TRANSCRIPTS_DIR: path.join(dir, 'claude'),
    CARTOGRAPHER_CODEX_TRANSCRIPTS_DIR: path.join(dir, 'sessions'),
    CARTOGRAPHER_CODEX_ARCHIVED_DIR: archived,
    CARTOGRAPHER_CODEX_PROJECT_INFERER: inferer,
  });

  const lines = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean) : []);
  return {
    dir, dev, live, archived, progress,
    run: (extraEnv = {}, ...args) => spawnSync('bash', [path.join(scripts, 'retro-index.sh'), '--provider', 'codex', ...args], { env: { ...env, ...extraEnv }, encoding: 'utf8' }),
    shipped: () => lines(shipped).map((line) => JSON.parse(line)),
    infererCalls: () => lines(calls),
    progressLines: () => lines(progress),
    /** Write a rollout into `where`, plain or compressed, and return its path. */
    put(where, id, { compressed = false, bytes = null } = {}) {
      const file = path.join(where, rolloutName(id) + (compressed ? '.zst' : ''));
      const body = rolloutBody(id, dev);
      fs.writeFileSync(file, bytes ?? (compressed ? compress(body) : body));
      return file;
    },
  };
}

const mtimeOf = (file) => Math.floor(fs.statSync(file).mtimeMs / 1000);

/** What Codex does a week on: the same rows under .zst, mtime kept, plain file gone. */
function compressInPlace(file, to = `${file}.zst`) {
  const { atime, mtime } = fs.statSync(file);
  fs.writeFileSync(to, compress(fs.readFileSync(file, 'utf8')));
  fs.utimesSync(to, atime, mtime);
  fs.rmSync(file);
  return to;
}

/** The rule retro-index.sh used: `find "$CODEX_TRANSCRIPTS" -name "*.jsonl"`, live tree only. */
function oldWalk(s) {
  const out = [];
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.jsonl')) out.push(full);
    }
  };
  walk(path.dirname(path.dirname(path.dirname(s.live))));
  return out;
}

const turnIds = (rows) => rows.map((row) => row.event_id);
const twoTurns = (id) => [`turn-codex-${id}-1`, `turn-codex-${id}-2`];

test('a compressed rollout in the live tree is indexed, with the turns of its plain twin', needsZstdBin, () => {
  const plain = sandbox();
  const plainFile = plain.put(plain.live, SID);
  const zst = sandbox();
  const zstFile = zst.put(zst.live, SID, { compressed: true });
  assert.deepEqual(oldWalk(zst), [], 'control: the old *.jsonl walk must not see this fixture');

  const a = plain.run();
  const b = zst.run();

  assert.equal(a.status, 0, a.stdout + a.stderr);
  assert.equal(b.status, 0, b.stdout + b.stderr);
  assert.deepEqual(turnIds(plain.shipped()), twoTurns(SID), 'the plain twin is the reference, so it must index');
  // Equal payloads but for the two things that name the sandbox: the recorded
  // path, and the workdir the tool call carried into the turn text.
  const strip = (s) => (rows) => rows.map(({ transcript_path, summary, ...rest }) => ({ ...rest, summary: summary.split(s.dev).join('<dev>') }));
  assert.deepEqual(strip(zst)(zst.shipped()), strip(plain)(plain.shipped()));
  assert.match(zst.shipped()[0].summary, /make the widget render.*Rendered the widget\./, 'the turn text came out of the compressed rows');
  for (const row of zst.shipped()) {
    assert.equal(row.project, PROJECT, 'the project comes from a tool workdir, past the first row');
    assert.equal(row.transcript_path, zstFile, 'the recorded path is the one on disk');
  }
  assert.deepEqual(zst.progressLines(), [`codex ${SID} ${mtimeOf(zstFile)} ${PROJECT}`]);
  assert.deepEqual(plain.progressLines(), [`codex ${SID} ${mtimeOf(plainFile)} ${PROJECT}`]);
  // A compressed rollout reaches the inferer as rows on stdin, so it needs
  // nothing of Node's zlib; a plain one is still handed its path.
  assert.deepEqual(zst.infererCalls(), [`-\t${zst.dev}`]);
  assert.deepEqual(plain.infererCalls(), [`${plainFile}\t${plain.dev}`]);
  assert.match(b.stdout, /Backfilled 2 turns; skipped 0 already-indexed session\(s\); 0 turn failure\(s\)\.$/m);
});

test('a rollout indexed while plain is skipped under its .zst name, not indexed twice', () => {
  const s = sandbox();
  const plainFile = s.put(s.live, SID);
  const first = s.run();
  assert.equal(first.status, 0, first.stdout + first.stderr);
  assert.deepEqual(turnIds(s.shipped()), twoTurns(SID));
  const checkpoint = [`codex ${SID} ${mtimeOf(plainFile)} ${PROJECT}`];
  assert.deepEqual(s.progressLines(), checkpoint);

  compressInPlace(plainFile);
  assert.deepEqual(oldWalk(s), [], 'control: only the compressed spelling is left');
  const second = s.run();

  assert.equal(second.status, 0, second.stdout + second.stderr);
  assert.deepEqual(turnIds(s.shipped()), twoTurns(SID), 'the second run shipped turns for a session already indexed');
  assert.match(second.stdout, new RegExp(`^Skipping \\(already indexed\\): ${SID} \\(codex/${PROJECT}\\)$`, 'm'));
  assert.doesNotMatch(second.stdout, /^Indexing session:/m);
  assert.match(second.stdout, /Backfilled 0 turns; skipped 1 already-indexed session\(s\)/);
  assert.equal(s.infererCalls().length, 1, 'the skip is decided from the name and mtime, without reading the rollout');
  assert.deepEqual(s.progressLines(), checkpoint, 'a skip must not rewrite the checkpoint');
});

test('the same holds once it is archived and compressed there', () => {
  const s = sandbox();
  const plainFile = s.put(s.live, SID);
  s.run();
  assert.deepEqual(turnIds(s.shipped()), twoTurns(SID));

  compressInPlace(plainFile, path.join(s.archived, `${rolloutName(SID)}.zst`));
  const second = s.run();

  assert.deepEqual(turnIds(s.shipped()), twoTurns(SID));
  assert.match(second.stdout, new RegExp(`^Skipping \\(already indexed\\): ${SID} `, 'm'));
  assert.match(second.stdout, /skipped 1 already-indexed session\(s\)/, 'the archived copy was not walked at all');
});

test('a rollout that grew after its last index and was then compressed is read again', needsZstdBin, () => {
  const s = sandbox();
  const zstFile = s.put(s.live, SID, { compressed: true });
  // The checkpoint is from an earlier write: catch-up indexed it mid-session.
  fs.writeFileSync(s.progress, `codex ${SID} ${mtimeOf(zstFile) - 600} ${PROJECT}\n`);

  const r = s.run();

  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(turnIds(s.shipped()), twoTurns(SID), 'a stale checkpoint must not hide the rest of the session');
  assert.equal(s.progressLines().at(-1), `codex ${SID} ${mtimeOf(zstFile)} ${PROJECT}`);
});

test('the archive is walked: a plain rollout archived before it was indexed', () => {
  const s = sandbox();
  const file = s.put(s.archived, SID);
  assert.deepEqual(oldWalk(s), [], 'control: the old walk covered the live tree only');

  const r = s.run();

  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(turnIds(s.shipped()), twoTurns(SID));
  assert.deepEqual(s.progressLines(), [`codex ${SID} ${mtimeOf(file)} ${PROJECT}`]);
});

test('the archive is walked: a compressed rollout that was never indexed', needsZstdBin, () => {
  const s = sandbox();
  const file = s.put(s.archived, SID, { compressed: true });
  const liveFile = s.put(s.live, OTHER, { compressed: true });
  assert.deepEqual(oldWalk(s), []);

  const r = s.run();

  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(turnIds(s.shipped()).sort(), [...twoTurns(SID), ...twoTurns(OTHER)].sort());
  assert.deepEqual(s.progressLines().sort(), [`codex ${SID} ${mtimeOf(file)} ${PROJECT}`, `codex ${OTHER} ${mtimeOf(liveFile)} ${PROJECT}`].sort());
});

test('without the zstd binary a compressed rollout is counted and named, never passed over', () => {
  const s = sandbox();
  const unread = s.put(s.live, SID, { compressed: true });
  // Already indexed while plain: needs no decompressor to be skipped.
  const indexed = s.put(s.live, OTHER, { compressed: true });
  fs.writeFileSync(s.progress, `codex ${OTHER} ${mtimeOf(indexed)} ${PROJECT}\n`);

  const r = s.run({ CARTOGRAPHER_ZSTD: path.join(s.dir, 'no-such-zstd') });

  assert.equal(r.status, 0, 'a missing tool is reported, and must not void the catch-up cooldown');
  assert.match(r.stdout, new RegExp(`^Skipping \\(compressed, and zstd is not installed\\): rollout-2026-10-01T09-00-00-${SID}$`, 'm'));
  assert.match(r.stdout, new RegExp(`^Skipping \\(already indexed\\): ${OTHER} `, 'm'));
  assert.match(r.stdout, /skipped 1 already-indexed session\(s\); 0 turn failure\(s\); 1 compressed rollout\(s\) not read \(zstd not installed\)\.$/m);
  assert.deepEqual(s.shipped(), []);
  assert.deepEqual(s.infererCalls(), []);
  assert.deepEqual(s.progressLines(), [`codex ${OTHER} ${mtimeOf(indexed)} ${PROJECT}`], 'an unread rollout must stay uncheckpointed, so the next run tries it');
  assert.ok(fs.existsSync(unread));
});

test('a .zst that does not decompress is counted and left uncheckpointed', needsZstdBin, () => {
  const s = sandbox();
  s.put(s.live, SID, { compressed: true, bytes: Buffer.from('this is not a zstd frame') });
  // A frame cut short: the first rows decode, the rest do not.
  const whole = compress(rolloutBody(OTHER, s.dev));
  s.put(s.live, OTHER, { compressed: true, bytes: whole.subarray(0, whole.length - 8) });

  const r = s.run();

  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /2 compressed rollout\(s\) not read \(did not decompress\)\.$/m);
  assert.match(r.stdout, new RegExp(`^Skipping \\(compressed, and it does not decompress\\): rollout-2026-10-01T09-00-00-${OTHER}$`, 'm'));
  assert.deepEqual(s.shipped(), [], 'no turn from before the break may be indexed as if the session were whole');
  assert.deepEqual(s.progressLines(), []);
});

test('a plain file beside its compressed twin is indexed once, from the plain file', () => {
  const s = sandbox();
  const plainFile = s.put(s.live, SID);
  // Codex partway through compressing: a .zst that is not finished yet.
  s.put(s.live, SID, { compressed: true, bytes: Buffer.from('half a frame') });

  const r = s.run();

  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(turnIds(s.shipped()), twoTurns(SID));
  for (const row of s.shipped()) assert.equal(row.transcript_path, plainFile);
  assert.match(r.stdout, /^Skipping \(plain copy beside it is read instead\): rollout-.*\.jsonl\.zst$/m);
  assert.doesNotMatch(r.stdout, /not read/);
});

test('the inferer names the same project from a .zst path as from the plain rows', needsNodeZstd, () => {
  const s = sandbox();
  const plainFile = s.put(s.live, SID);
  const zstFile = s.put(s.archived, SID, { compressed: true });
  const infer = (...args) => spawnSync('node', [INFERER, ...args, s.dev], { encoding: 'utf8' });

  assert.equal(infer(plainFile).stdout, `${PROJECT}\n`);
  assert.equal(infer(zstFile).stdout, `${PROJECT}\n`);

  // Unreadable is an error with nothing on stdout, never a guessed project.
  fs.writeFileSync(zstFile, 'this is not a zstd frame');
  const broken = infer(zstFile);
  assert.notEqual(broken.status, 0);
  assert.equal(broken.stdout, '');
});

test('the inferer reads rows from stdin, and stops at a cwd that settles the answer', () => {
  const s = sandbox();
  const rows = rolloutBody(SID, s.dev);
  const infer = (input) => spawnSync('node', [INFERER, '-', s.dev], { input, encoding: 'utf8' });

  assert.equal(infer(rows).stdout, `${PROJECT}\n`);

  // A session opened inside a project: its cwd wins over any workdir count,
  // so rows after the first cannot change the answer and are not needed.
  const meta = JSON.stringify({ type: 'session_meta', payload: { id: SID, cwd: path.join(s.dev, 'gadget-web', 'src') } });
  const elsewhere = JSON.stringify({ type: 'response_item', payload: { type: 'custom_tool_call', input: JSON.stringify({ workdir: path.join(s.dev, PROJECT) }) } });
  assert.equal(infer(`${meta}\n${elsewhere}\n${elsewhere}\nthis row is not JSON\n`).stdout, 'gadget-web\n');
});
