/**
 * tests/unit/cli-pipe-drain.test.js
 *
 * On macOS Node writes to a pipe asynchronously, so a CLI that calls
 * process.exit() straight after a large write is gone before the pipe has
 * taken everything. The reader gets a prefix that ends mid-string, the exit
 * code is 0, and nothing reports a problem. The MCP server spawns these CLIs
 * through pipes: its standup tool failed with `JSON.parse ... at position 8192`
 * whenever the checkout had enough uncommitted files to grow standup's
 * UNCLAIMED list, and passed on a clean tree. On the live corpus a 3-day
 * `--json` roster arrived cut at 131,041 bytes.
 *
 * A reader that drains promptly hides the defect most of the time, so each
 * case stalls its reader. It takes the first chunk, which proves the CLI is
 * mid-write, then stops reading for STALL_MS. A CLI that exits early dies
 * inside the stall with its output cut; one that waits for the drain is still
 * alive when reading resumes, because the rest of its output cannot fit in the
 * pipe. That only holds if the output is several times the pipe's capacity, so
 * every case also asserts the size. Below that size the stall proves nothing.
 *
 * session-digest `--day` already waited for its write; it is here so the next
 * edit to that exit path cannot quietly undo it.
 *
 * Run with: node --test tests/unit/cli-pipe-drain.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const STANDUP = path.join(ROOT, 'scripts', 'cartographer-standup.js');
const DIGEST = path.join(ROOT, 'scripts', 'session-digest.js');

// The default pipe capacity on macOS and Linux. The stalled reader has taken
// at most one chunk of about this size, and the pipe holds about this much
// more, so output past four times it cannot all be in flight.
const PIPE_BYTES = 64 * 1024;
const STALL_MS = 400;
const SESSIONS = 1000;

const sessionId = (i) => `pipe${String(i).padStart(4, '0')}-0000-4000-8000-000000000000`;
const sha = (i) => (0xabc000000 + i).toString(16);
const subject = (i) => `feat(pipe-drain): wait for stdout before exiting, row ${i} of ${SESSIONS}`;
const files = (i) => ['drain', 'pipe', 'exit', 'flush'].map((name) => `src/pipe-drain/${name}-${i}.js`);

/** A corpus of SESSIONS sessions, each with one command and one commit. */
function corpus(stamp) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'carto-pipe-')));
  const rows = [];
  for (let i = 0; i < SESSIONS; i++) {
    const base = { provider: 'claude', session_id: sessionId(i), project: 'pipefixture', cwd: dir };
    rows.push(
      { ...base, event_id: `evt-pipe-bash-${i}`, timestamp: stamp(i, 0), type: 'tool_bash', summary: 'Ran: ls' },
      { ...base, event_id: `evt-pipe-commit-${i}`, timestamp: stamp(i, 1), type: 'git_commit',
        summary: `[feature] Commit ${sha(i)}: ${subject(i)} | files: ${files(i).join(',')}` },
    );
  }
  fs.writeFileSync(path.join(dir, 'changelog.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return dir;
}

/** The caller's environment, minus anything that would make the run non-hermetic. */
function hermeticEnv(dir, extra = {}) {
  const env = { ...process.env, CARTOGRAPHER_DEV_DIR: dir,
    CODEX_HOME: path.join(dir, 'empty-codex'), CLAUDE_CONFIG_DIR: path.join(dir, 'empty-claude'), ...extra };
  for (const key of ['CARTOGRAPHER_SESSION_ID', 'CLAUDE_SESSION_ID', 'CLAUDE_CODE_SESSION_ID', 'CODEX_SESSION_ID']) delete env[key];
  return env;
}

/**
 * Run a CLI and read its stdout through a reader that stops after the first
 * chunk for STALL_MS. `exitedWhileStalled` is whether the process had already
 * exited when reading resumed.
 */
function readThroughStalledPipe(script, args, { cwd, env }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [];
    const err = [];
    let exited = false;
    let stalled = false;
    let exitedWhileStalled = null;
    child.on('exit', () => { exited = true; });
    child.on('error', reject);
    child.stderr.on('data', (chunk) => err.push(chunk));
    child.stdout.on('data', (chunk) => {
      out.push(chunk);
      if (stalled) return;
      stalled = true;
      child.stdout.pause();
      setTimeout(() => {
        exitedWhileStalled = exited;
        child.stdout.resume();
      }, STALL_MS);
    });
    child.on('close', (code) => resolve({
      code,
      stdout: Buffer.concat(out).toString('utf8'),
      stderr: Buffer.concat(err).toString('utf8'),
      exitedWhileStalled,
    }));
  });
}

