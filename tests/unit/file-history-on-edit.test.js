// The hook reads only the JSONL logs, but the testing guide pins the semantic
// leg off in every file so a live Qdrant can never leak into an assertion.
process.env.CARTOGRAPHER_SEMANTIC = '0';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { OFFLINE_INDEX_ENV } from './helpers/offline-index.js';

const ROOT = path.resolve(import.meta.dirname, '../..');
const HOOK = path.join(ROOT, 'plugins/session-cartographer/hooks/check-edit-collision.sh');

const SELF = 'self-0000-aaaa-bbbb-cccc';
const PEER = 'peer-1111-dddd-eeee-ffff';
const OTHER = 'othr-2222-dddd-eeee-ffff';
const HAS_RG = spawnSync('rg', ['--version']).status === 0;

function ago(days) { return new Date(Date.now() - days * 86400e3).toISOString(); }

/** A dev dir holding the logs and one repository, `widget`. */
function workspace({ gitInit = false } = {}) {
  const dev = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'carto-history-')));
  const repo = path.join(dev, 'widget');
  for (const f of ['src/app.js', 'src/quiet.js', 'lib/app.js']) {
    fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true });
    fs.writeFileSync(path.join(repo, f), 'x\n');
  }
  if (gitInit) {
    spawnSync('git', ['init', '-q', repo]);
    spawnSync('git', ['-C', repo, 'add', '.']);
  } else {
    fs.mkdirSync(path.join(repo, '.git'));
  }
  fs.mkdirSync(path.join(dev, '.carto'), { recursive: true });
  return { dev, repo, app: path.join(repo, 'src/app.js'), quiet: path.join(repo, 'src/quiet.js') };
}

function writeLogs(dev, changelog, milestones = []) {
  fs.writeFileSync(path.join(dev, 'changelog.jsonl'), changelog.map((r) => JSON.stringify(r)).join('\n') + '\n');
  fs.writeFileSync(path.join(dev, 'session-milestones.jsonl'), milestones.map((r) => JSON.stringify(r)).join('\n') + (milestones.length ? '\n' : ''));
}

const investigation = (id, days, extra = {}) => ({
  event_id: id, timestamp: ago(days), type: 'investigation', provider: 'claude', session_id: PEER,
  project: 'widget', summary: `Investigated: symptom ${id} — hypothesis ${id}`, symptom: `Morph rewinds to the previous preset (${id})`,
  hypothesis: `hypothesis ${id}`, files: ['src/app.js'], salience: 0.8, ...extra,
});
const outcome = (id, resolves, value, days) => ({
  event_id: id, timestamp: ago(days), type: 'investigation_outcome', session_id: PEER, project: 'widget',
  summary: `Investigation ${value}: ${resolves} — evidence`, resolves, outcome: value, evidence: 'evidence',
});
const commit = (id, session, sha, subject, days, files = 'src/app.js', extra = {}) => ({
  event_id: id, timestamp: ago(days), type: 'git_commit', provider: 'codex', session_id: session, project: 'widget',
  summary: `[fix] Commit ${sha}: ${subject} | files: ${files}`, ...extra,
});

/** The corpus most tests share: one confirmed and one refuted diagnosis, a peer commit, a newer own commit. */
function standardLogs(dev, repo) {
  writeLogs(dev, [
    investigation('evt-inv-confirmed', 5),
    outcome('evt-out-confirmed', 'evt-inv-confirmed', 'confirmed', 4),
    investigation('evt-inv-refuted', 3),
    outcome('evt-out-refuted', 'evt-inv-refuted', 'refuted', 2),
    // This session's own diagnosis, the newest: it already knows it.
    investigation('evt-inv-self', 0.1, { session_id: SELF }),
    commit('evt-peer-commit', PEER, 'abc1234def5678', 'fix(morph): re-seat the channel on completion', 2, 'src/app.js,src/other.js', { cwd: repo }),
    // Newer than the peer's commit, so a "latest commit" that forgot to
    // exclude this session would show this one instead.
    commit('evt-self-commit', SELF, 'fff9999eee8888', 'wip: my own change', 1, 'src/app.js', { cwd: repo }),
  ]);
}

