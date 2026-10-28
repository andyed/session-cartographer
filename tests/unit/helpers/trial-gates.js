// Environment for any test that spawns a hook with an opt-in trial gate.
//
// The trial hooks read their gate from the environment, and a developer who
// runs the trials has the gates set in the shell the suite runs in: Claude
// Code applies the `env` block of ~/.claude/settings.json to its Bash tool. A
// test that spreads process.env then runs a gated hook with a gate it never
// asked for. Measured 2026-10-16: with CARTOGRAPHER_FILE_HISTORY_ON_EDIT=1 in
// settings.json, edit-collision-hook.test.js failed "silent for own edits",
// because the collision hook added a file-history line that test never set up.
//
// Spread this in place of process.env, then set the gate a test means to
// exercise:
//
//   env: { ...withoutTrialGates(process.env), CARTOGRAPHER_DEV_DIR: dev }
//
// tests/unit/trial-gate-isolation.test.js fails any test file that runs a
// gated hook without it.
export const TRIAL_GATES = Object.freeze([
  'CARTOGRAPHER_RECALL_ON_PROMPT',
  'CARTOGRAPHER_FILE_HISTORY_ON_EDIT',
  'CARTOGRAPHER_FOCUS_ON_START',
]);

export function withoutTrialGates(env) {
  const out = { ...env };
  for (const key of TRIAL_GATES) delete out[key];
  return out;
}
