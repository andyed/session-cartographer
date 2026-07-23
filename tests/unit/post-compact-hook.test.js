import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOK = join(ROOT, 'plugins', 'session-cartographer', 'hooks', 'log-compact-summary.sh');
const INDEXER = join(ROOT, 'scripts', 'index-event.sh');

function runHook(dev, overrides = {}) {
  const payload = {
    hook_event_name: 'PostCompact',
    trigger: 'auto',
    session_id: 'claude-session-1',
    transcript_path: '/Users/test/.claude/projects/project/claude-session-1.jsonl',
    cwd: '/workspace/session-cartographer',
    compact_summary: [
      'Decision: keep raw turns canonical.',
      'Pending: add PostCompact indexing.',
      'api_key=sk-ant-abcdefghijklmnopqrstuvwxyz',
    ].join('\n'),
    ...overrides,
  };

  execFileSync('bash', [HOOK], {
    input: JSON.stringify(payload),
    env: {
      ...process.env,
      CARTOGRAPHER_DEV_DIR: dev,
      CARTOGRAPHER_POSTCOMPACT_INDEX: '0',
      CARTOGRAPHER_POSTCOMPACT_CATCHUP: '0',
    },
  });
}

function readEvents(dev) {
  const text = readFileSync(join(dev, 'changelog.jsonl'), 'utf8');
  return text.trim().split('\n').filter(Boolean).map(JSON.parse);
}

describe('PostCompact hook', () => {
  test('records a redacted, provenance-marked derived summary', () => {
    const dev = mkdtempSync(join(tmpdir(), 'cartographer-postcompact-'));
    runHook(dev);

    const [event] = readEvents(dev);
    assert.equal(event.type, 'derived_compaction_summary');
    assert.equal(event.provider, 'claude');
    assert.equal(event.canonical, false);
    assert.equal(event.noise_class, 'compaction_echo');
    assert.equal(event.compaction_trigger, 'auto');
    assert.equal(event.derived_from.kind, 'claude_postcompact');
    assert.match(event.summary, /keep raw turns canonical/);
    assert.match(event.summary, /\[REDACTED_(?:API_KEY|CREDENTIAL)\]/);
    assert.doesNotMatch(event.summary, /sk-ant-/);
    assert.doesNotMatch(event.summary, /\n/);
  });

  test('deduplicates repeated delivery of the same compaction summary', () => {
    const dev = mkdtempSync(join(tmpdir(), 'cartographer-postcompact-'));
    runHook(dev);
    runHook(dev);
    assert.equal(readEvents(dev).length, 1);
  });

  test('ignores an empty compact summary', () => {
    const dev = mkdtempSync(join(tmpdir(), 'cartographer-postcompact-'));
    runHook(dev, { compact_summary: '' });
    assert.throws(() => readEvents(dev), /ENOENT/);
  });

  test('caps stored summaries and records truncation', () => {
    const dev = mkdtempSync(join(tmpdir(), 'cartographer-postcompact-'));
    const payload = {
      hook_event_name: 'PostCompact',
      trigger: 'manual',
      session_id: 'claude-session-2',
      transcript_path: '/Users/test/.claude/projects/project/claude-session-2.jsonl',
      cwd: '/workspace/session-cartographer',
      compact_summary: 'x'.repeat(600),
    };
    execFileSync('bash', [HOOK], {
      input: JSON.stringify(payload),
      env: {
        ...process.env,
        CARTOGRAPHER_DEV_DIR: dev,
        CARTOGRAPHER_COMPACT_SUMMARY_MAX: '256',
        CARTOGRAPHER_POSTCOMPACT_INDEX: '0',
        CARTOGRAPHER_POSTCOMPACT_CATCHUP: '0',
      },
    });

    const [event] = readEvents(dev);
    assert.equal(event.summary.length, 256);
    assert.equal(event.summary_truncated, true);
  });

  test('real-time index payload retains derived-summary provenance', () => {
    const indexer = readFileSync(INDEXER, 'utf8');
    assert.match(indexer, /canonical: \(\$canonical == "true"\)/);
    assert.match(indexer, /noise_class: \$noise_class/);
    assert.match(indexer, /derived_from: \$derived_from/);
    assert.match(indexer, /summary_hash: \$summary_hash/);
    assert.match(indexer, /compaction_trigger: \$compaction_trigger/);
  });
});
