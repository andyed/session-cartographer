/**
 * tests/unit/standup-fold.test.js
 *
 * On 2026-10-27 `/standup --since 2d` printed 171 sessions over 535 lines. 137 of them
 * were Codex Desktop threads that had logged one Stop row each ("Codex turn completed
 * [0 events]"), lived a median 6 s by their UUIDv7 ids, and left no rollout on disk, so
 * nothing names a parent for them. They buried the 34 sessions that had done work, put
 * 24 one-row ids on the psychodeli-webgl-port contention line ("28 sessions"), and made
 * `short()` widen real ids to `01a17f5d-e` to tell them from a neighbour minted in the
 * same hour. SILENT listed 78 more Codex transcripts with no events, 77 of which were
 * guardian_review or spawned-agent sub-threads whose session_meta names a parent that
 * had logged hundreds of events (docs/standup-codex-threads-2026-10-27.md).
 *
 * The fold has one contract: it must be invisible to everything that was already right.
 * So the fixture is run twice, with and without its 30 short sessions, and the real
 * sessions' rows, their commit lines and the CONTENTION section must come out
 * byte-identical. A second run under --no-fold proves the fixture reproduces the defect
 * (the widened id, the padded contention line); without that, the first test passes
 * against a standup that never folds anything.
 *
 * Run with: node --test tests/unit/standup-fold.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { codexThreadMeta } from '../../scripts/standup-silence.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = path.join(ROOT, 'scripts', 'cartographer-standup.js');

const REAL_CODEX = '01a17f5d-ef58-78d0-b616-11de7041b5cb';
const REAL_CLAUDE = 'bbbbbbbb-2222-4222-8222-222222222222';
const SHORT_COMMIT = 'cccccccc-3333-4333-8333-333333333333';
const SHORT_EDIT = 'dddddddd-4444-4444-8444-444444444444';
const ORPHAN_PARENT = '01a0ffff-0000-7000-8000-000000000000';
// Not in any fixture: every fixture session is then a peer and none is dropped as "you".
const OBSERVER = 'ffffffff-0000-4000-8000-000000000000';
// Thirty UUIDv7-shaped ids. Half share REAL_CODEX's first eight characters, the way ids
// minted in the same hour do, so `short()` would widen the real id if they stayed.
const TINY = Array.from({ length: 30 }, (_, i) => {
  const n = String(i).padStart(3, '0');
  return `${i < 15 ? '01a17f5d' : '01a17fe5'}-${(0x7000 + i).toString(16)}-7${n}-8${n}-${String(i).padStart(12, '0')}`;
});

const pad = (n) => String(n).padStart(2, '0');
const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

/**
 * The fixture: two real sessions sharing a file, thirty short Codex sessions, and
 * optionally two edge sessions that are short by the count but left a commit or an edit.
 * Every timestamp is a whole number of minutes before build time, so `fmtAge` (which
 * rounds to the minute) prints the same age on two runs made within a second.
 */
