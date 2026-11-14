#!/usr/bin/env node

// Infer the repository a Codex desktop session actually worked in. Desktop
// sessions often report the shared workspace root as their cwd, while tool
// calls carry the more useful per-command workdir.
//
// TRANSCRIPT is a rollout path in either spelling: Codex zstd-compresses a
// rollout in place about a week after its session, and a path ending
// .jsonl.zst is read through transcript-file.js. `-` reads rows from stdin,
// which is how retro-index.sh hands over a rollout it has already piped
// through `zstd -dc`, so the indexer needs the zstd binary and nothing of
// this Node's zlib.
//
// Rows are streamed, not read whole: a rollout can outgrow the longest string
// Node can hold (the largest compressed one on 2026-11-13 was 206 MB on disk),
// and the first session_meta row usually settles the answer.

import { relative, resolve, sep } from 'node:path';
import { transcriptStream } from './transcript-file.js';

const [transcript, workspaceRoot] = process.argv.slice(2);
if (!transcript || !workspaceRoot) {
  console.error('Usage: infer-codex-project.js TRANSCRIPT|- WORKSPACE_ROOT');
  process.exit(2);
}

const root = resolve(workspaceRoot);
const counts = new Map();
let sessionCwd = '';

function projectUnderRoot(candidate) {
  if (!candidate || typeof candidate !== 'string') return '';
  const rel = relative(root, resolve(candidate));
  if (!rel || rel === '.' || rel.startsWith(`..${sep}`) || rel === '..') return '';
  return rel.split(sep)[0] || '';
}

function addCandidate(candidate) {
  const project = projectUnderRoot(candidate);
  if (project) counts.set(project, (counts.get(project) || 0) + 1);
}

// One name is printed, then the process ends without reading further rows.
function answer(project) {
  process.stdout.write(`${project}\n`, () => process.exit(0));
}

// True once the answer is known and no later row can change it.
function readRow(line) {
  if (!line) return false;
  let record;
  try { record = JSON.parse(line); } catch { return false; }

  if (record.type === 'session_meta') {
    sessionCwd ||= record.payload?.cwd || '';
    // The first cwd that is set is the only one consulted, and a cwd inside a
    // project wins over every workdir count.
    return Boolean(projectUnderRoot(sessionCwd));
  }

  if (record.type !== 'response_item' || record.payload?.type !== 'custom_tool_call') return false;
  const input = typeof record.payload.input === 'string'
    ? record.payload.input
    : JSON.stringify(record.payload.input || {});

  for (const match of input.matchAll(/["']workdir["']\s*:\s*["']([^"']+)["']/g)) {
    addCandidate(match[1]);
  }
  return false;
}

async function readRows() {
  const source = transcript === '-' ? process.stdin.setEncoding('utf8') : transcriptStream(transcript);
  // Split on "\n" alone, as the whole-file read did. readline also breaks a
  // row at a raw U+2028 inside a JSON string, and that row would be dropped.
  // A row can run to tens of megabytes (inline images), so only the new chunk
  // is searched for its end.
  let parts = [];
  for await (const chunk of source) {
    let start = 0;
    let end;
    while ((end = chunk.indexOf('\n', start)) >= 0) {
      parts.push(chunk.slice(start, end));
      const line = parts.length === 1 ? parts[0] : parts.join('');
      parts = [];
      if (readRow(line)) return;
      start = end + 1;
    }
    if (start < chunk.length) parts.push(chunk.slice(start));
  }
  readRow(parts.join(''));
}

try {
  await readRows();
} catch (error) {
  // An unreadable transcript is an error, never a guessed project: the caller
  // falls back or skips on a non-zero exit.
  console.error(`infer-codex-project: ${error?.message || error}`);
  process.exit(1);
}

const cwdProject = projectUnderRoot(sessionCwd);
if (cwdProject) {
  answer(cwdProject);
} else {
  const winner = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];
  answer(winner || sessionCwd.split(sep).filter(Boolean).at(-1) || 'unknown');
}
