#!/usr/bin/env node
/**
 * Pre-edit collision check: has another session touched the file this edit is
 * about to change?
 *
 * /standup answers that for a whole window, but only when someone thinks to
 * run it, and the collision it exists for is the one nobody thinks to check.
 * This runs as a PreToolUse hook on every edit and stays silent unless a peer
 * session edited or committed the same file recently. Then it adds a short note
 * to the agent's context. It never blocks: a collision is a reason to look, not
 * a reason to refuse, and a hook that denies edits on a heuristic would get
 * turned off.
 *
 * The two cases call for different actions, so the note names which one it is:
 *
 * - Same checkout. The peer's changes to this file may still be uncommitted,
 *   and a commit from this session would sweep their hunks in as its own.
 *   (Claude Code's Edit already refuses a file changed since it was read, so
 *   stale content is not the risk; mixed authorship is.)
 * - Separate worktree. Both branches now change one file; the conflict arrives
 *   at merge time, when it is most expensive.
 *
 * Budget. It runs before every edit, so it reads only the changelog tail and
 * JSON-parses only lines that mention the target file's basename. A warning is
 * repeated only when the peer has touched the file again since the last one.
 *
 * Fail open. Any error, missing log, or unparseable input exits 0 with no
 * output, so the edit proceeds exactly as it would without the hook.
 *
 * Env:
 *   CARTOGRAPHER_COLLISION_CHECK=0        disable
 *   CARTOGRAPHER_COLLISION_WINDOW=45m     how far back a peer touch counts (m/h)
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync, realpathSync } from 'fs';
import { join, basename, isAbsolute, resolve as resolvePath } from 'path';
import { homedir, tmpdir } from 'os';
import { HOUR, fmtAge, readTail, eventFiles, contentionKey } from './contention.js';
import { isResolved } from './sentinels.js';

const DEFAULT_WINDOW_MS = 45 * 60e3;

function parseWindow(s) {
  const m = String(s ?? '').match(/^(\d+(?:\.\d+)?)\s*([mh])$/i);
  if (!m) return DEFAULT_WINDOW_MS;
  const ms = parseFloat(m[1]) * (m[2].toLowerCase() === 'h' ? HOUR : 60e3);
  return Number.isFinite(ms) && ms > 0 ? ms : DEFAULT_WINDOW_MS;
}

/** Absolute target paths for an edit-shaped tool call; empty when there are none. */
export function targetPaths(input) {
  const tool = input?.tool_name;
  const ti = input?.tool_input || {};
  const cwd = typeof input?.cwd === 'string' ? input.cwd : null;
  let raw = [];
  if (tool === 'apply_patch') {
    // Codex patches name their files in headers; same pattern log-tool-use.sh records.
    const patch = String(ti.patch ?? ti.input ?? '');
    raw = [...patch.matchAll(/^\*\*\* (?:Update|Delete) File: (.+)$/gm)].map((m) => m[1].trim());
  } else {
    const p = ti.file_path ?? ti.notebook_path;
    if (typeof p === 'string') raw = [p];
  }
  return [...new Set(raw
    .filter((p) => p && !p.includes('\0'))
    .map((p) => (isAbsolute(p) ? p : cwd ? resolvePath(cwd, p) : null))
    .filter(Boolean))];
}

/**
 * Peer touches of `targets` within the window, newest per (file, peer).
 * Pure over its inputs so tests can drive it with a synthetic changelog.
 */
export function findCollisions({ changelog, targets, selfId, now, windowMs }) {
  if (!targets.length || !existsSync(changelog)) return [];
  const wanted = new Map(targets.map((t) => [contentionKey(t), t]));
  const names = [...new Set(targets.map((t) => basename(t)))];
  const events = readTail(changelog, windowMs, (line) => names.some((n) => line.includes(n)));
  const hits = new Map();
  for (const e of events) {
    if (e.type !== 'tool_file_edit' && e.type !== 'git_commit') continue;
    const id = e.session_id;
    if (!isResolved(id) || id === selfId) continue;
    const t = Date.parse(e.timestamp);
    if (!Number.isFinite(t) || t < now - windowMs || t > now + 60e3) continue;
    for (const f of eventFiles(e).files) {
      const key = contentionKey(f);
      if (!wanted.has(key)) continue;
      const k = `${key}\u0000${id}`;
      const prev = hits.get(k);
      if (prev && prev.t >= t) continue;
      hits.set(k, {
        key, target: wanted.get(key), peerPath: f, t, session: id,
        provider: e.provider || '?', project: e.project || '', kind: e.type === 'git_commit' ? 'commit' : 'edit',
        commit: e.type === 'git_commit' ? ((e.summary || '').match(/Commit\s+([0-9a-f]{6,40})/) || [])[1] || null : null,
      });
    }
  }
  return [...hits.values()].sort((a, b) => b.t - a.t);
}

