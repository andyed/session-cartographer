/**
 * tests/unit/session-id-chain.test.js
 *
 * Guards the session-id resolution chain:
 *
 *   CARTOGRAPHER_SESSION_ID → CLAUDE_SESSION_ID → CLAUDE_CODE_SESSION_ID → CODEX_SESSION_ID
 *
 * Why this test exists: before 0.5.0 every consumer read only
 * `CLAUDE_SESSION_ID`, which Claude Code has never set. Nothing crashed and no
 * error was printed — delta serving silently never activated, and 86% of
 * milestone records were written with `session_id: "unknown"`. The only place
 * the failure was visible was in the log rows nobody read.
 *
 * So these tests assert on the *written row*, not on stdout. A regression that
 * is silent to the user must not be silent to CI.
 *
 * Run with: node --test tests/unit/session-id-chain.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SEARCH = path.join(ROOT, 'scripts', 'cartographer-search.sh');
const DIGEST = path.join(ROOT, 'scripts', 'session-digest.js');

const SESSION_VARS = [
  'CARTOGRAPHER_SESSION_ID',
  'CLAUDE_SESSION_ID',
  'CLAUDE_CODE_SESSION_ID',
  'CODEX_SESSION_ID',
];

// Delta serving keeps a per-session served list under /tmp that outlives the
// process. Two calls sharing a session id means the second one is suppressed
// and returns nothing — so every invocation here gets its own id, unique across
// runs as well as within them.
let sidCounter = 0;
const freshSid = (label) => `sid-${label}-${process.pid}-${++sidCounter}`;

function cleanEnv(overrides = {}) {
  const env = { ...process.env };
  for (const key of SESSION_VARS) delete env[key];
  delete env.CARTOGRAPHER_PROVIDER;
  // macOS exports TMPDIR; Linux does not. Scripts that reference $TMPDIR before
  // creating it therefore work on a dev machine and fail in CI. Drop it so this
  // suite runs under the stricter of the two environments everywhere.
  delete env.TMPDIR;
  return { ...env, ...overrides };
}

/**
 * Run a search against a throwaway dev dir and return the served rows it wrote.
 * An empty corpus is fine — the row is written for the telemetry path, and the
 * session/provider fields on it are what we are asserting.
 */
function servedRowsFor(envOverrides) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-sid-'));
  const servedLog = path.join(dir, 'served-log.jsonl');

  // Seed a small corpus with the query token in exactly one event. Without a
  // match no served row is written and every assertion below passes vacuously.
  // The filler matters: BM25's IDF term goes negative when a word appears in
  // every document, so a one-document corpus scores its own match below zero
  // and returns nothing.
  const event = (i, summary) => JSON.stringify({
    event_id: `evt-seedfixture${String(i).padStart(2, '0')}`,
    timestamp: `2026-01-0${i}T00:00:00Z`,
    type: 'tool_bash',
    project: 'fixtureproject',
    cwd: '/tmp/fixtureproject',
    summary,
    session_id: 'sid-of-the-seeded-event',
  });
  const corpus = [
    event(1, 'Ran: zzqqxx distinctive fixture token for session id chain test'),
    ...Array.from({ length: 7 }, (_, i) =>
      event(i + 2, `Ran: routine filler command number ${i + 2} touching unrelated files`)),
  ];
  fs.writeFileSync(path.join(dir, 'changelog.jsonl'), `${corpus.join('\n')}\n`);
  fs.writeFileSync(path.join(dir, 'session-milestones.jsonl'), '');
  fs.writeFileSync(path.join(dir, 'research-log.jsonl'), '');

  const result = spawnSync('bash', [SEARCH, 'zzqqxx', '--limit', '1'], {
    encoding: 'utf8',
    env: cleanEnv({
      CARTOGRAPHER_DEV_DIR: dir,
      CARTOGRAPHER_SERVED_LOG: servedLog,
      CARTOGRAPHER_ACCESS_LEDGER: path.join(dir, 'access-ledger.jsonl'),
      CARTOGRAPHER_TRANSCRIPTS_DIR: path.join(dir, 'no-transcripts'),
      CARTOGRAPHER_QDRANT_URL: 'http://127.0.0.1:1', // unreachable: keyword-only
      ...envOverrides,
    }),
  });

  const rows = fs.existsSync(servedLog)
    ? fs.readFileSync(servedLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : [];
  fs.rmSync(dir, { recursive: true, force: true });
  return { rows, status: result.status, stderr: result.stderr };
}

test('the fixture actually produces a served row', () => {
  // Guards the guard: if this stops returning rows, every assertion below
  // becomes vacuous and the suite silently stops testing anything.
  const { rows, stderr } = servedRowsFor({ CLAUDE_CODE_SESSION_ID: freshSid('probe') });
  assert.ok(rows.length > 0, `expected at least one served row; stderr: ${stderr}`);
});

test('served row carries the session from CLAUDE_CODE_SESSION_ID', () => {
  const sid = freshSid('code');
  const { rows } = servedRowsFor({ CLAUDE_CODE_SESSION_ID: sid });
  assert.ok(rows.length > 0, 'no served row — fixture broken, not the chain');
  for (const row of rows) {
    assert.equal(row.session_id, sid,
      'served row must carry the session from CLAUDE_CODE_SESSION_ID');
    assert.equal(row.provider, 'claude');
  }
});

