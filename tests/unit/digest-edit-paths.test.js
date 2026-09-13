/**
 * tests/unit/digest-edit-paths.test.js
 *
 * The edit hook records a bash-mediated edit as `Modified: a.js,b.js (via bash)`.
 * session-digest matched a bare /^Modified:\s*(.+)$/ and keyed its hottest-files
 * panel on the whole tail, so three things went wrong at once and none of them
 * errored: the ` (via bash)` marker rode into the key, a multi-file row became
 * one fabricated filename, and the hook's loose path detector put JS property
 * access (`errors.push`) at the top of the panel. Measured on session 3c5f5a20
 * the panel claimed 76 files touched, led with `errors.push` ×11, and listed
 * `docs/HANDOFF.md` beside `docs/HANDOFF.md,docs/PRODUCT.md` as two entries.
 *
 * Each assertion below fails against that code. The fixture proves it exercises
 * the defect by mixing all three shapes into one session and requiring that the
 * same file, edited through both tools, lands in a single bucket.
 *
 * Run with: node --test tests/unit/digest-edit-paths.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { editSummaryValue, splitEditPaths, editSummaryPaths } from '../../scripts/edit-paths.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = path.join(ROOT, 'scripts', 'session-digest.js');
const SESSION = 'digest-edit-paths-session';
const AT = new Date(Date.now() - 3600_000).toISOString();

function digest(events, files) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'carto-digest-')));
  for (const rel of files) {
    fs.mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), 'x');
  }
  const changelog = path.join(dir, 'changelog.jsonl');
  fs.writeFileSync(changelog, events.map((e) => JSON.stringify({
    event_id: `evt-${Math.random().toString(36).slice(2, 10)}`,
    timestamp: AT,
    session_id: SESSION,
    project: 'fixture',
    cwd: dir,
    ...e,
  })).join('\n') + '\n');

  const env = { ...process.env, CARTOGRAPHER_DEV_DIR: dir, CARTOGRAPHER_CHANGELOG: changelog };
  // Delta serving is real: a harness that inherits a live session id loses rows.
  for (const key of ['CLAUDE_SESSION_ID', 'CLAUDE_CODE_SESSION_ID', 'CODEX_SESSION_ID', 'CARTOGRAPHER_SESSION_ID']) delete env[key];

  const run = spawnSync('node', [SCRIPT, '--session', SESSION, '--json', '--no-git'], { encoding: 'utf8', env });
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout);
}

const edit = (summary) => ({ type: 'tool_file_edit', summary });

test('the bash marker and the multi-file list never reach a panel key', () => {
  const out = digest(
    [edit('Modified: docs/HANDOFF.md,docs/PRODUCT.md (via bash)')],
    ['docs/HANDOFF.md', 'docs/PRODUCT.md'],
  );
  const keys = Object.keys(out.files);
  assert.deepEqual(keys.sort(), ['docs/HANDOFF.md', 'docs/PRODUCT.md']);
  assert.ok(!keys.some((k) => k.includes('via bash')), `marker leaked: ${keys}`);
  assert.ok(!keys.some((k) => k.includes(',')), `list not split: ${keys}`);
});

test('one file edited through both tools lands in one bucket', () => {
  const out = digest([
    edit('Modified: docs/HANDOFF.md,docs/PRODUCT.md (via bash)'),
    edit('Modified: docs/HANDOFF.md (via bash)'),
    edit(`Modified: ${path.join('docs', 'HANDOFF.md')}`),
  ], ['docs/HANDOFF.md', 'docs/PRODUCT.md']);
  assert.equal(out.files['docs/HANDOFF.md'], 3);
  assert.equal(out.files['docs/PRODUCT.md'], 1);
});

test('candidates that are not files are excluded but counted, never silently dropped', () => {
  const out = digest([
    edit('Modified: errors.push (via bash)'),
    edit('Modified: console.log,src/app.js (via bash)'),
  ], ['src/app.js']);
  assert.deepEqual(Object.keys(out.files), ['src/app.js']);
  assert.equal(out.files_unresolved, 2, 'both junk candidates must be reported');
});

test('a session whose every candidate misses still reports the miss', () => {
  const out = digest([edit('Modified: errors.push (via bash)')], []);
  assert.deepEqual(out.files, {});
  assert.equal(out.files_unresolved, 1);
});

test('the parser is one definition, and a comma in a real filename survives it', () => {
  assert.equal(editSummaryValue('Modified: a.js,b.js (via bash)'), 'a.js,b.js');
  assert.equal(editSummaryValue('Wrote: /tmp/x.md'), '/tmp/x.md');
  assert.equal(editSummaryValue('Ran: ls'), '');
  assert.deepEqual(editSummaryPaths('Modified: a.js, b.js (via bash)'), ['a.js', 'b.js']);
  // With a resolver the whole value gets first refusal, so `Notes, final.md`
  // is a filename rather than a two-item list.
  const resolve = (v) => v === 'Notes, final.md';
  assert.deepEqual(splitEditPaths('Notes, final.md', resolve), ['Notes, final.md']);
  assert.deepEqual(splitEditPaths('a.js,b.js', resolve), ['a.js', 'b.js']);
});
