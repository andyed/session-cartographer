/**
 * File contention primitives shared by /standup and the pre-edit collision hook.
 *
 * Both answer "did another session touch this file", and a second copy of any
 * of these would drift: the edit-summary parsing, the worktree collapse, and
 * the tail budget each encode a silent under-report that was fixed once.
 */

import { statSync, realpathSync, openSync, readSync, closeSync } from 'fs';
import { execFileSync } from 'child_process';
import { join, dirname, isAbsolute, resolve as resolvePath } from 'path';
import { editSummaryPaths } from './edit-paths.js';

export const HOUR = 3600e3;

export function fmtAge(ms) {
  const min = Math.round(ms / 60e3);
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  return `${h}h${String(min % 60).padStart(2, '0')}m`;
}

/**
 * Read only the tail of the changelog. It is ~69 MB and grows; a full parse to
 * answer a 6-hour question is the kind of cost that makes a command not get
 * run. Budget bytes from the window, floored generously — a short read that
 * misses the window start would silently under-report contention, which is the
 * one failure mode this tool cannot have.
 *
 * `keepLine` filters raw lines before JSON.parse. The pre-edit collision hook
 * runs on every edit and only cares about lines naming one file, so it skips
 * parsing the rest of an 8 MB tail.
 */
export function readTail(path, windowMs, keepLine = null) {
  const size = statSync(path).size;
  const bytes = Math.min(size, Math.max(8e6, Math.ceil(windowMs / HOUR) * 2e6));
  const fd = openSync(path, 'r');
  const buf = Buffer.alloc(bytes);
  readSync(fd, buf, 0, bytes, size - bytes);
  closeSync(fd);
  const text = buf.toString('utf-8');
  // Drop the first line: reading mid-file almost certainly split a record.
  return (bytes < size ? text.slice(text.indexOf('\n') + 1) : text)
    .split('\n')
    .filter((l) => l.trim() && (!keepLine || keepLine(l)))
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

export const COMMIT_RE = /Commit\s+([0-9a-f]{6,40}):\s*([^|]*)(?:\|\s*files:\s*(.*))?$/;

/**
 * Resolve an edit candidate to an absolute file, loosely.
 *
 * Same policy as session-digest's resolver and for the same reason: this names
 * files rather than serving them, so confining to the indexed corpus would drop
 * real edits. It is also what `editSummaryPaths` needs to tell a filename
 * containing a comma from the hook's comma-separated multi-file form.
 */
const resolvedEdits = new Map();
export function resolveEditedFile(candidate, cwd) {
  if (typeof candidate !== 'string') return null;
  let value = candidate.trim();
  if (/^(["'`]).*\1$/.test(value)) value = value.slice(1, -1);
  if (!value || value.includes('\0')) return null;
  if (!isAbsolute(value) && !(typeof cwd === 'string' && isAbsolute(cwd))) return null;
  const absolute = isAbsolute(value) ? value : resolvePath(cwd, value);
  if (!resolvedEdits.has(absolute)) {
    let hit = null;
    try { hit = statSync(absolute).isFile() ? absolute : null; } catch { hit = null; }
    resolvedEdits.set(absolute, hit);
  }
  return resolvedEdits.get(absolute);
}

/**
 * Files an event touched, as repo-relative paths.
 *
 * Edit summaries are parsed by edit-paths.js, not here. A bare /^Modified:\s+(\S+)/
 * looks adequate and is not: the hook writes bash-mediated edits as
 * `Modified: src/a.js,src/b.js (via bash)`, which that pattern turns into one
 * fabricated filename — so two sessions editing the same file through different
 * tools would never collide, and contention would under-report silently.
 */
export function eventFiles(e) {
  if (e.type === 'tool_file_edit') {
    const files = [];
    let unresolved = 0;
    for (const c of editSummaryPaths(e.summary, (v) => resolveEditedFile(v, e.cwd))) {
      const abs = resolveEditedFile(c, e.cwd);
      if (abs) files.push(abs);
      else unresolved++;
    }
    return { files, unresolved };
  }
  if (e.type === 'git_commit') {
    const m = (e.summary || '').match(COMMIT_RE);
    if (!m || !m[3]) return { files: [], unresolved: 0 };
    return {
      files: m[3].split(',').map((f) => f.trim()).filter(Boolean)
        .map((f) => (isAbsolute(f) || !e.cwd ? f : resolvePath(e.cwd, f))),
      unresolved: 0,
    };
  }
  return { files: [], unresolved: 0 };
}

/**
 * Collapse a worktree file onto the repository file it represents.
 *
 * Agent control rooms put a worktree behind every task, so the emerging default
 * collision is one agent in `repo/js/x.js` and another in
 * `repo/.claude/worktrees/<name>/js/x.js`. Those are two absolute paths and one
 * file, and keying on the path alone makes exactly the collision this tool
 * exists for invisible. The real path is kept for display; only the contention
 * key is canonical. Codex worktrees live outside the repository, so their
 * Git common directory identifies the main checkout. Cache that lookup per
 * worktree: a directory name alone is not proof that two repositories match.
 */
const WORKTREE_SEGMENT = /\/\.claude\/worktrees\/[^/]+(?=\/)/;
const CODEX_WORKTREE = /\/\.codex\/worktrees\/[^/]+\/[^/]+(?=\/)/;
const codexWorktreeRoots = new Map();
export const unmappedWorktrees = new Set();
export function contentionKey(absolutePath) {
  // Git resolves macOS's /var alias to /private/var. Canonicalise an existing
  // file first so the worktree's common-dir and a main-checkout edit share a key.
  let filePath = absolutePath;
  try { filePath = realpathSync(absolutePath); } catch { /* Commits may name a deleted file. */ }
  const claudePath = filePath.replace(WORKTREE_SEGMENT, '');
  if (claudePath !== filePath) return claudePath;
  const match = CODEX_WORKTREE.exec(filePath);
  if (!match) return filePath;
  const worktreeRoot = filePath.slice(0, match.index + match[0].length);
  if (!codexWorktreeRoots.has(worktreeRoot)) {
    let mainRoot = null;
    try {
      const common = execFileSync('git', ['-C', worktreeRoot, 'rev-parse', '--path-format=absolute', '--git-common-dir'], {
        encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000,
      }).trim();
      if (common.endsWith('/.git')) mainRoot = dirname(common);
    } catch { /* A vanished worktree cannot be matched safely. */ }
    codexWorktreeRoots.set(worktreeRoot, mainRoot);
    if (!mainRoot) unmappedWorktrees.add(worktreeRoot);
  }
  const mainRoot = codexWorktreeRoots.get(worktreeRoot);
  return mainRoot ? join(mainRoot, filePath.slice(worktreeRoot.length)) : filePath;
}
