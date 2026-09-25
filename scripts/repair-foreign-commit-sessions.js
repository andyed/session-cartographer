#!/usr/bin/env node
// repair-foreign-commit-sessions.js — detach inferred sessions from other people's commits.
//
// backfill-git-history.sh imported every contributor's commits from repositories
// that were only cloned (another person's app, a tool under evaluation). Then
// enrich-sessions.js gave session-less events the session whose time window they
// fell in, with no author check, so a stranger's commit landing during one of the
// owner's sessions became that session's work. ownership.js trusts a commit that
// carries a session "whatever the commit author says" — the right call for
// agent-authored commits the hook recorded live, and exactly wrong here — so the
// ingest-time owner filter (68a6a96) never caught these rows. Search, digests,
// /standup and frecency all read them as the owner's activity.
//
// A row is repaired only when all hold:
//   - type git_commit, with a session_id;
//   - it has the backfill shape (commit_hash + author, no cwd): the live hook
//     records cwd, so a hook-recorded commit is never touched;
//   - its author is not one of ownership.js's owner names.
//
// session_id and the inferred transcript_path are removed; the old values move
// to session_detached_from / transcript_detached_from so the edit is visible and
// reversible. The commit itself stays: it is accurate history of that repo.
//
// Usage: node scripts/repair-foreign-commit-sessions.js [--apply] [--dev <dir>]

import fs from 'fs';
import os from 'os';
import path from 'path';
import { ownerNames } from './ownership.js';

const APPLY = process.argv.includes('--apply');
const devFlag = process.argv.indexOf('--dev');
const DEV = devFlag > -1 ? process.argv[devFlag + 1]
  : (process.env.CARTOGRAPHER_DEV_DIR || path.join(os.homedir(), 'Documents', 'dev'));
const LOG = path.join(DEV, 'changelog.jsonl');

export function isForeignInferred(e, owners) {
  return e?.type === 'git_commit'
    && typeof e.session_id === 'string' && e.session_id !== ''
    && !('cwd' in e)
    && typeof e.commit_hash === 'string'
    && typeof e.author === 'string' && e.author !== ''
    && !owners.has(e.author);
}

export function detach(e) {
  const out = { ...e, session_detached_from: e.session_id };
  delete out.session_id;
  if ('transcript_path' in e) {
    out.transcript_detached_from = e.transcript_path;
    delete out.transcript_path;
  }
  return out;
}

function main() {
  if (!fs.existsSync(LOG)) { console.error(`No changelog at ${LOG}`); process.exit(2); }
  const owners = ownerNames();
  const raw = fs.readFileSync(LOG, 'utf8');
  const readSize = Buffer.byteLength(raw);
  const lines = raw.split('\n');
  const byAuthor = new Map();
  const sessions = new Set();
  const ids = [];
  let repaired = 0;
  const out = lines.map((line) => {
    if (!line.trim()) return line;
    let e;
    try { e = JSON.parse(line); } catch { return line; } // never rewrite what we cannot parse
    if (!isForeignInferred(e, owners)) return line;
    repaired++;
    const k = `${e.author} · ${e.project}`;
    byAuthor.set(k, (byAuthor.get(k) || 0) + 1);
    sessions.add(e.session_id);
    ids.push(e.event_id);
    return JSON.stringify(detach(e));
  });

  console.log(`Owner names: ${[...owners].join(', ')}`);
  console.log(`Changelog:   ${LOG} (${lines.filter((l) => l.trim()).length} rows)`);
  console.log(`\nForeign commits carrying an inferred session: ${repaired}, across ${sessions.size} of the owner's sessions`);
  for (const [k, n] of [...byAuthor.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${k}`);

  if (!APPLY) {
    console.log('\nDry run — nothing written. Pass --apply to rewrite changelog.jsonl (a .bak copy is kept).');
    return;
  }
  const backup = `${LOG}.bak-foreign-sessions`;
  fs.copyFileSync(LOG, backup);
  // Write beside, then rename: a crash mid-write must not truncate the log.
  // Hooks in other sessions append to this log continuously. Carry over any rows
  // appended since the read, then rename only if nothing more arrived meanwhile.
  const tmp = `${LOG}.tmp-foreign-sessions`;
  let body = out.join('\n');
  for (let attempt = 0; ; attempt++) {
    const size = fs.statSync(LOG).size;
    const appended = size > readSize ? fs.readFileSync(LOG).subarray(readSize).toString('utf8') : '';
    fs.writeFileSync(tmp, body + appended);
    if (fs.statSync(LOG).size === size) { fs.renameSync(tmp, LOG); break; }
    if (attempt >= 5) { fs.rmSync(tmp); console.error('Log kept growing during the rewrite; nothing applied. Retry.'); process.exit(1); }
  }
  fs.writeFileSync(path.join(DEV, '.carto', 'foreign-sessions-detached.txt'), ids.join('\n') + '\n');
  console.log(`\nApplied. Backup: ${backup}`);
  console.log(`Event ids: ${path.join(DEV, '.carto', 'foreign-sessions-detached.txt')}`);
  // No re-index: imported commits are embedded without session_id, so the
  // semantic payloads never carried the inferred session (checked 2026-09-24).
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) main();
