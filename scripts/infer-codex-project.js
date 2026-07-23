#!/usr/bin/env node

// Infer the repository a Codex desktop session actually worked in. Desktop
// sessions often report the shared workspace root as their cwd, while tool
// calls carry the more useful per-command workdir.

import { readFileSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';

const [transcript, workspaceRoot] = process.argv.slice(2);
if (!transcript || !workspaceRoot) {
  console.error('Usage: infer-codex-project.js TRANSCRIPT WORKSPACE_ROOT');
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

for (const line of readFileSync(transcript, 'utf8').split('\n')) {
  if (!line) continue;
  let record;
  try { record = JSON.parse(line); } catch { continue; }

  if (record.type === 'session_meta') {
    sessionCwd ||= record.payload?.cwd || '';
    continue;
  }

  if (record.type !== 'response_item' || record.payload?.type !== 'custom_tool_call') continue;
  const input = typeof record.payload.input === 'string'
    ? record.payload.input
    : JSON.stringify(record.payload.input || {});

  for (const match of input.matchAll(/["']workdir["']\s*:\s*["']([^"']+)["']/g)) {
    addCandidate(match[1]);
  }
}

const cwdProject = projectUnderRoot(sessionCwd);
if (cwdProject) {
  process.stdout.write(`${cwdProject}\n`);
  process.exit(0);
}

const winner = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];
process.stdout.write(`${winner || sessionCwd.split(sep).filter(Boolean).at(-1) || 'unknown'}\n`);
