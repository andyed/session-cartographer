/**
 * tests/unit/start-note-hook.test.js
 *
 * The SessionStart note (hooks/surface-focus-on-start.sh + start-note.jq) is the
 * most-read surface cartographer has with agents: 78% of recall happens on a
 * session's first turn. Every way it can be wrong is quiet. A note built from
 * the wrong wrapup reads as well as one built from the right one; a gate that
 * never re-arms prints nothing, which is also what a quiet project prints.
 *
 * So the fixture is built to trip each of those:
 *   - the newest wrapup sits BEFORE an older one in the log, and carries a
 *     +00:00 offset with fractional seconds, so "last line wins" or a string
 *     compare picks the wrong one;
 *   - a compaction row for the same project carries an `unresolved` field and a
 *     wrapup for another project names this one in its prose, so a loose grep
 *     leaks them in;
 *   - a legacy wrapup marks its threads "Unfinished:" with prose after the
 *     clause; another has no marker at all and must yield none, not a guess;
 *   - the changelog holds a live peer, a session outside the window, and the
 *     starting session itself, which must not count as its own peer.
 *
 * Run with: node --test tests/unit/start-note-hook.test.js
 */
process.env.CARTOGRAPHER_SEMANTIC = '0';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { OFFLINE_INDEX_ENV } from './helpers/offline-index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const HOOK = path.join(ROOT, 'plugins', 'session-cartographer', 'hooks', 'surface-focus-on-start.sh');

const SELF = '11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PEER = '22222222-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const STALE = '33333333-cccc-4ccc-8ccc-cccccccccccc';

// The hook's shebang is /bin/bash, which on macOS is 3.2: run the version it runs under.
const SHELL = fs.existsSync('/bin/bash') ? '/bin/bash' : 'bash';

const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString().replace(/\.\d{3}Z$/, 'Z');
const HOUR = 3600e3;

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
function git(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com',
    '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main', ...args],
  { cwd, encoding: 'utf8', env: GIT_ENV });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

