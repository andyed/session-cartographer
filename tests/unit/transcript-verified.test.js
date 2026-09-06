/**
 * tests/unit/transcript-verified.test.js
 *
 * Guards the `transcript_verified` flag on milestone rows.
 *
 * Why this test exists: the hook takes `transcript_path` verbatim from the host
 * payload, which is the path the host INTENDS for the session — not a promise
 * that the file was ever written. Sessions ending with reason "other" routinely
 * leave no transcript, and 7,723 of those rows (78%) pointed at a nonexistent
 * file. That was 97% of every broken link in a 15,000-row log, and every one of
 * them carried a `claude-history://` deeplink that looked identical to a working
 * one until a human clicked it.
 *
 * Nothing crashed and nothing was logged. The failure was visible only to
 * someone who stat'd the paths — so it must not be silent to CI.
 *
 * Run with: node --test tests/unit/transcript-verified.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const HOOK = path.join(ROOT, 'plugins/session-cartographer/hooks/log-session-milestones.sh');

/**
 * Provider detection keys off the transcript path containing `/.claude/projects/`,
 * so fixtures must live under that shape or the hook resolves provider "unknown"
 * and never mints a deeplink for reasons unrelated to what we're testing.
 */
function claudeTranscriptPath(dir, sessionId) {
  return path.join(dir, '.claude', 'projects', '-tmp-carto', `${sessionId}.jsonl`);
}

/** Run the hook with a SessionEnd payload; return the milestone row it wrote. */
function runHook({ transcriptPath, sessionId }) {
  const dev = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-tv-'));
  const payload = {
    hook_event_name: 'SessionEnd',
    reason: 'other',
    session_id: sessionId,
    transcript_path: transcriptPath,
    cwd: dev,
  };
  const res = spawnSync('bash', [HOOK], {
    input: JSON.stringify(payload),
    env: { ...process.env, CARTOGRAPHER_DEV_DIR: dev, CLAUDE_SESSION_ID: sessionId },
    encoding: 'utf8',
  });
  assert.equal(res.status, 0, `hook exited ${res.status}: ${res.stderr}`);
  // Suppression means "no log file at all" is a legitimate outcome here.
  const log = path.join(dev, 'session-milestones.jsonl');
  const rows = fs.existsSync(log)
    ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
    : [];
  const row = rows.find((r) => r.session_id === sessionId);
  fs.rmSync(dev, { recursive: true, force: true });
  return row ?? null;
}

/** Same, but seeds the changelog so the session reads as having done work. */
function runHookWithActivity({ transcriptPath, sessionId }) {
  const dev = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-tv-'));
  fs.writeFileSync(
    path.join(dev, 'changelog.jsonl'),
    JSON.stringify({ session_id: sessionId, type: 'tool_file_edit' }) + '\n',
  );
  const res = spawnSync('bash', [HOOK], {
    input: JSON.stringify({
      hook_event_name: 'SessionEnd', reason: 'other',
      session_id: sessionId, transcript_path: transcriptPath, cwd: dev,
    }),
    env: { ...process.env, CARTOGRAPHER_DEV_DIR: dev, CLAUDE_SESSION_ID: sessionId },
    encoding: 'utf8',
  });
  assert.equal(res.status, 0, `hook exited ${res.status}: ${res.stderr}`);
  const log = path.join(dev, 'session-milestones.jsonl');
  const rows = fs.existsSync(log)
    ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
    : [];
  const row = rows.find((r) => r.session_id === sessionId);
  fs.rmSync(dev, { recursive: true, force: true });
  return row ?? null;
}

test('a transcript that exists is marked verified and keeps its deeplink', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-fix-'));
  const f = claudeTranscriptPath(dir, 'sess-real-0001');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, '{"type":"user"}\n');
  try {
    const row = runHook({ transcriptPath: f, sessionId: 'sess-real-0001' });
    assert.ok(row, 'a resolvable transcript must still be logged');
    assert.equal(row.transcript_verified, true);
    assert.equal(row.transcript_path, f);
    assert.match(row.deeplink, /^claude-history:\/\//);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a transcript that was never written is marked unverified', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-fix-'));
  const missing = claudeTranscriptPath(dir, 'sess-ghost-0001');
  assert.equal(fs.existsSync(missing), false, 'fixture must not exist');
  const row = runHookWithActivity({ transcriptPath: missing, sessionId: 'sess-ghost-0001' });
  assert.ok(row, 'a session with real work is kept even without a transcript');
  assert.equal(row.transcript_verified, false);
  // The intended path is still evidence — keep it, don't discard it.
  assert.equal(row.transcript_path, missing);
});

test('an unresolvable transcript yields no deeplink at all', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-fix-'));
  const missing = claudeTranscriptPath(dir, 'sess-ghost-0002');
  const row = runHookWithActivity({ transcriptPath: missing, sessionId: 'sess-ghost-0002' });
  assert.ok(row, 'row expected: this session logged activity');
  // A deeplink that cannot open is worse than none: it is indistinguishable
  // from a working one until someone clicks it.
  assert.equal(row.deeplink, '');
});

test('an absent transcript_path is unverified rather than crashing', () => {
  const row = runHookWithActivity({ transcriptPath: '', sessionId: 'sess-empty-0001' });
  assert.ok(row, 'row expected: this session logged activity');
  assert.equal(row.transcript_verified, false);
  assert.equal(row.deeplink, '');
});

test('a dead transcript with zero activity is not logged at all', () => {
  // 7,646 rows of exactly this shape — 51% of a 15,000-row log. Nothing to
  // open, nothing to join to, nothing indexed. It is not a low-value record,
  // it is an empty one.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-fix-'));
  const missing = claudeTranscriptPath(dir, 'sess-void-0001');
  const row = runHook({ transcriptPath: missing, sessionId: 'sess-void-0001' });
  assert.equal(row, null, 'a contentless session end must write no milestone');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('zero activity is still logged when the transcript resolves', () => {
  // Only the intersection is dropped. A reachable conversation is content even
  // when no tool events were logged against it.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-fix-'));
  const f = claudeTranscriptPath(dir, 'sess-quiet-0001');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, '{"type":"user"}\n');
  try {
    const row = runHook({ transcriptPath: f, sessionId: 'sess-quiet-0001' });
    assert.ok(row, 'a resolvable transcript is content, log it');
    assert.equal(row.transcript_verified, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
