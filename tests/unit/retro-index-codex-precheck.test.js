/**
 * tests/unit/retro-index-codex-precheck.test.js
 *
 * retro-index.sh derives a Codex session's id and project by running two jq
 * passes and scripts/infer-codex-project.js over the whole transcript. Until
 * 2026-10-07 it did that *before* consulting the checkpoint, so a zero-work
 * catch-up (78 of 123 runs in two weeks) paid ~150 ms per transcript to decide
 * to skip every one of them: 26 s median, 66 s p95, measured from
 * .carto/transcript-catch-up.jsonl.
 *
 * The fix is a pre-check keyed on what the path already carries: a rollout
 * file is named rollout-<date>T<time>-<session id>, so "codex <id> <mtime> "
 * as a line prefix of the progress file identifies a checkpointed session
 * without opening the transcript. These tests assert on composition, per
 * docs/TESTING.md: not "the run succeeded" but *which processes ran*. The
 * inferer is replaced by a recorder, so a checkpointed session must leave the
 * recorder untouched, and every case that must fall through to the full
 * derivation must reach it.
 *
 * Run with: node --test tests/unit/retro-index-codex-precheck.test.js
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
const SCRIPT = path.join(ROOT, 'scripts', 'retro-index.sh');

const SID = '01a1098b-d003-7511-a7a3-74e7bf0bf599';
const ROLLOUT = `rollout-2026-10-04T17-52-00-${SID}.jsonl`;
const PROJECT = 'widget-web';

/**
 * A fixture: an isolated CARTOGRAPHER_DEV_DIR, a Codex session store holding
 * one rollout, and an inferer stand-in that records every invocation.
 */
function fixture({ basename = ROLLOUT, withMeta = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-precheck-'));
  const dev = path.join(dir, 'dev');
  const carto = path.join(dev, '.carto');
  const sessions = path.join(dir, 'sessions');
  const day = path.join(sessions, '2026', '10', '04');
  fs.mkdirSync(carto, { recursive: true });
  fs.mkdirSync(day, { recursive: true });

  const transcript = path.join(day, basename);
  const rows = [];
  if (withMeta) {
    rows.push({ type: 'session_meta', payload: { id: SID, cwd: path.join(dev, PROJECT), timestamp: '2026-10-04T17:52:00.000Z' } });
  }
  rows.push({ type: 'event_msg', timestamp: '2026-10-04T17:52:01.000Z', payload: { type: 'user_message', message: 'make the widget render' } });
  rows.push({ type: 'response_item', timestamp: '2026-10-04T17:52:05.000Z', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Rendered.' }] } });
  fs.writeFileSync(transcript, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const mtime = Math.floor(fs.statSync(transcript).mtimeMs / 1000);

  const calls = path.join(dir, 'inferer-calls');
  const inferer = path.join(dir, 'infer-stub.js');
  fs.writeFileSync(inferer, [
    "import { appendFileSync } from 'node:fs';",
    `appendFileSync(${JSON.stringify(calls)}, process.argv.slice(2).join('\\t') + '\\n');`,
    `console.log(${JSON.stringify(PROJECT)});`,
    '',
  ].join('\n'));

  const progress = path.join(carto, 'retro-index-progress');
  const env = { ...process.env, ...OFFLINE_INDEX_ENV };
  for (const key of ['CARTOGRAPHER_SESSION_ID', 'CLAUDE_SESSION_ID', 'CLAUDE_CODE_SESSION_ID', 'CODEX_SESSION_ID']) delete env[key];
  Object.assign(env, {
    CARTOGRAPHER_DEV_DIR: dev,
    CARTOGRAPHER_CODEX_TRANSCRIPTS_DIR: sessions,
    CARTOGRAPHER_CODEX_ARCHIVED_DIR: path.join(dir, 'no-archive'),
    CARTOGRAPHER_CODEX_PROJECT_INFERER: inferer,
  });

  const run = (...args) => spawnSync('bash', [SCRIPT, '--provider', 'codex', ...args], { env, encoding: 'utf8' });
  const infererCalls = () => (fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').split('\n').filter(Boolean) : []);
  const progressLines = () => (fs.existsSync(progress) ? fs.readFileSync(progress, 'utf8').split('\n').filter(Boolean) : []);
  const checkpoint = (line) => fs.writeFileSync(progress, line + '\n');

  return { dir, dev, transcript, mtime, progress, run, infererCalls, progressLines, checkpoint };
}

test('a session checkpointed at this mtime is skipped before jq or the inferer run', () => {
  const f = fixture();
  f.checkpoint(`codex ${SID} ${f.mtime} ${PROJECT}`);
  const before = fs.readFileSync(f.progress, 'utf8');

  const r = f.run();

  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(f.infererCalls(), [], 'the inferer ran for a checkpointed session');
  // The skip line names the project from the checkpoint, so output is the
  // same as the full-derivation path produced before the pre-check existed.
  assert.match(r.stdout, new RegExp(`^Skipping \\(already indexed\\): ${SID} \\(codex/${PROJECT}\\)$`, 'm'));
  assert.doesNotMatch(r.stdout, /^Indexing session:/m);
  assert.match(r.stdout, /skipped 1 already-indexed session\(s\)/);
  assert.equal(fs.readFileSync(f.progress, 'utf8'), before, 'a skip must not rewrite the checkpoint');
});

test('a prefix match is on mtime too: a grown transcript falls through to the full derivation', () => {
  const f = fixture();
  f.checkpoint(`codex ${SID} ${f.mtime - 60} ${PROJECT}`);

  const r = f.run();

  assert.deepEqual(f.infererCalls(), [`${f.transcript}\t${f.dev}`], 'the inferer must see a transcript whose checkpoint mtime is stale');
  assert.match(r.stdout, new RegExp(`^Indexing session: ${SID} \\(codex/${PROJECT}\\)$`, 'm'));
  assert.doesNotMatch(r.stdout, /^Skipping/m);
});

test('a pre-attribution checkpoint (no project field) still invalidates', () => {
  // Codex lines written before project joined the key have three fields. The
  // full check never honoured them for Codex; the prefix carries a trailing
  // space precisely so that the pre-check does not start to.
  const f = fixture();
  f.checkpoint(`codex ${SID} ${f.mtime}`);

  const r = f.run();

  assert.equal(f.infererCalls().length, 1, 'a three-field checkpoint must fall through');
  assert.match(r.stdout, new RegExp(`^Indexing session: ${SID} `, 'm'));
});

test('a transcript whose name carries no session id takes the full path', () => {
  const f = fixture({ basename: 'notes.jsonl', withMeta: false });
  f.checkpoint(`codex notes ${f.mtime} ${PROJECT}`);

  const r = f.run();

  // The full derivation falls back to the basename as the id and reaches the
  // full-key check, which honours the line — same behaviour as before.
  assert.equal(f.infererCalls().length, 1, 'an unparseable name must not be pre-checked');
  assert.match(r.stdout, new RegExp(`^Skipping \\(already indexed\\): notes \\(codex/${PROJECT}\\)$`, 'm'));
});

test('--project bypasses the pre-check, because inclusion needs the inferred project', () => {
  const f = fixture();
  f.checkpoint(`codex ${SID} ${f.mtime} ${PROJECT}`);

  const r = f.run('--project', 'something-else');

  assert.equal(f.infererCalls().length, 1, 'the inferer decides --project membership');
  assert.doesNotMatch(r.stdout, /^Skipping/m);
  assert.match(r.stdout, /skipped 0 already-indexed/);
});