test('CARTOGRAPHER_SESSION_ID wins over every provider variable', () => {
  const sid = freshSid('override');
  const { rows } = servedRowsFor({
    CARTOGRAPHER_SESSION_ID: sid,
    CLAUDE_CODE_SESSION_ID: freshSid('code'),
    CODEX_SESSION_ID: freshSid('codex'),
  });
  assert.ok(rows.length > 0, 'no served row — fixture broken, not the chain');
  for (const row of rows) assert.equal(row.session_id, sid);
});

// The digest reports its resolved session directly, so it can assert the chain
// without needing a populated corpus.
function digestSession(envOverrides) {
  const result = spawnSync('node', [DIGEST, '--json', '--no-git'], {
    encoding: 'utf8',
    env: cleanEnv(envOverrides),
  });
  return { stdout: result.stdout, stderr: result.stderr, status: result.status };
}

test('digest reads CLAUDE_CODE_SESSION_ID, not just the legacy name', () => {
  const { stderr, status } = digestSession({ CLAUDE_CODE_SESSION_ID: 'sid-code-abc' });
  // No events for a synthetic id, so it exits 1 — but it must have RESOLVED the
  // id rather than bailing with "No session id", which is exit 2.
  assert.equal(status, 1, `expected resolved-but-empty, got: ${stderr}`);
  assert.match(stderr, /sid-code-abc/,
    'digest must report the session it resolved from CLAUDE_CODE_SESSION_ID');
});

test('digest still honours the legacy CLAUDE_SESSION_ID', () => {
  const { stderr, status } = digestSession({ CLAUDE_SESSION_ID: 'sid-legacy-abc' });
  assert.equal(status, 1, `expected resolved-but-empty, got: ${stderr}`);
  assert.match(stderr, /sid-legacy-abc/);
});

test('digest honours CODEX_SESSION_ID', () => {
  const { stderr, status } = digestSession({ CODEX_SESSION_ID: 'sid-codex-abc' });
  assert.equal(status, 1, `expected resolved-but-empty, got: ${stderr}`);
  assert.match(stderr, /sid-codex-abc/);
});

test('digest exits 2 with a clear message when nothing resolves', () => {
  const { stderr, status } = digestSession({});
  assert.equal(status, 2);
  assert.match(stderr, /No session id/);
});

// ─── Sentinel handling ───
// "unknown" is truthy and equal to itself, so it never throws — it just merges
// every unattributed record into one phantom identity. During the 0.5.0 repair
// that phantom "matched" 148 orphans and overstated recovery by 54%. These
// assert the class of bug cannot come back silently.

test('sentinels are not treated as real values', async () => {
  const { isResolved, firstResolved } = await import('../../scripts/sentinels.js');
  for (const absent of ['', 'unknown', 'UNKNOWN', '  unknown  ', null, undefined]) {
    assert.equal(isResolved(absent), false, `${JSON.stringify(absent)} must not be resolved`);
  }
  for (const real of ['sid-123', 'claude', 'main', 'none', '0']) {
    assert.equal(isResolved(real), true, `${JSON.stringify(real)} must be resolved`);
  }
  assert.equal(firstResolved(['', 'unknown', null, 'claude']), 'claude');
  assert.equal(firstResolved(['', 'unknown'], 'fallback'), 'fallback');
});

test('session windows are never keyed by a sentinel', async () => {
  const { buildSessionWindows } = await import('../../scripts/session-windows.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-sentinel-'));
  const log = path.join(dir, 'changelog.jsonl');
  fs.writeFileSync(log, [
    // Three orphans that must NOT collapse into one shared window.
    '{"event_id":"a","timestamp":"2026-01-01T00:00:00Z","session_id":"unknown","project":"p1"}',
    '{"event_id":"b","timestamp":"2026-06-01T00:00:00Z","session_id":"","project":"p2"}',
    '{"event_id":"c","timestamp":"2026-12-01T00:00:00Z","session_id":null,"project":"p3"}',
    '{"event_id":"d","timestamp":"2026-03-01T00:00:00Z","session_id":"real-sid","project":"p1"}',
  ].join('\n'));

  const { sessions } = buildSessionWindows({
    sources: [log],
    transcriptDirs: [path.join(dir, 'none')],
  });
  fs.rmSync(dir, { recursive: true, force: true });

  assert.deepEqual([...sessions.keys()], ['real-sid'],
    'only the genuinely attributed session may produce a window');
  // The phantom spanned Jan→Dec and shadowed every real session. Prove it is gone.
  for (const key of sessions.keys()) {
    assert.ok(isResolvedKey(key), `window keyed by sentinel: ${JSON.stringify(key)}`);
  }
});

function isResolvedKey(key) {
  return key !== '' && key !== 'unknown' && key !== null && key !== undefined;
}

test('no consumer reads the legacy variable alone', () => {
  // A source that mentions CLAUDE_SESSION_ID must also mention the real one,
  // otherwise it has the original bug.
  const files = [
    'scripts/cartographer-search.sh',
    'scripts/session-digest.js',
    'plugins/session-cartographer/hooks/log-knowledge-gap.sh',
    'plugins/session-cartographer/skills/wrapup/SKILL.md',
    'plugins/session-cartographer/skills/investigate/SKILL.md',
  ];
  for (const rel of files) {
    const full = path.join(ROOT, rel);
    if (!fs.existsSync(full)) continue;
    const text = fs.readFileSync(full, 'utf8');
    if (!text.includes('CLAUDE_SESSION_ID')) continue;
    assert.ok(text.includes('CLAUDE_CODE_SESSION_ID'),
      `${rel} reads the legacy CLAUDE_SESSION_ID without CLAUDE_CODE_SESSION_ID`);
  }
});