function baseEnv(extra = {}) {
  const env = { ...process.env, ...OFFLINE_INDEX_ENV };
  for (const k of ['CARTOGRAPHER_FILE_HISTORY_ON_EDIT', 'CARTOGRAPHER_FILE_HISTORY_DAYS', 'CARTOGRAPHER_COLLISION_CHECK',
    'CARTOGRAPHER_COLLISION_WINDOW', 'CARTOGRAPHER_PROVIDER', 'CARTOGRAPHER_RG']) delete env[k];
  return { ...env, ...extra };
}

function runHook(dev, payload, { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-history-state-')), env = {} } = {}) {
  const result = spawnSync('bash', [HOOK], {
    cwd: ROOT,
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: baseEnv({ CARTOGRAPHER_DEV_DIR: dev, CARTOGRAPHER_ROOT: ROOT, TMPDIR: tmp, CARTOGRAPHER_FILE_HISTORY_ON_EDIT: '1', ...env }),
  });
  return { ...result, tmp };
}

function payload(file, session = SELF) {
  return { hook_event_name: 'PreToolUse', session_id: session, tool_name: 'Edit', tool_input: { file_path: file }, cwd: path.dirname(file) };
}

function context(r) {
  assert.equal(r.status, 0, r.stderr);
  if (!r.stdout) return null;
  const out = JSON.parse(r.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal('permissionDecision' in out.hookSpecificOutput, false, 'a context note never decides');
  assert.deepEqual(Object.keys(out), ['hookSpecificOutput'], 'Codex rejects unknown top-level keys');
  return out.hookSpecificOutput.additionalContext;
}

function trial(dev) {
  const file = path.join(dev, 'file-history-on-edit-trial.jsonl');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
}

test('the first edit of a file names its diagnosis and the peer commit, with ids to fetch', () => {
  const { dev, repo, app } = workspace();
  standardLogs(dev, repo);
  const ctx = context(runHook(dev, payload(app)));
  const lines = ctx.split('\n');
  assert.equal(lines.length, 2, `at most two lines: ${ctx}`);
  assert.match(lines[0], /^\[carto history\] src\/app\.js: confirmed diagnosis 5d ago \(evt-inv-confirmed\): Morph rewinds/);
  assert.match(lines[1], /^\[carto history\] app\.js: last commit by another session abc1234d 2d ago \(evt-peer-commit\): "fix\(morph\): re-seat/);
  assert.match(lines[1], /\/remember --get <id> for any record\.$/);
  assert.doesNotMatch(ctx, /evt-inv-refuted/, 'a refuted hypothesis is not knowledge about the file');
  assert.doesNotMatch(ctx, /evt-inv-self/, "the session's own diagnosis is not news to it");

  const rows = trial(dev);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].fired, true);
  assert.equal(rows[0].reason, 'fired');
  assert.equal(rows[0].file, 'src/app.js');
  assert.equal(rows[0].project, 'widget');
  assert.equal(rows[0].session, SELF);
  assert.ok(Number.isFinite(rows[0].latency_ms));
  assert.deepEqual(rows[0].shown, ['evt-inv-confirmed', 'evt-peer-commit']);
  assert.equal(rows[0].scan, HAS_RG ? 'rg' : 'node');
});

test('the same session commit is excluded even when it is the newest', () => {
  const { dev, repo, app } = workspace();
  standardLogs(dev, repo);
  const ctx = context(runHook(dev, payload(app)));
  assert.doesNotMatch(ctx, /fff9999|evt-self-commit/);
  // The fixture is only meaningful if the session's own commit would win on recency.
  const fromPeerView = context(runHook(dev, payload(app, OTHER)));
  assert.match(fromPeerView, /fff9999e 24h ago/, 'to any other session the newest commit is the one excluded above');
});

test('a second edit of the same file in the same session is silent and costs no scan', () => {
  const { dev, repo, app } = workspace();
  standardLogs(dev, repo);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-history-state-'));
  assert.ok(context(runHook(dev, payload(app), { tmp })), 'first edit fires');
  // A missing changelog would make a scan return nothing, so silence here
  // could not be told from a lookup that found nothing. Removing the logs
  // proves the second call never read them.
  fs.rmSync(path.join(dev, 'changelog.jsonl'));
  assert.equal(runHook(dev, payload(app), { tmp }).stdout, '');
  assert.equal(trial(dev).length, 1, 'a repeat edit is not an evaluation');
  standardLogs(dev, repo);
  assert.ok(context(runHook(dev, payload(app), { tmp: fs.mkdtempSync(path.join(os.tmpdir(), 'carto-history-state-')) })),
    'the history is still there for a session that has not seen it');
});

test('silent with the gate off, with collision still on', () => {
  const { dev, repo, app } = workspace();
  standardLogs(dev, repo);
  for (const value of [undefined, '0', 'true']) {
    const env = value === undefined ? {} : { CARTOGRAPHER_FILE_HISTORY_ON_EDIT: value };
    const r = spawnSync('bash', [HOOK], {
      cwd: ROOT, input: JSON.stringify(payload(app)), encoding: 'utf8',
      env: baseEnv({ CARTOGRAPHER_DEV_DIR: dev, CARTOGRAPHER_ROOT: ROOT, TMPDIR: fs.mkdtempSync(path.join(os.tmpdir(), 'carto-history-state-')), ...env }),
    });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '', `gate ${value}`);
  }
  assert.equal(trial(dev).length, 0, 'nothing evaluated, nothing logged');
});

