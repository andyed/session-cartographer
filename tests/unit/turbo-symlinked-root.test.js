// ~/.claude/skills/remember is a symlink into the checkout, and the remember
// skill derives its runtime root as `../..` from there. The kernel resolves
// that `..` physically, through the symlink, so bash's `[ -f ]` finds the Turbo
// controller — but node's ESM resolver collapses `..` lexically against
// import.meta.url first, so it looks for the module beside the SYMLINK's parent
// instead. The controller failed to load, its stderr was discarded, and the
// call was recorded as a plain portable search. Turbo was switched on and
// silently unused on the path most Claude Code sessions actually take.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function runSearch(searchScript, callLog, env = {}) {
  try {
    execFileSync('bash', [searchScript, 'granite creek', '--limit', '3'], {
      env: {
        ...process.env,
        CARTOGRAPHER_SESSION_ID: '',
        CLAUDE_SESSION_ID: '',
        CLAUDE_CODE_SESSION_ID: '',
        CODEX_SESSION_ID: '',
        CARTOGRAPHER_SEMANTIC: '0',
        CARTOGRAPHER_SEARCH_CALL_LOG: callLog,
        CARTOGRAPHER_SERVED_LOG: '/dev/null',
        CARTOGRAPHER_ACCESS_LEDGER: '/dev/null',
        ...env,
      },
      stdio: 'ignore',
      timeout: 120000,
    });
  } catch {
    // A portable search over an empty corpus can exit non-zero; the telemetry
    // row is what this test reads.
  }
  const lines = fs.readFileSync(callLog, 'utf8').trim().split('\n').filter(Boolean);
  return JSON.parse(lines[lines.length - 1]);
}

test('a Turbo controller that is present but unloadable is recorded, not swallowed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-unloadable-'));
  const scripts = path.join(dir, 'scripts');
  fs.mkdirSync(scripts);
  for (const file of ['cartographer-search.sh', 'cartographer-turbo.js', 'bm25-search.awk']) {
    fs.copyFileSync(path.join(repo, 'scripts', file), path.join(scripts, file));
  }
  // turbo-common.js is deliberately absent: the controller exists and imports fail.
  const row = runSearch(path.join(scripts, 'cartographer-search.sh'), path.join(dir, 'calls.jsonl'));

  assert.equal(row.selected_backend, 'cli');
  assert.equal(row.fallback_reason, 'turbo_control_unloadable');
  assert.ok(row.fallback_detail, 'an unloadable controller must record why');
  assert.ok(!/[\r\n\t]/.test(row.fallback_detail), 'fallback_detail must stay single-line');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('the runtime root resolves physically through a symlinked skill directory', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-symlink-'));
  // Reproduce the real shape: <root>/skills/remember symlinks into the checkout,
  // and the caller reaches the runtime as `<link>/../../scripts/...`.
  const skills = path.join(dir, 'skills');
  fs.mkdirSync(skills);
  fs.symlinkSync(path.join(repo, 'plugins', 'session-cartographer', 'skills', 'remember'),
    path.join(skills, 'remember'));

  // Built by concatenation, not path.join: join() collapses `..` lexically and
  // would sidestep the very trap under test — the same collapse node's ESM
  // resolver performs, and the reason this bug existed.
  const viaSymlink = `${skills}/remember/../../scripts/cartographer-search.sh`;
  assert.ok(fs.existsSync(viaSymlink), 'the shell path must resolve through the symlink');

  const row = runSearch(viaSymlink, path.join(dir, 'calls.jsonl'), { CARTOGRAPHER_TURBO: '0' });
  // With Turbo explicitly off this is a portable call — but it must be a clean
  // one, not a controller that failed to load on the way past.
  assert.notEqual(row.fallback_reason, 'turbo_control_unloadable');

  fs.rmSync(dir, { recursive: true, force: true });
});