function build({ edges = false } = {}) {
  const base = Date.now();
  const iso = (minutesAgo, plusMs = 0) => new Date(base - minutesAgo * 60e3 + plusMs).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const dir = tmp('standup-fold-');
  const repo = path.join(dir, 'widgetworks');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  for (const f of ['src/shared.js', 'src/codex-only.js', 'src/edge.js', 'src/x.js']) {
    fs.writeFileSync(path.join(repo, f), '// fixture\n');
  }
  const ev = (o) => ({ event_id: `evt-${Math.random().toString(36).slice(2, 10)}`, related_ids: [], salience: 0.4, ...o });

  const real = [
    ev({ timestamp: iso(50), type: 'tool_file_edit', provider: 'codex', session_id: REAL_CODEX, project: 'widgetworks', cwd: repo,
         summary: 'Modified: src/shared.js' }),
    ev({ timestamp: iso(45), type: 'git_commit', provider: 'codex', session_id: REAL_CODEX, project: 'widgetworks', cwd: repo,
         summary: '[feat] Commit 0123abcd: feat(widget): share the thing | files: src/shared.js' }),
    ev({ timestamp: iso(40), type: 'tool_file_edit', provider: 'codex', session_id: REAL_CODEX, project: 'widgetworks', cwd: repo,
         summary: 'Modified: src/codex-only.js' }),
    ev({ timestamp: iso(39), type: 'git_push', provider: 'codex', session_id: REAL_CODEX, project: 'widgetworks', cwd: repo,
         summary: 'Pushed: origin main' }),
    ev({ timestamp: iso(30), type: 'tool_file_edit', provider: 'claude', session_id: REAL_CLAUDE, project: 'widgetworks', cwd: repo,
         summary: `Modified: ${path.join(repo, 'src/shared.js')}` }),
    ev({ timestamp: iso(25), type: 'tool_bash', provider: 'claude', session_id: REAL_CLAUDE, project: 'widgetworks', cwd: repo,
         summary: 'Ran: npm test' }),
  ];
  if (edges) {
    // One commit, no span: short by the count, but a sha is something a peer can collide with.
    real.push(ev({ timestamp: iso(22), type: 'git_commit', provider: 'codex', session_id: SHORT_COMMIT, project: 'widgetworks', cwd: repo,
                   summary: '[fix] Commit cafe0001: fix(edge): one commit and gone | files: src/x.js' }));
    // One edit, no span: same.
    real.push(ev({ timestamp: iso(21), type: 'tool_file_edit', provider: 'codex', session_id: SHORT_EDIT, project: 'widgetworks', cwd: repo,
                   summary: 'Modified: src/edge.js' }));
  }

  // The short sessions: one Stop row each, every other one with a second row 20 s before
  // it (span 20 s), ages 0..29 min so 20 of them fall inside the 20-minute live window.
  // Every third is filed under widgetworks, the rest under the workspace root, so the
  // project contention line would read "12 sessions" if they stayed.
  const tiny = [];
  TINY.forEach((id, i) => {
    const project = i % 3 === 0 ? 'widgetworks' : 'dev';
    const cwd = i % 3 === 0 ? repo : dir;
    if (i % 2 === 0) {
      tiny.push(ev({ timestamp: iso(i, -20e3), type: 'milestone_turn_stop', provider: 'codex', session_id: id, project, cwd,
                     summary: 'Codex turn completed [0 events]' }));
    }
    tiny.push(ev({ timestamp: iso(i), type: 'milestone_turn_stop', provider: 'codex', session_id: id, project, cwd,
                   summary: 'Codex turn completed [0 events]' }));
  });
  const TINY_EVENTS = tiny.length;   // 45

  // Two corpora whose rows name the same absolute repo path, so the real rows are
  // identical byte for byte; the repo need not live under either CARTOGRAPHER_DEV_DIR.
  const write = (name, rows) => {
    const d = path.join(dir, name);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'changelog.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    return d;
  };
  return { dir, repo, TINY_EVENTS, withTiny: write('with', [...real, ...tiny]), withoutTiny: write('without', real) };
}

function run(dev, args, { self = OBSERVER, codexHome } = {}) {
  const empty = tmp('standup-fold-empty-');
  const res = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf-8',
    cwd: dev,
    env: { ...process.env, CARTOGRAPHER_DEV_DIR: dev, CARTOGRAPHER_SESSION_ID: self,
           CLAUDE_SESSION_ID: '', CLAUDE_CODE_SESSION_ID: '', CODEX_SESSION_ID: '',
           CODEX_HOME: codexHome || path.join(empty, 'codex'), CLAUDE_CONFIG_DIR: path.join(empty, 'claude') },
  });
  assert.equal(res.status, 0, `exit ${res.status}: ${res.stderr}`);
  return res.stdout;
}

const rows = (out) => out.split('\n').filter((l) => /^[●○] /.test(l));
/** A roster row and its indented lines, up to the blank line that ends it. */
function block(out, label) {
  const lines = out.split('\n');
  const start = lines.findIndex((l) => l.startsWith(`● ${label} `) || l.startsWith(`○ ${label} `));
  assert.ok(start >= 0, `no roster row labelled ${label} in:\n${out}`);
  const end = lines.indexOf('', start);
  return lines.slice(start, end < 0 ? undefined : end).join('\n');
}
/** From a section heading to the blank line that ends the section. */
function section(out, heading) {
  const lines = out.split('\n');
  const start = lines.findIndex((l) => l.startsWith(heading));
  assert.ok(start >= 0, `no ${heading} section in:\n${out}`);
  const end = lines.indexOf('', start);
  return lines.slice(start, end < 0 ? undefined : end).join('\n');
}
const stripVolatile = (sessions) => sessions.map(({ idle_ms, ...rest }) => rest);

