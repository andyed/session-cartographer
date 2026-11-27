/**
 * tests/unit/mailbox.test.js
 *
 * Cross-agent notes (scripts/mailbox.js, hooks/deliver-notes-on-prompt.sh).
 * The failures that matter are quiet ones: a note delivered twice, a note
 * delivered to the wrong session, a note that arrives without saying who sent
 * it, a delivery hook that costs every prompt a node start, and a manifest
 * change that moves an existing Codex hook and so drops its trust. Each test
 * drives the real module or the real hook against a throwaway corpus.
 *
 * Run with: node --test tests/unit/mailbox.test.js
 */
process.env.CARTOGRAPHER_SEMANTIC = '0';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  DELIVER_MAX_NOTES, NOTE_MAX_CHARS, mailboxRoot, pendingCounts, pendingNotes, renderDelivery,
  safeSessionId, sendNote, takeNotes,
} from '../../scripts/mailbox.js';

import { OFFLINE_INDEX_ENV } from './helpers/offline-index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PLUGIN = path.join(ROOT, 'plugins', 'session-cartographer');
const HOOK = path.join(PLUGIN, 'hooks', 'deliver-notes-on-prompt.sh');
const BRIDGE = path.join(PLUGIN, 'hooks', 'antigravity-hook-bridge.cjs');
const MAILBOX_CLI = path.join(ROOT, 'scripts', 'mailbox.js');

const IDENTITY_VARS = [
  'CARTOGRAPHER_SESSION_ID', 'CLAUDE_SESSION_ID', 'CLAUDE_CODE_SESSION_ID', 'CODEX_SESSION_ID',
  'ANTIGRAVITY_CONVERSATION_ID', 'ANTIGRAVITY_AGENT', 'CARTOGRAPHER_PROVIDER', 'CODEX_THREAD_ID',
  'HERMES_SESSION_ID', 'CARTOGRAPHER_HOOK_ACTIVE',
];

