#!/usr/bin/env node
// migrate-project-attribution.js — repoint events that were filed under a worktree name.
//
// Before 0.7 every hook derived the project as `basename $(git rev-parse
// --show-toplevel)`. Inside a git worktree that basename is the WORKTREE directory,
// so a session run in repo/.claude/worktrees/agent-a4b1610b7457c11fa was filed under
// the project "agent-a4b1610b7457c11fa". Agent worktrees are created automatically,
// so each throwaway directory became a phantom project owning real history — history
// that never surfaces under a /remember scoped to the actual repo.
//
// THIS IS TIME-SENSITIVE. The repair works by asking git to resolve each recorded cwd
// to its parent repo, which only answers while the worktree directory still exists.
// Prune the worktrees first and the mapping is gone for good. Run this BEFORE any
// `git worktree prune` housekeeping.
//
// Only the `project` field is rewritten, and a `project_repointed_from` key is added
// so the edit is visible. `cwd` and `git_branch` are accurate history and are left
// exactly as they were.
//
// Usage: node scripts/migrate-project-attribution.js [--apply] [--dev <dir>]

import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const APPLY = process.argv.includes('--apply');
const devFlag = process.argv.indexOf('--dev');
const DEV = devFlag > -1 ? process.argv[devFlag + 1]
  : (process.env.CARTOGRAPHER_DEV_DIR || path.join(os.homedir(), 'Documents', 'dev'));

// The four searched logs. Anything written elsewhere is unreachable anyway.
const LOGS = ['changelog.jsonl', 'research-log.jsonl',
              'session-milestones.jsonl', 'tool-use-log.jsonl'];

const resolveCache = new Map();

/** Parent-repo name for a directory, or null. Mirrors cartographer_project in common.sh. */
function parentRepo(dir) {
  if (resolveCache.has(dir)) return resolveCache.get(dir);
  let out = null;
  try {
    if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
      const common = execFileSync('git',
        ['-C', dir, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      // Only trust a common dir literally named .git — a bare repo (repo.git) would
      // otherwise resolve to the name of its parent directory.
      if (common.endsWith('/.git')) out = path.basename(path.dirname(common));
    }
  } catch { /* not a repo, or git unavailable */ }
  resolveCache.set(dir, out);
  return out;
}

/**
 * Only repoint when the record carries the bug's exact signature: the stored project
 * IS the basename of the recorded cwd (or of that cwd's own toplevel), and the parent
 * repo is something else. That leaves alone any project set by another code path —
 * notably log-tool-use's FILE_REPO branch, which is legitimately not the cwd.
 */
function shouldRepoint(ev) {
  if (!ev || typeof ev !== 'object') return null;
  const cwd = ev.cwd;
  if (!cwd || typeof cwd !== 'string' || !ev.project) return null;
  if (ev.project_repointed_from) return null;            // idempotent: already done
  const parent = parentRepo(cwd);
  if (!parent || parent === ev.project) return null;
  if (ev.project !== path.basename(cwd)) return null;    // not the bug's signature
  return parent;
}

function idsOf(lines) {
  const s = new Set();
  for (const l of lines) {
    const m = /"event_id"\s*:\s*"([^"]+)"/.exec(l);
    if (m) s.add(m[1]);
  }
  return s;
}

let totalMoved = 0, totalUnresolvable = 0;
const byProject = new Map();
const stamp = new Date().toISOString().replace(/[:.]/g, '-');

for (const name of LOGS) {
  const file = path.join(DEV, name);
  if (!fs.existsSync(file)) { console.log(`  ${name.padEnd(26)} not present, skipped`); continue; }

  const sizeBefore = fs.statSync(file).size;
  const raw = fs.readFileSync(file, 'utf8');
  const lines = raw.split('\n');
  const trailingNewline = lines[lines.length - 1] === '';
  const body = trailingNewline ? lines.slice(0, -1) : lines;

  let moved = 0, unresolvable = 0;
  const out = body.map((line) => {
    if (!line.trim()) return line;
    let ev;
    try { ev = JSON.parse(line); } catch { return line; }   // never drop a bad line
    const cwd = ev && ev.cwd;
    if (cwd && ev.project && /worktrees?\//.test(cwd) && !fs.existsSync(cwd)) unresolvable++;
    const parent = shouldRepoint(ev);
    if (!parent) return line;
    byProject.set(ev.project, (byProject.get(ev.project) || 0) + 1);
    moved++;
    ev.project_repointed_from = ev.project;
    ev.project = parent;
    return JSON.stringify(ev);                              // single line, as the pipeline requires
  });

  totalMoved += moved; totalUnresolvable += unresolvable;
  console.log(`  ${name.padEnd(26)} ${String(body.length).padStart(7)} events   ` +
              `${String(moved).padStart(5)} to repoint   ${String(unresolvable).padStart(5)} unresolvable`);

  if (!APPLY || moved === 0) continue;

  // Back up unconditionally. This file takes live appends from other sessions.
  const backup = `${file}.bak-${stamp}`;
  fs.copyFileSync(file, backup);

  // Anything appended while we were working is beyond sizeBefore; carry it across
  // verbatim rather than truncating it away.
  const fd = fs.openSync(file, 'r');
  const tailLen = fs.statSync(file).size - sizeBefore;
  let tail = '';
  if (tailLen > 0) {
    const buf = Buffer.alloc(tailLen);
    fs.readSync(fd, buf, 0, tailLen, sizeBefore);
    tail = buf.toString('utf8');
  }
  fs.closeSync(fd);

  const tmp = `${file}.tmp-${stamp}`;
  fs.writeFileSync(tmp, out.join('\n') + (trailingNewline ? '\n' : '') + tail);
  fs.renameSync(tmp, file);

  // Verify by event-id SET comparison, not line counts — a concurrent append can mask
  // a loss that a count check would pass.
  const beforeIds = idsOf(body.concat(tail.split('\n')));
  const afterIds = idsOf(fs.readFileSync(file, 'utf8').split('\n'));
  const lost = [...beforeIds].filter((i) => !afterIds.has(i));
  if (lost.length) {
    fs.copyFileSync(backup, file);
    console.error(`  !! ${name}: ${lost.length} event id(s) lost — RESTORED from ${path.basename(backup)}`);
    process.exitCode = 1;
  } else {
    console.log(`     applied, ${beforeIds.size} event ids intact, backup ${path.basename(backup)}`);
  }
}

console.log();
if (byProject.size) {
  console.log('  phantom projects that would be repointed:');
  [...byProject.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)
    .forEach(([p, n]) => console.log(`    ${String(n).padStart(6)}  ${p}`));
  if (byProject.size > 12) console.log(`    ... and ${byProject.size - 12} more`);
  console.log();
}
console.log(`  ${totalMoved} event(s) ${APPLY ? 'repointed' : 'would be repointed'}` +
            ` across ${byProject.size} phantom project(s)`);
if (totalUnresolvable) {
  console.log(`  ${totalUnresolvable} event(s) reference a worktree that no longer exists —` +
              ` already orphaned, not recoverable.`);
}
if (!APPLY && totalMoved) console.log('\n  dry run. re-run with --apply to write.');
