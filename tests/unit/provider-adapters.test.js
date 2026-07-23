import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isAllowedTranscriptPath, normalizeTranscriptEntries, transcriptRoots } from '../../explorer/server/transcripts.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CODEX_ADAPTER = join(ROOT, 'scripts', 'codex-transcript-to-turns.awk');
const CODEX_PROJECT_INFERER = join(ROOT, 'scripts', 'infer-codex-project.js');
const COMMON_HOOKS = join(ROOT, 'plugins', 'session-cartographer', 'hooks', 'common.sh');
const HOOK_CONFIG = join(ROOT, 'plugins', 'session-cartographer', 'hooks', 'hooks.json');

function tempJsonl(lines) {
  const dir = mkdtempSync(join(tmpdir(), 'cartographer-provider-'));
  const path = join(dir, 'rollout-test.jsonl');
  writeFileSync(path, `${lines.map(JSON.stringify).join('\n')}\n`);
  return path;
}

function normalizeCodex(lines) {
  const path = tempJsonl(lines);
  const output = execFileSync('awk', [
    '-f', CODEX_ADAPTER,
    '-v', 'sid=codex-session',
    '-v', 'proj=shared-project',
    '-v', `tpath=${path}`,
    path,
  ], { encoding: 'utf8' });
  return output.trim().split('\n').filter(Boolean).map(JSON.parse);
}

function detectProvider(payload, env = {}) {
  return execFileSync('bash', [
    '-c', '. "$1"; detect_provider "$2"',
    '--', COMMON_HOOKS, JSON.stringify(payload),
  ], { encoding: 'utf8', env: { ...process.env, ...env } }).trim();
}

describe('Codex transcript adapter', () => {
  test('emits provider-neutral turn documents with Codex provenance', () => {
    const turns = normalizeCodex([
      { timestamp: '2026-07-13T10:00:00Z', type: 'session_meta', payload: { id: 'codex-session' } },
      { timestamp: '2026-07-13T10:00:01Z', type: 'event_msg', payload: { type: 'user_message', message: 'Design the provider boundary' } },
      { timestamp: '2026-07-13T10:00:02Z', type: 'event_msg', payload: { type: 'agent_message', message: 'duplicate display event' } },
      { timestamp: '2026-07-13T10:00:03Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Use one shared memory plane' }] } },
      { timestamp: '2026-07-13T10:00:04Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'apply_patch', input: 'Update provider field' } },
      { timestamp: '2026-07-13T10:01:00Z', type: 'event_msg', payload: { type: 'user_message', message: 'Can Claude read it?' } },
      { timestamp: '2026-07-13T10:01:01Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Yes' }] } },
    ]);

    assert.equal(turns.length, 2);
    assert.equal(turns[0].provider, 'codex');
    assert.equal(turns[0].type, 'transcript');
    assert.equal(turns[0].event_id, 'turn-codex-codex-session-1');
    assert.match(turns[0].summary, /shared memory plane/);
    assert.doesNotMatch(turns[0].summary, /duplicate display event/);
    assert.match(turns[1].summary, /Can Claude read it/);
  });
});

describe('Codex project inference', () => {
  test('uses a specific session cwd when available', () => {
    const path = tempJsonl([
      { type: 'session_meta', payload: { cwd: '/workspace/session-cartographer' } },
      { type: 'response_item', payload: { type: 'custom_tool_call', input: '{"workdir":"/workspace/other"}' } },
    ]);
    const project = execFileSync('node', [CODEX_PROJECT_INFERER, path, '/workspace'], { encoding: 'utf8' }).trim();
    assert.equal(project, 'session-cartographer');
  });

  test('uses the dominant tool workdir when the desktop cwd is the workspace root', () => {
    const path = tempJsonl([
      { type: 'session_meta', payload: { cwd: '/workspace' } },
      { type: 'response_item', payload: { type: 'custom_tool_call', input: '{"workdir":"/workspace/session-cartographer"}' } },
      { type: 'response_item', payload: { type: 'custom_tool_call', input: 'tools.exec({"workdir":"/workspace/session-cartographer/scripts"})' } },
      { type: 'response_item', payload: { type: 'custom_tool_call', input: '{"workdir":"/workspace/psychodeli-webgl-port"}' } },
    ]);
    const project = execFileSync('node', [CODEX_PROJECT_INFERER, path, '/workspace'], { encoding: 'utf8' }).trim();
    assert.equal(project, 'session-cartographer');
  });
});

describe('hook provider detection', () => {
  test('detects providers from transcript provenance', () => {
    assert.equal(detectProvider({ transcript_path: '/Users/me/.claude/projects/p/s.jsonl' }), 'claude');
    assert.equal(detectProvider({ transcript_path: '/Users/me/.codex/sessions/2026/07/13/r.jsonl' }), 'codex');
  });

  test('supports an explicit custom-producer override', () => {
    assert.equal(detectProvider({}, { CARTOGRAPHER_PROVIDER: 'codex' }), 'codex');
  });
});

describe('shared hook configuration', () => {
  test('contains no unsupported async handlers and registers lifecycle bridges', () => {
    const config = JSON.parse(readFileSync(HOOK_CONFIG, 'utf8'));
    assert.ok(config.hooks.Stop);
    assert.ok(config.hooks.SessionStart);
    assert.ok(config.hooks.PostCompact);
    assert.match(JSON.stringify(config.hooks.SessionStart), /start-transcript-catch-up\.sh/);
    assert.match(JSON.stringify(config.hooks.PostCompact), /log-compact-summary\.sh/);
    assert.doesNotMatch(JSON.stringify(config), /"async"/);
  });
});

describe('Explorer transcript boundary', () => {
  test('allows both configured roots without accepting sibling-prefix traversal', () => {
    const roots = transcriptRoots({
      CARTOGRAPHER_CLAUDE_TRANSCRIPTS_DIR: '/history/claude',
      CARTOGRAPHER_CODEX_TRANSCRIPTS_DIR: '/history/codex',
    }, '/home/test');

    assert.equal(isAllowedTranscriptPath('/history/claude/project/session.jsonl', roots), true);
    assert.equal(isAllowedTranscriptPath('/history/codex/2026/07/session.jsonl', roots), true);
    assert.equal(isAllowedTranscriptPath('/history/codex-evil/session.jsonl', roots), false);
    assert.equal(isAllowedTranscriptPath('/etc/passwd', roots), false);
  });

  test('normalizes Codex records to the Explorer message shape', () => {
    const normalized = normalizeTranscriptEntries([
      { type: 'session_meta', payload: { id: 's1' } },
      { timestamp: '2026-07-13T10:00:00Z', type: 'event_msg', payload: { type: 'user_message', message: 'Can Claude read this?' } },
      { timestamp: '2026-07-13T10:00:01Z', type: 'response_item', payload: { id: 'm1', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Yes' }] } },
    ]);

    assert.equal(normalized.provider, 'codex');
    assert.deepEqual(normalized.messages.map(message => message.role), ['user', 'assistant']);
    assert.deepEqual(normalized.messages.map(message => message.content), ['Can Claude read this?', 'Yes']);
  });
});