test('a file with no history is silent and logged as no_history', () => {
  const { dev, repo, quiet } = workspace();
  standardLogs(dev, repo);
  assert.equal(runHook(dev, payload(quiet)).stdout, '');
  const rows = trial(dev);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].fired, false);
  assert.equal(rows[0].reason, 'no_history');
  assert.equal(rows[0].file, 'src/quiet.js');
});

test('a file outside any repository is not scanned', () => {
  const { dev, repo } = workspace();
  standardLogs(dev, repo);
  const loose = path.join(dev, 'notes.md');
  fs.writeFileSync(loose, 'x\n');
  assert.equal(runHook(dev, payload(loose)).stdout, '');
  assert.equal(trial(dev)[0].reason, 'no_repo');
});

test('the in-process scan says exactly what rg says', { skip: !HAS_RG && 'rg not installed' }, () => {
  const { dev, repo, app } = workspace();
  standardLogs(dev, repo);
  const withRg = context(runHook(dev, payload(app)));
  const without = context(runHook(dev, payload(app), { env: { CARTOGRAPHER_RG: 'none' } }));
  assert.equal(without, withRg);
  assert.deepEqual(trial(dev).map((r) => r.scan), ['rg', 'node']);
});

test('records from a worktree, a subdirectory cwd, or another repo are matched by project and path', () => {
  const { dev, repo, app } = workspace();
  writeLogs(dev, [
    // Repo-relative files from a session whose cwd was a subdirectory.
    commit('evt-subdir', PEER, '1111111aaaa', 'from a subdirectory', 3, 'src/app.js', { cwd: path.join(repo, 'src') }),
    // Same relative path, different repository: not this file.
    commit('evt-other-repo', PEER, '2222222bbbb', 'other repo', 1, 'src/app.js', { project: 'gadget', cwd: path.join(dev, 'gadget') }),
    // Same basename elsewhere in this repository: not this file.
    commit('evt-lib', PEER, '3333333cccc', 'lib app', 1, 'lib/app.js', { cwd: repo }),
    // An edit from a Claude worktree of this repository.
    { event_id: 'evt-wt-edit', timestamp: ago(0.5), type: 'tool_file_edit', session_id: OTHER, provider: 'claude', project: 'widget',
      summary: `Modified: ${path.join(repo, '.claude/worktrees/lane-b/src/app.js')}` },
  ]);
  const ctx = context(runHook(dev, payload(app)));
  assert.match(ctx, /1111111a/);
  assert.doesNotMatch(ctx, /2222222|3333333/);
  assert.doesNotMatch(ctx, /evt-wt-edit/, 'an edit only stands in when no commit was logged');

  writeLogs(dev, [
    { event_id: 'evt-wt-edit', timestamp: ago(0.5), type: 'tool_file_edit', session_id: OTHER, provider: 'claude', project: 'widget',
      summary: `Modified: ${path.join(repo, '.claude/worktrees/lane-b/src/app.js')}` },
    // The hook's loose bash detector writes property access as "paths".
    { event_id: 'evt-junk', timestamp: ago(0.2), type: 'tool_file_edit', session_id: PEER, provider: 'codex', project: 'widget',
      cwd: repo, summary: 'Modified: errors.push,app.js (via bash)' },
  ]);
  const edited = context(runHook(dev, payload(app)));
  assert.match(edited, /edited 12h ago by another session with no logged commit \(claude othr-222, evt-wt-edit\)/);
});

