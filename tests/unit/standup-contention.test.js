/**
 * tests/unit/standup-contention.test.js
 *
 * `/standup` exists for one line of its output — CONTENTION — and every way it
 * can fail is silent. A parser that finds nothing prints "no shared project or
 * file across these sessions," which is also what a quiet workspace prints, so
 * the tool cannot be trusted unless a fixture proves it trips.
 *
 * The first draft of cartographer-standup.js matched edit summaries with a bare
 * /^Modified:\s+(\S+)/ instead of edit-paths.js. That turned the hook's
 * bash-mediated form — `Modified: a.js,b.js (via bash)` — into one fabricated
 * filename, so a file edited by one session through Bash and another through
 * Edit never collided. Against the live corpus it reported 3 contested files
 * where the shared parser finds 6. It did not error, and the missing half was
 * invisible.
 *
 * The fixture below mixes both edit shapes, a workspace-root session that must
 * NOT register as contention, a `git commit -q` blank subject, and a session
 * with no overlap at all. Each assertion fails against that draft.
 *
 * Run with: node --test tests/unit/standup-contention.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = path.join(ROOT, 'scripts', 'cartographer-standup.js');

const ALPHA = 'aaaaaaaa-1111-4111-8111-111111111111';
const BETA = 'bbbbbbbb-2222-4222-8222-222222222222';
const SOLO = 'cccccccc-3333-4333-8333-333333333333';
const ROOTED = 'dddddddd-4444-4444-8444-444444444444';
const WT_MAIN = 'eeeeeeee-5555-4555-8555-555555555555';
const WT_TREE = 'ffffffff-6666-4666-8666-666666666666';

function iso(minutesAgo) {
  return new Date(Date.now() - minutesAgo * 60e3).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function build() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'standup-'));
  const repo = path.join(dir, 'widgetworks');
  const other = path.join(dir, 'lonely');
  const worktree = path.join(repo, '.claude', 'worktrees', 'brave-thompson-40e495');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.mkdirSync(path.join(worktree, 'src'), { recursive: true });
  fs.mkdirSync(other, { recursive: true });
  fs.writeFileSync(path.join(worktree, 'src/worktree-file.js'), '// fixture\n');

  // The resolver only accepts paths that exist, so the fixture must too.
  for (const f of ['src/shared.js', 'src/also-shared.js', 'src/alpha-only.js',
                   'src/root-shared.js', 'src/worktree-file.js']) {
    fs.writeFileSync(path.join(repo, f), '// fixture\n');
  }
  fs.writeFileSync(path.join(other, 'solo.js'), '// fixture\n');

  const ev = (o) => JSON.stringify({
    event_id: `evt-${Math.random().toString(36).slice(2, 10)}`,
    provider: 'claude', related_ids: [], salience: 0.4, ...o,
  });

  const rows = [
    // ALPHA edits two files in one bash-mediated summary — the shape a naive
    // /^Modified:\s+(\S+)/ collapses into a single fabricated filename.
    ev({ timestamp: iso(90), type: 'tool_file_edit', session_id: ALPHA, project: 'widgetworks', cwd: repo,
         summary: 'Modified: src/shared.js,src/also-shared.js (via bash)' }),
    ev({ timestamp: iso(85), type: 'tool_file_edit', session_id: ALPHA, project: 'widgetworks', cwd: repo,
         summary: `Modified: ${path.join(repo, 'src/alpha-only.js')}` }),
    // git commit -q blanks the subject the hook scrapes; the sha survives.
    ev({ timestamp: iso(80), type: 'git_commit', session_id: ALPHA, project: 'widgetworks', cwd: repo,
         summary: '[other] Commit deadbee1:  | files: src/shared.js' }),

    // BETA reaches the same files through the single-file Edit shape, and via
    // an absolute path, so only absolute-path keying makes them one entry.
    ev({ timestamp: iso(40), type: 'tool_file_edit', session_id: BETA, project: 'widgetworks', cwd: repo,
         summary: `Modified: ${path.join(repo, 'src/shared.js')}` }),
    ev({ timestamp: iso(35), type: 'tool_file_edit', session_id: BETA, project: 'widgetworks', cwd: repo,
         summary: 'Modified: src/also-shared.js' }),

    // No overlap with anyone. Must appear in the roster, never in contention.
    ev({ timestamp: iso(20), type: 'tool_file_edit', session_id: SOLO, project: 'lonely', cwd: other,
         summary: 'Modified: solo.js' }),

    // Two sessions "sharing" the workspace root is the filesystem, not a
    // collision — non-projects.js owns that judgement.
    ev({ timestamp: iso(15), type: 'tool_bash', session_id: ROOTED, project: 'dev', cwd: dir, summary: 'Ran: ls' }),
    ev({ timestamp: iso(10), type: 'tool_bash', session_id: SOLO, project: 'dev', cwd: dir, summary: 'Ran: ls' }),

    // Two sessions on the same file while filed under the workspace root. The
    // file's identity is its path; the project label is scaffolding and must
    // not suppress the collision.
    ev({ timestamp: iso(9), type: 'tool_file_edit', session_id: ROOTED, project: 'dev', cwd: repo,
         summary: 'Modified: src/root-shared.js' }),
    ev({ timestamp: iso(8), type: 'tool_file_edit', session_id: SOLO, project: 'dev', cwd: repo,
         summary: 'Modified: src/root-shared.js' }),

    // Same repo file, one from the main checkout and one from a worktree —
    // two absolute paths, one file. Agent control rooms make this the default.
    ev({ timestamp: iso(7), type: 'tool_file_edit', session_id: WT_MAIN, project: 'widgetworks', cwd: repo,
         summary: 'Modified: src/worktree-file.js' }),
    ev({ timestamp: iso(6), type: 'tool_file_edit', session_id: WT_TREE, project: 'widgetworks', cwd: worktree,
         summary: 'Modified: src/worktree-file.js' }),

    // Sentinels. "unknown" is truthy and equal to itself; grouping on it fuses
    // every unattributed event — across providers — into one phantom session.
    ev({ timestamp: iso(5), type: 'tool_file_edit', session_id: 'unknown', project: 'widgetworks', cwd: repo,
         summary: 'Modified: src/root-shared.js' }),
    ev({ timestamp: iso(4), provider: 'codex', type: 'tool_file_edit', session_id: '', project: 'widgetworks', cwd: repo,
         summary: 'Modified: src/root-shared.js' }),

    // A path the hook emitted that resolves to nothing: a non-path, or a real
    // file since deleted. Must be reported, never silently dropped.
    ev({ timestamp: iso(3), type: 'tool_file_edit', session_id: SOLO, project: 'widgetworks', cwd: repo,
         summary: 'Modified: src/since-deleted.js' }),
  ];

  fs.writeFileSync(path.join(dir, 'changelog.jsonl'), rows.join('\n') + '\n');
  return { dir, repo };
}

function run(dir, args) {
  const res = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf-8',
    env: { ...process.env, CARTOGRAPHER_DEV_DIR: dir, CARTOGRAPHER_SESSION_ID: ALPHA,
           CLAUDE_SESSION_ID: '', CLAUDE_CODE_SESSION_ID: '', CODEX_SESSION_ID: '' },
  });
  assert.equal(res.status, 0, `exit ${res.status}: ${res.stderr}`);
  return res.stdout;
}

test('bash-mediated multi-file edits collide with single-file edits', () => {
  const { dir } = build();
  const data = JSON.parse(run(dir, ['--since', '6h', '--json']));
  const contested = data.contention.files.map((f) => path.basename(f.path)).sort();

  // The defect this test exists for: a naive parser finds neither of these,
  // because it never split the comma form into two paths.
  for (const name of ['also-shared.js', 'shared.js']) {
    const hit = data.contention.files.find((f) => path.basename(f.path) === name);
    assert.ok(hit, `${name} must be contested`);
    assert.deepEqual([...hit.sessions].sort(), [ALPHA, BETA].sort());
  }
  assert.ok(contested.includes('also-shared.js') && contested.includes('shared.js'));
});

test('a file only one session touched is not contention', () => {
  const { dir } = build();
  const data = JSON.parse(run(dir, ['--since', '6h', '--json']));
  const names = data.contention.files.map((f) => path.basename(f.path));
  assert.ok(!names.includes('alpha-only.js'), 'only ALPHA edited alpha-only.js');
  assert.ok(!names.includes('solo.js'), 'only SOLO edited solo.js');
});

test('the workspace root is not a contested project', () => {
  const { dir } = build();
  const data = JSON.parse(run(dir, ['--since', '6h', '--json']));
  const projects = data.contention.projects.map((p) => p.project);
  assert.deepEqual(projects, ['widgetworks'], 'dev is filesystem scaffolding, not a shared project');
});

test('every session in the window reaches the roster', () => {
  const { dir } = build();
  const data = JSON.parse(run(dir, ['--since', '6h', '--json']));
  assert.deepEqual(data.sessions.map((s) => s.id).sort(), [ALPHA, BETA, SOLO, ROOTED, WT_MAIN, WT_TREE].sort());
  assert.equal(data.sessions.find((s) => s.id === ALPHA).is_self, true);
});

test('--commit attributes a sha to its session even with a blank subject', () => {
  const { dir } = build();
  const out = run(dir, ['--commit', 'deadbee1', '--since', '6h']);
  assert.match(out, /deadbee1/);
  assert.match(out, new RegExp(ALPHA));
  assert.match(out, /src\/shared\.js/);
});

test('a window with one session reports no contention rather than failing open', () => {
  const { dir } = build();
  // Narrow enough that only SOLO's last edit is in frame.
  const out = run(dir, ['--since', '4m']);
  assert.match(out, /CONTENTION — none/);
});

test('a sentinel session id is counted, never grouped as a session', () => {
  const { dir } = build();
  const data = JSON.parse(run(dir, ['--since', '6h', '--json']));
  const ids = data.sessions.map((s) => s.id);
  assert.ok(!ids.includes('unknown'), 'the "unknown" sentinel must not key the roster');
  assert.ok(!ids.includes(''), 'the empty sentinel must not key the roster');
  // Counted, not dropped: a silent discard and a clean corpus look identical.
  assert.equal(data.unattributed_events, 2);
  const out = run(dir, ['--since', '6h']);
  assert.match(out, /2 events carry no resolvable session id/);
});

test('the workspace-root project label does not suppress a file collision', () => {
  const { dir } = build();
  const data = JSON.parse(run(dir, ['--since', '6h', '--json']));
  const hit = data.contention.files.find((f) => path.basename(f.path) === 'root-shared.js');
  assert.ok(hit, 'two sessions edited root-shared.js while filed under "dev"');
  assert.deepEqual([...hit.sessions].sort(), [ROOTED, SOLO].sort());
});

test('a worktree edit collides with the main checkout of the same file', () => {
  const { dir } = build();
  const data = JSON.parse(run(dir, ['--since', '6h', '--json']));
  const hit = data.contention.files.find((f) => f.sessions.includes(WT_TREE));
  assert.ok(hit, 'the worktree and main-checkout edits are one file');
  assert.deepEqual([...hit.sessions].sort(), [WT_MAIN, WT_TREE].sort());
  assert.equal(hit.worktree_split, true);
  assert.equal(hit.paths.length, 2, 'both real paths are preserved for display');
  assert.match(run(dir, ['--since', '6h']), /separate worktrees/);
});

test('an edit candidate that resolves to nothing is reported, not dropped', () => {
  const { dir } = build();
  const data = JSON.parse(run(dir, ['--since', '6h', '--json']));
  assert.ok(data.edits_unresolved >= 1, 'src/since-deleted.js resolves to no file');
  assert.match(run(dir, ['--since', '6h']), /did not resolve to a file on disk/);
});

test('--project scopes contention, not only the roster', () => {
  const { dir } = build();
  const data = JSON.parse(run(dir, ['--since', '6h', '--project', 'lonely', '--json']));
  assert.deepEqual(data.contention.projects.map((p) => p.project), []);
  for (const f of data.contention.files) {
    assert.ok(!f.path.includes('widgetworks'), `widgetworks file leaked into a lonely-scoped run: ${f.path}`);
  }
});