test('thirty one-row Codex sessions fold into one line and leave the real rows byte-identical', () => {
  const { withTiny, withoutTiny, TINY_EVENTS } = build();
  assert.equal(TINY_EVENTS, 45);
  const folded = run(withTiny, ['--since', '6h']);
  const plain = run(withoutTiny, ['--since', '6h']);

  // Two real rows plus the fold line; the real ids are not widened by folded neighbours.
  assert.equal(rows(folded).length, 3, folded);
  assert.equal(rows(plain).length, 2, plain);
  assert.match(folded, /^STANDUP — last 6h {3}2 sessions \+ 30 short \(folded\)$/m);
  assert.match(folded, /^● 30 short codex sessions \(45 events\) — folded$/m);
  assert.match(folded, /^ {4}each <3 events in <2m, nothing edited or committed · 20 live · newest 0m ago · --no-fold lists them$/m);
  for (const id of TINY) assert.ok(!folded.includes(id.slice(0, 13)), `${id} must not surface in the folded roster`);

  // The contract: the fold is invisible to the real rows, their commits, and CONTENTION.
  for (const id of [REAL_CODEX, REAL_CLAUDE]) {
    assert.equal(block(folded, id.slice(0, 8)), block(plain, id.slice(0, 8)));
  }
  assert.match(block(folded, '01a17f5d'), /^ {4}0123abcd {2}feat\(widget\): share the thing$/m);
  assert.equal(section(folded, 'CONTENTION'), section(plain, 'CONTENTION'));
  // Roster order: most recently active first.
  assert.match(folded, /^ {2}widgetworks — 2 sessions: bbbbbbbb, 01a17f5d$/m);
  // The key is the realpath: absolute under a symlinked temp dir (macOS), relative
  // elsewhere, and with the platform's separator (Windows prints src\shared.js).
  assert.match(folded, /^ {4}(.*[\\/])?src[\\/]shared\.js$/m);
  assert.match(folded, /^ {6}bbbbbbbb · 01a17f5d {3}last touched 30m ago$/m);
});

test('the fixture reproduces the defect: without the fold the real id widens and contention pads', () => {
  const { withTiny } = build();
  const out = run(withTiny, ['--since', '6h', '--no-fold']);
  assert.ok(rows(out).length >= 32, `every short session must be a roster row under --no-fold (got ${rows(out).length})`);
  assert.match(out, /^[●○] 01a17f5d-e /m, 'a short session sharing eight characters must force the widened id');
  assert.match(out, /^ {2}widgetworks — 12 sessions: /m, 'ten one-row sessions must pad the project line');
  assert.doesNotMatch(out, /short codex sessions/);
});

test('--json moves the short sessions out of sessions[] and contention, and says why', () => {
  const { withTiny, withoutTiny } = build();
  const folded = JSON.parse(run(withTiny, ['--since', '6h', '--json']));
  const plain = JSON.parse(run(withoutTiny, ['--since', '6h', '--json']));
  assert.deepEqual(new Set(folded.sessions.map((s) => s.id)), new Set([REAL_CODEX, REAL_CLAUDE]));
  assert.deepEqual(stripVolatile(folded.sessions), stripVolatile(plain.sessions));
  assert.deepEqual(folded.contention, plain.contention);
  assert.equal(folded.contention.files.length, 1);
  assert.deepEqual(folded.contention.projects, [{ project: 'widgetworks', sessions: [REAL_CLAUDE, REAL_CODEX] }]);

  const s = folded.short_sessions;
  assert.equal(s.count, 30);
  assert.equal(s.events, 45);
  assert.equal(s.live, 20);
  assert.deepEqual(s.by_provider, { codex: 30 });
  assert.deepEqual(s.rule, { max_events_exclusive: 3, max_span_ms: 120000, edits: 0, commits: 0, pushes: 0 });
  assert.deepEqual(new Set(s.sessions.map((x) => x.id)), new Set(TINY));
  assert.ok(s.sessions.every((x) => x.events <= 2 && x.types.milestone_turn_stop === x.events));
  assert.equal(plain.short_sessions.count, 0);
  assert.equal(JSON.parse(run(withTiny, ['--since', '6h', '--json', '--no-fold'])).sessions.length, 32);
});