function assertDrained(result) {
  assert.equal(result.code, 0, result.stderr);
  const bytes = Buffer.byteLength(result.stdout);
  // The defect's signature: the process ended while its reader still owed it a read.
  assert.equal(result.exitedWhileStalled, false,
    `the CLI exited before its reader drained the pipe; stdout ends at byte ${bytes}`);
  assert.ok(bytes > 4 * PIPE_BYTES,
    `the fixture must outgrow the pipe several times over, or the stall proves nothing (got ${bytes} bytes)`);
}

const ago = (minutes) => new Date(Date.now() - minutes * 60e3).toISOString().replace(/\.\d{3}Z$/, 'Z');
// Inside a 2h window, and older than standup's 2-minute "newest event is you"
// heuristic, so every fixture session is a peer and none is dropped as self.
const liveDir = corpus((i, k) => ago(100 - (i % 90) - k * 0.5));
test.after(() => fs.rmSync(liveDir, { recursive: true, force: true }));

test('standup --json arrives whole through a stalled pipe', async () => {
  const result = await readThroughStalledPipe(STANDUP, ['--since', '2h', '--json'],
    { cwd: liveDir, env: hermeticEnv(liveDir) });
  assertDrained(result);
  const doc = JSON.parse(result.stdout);
  assert.equal(doc.sessions.length, SESSIONS);
  assert.deepEqual(new Set(doc.sessions.map((s) => s.id)),
    new Set(Array.from({ length: SESSIONS }, (_, i) => sessionId(i))));
  for (const s of doc.sessions) {
    assert.equal(s.commits.length, 1, s.id);
    assert.equal(s.commits[0].subject, subject(Number(s.id.slice(4, 8))), s.id);
  }
});

test('standup --commit lists every matching commit through a stalled pipe', async () => {
  const result = await readThroughStalledPipe(STANDUP, ['--since', '2h', '--commit', 'pipe-drain'],
    { cwd: liveDir, env: hermeticEnv(liveDir) });
  assertDrained(result);
  const heads = result.stdout.split('\n').filter((line) => /^[0-9a-f]{6,40} {2}/.test(line));
  assert.equal(heads.length, SESSIONS);
  assert.deepEqual(new Set(heads.map((line) => line.split(' ')[0])),
    new Set(Array.from({ length: SESSIONS }, (_, i) => sha(i))));
  // Each block ends with a blank line, the last one included.
  assert.ok(result.stdout.endsWith('\n\n'), JSON.stringify(result.stdout.slice(-80)));
});

test('session-digest --day --json arrives whole through a stalled pipe', async () => {
  // PDT: the day runs 2026-09-26T07:00Z to 2026-09-27T07:00Z.
  const start = Date.parse('2026-09-26T08:00:00Z');
  const dir = corpus((i, k) => new Date(start + i * 60e3 + k * 1e3).toISOString().replace(/\.\d{3}Z$/, 'Z'));
  try {
    const env = hermeticEnv(dir, { TZ: 'America/Los_Angeles', CARTOGRAPHER_CHANGELOG: path.join(dir, 'changelog.jsonl') });
    const result = await readThroughStalledPipe(DIGEST, ['--day', '2026-09-26', '--json', '--no-git'], { cwd: dir, env });
    assertDrained(result);
    const doc = JSON.parse(result.stdout);
    assert.equal(doc.totals.sessions, SESSIONS);
    assert.equal(doc.totals.commits_logged, SESSIONS);
    const project = doc.projects.find((p) => p.name === 'pipefixture');
    assert.equal(project?.commits.length, SESSIONS);
    assert.equal(project.sessions.length, SESSIONS);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
