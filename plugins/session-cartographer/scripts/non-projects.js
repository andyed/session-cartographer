/**
 * non-projects.js — the one definition of "this `project` value is not a project."
 *
 * `project` is derived from the session cwd, so anything the corpus records is a
 * directory basename, not a curated identity. Three classes of junk land in the
 * field and each one has already caused a wrong answer:
 *
 *   1. Filesystem scaffolding. A session started in the home directory or the
 *      workspace root files events under `andyed` / `dev`. Left in,
 *      build-profile.js reported `andyed` as the busiest project and the "active
 *      surface" section described the filesystem instead of the work.
 *
 *   2. Auto-named agent worktrees. Hooks derived the project as
 *      `basename $(git rev-parse --show-toplevel)`, which inside
 *      `psychodeli-webgl-port/.claude/worktrees/brave-thompson-40e495` is the
 *      throwaway worktree directory. ~5,700 events were filed under directories
 *      that no longer exist (see tests/unit/worktree-project-attribution.test.js).
 *      The hook is fixed; the historical events are still in the logs.
 *
 *   3. Generic container names — `repo`, `dist`, `spec` — which are real
 *      directories in many checkouts and identify nothing.
 *
 * This list was previously spelled twice, in build-profile.js (NON_PROJECTS) and
 * cooccurrence-graph.js (PROJECT_BLOCKLIST), with different members. Per
 * CLAUDE.md's sentinel rule, a definition that consumers re-derive inline is
 * treated as a defect here — the two copies had already diverged before a third
 * consumer (bootstrap-project-registry.js) needed the same answer.
 */
import path from 'node:path';

/**
 * Docker-style auto-generated worktree names: `adjective-surname-hex`.
 *
 * The trailing group requires at least one DIGIT as well as being hex. A bare
 * /[0-9a-f]{6,}/ also matches ordinary English words built from the letters a-f
 * — `decade`, `facade`, `faced` — so `my-app-decade` would have been discarded
 * as a worktree. Requiring a digit costs nothing: the generator's suffix is a
 * truncated hash and effectively always contains one.
 */
export const WORKTREE_NAME = /^[a-z]+-[a-z]+-(?=[0-9a-f]*[0-9])[0-9a-f]{6,}$/;

/** The other auto-worktree convention seen in this corpus: `agent-<sha>`. */
export const AGENT_WORKTREE_NAME = /^agent-[0-9a-f]{8,}$/;

/**
 * Static names that are never a project. Union of the two lists that existed
 * before this module; nothing was dropped, because each entry was added in
 * response to something that actually showed up in the logs.
 */
export const STATIC_NON_PROJECTS = [
  // cwd-encoded path fragments
  'andyed', 'Users', 'Users-andyed', 'Documents', 'Documents-dev', 'Downloads',
  'Desktop', 'Library', 'home', 'workspace', 'images', 'tmp', 'var', 'private',
  'node_modules', 'dev',
  // sentinels and non-answers
  '/', '?', '', 'unknown',
  // generic container directories that identify nothing
  'repo', 'dist', 'spec',
];

/**
 * The full non-project set for this machine: the static list plus the two
 * names that can only be known at runtime — the home directory basename and
 * the workspace-root basename. Both are cwd-derived "projects" that otherwise
 * outrank every real one on event count.
 *
 * @param {object}   env    process.env, injectable for tests
 * @param {string}   devDir resolved workspace root
 * @param {string[]} extra  caller-supplied additions (e.g. CARTOGRAPHER_PROFILE_EXCLUDE)
 */
export function nonProjectNames(env = process.env, devDir = '', extra = []) {
  return new Set([
    ...STATIC_NON_PROJECTS,
    path.basename(env.HOME || ''),
    path.basename(devDir || ''),
    ...extra.map((s) => String(s).trim()).filter(Boolean),
  ]);
}

/** True when `name` names filesystem scaffolding, a worktree, or nothing. */
export function isNonProject(name, names = nonProjectNames()) {
  const value = String(name ?? '').trim();
  if (!value) return true;
  if (names.has(value)) return true;
  return WORKTREE_NAME.test(value) || AGENT_WORKTREE_NAME.test(value);
}