test('a session short by the count that committed or edited is a peer, not a short session', () => {
  const { withTiny } = build({ edges: true });
  const out = run(withTiny, ['--since', '6h']);
  assert.equal(rows(out).length, 5, out);   // 2 real + 2 edges + the fold line
  assert.match(block(out, 'cccccccc'), /^ {4}cafe0001 {2}fix\(edge\): one commit and gone$/m);
  assert.match(block(out, 'dddddddd'), /1 events$/m);
  assert.match(out, /^● 30 short codex sessions \(45 events\) — folded$/m);
  const data = JSON.parse(run(withTiny, ['--since', '6h', '--json']));
  assert.equal(data.short_sessions.count, 30);
  assert.ok(data.contention.projects[0].sessions.includes(SHORT_COMMIT));
});

test('your own session is never folded, however short', () => {
  const { withTiny } = build();
  const out = run(withTiny, ['--since', '6h', '--all'], { self: TINY[0] });
  // `short()` stops at the first character that tells it from the real 01a17f5d-e.
  assert.match(out, /^you are 01a17f5d-7 · widgetworks$/m);
  assert.match(out, /^● 01a17f5d-7 \(you\) {2}codex {2}widgetworks$/m);
  assert.match(out, /^[●○] 29 short codex sessions \(43 events\) — folded$/m);
});

test('a window holding only short sessions is not reported as empty', () => {
  const { withTiny } = build();
  // Real events are 25+ minutes old; the twenty newest short sessions are inside 20m.
  const out = run(withTiny, ['--since', '20m']);
  assert.equal(rows(out).length, 1, out);
  assert.match(out, /^● 20 short codex sessions \(30 events\) — folded$/m);
  assert.doesNotMatch(out, /No other logged sessions/);
  assert.match(out, /^CONTENTION — none\./m);
});

// ---- SILENT: sub-threads under their parent --------------------------------