/**
 * Did the peer touch this file through a different checkout? Same contention
 * key, different real path. Raw strings are not enough: /tmp and /private/tmp
 * are one checkout on macOS, not two worktrees.
 */
function real(p) { try { return realpathSync(p); } catch { return p; } }
export function isSplit(hit) { return real(hit.peerPath) !== real(hit.target); }

function note(hit, now) {
  const shown = hit.target.replace(homedir(), '~');
  const who = `${hit.provider} session ${hit.session.slice(0, 8)}${hit.project ? ` (${hit.project})` : ''}`;
  const age = fmtAge(Math.max(0, now - hit.t));
  const what = hit.kind === 'commit' ? `committed it${hit.commit ? ` in ${hit.commit.slice(0, 8)}` : ''}` : 'edited it';
  if (isSplit(hit)) {
    return `${shown}: ${who} ${what} ${age} ago in a separate worktree (${hit.peerPath.replace(homedir(), '~')}). ` +
      'Both branches now change this file; expect a conflict at merge and coordinate before integrating.';
  }
  if (hit.kind === 'commit') {
    return `${shown}: ${who} ${what} ${age} ago in this checkout. Re-read the file if your view of it predates that commit.`;
  }
  return `${shown}: ${who} ${what} ${age} ago in this checkout. Their changes may be uncommitted here — ` +
    `check \`git diff -- ${basename(hit.target)}\` and do not commit their hunks as this session's work.`;
}

/** Suppress repeats: warn again only when the peer touched the file after the last warning. */
function freshOnly(hits, selfId) {
  const dir = join(tmpdir(), 'session-cartographer');
  const file = join(dir, `collision-${String(selfId).replace(/[^A-Za-z0-9_-]/g, '_')}.json`);
  let seen = {};
  try { seen = JSON.parse(readFileSync(file, 'utf-8')) || {}; } catch { seen = {}; }
  const fresh = hits.filter((h) => !(seen[`${h.key}\u0000${h.session}`] >= h.t));
  if (fresh.length) {
    for (const h of fresh) seen[`${h.key}\u0000${h.session}`] = h.t;
    try { mkdirSync(dir, { recursive: true }); writeFileSync(file, JSON.stringify(seen)); } catch { /* repeats are tolerable */ }
  }
  return fresh;
}

function main() {
  if (process.env.CARTOGRAPHER_COLLISION_CHECK === '0') return;
  let input;
  try { input = JSON.parse(readFileSync(0, 'utf-8')); } catch { return; }
  const selfId = input?.session_id;
  if (!isResolved(selfId)) return;
  const targets = targetPaths(input);
  if (!targets.length) return;

  const dev = process.env.CARTOGRAPHER_DEV_DIR || join(homedir(), 'Documents/dev');
  const now = Date.now();
  const hits = freshOnly(findCollisions({
    changelog: join(dev, 'changelog.jsonl'), targets, selfId, now,
    windowMs: parseWindow(process.env.CARTOGRAPHER_COLLISION_WINDOW),
  }), selfId);
  if (!hits.length) return;

  // Record what was surfaced so the check can later be judged on whether it
  // preceded a real conflict, the same way /remember is judged on use.
  try {
    const log = join(dev, '.carto', 'collision-warnings.jsonl');
    for (const h of hits) {
      appendFileSync(log, JSON.stringify({
        timestamp: new Date(now).toISOString(), self: selfId, peer: h.session, file: h.key,
        kind: h.kind, split: isSplit(h), age_ms: now - h.t,
      }) + '\n');
    }
  } catch { /* telemetry never blocks the note */ }

  const lines = hits.slice(0, 3).map((h) => `- ${note(h, now)}`);
  if (hits.length > 3) lines.push(`- … ${hits.length - 3} more; run /standup for the full view.`);
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      additionalContext: `[carto collision] Another session touched a file this edit changes:\n${lines.join('\n')}`,
    },
  }));
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  try { main(); } catch { /* fail open: the edit proceeds */ }
}