/** A repo with an upstream, one unpushed commit, one tracked edit, one untracked file. */
function repo(base, name) {
  const dir = path.join(base, name);
  const remote = path.join(base, `${name}-remote.git`);
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  git(base, 'init', '-q', '--bare', remote);
  git(dir, 'init', '-q');
  git(dir, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  fs.writeFileSync(path.join(dir, 'src', 'a.js'), 'one\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'one');
  git(dir, 'remote', 'add', 'origin', remote);
  git(dir, 'push', '-q', '-u', 'origin', 'main');
  fs.writeFileSync(path.join(dir, 'src', 'b.js'), 'two\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'two');
  fs.writeFileSync(path.join(dir, 'src', 'a.js'), 'one, edited\n');
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'untracked\n');
  return dir;
}

const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';

function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-start-note-'));
  const dev = path.join(base, 'dev');
  fs.mkdirSync(dev);
  const alpha = repo(base, 'alpha');
  const legacy = repo(base, 'legacy');
  const plain = repo(base, 'plain');
  const quiet = repo(base, 'quiet');

  const threads = [
    'Verify the retry budget on the staging box before tagging 0.9',
    'Decide whether src/a.js keeps the legacy cursor; both callers still pass it',
    'Rerun the parity suite after the scope fix lands',
  ];
  // The older alpha wrapup is 6 h old but written in +05:00, so its string is
  // later than the newer one's: a string sort, or "last line wins", picks it.
  const olderAt0500 = new Date(Date.now() - HOUR).toISOString().replace(/\.\d{3}Z$/, '+05:00');
  fs.writeFileSync(path.join(dev, 'session-milestones.jsonl'), jsonl([
    { event_id: 'evt-alpha-new', timestamp: new Date(Date.now() - 3 * HOUR).toISOString().replace('Z', '123+00:00'),
      milestone: 'session_wrapup', project: 'alpha', git_branch: 'feat/retry', session_id: 'w1',
      description: 'Shipped retry budget.', unresolved: threads },
    { event_id: 'evt-alpha-old', timestamp: olderAt0500, milestone: 'session_wrapup', project: 'alpha',
      session_id: 'w0', description: 'Older synthesis.', unresolved: ['STALE THREAD FROM THE OLDER WRAPUP'] },
    // Same project and the "session_wrapup" string, but not a wrapup.
    { event_id: 'evt-alpha-compact', timestamp: iso(HOUR), milestone: 'compaction_auto', project: 'alpha',
      after: 'session_wrapup', unresolved: ['COMPACTION IS NOT A WRAPUP'] },
    // Another project's wrapup with "project":"alpha" nested in its digest.
    { event_id: 'evt-other', timestamp: iso(HOUR / 2), milestone: 'session_wrapup', project: 'beta',
      description: 'Beta work.', digest: { project: 'alpha' }, unresolved: ['BETA THREAD'] },
    { event_id: 'evt-legacy', timestamp: iso(24 * HOUR), milestone: 'session_wrapup', project: 'legacy',
      description: 'Ported the mixer. Unfinished: wire the gain stage; rerun the golden capture. Key insight: prose after the clause is not a thread.' },
    { event_id: 'evt-plain', timestamp: iso(24 * HOUR), milestone: 'session_wrapup', project: 'plain',
      description: 'Did several things and left some work for later.' },
  ]));

  // The roster's input. STALE was last seen 5 h ago. SELF, the session starting,
  // is already logged (a resume). PEER edited alpha's src/a.js, then a scratch
  // file outside the project, and is the newest event: standup's own guess at
  // "self" is the newest session, so without --me the peer would be dropped.
  const aJs = path.join(alpha, 'src', 'a.js');
  const scratch = path.join(base, 'scratch', 'tool.mjs');
  fs.mkdirSync(path.dirname(scratch));
  fs.writeFileSync(scratch, '\n');
  fs.writeFileSync(path.join(dev, 'changelog.jsonl'), jsonl([
    { event_id: 'e1', timestamp: iso(5 * HOUR), type: 'tool_file_edit', session_id: STALE, provider: 'claude',
      project: 'alpha', cwd: alpha, summary: `Modified: ${aJs}` },
    { event_id: 'e2', timestamp: iso(5 * 60e3), type: 'tool_bash', session_id: SELF, provider: 'claude',
      project: 'alpha', cwd: alpha, summary: 'ls' },
    { event_id: 'e3', timestamp: iso(3 * 60e3), type: 'tool_file_edit', session_id: PEER, provider: 'codex',
      project: 'alpha', cwd: alpha, summary: `Modified: ${aJs}` },
    { event_id: 'e4', timestamp: iso(60e3), type: 'tool_file_edit', session_id: PEER, provider: 'codex',
      project: 'alpha', cwd: alpha, summary: `Modified: ${scratch}` },
  ]));
  return { base, dev, alpha, legacy, plain, quiet, threads };
}

function run(f, cwd, { sid = SELF, source = 'startup', gate = '1', env = {} } = {}) {
  const payload = { hook_event_name: 'SessionStart', source, session_id: sid, cwd,
    transcript_path: `/home/t/.claude/projects/x/${sid}.jsonl` };
  const childEnv = { ...process.env, ...OFFLINE_INDEX_ENV, CARTOGRAPHER_DEV_DIR: f.dev,
    CARTOGRAPHER_FOCUS_ON_START: gate, CARTOGRAPHER_SEMANTIC: '0', ...env };
  for (const k of ['CLAUDE_SESSION_ID', 'CLAUDE_CODE_SESSION_ID', 'CODEX_SESSION_ID',
    'CARTOGRAPHER_SESSION_ID', 'CARTOGRAPHER_ROOT', 'CARTOGRAPHER_MILESTONES', 'CARTOGRAPHER_PROVIDER']) {
    if (!(k in env)) delete childEnv[k];
  }
  const r = spawnSync(SHELL, [HOOK], { input: JSON.stringify(payload), encoding: 'utf8', env: childEnv });
  assert.equal(r.status, 0, r.stderr);
  const note = r.stdout.trim() ? JSON.parse(r.stdout).hookSpecificOutput.additionalContext : '';
  return { note, stdout: r.stdout };
}

const trialRows = (f) => {
  const p = path.join(f.dev, 'focus-on-start-trial.jsonl');
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
};

test('a wrapup with unresolved[] puts its threads, repo state and live peers in the note', () => {
  const f = fixture();
  try {
    const { note } = run(f, f.alpha);
    assert.match(note, /^\[carto start note · alpha\]/);
    // The newest wrapup by timestamp, though it is written first and carries an offset.
    assert.match(note, /evt-alpha-new/);
    assert.match(note, /branch feat\/retry/);
    for (const t of f.threads) assert.ok(note.includes(`- ${t}`), `missing thread: ${t}\n${note}`);
    assert.match(note, /\/remember --get evt-alpha-new/);
    assert.doesNotMatch(note, /STALE THREAD|COMPACTION IS NOT|BETA THREAD|evt-alpha-old|evt-other/);
    // Repo: one tracked edit + one untracked file, one commit ahead of origin/main.
    assert.match(note, /Repo: branch main, uncommitted 1 tracked \+ 1 untracked, 1 unpushed\./);
    // The peer and the file it touched; neither the stale session nor this one.
    assert.match(note, /Also active here in the last 2h: 22222222 codex 1m ago \(a\.js\)\./);
    assert.doesNotMatch(note, /33333333|11111111|tool\.mjs/);
    assert.match(note, /→ \/remember --project alpha for full orientation\.$/);
    assert.ok(note.length <= 800, `note is ${note.length} chars`);

    const [row] = trialRows(f);
    assert.equal(row.v, 2);
    assert.equal(row.session_id, SELF);
    assert.equal(row.wrapup_id, 'evt-alpha-new');
    assert.equal(row.open_source, 'unresolved');
    assert.equal(row.open_threads, 3);
    assert.equal(row.open_shown, 3);
    assert.equal(row.dirty, 2);
    assert.equal(row.untracked, 1);
    assert.equal(row.unpushed, 1);
    assert.equal(row.peers, 1);
    assert.deepEqual(row.peer_ids, ['22222222']);
    assert.equal(row.reason, 'new_wrapup+peers');
    assert.equal(row.shown, true);
    assert.equal(row.chars, note.length);
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});

test('a legacy wrapup yields the threads of its "Unfinished:" clause and nothing after it', () => {
  const f = fixture();
  try {
    const { note } = run(f, f.legacy);
    assert.match(note, /evt-legacy/);
    assert.match(note, /^- wire the gain stage$/m);
    assert.match(note, /^- rerun the golden capture$/m);
    assert.doesNotMatch(note, /Key insight|prose after the clause/);
    assert.equal(trialRows(f)[0].open_source, 'marker');
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});

test('a wrapup with no marker shows no threads rather than a guess', () => {
  const f = fixture();
  try {
    const { note } = run(f, f.plain);
    assert.match(note, /evt-plain/);
    assert.match(note, /It recorded no open threads\./);
    assert.doesNotMatch(note, /^- /m);
    const [row] = trialRows(f);
    assert.equal(row.open_source, 'none');
    assert.equal(row.open_threads, 0);
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});

test('no wrapup and no peer: silent, but the evaluation is still logged', () => {
  const f = fixture();
  try {
    const { stdout } = run(f, f.quiet);
    assert.equal(stdout, '');
    const [row] = trialRows(f);
    assert.equal(row.project, 'quiet');
    assert.equal(row.shown, false);
    assert.equal(row.reason, 'nothing');
    assert.equal(row.wrapup_id, null);
    assert.equal(row.peers, 0, 'the roster ran and found nobody, which is not the same as not running');
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});

test('the gate off and a compaction start both leave no trace', () => {
  const f = fixture();
  try {
    assert.equal(run(f, f.alpha, { gate: '0' }).stdout, '');
    assert.equal(run(f, f.alpha, { source: 'compact' }).stdout, '');
    assert.deepEqual(trialRows(f), []);
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});

test('a repeat start with nothing new is silent; a live peer or a new wrapup re-arms it', () => {
  const f = fixture();
  try {
    // legacy has a wrapup and no peers.
    assert.match(run(f, f.legacy).note, /evt-legacy/);
    const repeat = run(f, f.legacy, { sid: 'second-session' });
    assert.equal(repeat.stdout, '', 'the same wrapup, already shown, with nobody else here');
    const rows = trialRows(f);
    assert.equal(rows.length, 2, 'every evaluation is logged, shown or not');
    assert.deepEqual(rows.map((r) => [r.shown, r.reason]), [[true, 'new_wrapup'], [false, 'repeat']]);

    // A peer re-arms it even though the wrapup was shown before.
    assert.match(run(f, f.alpha).note, /evt-alpha-new/);
    const withPeer = run(f, f.alpha, { sid: 'third-session' });
    assert.match(withPeer.note, /22222222 codex/);
    assert.equal(trialRows(f).at(-1).reason, 'peers');

    // A newer wrapup re-arms it with no peer.
    fs.appendFileSync(path.join(f.dev, 'session-milestones.jsonl'), jsonl([
      { event_id: 'evt-legacy-2', timestamp: iso(60e3), milestone: 'session_wrapup', project: 'legacy',
        description: 'Second pass.', unresolved: ['Tag the release'] },
    ]));
    const fresh = run(f, f.legacy, { sid: 'fourth-session' });
    assert.match(fresh.note, /evt-legacy-2/);
    assert.match(fresh.note, /^- Tag the release$/m);
    assert.equal(trialRows(f).at(-1).reason, 'new_wrapup');
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});

test('the note stays inside its budget and says how many threads it left out', () => {
  const f = fixture();
  try {
    const long = Array.from({ length: 9 }, (_, i) =>
      `Thread ${i + 1}: ${'investigate the retry budget interaction with the scope fix '.repeat(4)}`);
    fs.appendFileSync(path.join(f.dev, 'session-milestones.jsonl'), jsonl([
      { event_id: 'evt-alpha-long', timestamp: iso(60e3), milestone: 'session_wrapup', project: 'alpha',
        description: 'Long hand-off.', unresolved: long },
    ]));
    const { note } = run(f, f.alpha);
    assert.ok(note.length <= 800, `note is ${note.length} chars`);
    const listed = note.split('\n').filter((l) => l.startsWith('- ')).length;
    // Without this, a budget that never bites passes the assertion above.
    assert.ok(listed > 0 && listed < long.length, `listed ${listed} of ${long.length}`);
    assert.ok(note.includes(`+${long.length - listed} more. Full record: /remember --get evt-alpha-long`));
    assert.ok(note.split('\n').filter((l) => l.startsWith('- ')).every((l) => l.length <= 102));
    // The tail and the repo line survive the cut.
    assert.match(note, /Repo: branch main/);
    assert.match(note, /→ \/remember --project alpha/);
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});