const CLAUDE = 'aaaaaaaa-1111-4111-8111-111111111111';
const CODEX = 'bbbbbbbb-2222-7222-8222-222222222222';
const AGY = 'cccccccc-3333-4333-8333-333333333333';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-mailbox-'));
  const dev = path.join(root, 'dev');
  fs.mkdirSync(dev);
  return { root, dev, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function env(fx, overrides = {}) {
  const out = { ...process.env };
  for (const key of IDENTITY_VARS) delete out[key];
  return { ...out, CARTOGRAPHER_DEV_DIR: fx.dev, TMPDIR_BASE: fx.root, ...overrides };
}

const events = (fx) => {
  const file = path.join(fx.dev, 'changelog.jsonl');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
};

const send = (fx, to, from, text, now) => sendNote({ dev: fx.dev, to, from, text, now, index: false });

function runHook(fx, payload, overrides = {}) {
  return spawnSync('bash', [HOOK], { input: JSON.stringify(payload), env: env(fx, overrides), encoding: 'utf8' });
}

const contextOf = (stdout) => (stdout.trim() ? JSON.parse(stdout).hookSpecificOutput.additionalContext : '');

// ─── Module ───

test('a note is delivered once, to its recipient only, and names its sender', () => {
  const fx = fixture();
  try {
    send(fx, { id: CLAUDE, provider: 'claude', project: 'mavericks' },
      { id: CODEX, provider: 'codex', project: 'lavites' }, 'Editing src/camera.js now.\nHold the merge.');

    assert.deepEqual(takeNotes({ dev: fx.dev, sessions: [AGY], index: false }).notes, [], 'another session gets nothing');
    const first = takeNotes({ dev: fx.dev, sessions: [CLAUDE], provider: 'claude', index: false });
    assert.equal(first.notes.length, 1);
    assert.equal(takeNotes({ dev: fx.dev, sessions: [CLAUDE], index: false }).notes.length, 0, 'never twice');

    const text = renderDelivery(first.notes);
    assert.match(text, new RegExp(`From codex session ${CODEX}, working in lavites`));
    assert.match(text, /^> Editing src\/camera\.js now\.$/m);
    assert.match(text, /^> Hold the merge\.$/m, 'each line of the note is quoted');
    assert.match(text, /not from the user/);
    assert.match(text, /`tell` tool with the sender's session id/);
    assert.equal(fs.readdirSync(path.join(mailboxRoot(fx.dev), CLAUDE, 'delivered')).length, 1);
  } finally {
    fx.cleanup();
  }
});

test('a note from a session with no id says it cannot be answered', () => {
  const text = renderDelivery([{ note_id: 'n', sent_at: new Date().toISOString(), text: 'hi',
    from: { session_id: '', provider: 'codex' } }]);
  assert.match(text, /an unidentified codex session \(no reply address\)/);
});

test('two deliveries racing over the same notes hand each note out once', () => {
  const fx = fixture();
  try {
    for (let i = 0; i < 4; i += 1) send(fx, { id: CLAUDE, provider: 'claude' }, { id: CODEX, provider: 'codex' }, `n${i}`, Date.now() + i);
    // Both callers list the same four before either claims: the rename is the lock.
    const listed = pendingNotes({ dev: fx.dev, session: CLAUDE });
    assert.equal(listed.length, 4);
    const a = takeNotes({ dev: fx.dev, sessions: [CLAUDE], index: false });
    const b = takeNotes({ dev: fx.dev, sessions: [CLAUDE], index: false });
    assert.equal(a.notes.length + b.notes.length, 4);
    assert.deepEqual(a.notes.map((n) => n.text), ['n0', 'n1', 'n2', 'n3'], 'oldest first');
  } finally {
    fx.cleanup();
  }
});

test('a burst of notes is capped per prompt and the rest wait for the next one', () => {
  const fx = fixture();
  try {
    const total = DELIVER_MAX_NOTES + 2;
    for (let i = 0; i < total; i += 1) send(fx, { id: CLAUDE, provider: 'claude' }, { id: CODEX, provider: 'codex' }, `n${i}`, Date.now() + i);
    const first = takeNotes({ dev: fx.dev, sessions: [CLAUDE], index: false });
    assert.equal(first.notes.length, DELIVER_MAX_NOTES);
    assert.equal(first.remaining, 2);
    assert.match(renderDelivery(first.notes, { remaining: first.remaining }), /2 more waiting/);
    assert.deepEqual(pendingCounts({ dev: fx.dev }), { [CLAUDE]: 2 });
    assert.equal(takeNotes({ dev: fx.dev, sessions: [CLAUDE], index: false }).notes.length, 2);
    assert.deepEqual(pendingCounts({ dev: fx.dev }), {});
  } finally {
    fx.cleanup();
  }
});

test('sending refuses bad ids, empty or oversized notes, and notes to yourself', () => {
  const fx = fixture();
  try {
    for (const bad of ['', 'unknown', '../etc', 'a/b', 'x', '..aaaa', '-rf-aaaa']) {
      assert.equal(safeSessionId(bad), '', `${JSON.stringify(bad)} must not become a directory name`);
      assert.throws(() => send(fx, { id: bad, provider: 'claude' }, {}, 'hi'), /recipient session id/);
    }
    assert.throws(() => send(fx, { id: CLAUDE }, {}, '   '), /empty/);
    assert.throws(() => send(fx, { id: CLAUDE }, {}, 'x'.repeat(NOTE_MAX_CHARS + 1)), /limit/);
    assert.throws(() => send(fx, { id: CLAUDE }, { id: CLAUDE }, 'hi'), /itself/);
    assert.equal(fs.existsSync(mailboxRoot(fx.dev)), false, 'a refused note writes nothing');
    assert.equal(events(fx).length, 0, 'and logs nothing');
  } finally {
    fx.cleanup();
  }
});

test('each send and each delivery is one searchable changelog event, and notes are private files', () => {
  const fx = fixture();
  try {
    const { file } = send(fx, { id: AGY, provider: 'antigravity', project: 'dev' },
      { id: CLAUDE, provider: 'claude', project: 'mavericks' }, 'Rincon push landed; rebase before merging.');
    if (process.platform !== 'win32') { // Windows has no POSIX mode bits to check
      assert.equal(fs.statSync(file).mode & 0o777, 0o600);
      assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
    }
    takeNotes({ dev: fx.dev, sessions: [AGY], provider: 'antigravity', index: false });

    const rows = events(fx);
    assert.deepEqual(rows.map((r) => [r.type, r.provider, r.session_id]), [
      ['milestone_note_sent', 'claude', CLAUDE],
      ['milestone_note_delivered', 'antigravity', AGY],
    ]);
    for (const row of rows) {
      assert.match(row.event_id, /^evt-[a-z0-9]{12}$/);
      assert.ok(Date.parse(row.timestamp));
      assert.match(row.summary, /Rincon push landed/, 'the summary carries the note, so recall can find it');
      assert.doesNotMatch(row.summary, /[\n\t]/);
    }
    assert.equal(rows[0].note_id, rows[1].note_id);
  } finally {
    fx.cleanup();
  }
});

// ─── The hook ───

const NO_BASH = process.platform === 'win32' && 'the hook is bash, run here only through Git Bash';

test('the hook delivers to Claude, Codex and Antigravity recipients, once each', { skip: NO_BASH }, () => {
  const fx = fixture();
  try {
    const from = { id: 'dddddddd-4444-4444-8444-444444444444', provider: 'claude', project: 'dev' };
    send(fx, { id: CLAUDE, provider: 'claude' }, from, 'to claude');
    send(fx, { id: CODEX, provider: 'codex' }, from, 'to codex');
    send(fx, { id: AGY, provider: 'antigravity' }, from, 'to antigravity');

    const claude = { session_id: CLAUDE, prompt: 'hi', hook_event_name: 'UserPromptSubmit',
      transcript_path: `/Users/x/.claude/projects/p/${CLAUDE}.jsonl` };
    const out = runHook(fx, claude);
    assert.equal(out.status, 0);
    assert.equal(JSON.parse(out.stdout).hookSpecificOutput.hookEventName, 'UserPromptSubmit');
    assert.match(contextOf(out.stdout), /^> to claude$/m);
    assert.doesNotMatch(contextOf(out.stdout), /to codex|to antigravity/);
    assert.equal(runHook(fx, claude).stdout, '', 'the next prompt gets nothing');

    // Codex's payload carries turn_id and model; its env carries CODEX_SESSION_ID.
    const codex = runHook(fx, { session_id: CODEX, prompt: 'hi', turn_id: 't1', model: 'gpt' }, { CODEX_SESSION_ID: CODEX });
    assert.match(contextOf(codex.stdout), /^> to codex$/m);

    // Antigravity: through the bridge, mid-turn (invocationNum 3), as injectSteps.
    const agy = spawnSync(process.execPath, [BRIDGE, 'deliver-notes-on-prompt.sh', '3000'], {
      input: JSON.stringify({ hookEventName: 'PreInvocation', conversationId: AGY, lastUserInput: 'go', invocationNum: 3,
        transcriptPath: `/Users/x/.gemini/antigravity/brain/${AGY}/.system_generated/logs/transcript.jsonl` }),
      env: env(fx), encoding: 'utf8',
    });
    assert.equal(agy.status, 0, agy.stderr);
    const step = JSON.parse(agy.stdout).injectSteps?.[0]?.systemMessage?.systemMessage;
    assert.match(step || '', /^> to antigravity$/m);

    const delivered = events(fx).filter((r) => r.type === 'milestone_note_delivered');
    assert.deepEqual(delivered.map((r) => [r.session_id, r.provider]),
      [[CLAUDE, 'claude'], [CODEX, 'codex'], [AGY, 'antigravity']], 'each delivery names the recipient\'s own provider');
  } finally {
    fx.cleanup();
  }
});

test('with nothing pending the hook prints nothing and never starts node', { skip: NO_BASH }, () => {
  const fx = fixture();
  try {
    // node on PATH is a stand-in that records being started; jq is the real one,
    // so the hook gets as far as learning who is asking.
    const marker = path.join(fx.root, 'node-ran');
    const bin = path.join(fx.root, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'node'), `#!/bin/sh\necho node >> '${marker}'\n`, { mode: 0o755 });
    const jq = spawnSync('sh', ['-c', 'command -v jq'], { encoding: 'utf8' }).stdout.trim();
    assert.ok(jq, 'jq is required by the hooks');
    fs.symlinkSync(jq, path.join(bin, 'jq'));
    const quiet = { PATH: `${bin}:/usr/bin:/bin` };
    assert.equal(runHook(fx, { session_id: CLAUDE, prompt: 'hi' }, quiet).stdout, '', 'no mailbox');
    send(fx, { id: CODEX, provider: 'codex' }, { id: AGY, provider: 'antigravity' }, 'not for claude');
    assert.equal(runHook(fx, { session_id: CLAUDE, prompt: 'hi' }, quiet).stdout, '', 'a note for someone else');
    const ran = fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').trim().split('\n') : [];
    assert.ok(!ran.includes('node'), `node started without a note for this session: ${ran}`);
    assert.deepEqual(pendingCounts({ dev: fx.dev }), { [CODEX]: 1 }, 'and the other session\'s note is untouched');
  } finally {
    fx.cleanup();
  }
});

test('the hook is registered for all three providers without moving an existing Codex hook', () => {
  const read = (rel) => JSON.parse(fs.readFileSync(path.join(PLUGIN, rel), 'utf8'));
  const current = { claude: read('hooks/hooks.json'), codex: read('hooks/codex-hooks.json') };
  for (const [name, manifest] of Object.entries(current)) {
    const groups = manifest.hooks.UserPromptSubmit;
    const commands = groups.map((g) => g.hooks.map((h) => h.command).join(' '));
    assert.match(commands.at(-1), /run-hook\.cjs" deliver-notes-on-prompt\.sh \d+$/, `${name}: delivery hook last`);
    assert.match(commands[0], /surface-recall-on-prompt\.sh/, `${name}: the recall hook keeps index 0`);
  }
  // Codex keys trust by event, group index and hook index: the committed
  // manifest's groups must all stand where they stood.
  const before = JSON.parse(spawnSync('git', ['show', 'HEAD:plugins/session-cartographer/hooks/codex-hooks.json'],
    { cwd: ROOT, encoding: 'utf8' }).stdout || '{"hooks":{}}');
  for (const [event, groups] of Object.entries(before.hooks)) {
    groups.forEach((group, i) => {
      const was = JSON.stringify(group);
      if (was.includes('deliver-notes-on-prompt')) return;
      assert.equal(JSON.stringify(current.codex.hooks[event][i]), was, `codex ${event}[${i}] moved or changed`);
    });
  }
  const agy = read('hooks.json')['session-cartographer'].PreInvocation.map((h) => h.command);
  assert.ok(agy.some((c) => /antigravity-hook-bridge\.cjs deliver-notes-on-prompt\.sh \d+$/.test(c)), 'antigravity PreInvocation');
  for (const launcher of ['run-hook.cjs', 'antigravity-hook-bridge.cjs']) {
    assert.match(fs.readFileSync(path.join(PLUGIN, 'hooks', launcher), 'utf8'), /'deliver-notes-on-prompt\.sh'/,
      `${launcher} must allow the hook by name`);
  }
});

// ─── The send CLI: a shell sender for Antigravity, whose MCP server sees no session ───

test('send from a shell names the Antigravity conversation as sender, and refuses what tell refuses', () => {
  const fx = fixture();
  try {
    const now = Date.now();
    const iso = (ms) => new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z');
    const row = (id, sid, provider, project, ago) => ({ event_id: id, timestamp: iso(now - ago * 60e3), type: 'tool_bash',
      provider, project, session_id: sid, summary: 'Ran: ls' });
    const rows = [row('evt-s-1', CLAUDE, 'claude', 'session-cartographer', 20), row('evt-s-2', CLAUDE, 'claude', 'session-cartographer', 15),
      row('evt-s-3', AGY, 'antigravity', 'mavericks', 10), row('evt-s-4', AGY, 'antigravity', 'mavericks', 5)];
    fs.writeFileSync(path.join(fx.dev, 'changelog.jsonl'), `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`);
    for (const name of ['session-milestones.jsonl', 'research-log.jsonl', 'tool-use-log.jsonl']) fs.writeFileSync(path.join(fx.dev, name), '');

    const cli = (args, overrides = {}, input) => spawnSync(process.execPath, [MAILBOX_CLI, 'send', ...args],
      { env: { ...env(fx, { ...OFFLINE_INDEX_ENV, ...overrides }) }, encoding: 'utf8', input });
    const asAgy = { ANTIGRAVITY_CONVERSATION_ID: AGY };

    const ok = cli(['--to', CLAUDE.slice(0, 8), '--note', '-'], asAgy, 'Synced the plugin.\nReload to pick up the hook.\n');
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, new RegExp(`Queued note-\\S+ for claude session ${CLAUDE} \\(session-cartographer\\)`));
    assert.match(ok.stdout, new RegExp(`from antigravity session ${AGY}`));
    const pending = pendingNotes({ dev: fx.dev, session: CLAUDE }).map((x) => x.note);
    assert.equal(pending.length, 1);
    assert.deepEqual([pending[0].from.session_id, pending[0].from.provider, pending[0].from.project], [AGY, 'antigravity', 'mavericks'],
      'the sender comes from the environment the shell was given');
    assert.equal(pending[0].text, 'Synced the plugin.\nReload to pick up the hook.', 'stdin is read, newlines survive');

    const refusals = [
      [['--to', 'zzzzzzzz', '--note', 'x'], asAgy, /no session in the last 2 days of standup starts with "zzzzzzzz"/],
      [['--to', AGY, '--note', 'x'], asAgy, /that is this session/],
      [['--to', 'short', '--note', 'x'], asAgy, /prefix of at least 8 characters/],
      [['--to', CLAUDE, '--note', '   '], asAgy, /note is required/],
      [['--to', CLAUDE, '--note', 'x'.repeat(2001)], asAgy, /limit is 2000/],
    ];
    for (const [args, overrides, reason] of refusals) {
      const res = cli(args, overrides);
      assert.equal(res.status, 1, `${args.join(' ')} is refused`);
      assert.match(res.stderr, reason);
    }
    assert.equal(cli(['--to', CLAUDE]).status, 2, 'a missing --note is a usage error');
    assert.equal(pendingNotes({ dev: fx.dev, session: CLAUDE }).length, 1, 'no refusal wrote a note');
    assert.equal(pendingNotes({ dev: fx.dev, session: AGY }).length, 0);
  } finally {
    fx.cleanup();
  }
});

test('the delivered note tells an Antigravity recipient how to answer from a shell', () => {
  const text = renderDelivery([{ sent_at: new Date().toISOString(), text: 'hi',
    from: { session_id: CLAUDE, provider: 'claude', project: 'dev' } }]);
  assert.match(text, /`tell` tool/);
  assert.match(text, /mailbox\.js" send --to <id> --note "<text>"/);
});

test('a plugin installed through a directory link delivers the queued note', () => {
  const fx = fixture();
  try {
    const installed = path.join(fx.root, 'installed-plugin');
    fs.symlinkSync(PLUGIN, installed, 'junction');
    send(fx, { id: AGY, provider: 'antigravity' }, { id: CLAUDE, provider: 'claude' }, 'Linked plugin delivery');
    const result = spawnSync(process.execPath, [
      path.join(installed, 'scripts', 'mailbox.js'), 'deliver', '--session', AGY, '--provider', 'antigravity',
    ], { env: env(fx), encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(contextOf(result.stdout), /^> Linked plugin delivery$/m);
    assert.equal(events(fx).filter(row => row.type === 'milestone_note_delivered').length, 1);
  } finally {
    fx.cleanup();
  }
});

test('the mailbox module is mirrored byte for byte into the plugin', () => {
  assert.equal(fs.readFileSync(path.join(PLUGIN, 'scripts', 'mailbox-store.js'), 'utf8'), fs.readFileSync(path.join(ROOT, 'scripts', 'mailbox-store.js'), 'utf8'));
  assert.equal(fs.readFileSync(path.join(PLUGIN, 'scripts', 'mailbox.js'), 'utf8'),
    fs.readFileSync(path.join(ROOT, 'scripts', 'mailbox.js'), 'utf8'));
});