/** A rollout under today's local-date directory, as Codex files them. */
function writeRollout(home, id, firstLine, minutesAgo) {
  const d = new Date();
  const dir = path.join(home, 'sessions', String(d.getFullYear()), pad(d.getMonth() + 1), pad(d.getDate()));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-2026-10-27T08-56-38-${id}.jsonl`);
  fs.writeFileSync(file, `${firstLine}\n{"type":"event_msg","payload":{"type":"thread_settings_applied"}}\n`);
  const t = new Date(Date.now() - minutesAgo * 60e3);
  fs.utimesSync(file, t, t);
  return file;
}
const meta = (payload) => JSON.stringify({ timestamp: '2026-10-27T15:56:38.953Z', type: 'session_meta', payload: { originator: 'Codex Desktop', cwd: '/w', base_instructions: { text: 'x'.repeat(2000) }, ...payload } });
const guardian = (id, parent) => meta({ id, session_id: parent, parent_thread_id: parent, source: { subagent: { other: 'guardian' } }, thread_source: 'guardian_review' });
const spawned = (id, parent) => meta({ id, session_id: parent, parent_thread_id: parent, source: { subagent: { thread_spawn: { parent_thread_id: parent, depth: 1, agent_path: '/root/play_stranger', agent_nickname: 'Ramanujan' } } }, thread_source: 'subagent' });
const userThread = (id) => meta({ id, session_id: id, source: 'vscode', thread_source: 'user' });
const sid = (n) => `01a18${String(n).padStart(3, '0')}-aaaa-7aaa-8aaa-${String(n).padStart(12, '0')}`;

test('SILENT counts sub-threads under their parent and lists only the three newest threads of their own', () => {
  const { withTiny } = build();
  const home = tmp('standup-fold-codex-');
  // Five guardian reviews of the logged Codex session, one spawned agent of a parent that
  // logged nothing, and six threads of their own: two user threads, three rollouts whose
  // first line is not a session_meta record, and one whose parent is the sentinel "unknown".
  for (let i = 0; i < 5; i++) writeRollout(home, sid(i), guardian(sid(i), REAL_CODEX), 1 + i);
  writeRollout(home, sid(5), spawned(sid(5), ORPHAN_PARENT), 6);
  const standalone = [];
  for (let i = 6; i < 12; i++) {
    const line = i < 8 ? userThread(sid(i)) : i < 11 ? '{"cmd":"apply_patch src/app.js"}' : meta({ id: sid(i), parent_thread_id: 'unknown', thread_source: 'user' });
    writeRollout(home, sid(i), line, 10 + i);      // newest first: sid(6), sid(7), sid(8)…
    standalone.push(sid(i));
  }

  const out = run(withTiny, ['--since', '6h'], { codexHome: home });
  const silent = section(out, 'SILENT');
  const listed = [...silent.matchAll(/^ {2}codex {2}([0-9a-f]{8}) {2}transcript written .* · 0 events logged$/gm)].map((m) => m[1]);
  assert.deepEqual(listed, standalone.slice(0, 3).map((id) => id.slice(0, 8)), silent);
  assert.match(silent, /^ {2}… 3 more Codex sessions with no events \(6 in all, 3 newest shown\)$/m);
  assert.match(silent, /^ {2}6 Codex Desktop sub-threads \(guardian_review 5, subagent 1\) of 2 parent sessions: 01a17f5d ×5, 01a0ffff ×1 \(not logged\)$/m);
  assert.match(silent, /^ {4}sub-threads logged no events of their own; 1 parent logged nothing in the window$/m);
  for (let i = 0; i < 6; i++) assert.ok(!silent.includes(sid(i).slice(0, 8)), `sub-thread ${sid(i)} must not be listed as a session`);

  const data = JSON.parse(run(withTiny, ['--since', '6h', '--json'], { codexHome: home }));
  assert.equal(data.silent.codex_sessions_without_events.length, 12, 'the full list stays machine-readable');
  assert.equal(data.silent.codex_subthreads.count, 6);
  assert.deepEqual(data.silent.codex_subthreads.by_source, { guardian_review: 5, subagent: 1 });
  assert.deepEqual(data.silent.codex_subthreads.parents, [
    { id: REAL_CODEX, children: 5, logged: true },
    { id: ORPHAN_PARENT, children: 1, logged: false },
  ]);
  const byId = new Map(data.silent.codex_sessions_without_events.map((r) => [r.id, r]));
  assert.equal(byId.get(sid(0)).parent, REAL_CODEX);
  assert.equal(byId.get(sid(0)).thread_source, 'guardian_review');
  assert.equal(byId.get(sid(5)).subagent, 'thread_spawn');
  assert.equal(byId.get(sid(11)).parent, null, 'a sentinel parent is no parent');
  assert.equal(byId.get(sid(9)).parent, null);
});

test('codexThreadMeta reads the parent from either place, and refuses what it cannot read', () => {
  const dir = tmp('thread-meta-');
  const w = (name, body) => { const p = path.join(dir, name); fs.writeFileSync(p, body); return p; };
  assert.deepEqual(codexThreadMeta(w('g.jsonl', guardian('child', 'parent') + '\n')), {
    id: 'child', parent: 'parent', threadSource: 'guardian_review', subagent: 'guardian', originator: 'Codex Desktop', cwd: '/w',
  });
  // thread_spawn carries the parent inside source as well; take it from there when the top-level field is absent.
  const spawnOnly = meta({ id: 'child', source: { subagent: { thread_spawn: { parent_thread_id: 'parent' } } }, thread_source: 'subagent' });
  assert.equal(codexThreadMeta(w('s.jsonl', spawnOnly + '\n')).parent, 'parent');
  assert.equal(codexThreadMeta(w('s.jsonl', spawnOnly + '\n')).subagent, 'thread_spawn');
  const user = codexThreadMeta(w('u.jsonl', userThread('me') + '\n'));
  assert.equal(user.parent, null);
  assert.equal(user.subagent, null);
  assert.equal(codexThreadMeta(w('cmd.jsonl', '{"cmd":"x"}\n{"cmd":"y"}\n')), null, 'not a session_meta record');
  assert.equal(codexThreadMeta(w('torn.jsonl', '{"type":"session_meta"')), null, 'unparseable');
  assert.equal(codexThreadMeta(w('big.jsonl', guardian('child', 'parent') + '\n'), { maxBytes: 64 }), null, 'a first line that does not fit is unknown, not standalone');
  assert.equal(codexThreadMeta(path.join(dir, 'missing.jsonl')), null);
});