test('a summary without a files list counts only a path, or a basename the repository holds once', () => {
  const { dev, repo, app, quiet } = workspace({ gitInit: true });
  const bare = (id, text, days) => investigation(id, days, { files: undefined, symptom: text, summary: `Investigated: ${text}` });
  writeLogs(dev, [
    bare('evt-bare-app', 'app.js stalls on resume', 2),          // two app.js files: ambiguous
    bare('evt-path-app', 'src/app.js drops the first frame', 3),  // a path: exact
    bare('evt-bare-quiet', 'quiet.js races the loader.', 4),      // one quiet.js: unambiguous
    bare('evt-quietly', 'quiet.json is stale', 1),                // a longer name is not a mention
  ]);
  const appCtx = context(runHook(dev, payload(app)));
  assert.match(appCtx, /evt-path-app/);
  assert.doesNotMatch(appCtx, /evt-bare-app/);
  const quietCtx = context(runHook(dev, payload(quiet)));
  assert.match(quietCtx, /open diagnosis 4d ago \(evt-bare-quiet\)/);
  assert.doesNotMatch(quietCtx, /evt-quietly/);
});

test('a backfilled diagnosis with no outcome reads unclosed and yields to a confirmed one', () => {
  const { dev, app } = workspace();
  const backfilled = (id, days) => investigation(id, days, { backfilled_by: 'backfill-investigations' });
  writeLogs(dev, [backfilled('evt-old-task', 1), investigation('evt-real', 9), outcome('evt-real-out', 'evt-real', 'confirmed', 8)]);
  const ctx = context(runHook(dev, payload(app)));
  assert.match(ctx, /confirmed diagnosis 9d ago \(evt-real\).*\(\+1 more: evt-old-task\)/, 'newer, but of unknown status');
  writeLogs(dev, [backfilled('evt-old-task', 1)]);
  assert.match(context(runHook(dev, payload(app))), /unclosed diagnosis 24h ago \(evt-old-task\)/);
});

test('a wrapup that names the file fills the second line when there is no commit', () => {
  const { dev, app } = workspace();
  writeLogs(dev, [investigation('evt-open', 6)], [
    { event_id: 'evt-wrap', timestamp: ago(2), milestone: 'session_wrapup', session_id: PEER, project: 'widget',
      description: 'Tuned the morph.', unresolved: JSON.stringify(['src/app.js still rewinds on the third morph']) },
    { event_id: 'evt-wrap-self', timestamp: ago(1), milestone: 'session_wrapup', session_id: SELF, project: 'widget',
      description: 'Touched src/app.js myself.' },
  ]);
  const lines = context(runHook(dev, payload(app))).split('\n');
  assert.equal(lines.length, 2);
  assert.match(lines[0], /open diagnosis 6d ago \(evt-open\)/);
  // With a commit as well there are three items and room for two.
  writeLogs(dev, [investigation('evt-open', 6), commit('evt-c', PEER, 'abc1234def5678', 'fix it', 3, 'src/app.js')], [
    { event_id: 'evt-wrap', timestamp: ago(2), milestone: 'session_wrapup', session_id: PEER, project: 'widget',
      unresolved: JSON.stringify(['src/app.js still rewinds on the third morph']) },
  ]);
  const capped = context(runHook(dev, payload(app)));
  assert.equal(capped.split('\n').length, 2, capped);
  assert.doesNotMatch(capped, /evt-wrap/);
  assert.deepEqual(trial(dev).at(-1).shown, ['evt-open', 'evt-c']);
  assert.equal(trial(dev).at(-1).wrapup, 'evt-wrap', 'found, logged, and left out for room');
  assert.match(lines[1], /^\[carto history\] app\.js: wrapup 2d ago \(evt-wrap\), unresolved: src\/app\.js still rewinds/);
});

