/**
 * tests/unit/trial-gate-isolation.test.js
 *
 * A hook test that spreads process.env inherits whatever trial gates the
 * developer's shell carries. Claude Code applies the `env` block of
 * ~/.claude/settings.json to its Bash tool, so turning a trial on for real use
 * also turns it on inside the suite. On 2026-10-16, setting
 * CARTOGRAPHER_FILE_HISTORY_ON_EDIT=1 made edit-collision-hook.test.js fail:
 * the collision hook added a history line that test never set up.
 *
 * Two static checks keep that from coming back:
 *
 * 1. The opt-in gates are derived from the hooks, not listed by hand: every
 *    `${CARTOGRAPHER_X:-0}" = "1"` (or `!= "1"`) in a hook must be in
 *    TRIAL_GATES, so a new trial cannot be added without the helper knowing.
 * 2. Every test file that runs a gated hook imports withoutTrialGates.
 *
 * Check 2 is file-level, like live-index-isolation.test.js: it catches a file
 * that never clears the gates, not one spawn site left uncleared in a file
 * that clears them elsewhere.
 *
 * Run with: node --test tests/unit/trial-gate-isolation.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TRIAL_GATES } from './helpers/trial-gates.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const HOOKS_DIR = path.join(ROOT, 'plugins', 'session-cartographer', 'hooks');
const TESTS_DIR = path.join(ROOT, 'tests', 'unit');
const OPT_IN = /\$\{(CARTOGRAPHER_[A-Z_]+):-0\}"\s*!?=\s*"1"/g;

/** hook file name -> the opt-in gates its code reads. */
function gatedHooks() {
  const out = new Map();
  for (const name of fs.readdirSync(HOOKS_DIR).filter((f) => f.endsWith('.sh'))) {
    const code = fs.readFileSync(path.join(HOOKS_DIR, name), 'utf8')
      .split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
    const gates = [...code.matchAll(OPT_IN)].map((m) => m[1]);
    if (gates.length) out.set(name, gates);
  }
  return out;
}

test('every opt-in gate a hook reads is in TRIAL_GATES', () => {
  const hooks = gatedHooks();
  // The derivation has to find something, or check 2 passes vacuously.
  assert.ok(hooks.size >= 3, `expected the three trial hooks, found ${[...hooks.keys()].join(', ') || 'none'}`);
  for (const [hook, gates] of hooks) {
    for (const gate of gates) assert.ok(TRIAL_GATES.includes(gate), `${hook} reads ${gate}, which TRIAL_GATES does not clear`);
  }
});

test('every test file that runs a gated hook clears the trial gates', () => {
  const hooks = [...gatedHooks().keys()];
  const offenders = [];
  let checked = 0;
  for (const name of fs.readdirSync(TESTS_DIR).filter((f) => f.endsWith('.test.js') && f !== path.basename(fileURLToPath(import.meta.url)))) {
    // A doc comment naming a hook is not a run of it: recall-cue.test.js
    // describes surface-recall-on-prompt.sh and spawns only the classifier.
    const src = fs.readFileSync(path.join(TESTS_DIR, name), 'utf8')
      .split('\n').filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l)).join('\n');
    if (!hooks.some((h) => src.includes(h)) || !/spawnSync|execFileSync|spawn\(/.test(src)) continue;
    checked++;
    if (!/withoutTrialGates/.test(src)) offenders.push(name);
  }
  assert.ok(checked > 0, 'found no test file that runs a gated hook; the scan is broken');
  assert.deepEqual(offenders, [], `run gated hooks without withoutTrialGates: ${offenders.join(', ')}`);
});
