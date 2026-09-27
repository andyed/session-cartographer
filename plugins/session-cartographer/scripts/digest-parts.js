/**
 * digest-parts.js — the pieces the session digest and the day digest share.
 *
 * Both panels read the same hook events and have to agree about them: a commit
 * subject recovered one way in the session panel and another way in the day
 * panel is two answers to "what landed", and the reader has no way to tell
 * which is right. So commit parsing, edit-path resolution, and live repo state
 * live here once, lifted out of session-digest.js unchanged.
 */
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { isResolved } from './sentinels.js';

export function fmtDuration(ms) {
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  return `${h}h${String(mins % 60).padStart(2, '0')}m`;
}

export const truncate = (text, max) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);
export const abbrev = (n) => (n >= 10000 ? `${(n / 1000).toFixed(1)}k` : String(n));

const SPARK = '▁▂▃▄▅▆▇█';
/** One glyph per bin, scaled to the peak. An empty bin is a gap, not a low bar. */
export function sparkline(bins) {
  const peak = Math.max(...bins);
  return bins.map((n) => {
    if (n === 0) return '·';
    return SPARK[Math.min(SPARK.length - 1, Math.floor((n / peak) * SPARK.length))];
  }).join('');
}

// Commit summaries carry escaped newlines and a trailing `| files:` tail from
// the hook's flattening pass. Recover just the subject line.
export function commitParts(summary) {
  const text = String(summary || '');
  const m = text.match(/Commit ([0-9a-f]{6,40}):\s*([\s\S]*)$/);
  if (!m) return null;
  const subject = m[2]
    .split(/\\n|\n/)[0]
    .split(' | files:')[0]
    .replace(/["',]\s*$/, '')
    .trim();
  const typeMatch = text.match(/^\[([a-z]+)\]/);
  return { hash: m[1].slice(0, 7), sha: m[1], subject, type: typeMatch ? typeMatch[1] : 'other' };
}

// Relativize against the project segment, not cwd: the same file edited from
// the repo root and from a subdirectory must collapse to one entry. An agent
// worktree is a checkout of the same repository, so its prefix goes too —
// otherwise one file edited in the main checkout and in
// `.claude/worktrees/inspiring-williamson-a3dcd0/` reads as two files.
const WORKTREE_PREFIX = /^\.claude\/worktrees\/[^/]+\//;
export function relativize(abs, project, dev, home = process.env.HOME) {
  if (isResolved(project)) {
    const marker = `/${project}/`;
    const at = abs.lastIndexOf(marker);
    if (at >= 0) return abs.slice(at + marker.length).replace(WORKTREE_PREFIX, '');
  }
  if (abs.startsWith(`${dev}/`)) return abs.slice(dev.length + 1);
  return home && abs.startsWith(`${home}/`) ? `~/${abs.slice(home.length + 1)}` : abs;
}

// The hook's bash-path detector reads shell source text, so it emits JS
// property access (`errors.push`, `console.log`) alongside real files —
// 58% of its candidates, corpus-wide. Existence on disk is the filter, and it
// is the same question the panel's "touched" already implies. Unlike the
// Explorer's resolver this does not confine itself to the indexed corpus: the
// digest only names a file rather than serving it, and edits to ~/.claude
// memory files are real session work.
export function createEditResolver() {
  const resolvedEdits = new Map();
  return function resolveEditedFile(candidate, cwd) {
    if (typeof candidate !== 'string') return null;
    let value = candidate.trim();
    if (/^(["'`]).*\1$/.test(value)) value = value.slice(1, -1);
    if (!value || value.includes('\0')) return null;
    if (!path.isAbsolute(value) && !(typeof cwd === 'string' && path.isAbsolute(cwd))) return null;
    const absolute = path.isAbsolute(value) ? value : path.resolve(cwd, value);
    if (!resolvedEdits.has(absolute)) {
      let hit = null;
      try { hit = fs.statSync(absolute).isFile() ? absolute : null; } catch { hit = null; }
      resolvedEdits.set(absolute, hit);
    }
    return resolvedEdits.get(absolute);
  };
}

// GIT_OPTIONAL_LOCKS=0: a digest runs while other sessions commit, and a
// `git status` that refreshes the index takes index.lock, which makes their
// commit fail. Read-only means not taking that lock either.
export function git(dir, argv) {
  return execFileSync('git', ['-C', dir, ...argv], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  }).trim();
}

// Live git state for a directory. This is the part that is not in any log — it
// is what the work is leaving behind right now.
export function repoState(dir) {
  try {
    const root = git(dir, ['rev-parse', '--show-toplevel']);
    const branch = git(dir, ['branch', '--show-current']) || 'detached';
    const dirty = git(dir, ['status', '--porcelain']).split('\n').filter(Boolean).length;
    let unpushed = null;
    try {
      unpushed = git(dir, ['rev-list', '--count', '@{u}..HEAD']);
    } catch { unpushed = null; } // no upstream configured
    return { root, name: path.basename(root), branch, dirty, unpushed };
  } catch {
    return null;
  }
}