test('with a live collision, both notes arrive in one object and the commit is named once', () => {
  const { dev, repo, app } = workspace();
  writeLogs(dev, [
    investigation('evt-inv', 5),
    commit('evt-fresh-commit', PEER, 'abc1234def5678', 'fix: just now', 5 / 1440, 'src/app.js', { cwd: repo }),
  ]);
  const ctx = context(runHook(dev, payload(app)));
  assert.match(ctx, /^\[carto collision\][\s\S]*committed it in abc1234d/);
  assert.match(ctx, /\[carto history\] src\/app\.js: open diagnosis/);
  assert.equal(ctx.match(/abc1234d/g).length, 1, 'the history note drops the commit the collision note already names');

  // With nothing else to say, the history note stays silent and says why in the trial.
  writeLogs(dev, [commit('evt-fresh-commit', PEER, 'abc1234def5678', 'fix: just now', 5 / 1440, 'src/app.js', { cwd: repo })]);
  const only = context(runHook(dev, payload(app)));
  assert.doesNotMatch(only, /carto history/);
  assert.deepEqual([trial(dev).at(-1).reason, trial(dev).at(-1).commit], ['suppressed', 'evt-fresh-commit']);
});

test('a commit older than the window is history git log can give; the window is tunable', () => {
  const { dev, repo, app } = workspace();
  writeLogs(dev, [commit('evt-old', PEER, 'abc1234def5678', 'old fix', 20, 'src/app.js', { cwd: repo })]);
  assert.equal(runHook(dev, payload(app)).stdout, '');
  assert.match(context(runHook(dev, payload(app), { env: { CARTOGRAPHER_FILE_HISTORY_DAYS: '30' } })), /abc1234d 20d ago/);
});

test('history alone runs with the collision check disabled', () => {
  const { dev, repo, app } = workspace();
  standardLogs(dev, repo);
  const ctx = context(runHook(dev, payload(app), { env: { CARTOGRAPHER_COLLISION_CHECK: '0' } }));
  assert.match(ctx, /^\[carto history\]/);
});

test('an unresolved session is never evaluated', () => {
  const { dev, repo, app } = workspace();
  standardLogs(dev, repo);
  for (const sid of ['unknown', '', ' Unknown ']) assert.equal(runHook(dev, payload(app, sid)).stdout, '');
  assert.equal(trial(dev).length, 0);
});

test('Codex apply_patch names every file it changes', () => {
  const { dev, repo } = workspace();
  standardLogs(dev, repo);
  const r = runHook(dev, {
    hook_event_name: 'PreToolUse', session_id: SELF, tool_name: 'apply_patch', cwd: repo,
    transcript_path: '/Users/x/.codex/sessions/2026/10/15/rollout-x.jsonl',
    tool_input: { input: '*** Begin Patch\n*** Update File: src/quiet.js\n@@\n-x\n+y\n*** Update File: src/app.js\n@@\n-x\n+z\n*** End Patch\n' },
  });
  assert.match(context(r), /src\/app\.js: confirmed diagnosis/);
  const rows = Object.fromEntries(trial(dev).map((row) => [row.file, row]));
  assert.deepEqual(Object.keys(rows).sort(), ['src/app.js', 'src/quiet.js']);
  assert.ok(Object.values(rows).every((row) => row.provider === 'codex'));
  assert.deepEqual([rows['src/app.js'].fired, rows['src/app.js'].reason], [true, 'fired']);
  assert.deepEqual([rows['src/quiet.js'].fired, rows['src/quiet.js'].reason, rows['src/quiet.js'].shown], [false, 'no_history', []],
    'one scan, but each file is judged on its own');
});
