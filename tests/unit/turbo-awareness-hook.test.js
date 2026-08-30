import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '../..');
const HOOK = path.join(ROOT, 'plugins/session-cartographer/hooks/surface-turbo-on-start.sh');

function runHook(root, enabled, envOverrides = {}) {
  const config = path.join(root, 'config.json');
  fs.writeFileSync(config, `${JSON.stringify({
    version: 1,
    turbo: { enabled, auto_start: true },
  })}\n`);
  const payload = {
    hook_event_name: 'SessionStart',
    source: 'startup',
    session_id: 'session-awareness-test',
    transcript_path: '/Users/test/.codex/sessions/2026/08/30/test.jsonl',
    cwd: root,
    turn_id: 'turn-codex',
  };
  return spawnSync('bash', [HOOK], {
    cwd: ROOT,
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: {
      ...process.env,
      CARTOGRAPHER_CONFIG: config,
      CARTOGRAPHER_DEV_DIR: path.join(root, 'dev'),
      ...envOverrides,
    },
  });
}

test('active Turbo injects targeted recall guidance and one exposure receipt', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-turbo-awareness-'));
  try {
    const first = runHook(root, true);
    assert.equal(first.status, 0, first.stderr);
    const output = JSON.parse(first.stdout);
    const context = output.hookSpecificOutput.additionalContext;
    assert.equal(output.hookSpecificOutput.hookEventName, 'SessionStart');
    assert.match(context, /Turbo active/);
    assert.match(context, /remember or focus/);
    assert.match(context, /self-contained/);

    const second = runHook(root, true);
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stdout, /Turbo active/,
      'resume-like reinjection should retain awareness context');

    const receipts = fs.readFileSync(path.join(root, 'dev/.carto/turbo-awareness.jsonl'), 'utf8')
      .trim().split('\n').map(JSON.parse);
    assert.equal(receipts.length, 1, 'one session must contribute one exposure denominator');
    assert.equal(receipts[0].session_id, 'session-awareness-test');
    assert.equal(receipts[0].provider, 'codex');
    assert.equal(receipts[0].activation_source, 'shared_config');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('disabled or explicitly bypassed Turbo injects no awareness context', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-turbo-awareness-off-'));
  try {
    const disabled = runHook(root, false);
    assert.equal(disabled.status, 0, disabled.stderr);
    assert.equal(disabled.stdout, '');

    const bypassed = runHook(root, true, { CARTOGRAPHER_TURBO: '0' });
    assert.equal(bypassed.status, 0, bypassed.stderr);
    assert.equal(bypassed.stdout, '');
    assert.equal(fs.existsSync(path.join(root, 'dev/.carto/turbo-awareness.jsonl')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
