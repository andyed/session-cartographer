#!/usr/bin/env node
/**
 * copy-blocked-images.js — copy the images the Explorer cannot open into its
 * protected-copies folder, so the image wall and session review show them
 * without granting the Explorer access to ~/Downloads and similar folders.
 *
 * The Explorer runs under launchd, and macOS may give that process no access
 * to privacy-protected folders: an open either stalls on a prompt nobody sees
 * or is refused outright once someone declined it. This script asks the
 * running Explorer which named images it could not read, then copies each one.
 * Run it from a process that can read those folders: a terminal, or an
 * agent's shell.
 *
 *   node scripts/copy-blocked-images.js [--days 90] [--explorer http://127.0.0.1:2527] [--dry-run]
 *
 * Only regular image files inside a protected folder are copied, never
 * symlinks or anything over 64 MiB, and each copy keeps its original's mtime,
 * because the wall decides "written in a session" from it.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { copyPathFor, defaultCopyDir, protectedRoot } from '../explorer/server/guarded-open.js';

const IMAGE_EXT = /\.(?:png|jpe?g|gif|webp|svg|avif|bmp|ico)$/i;
const MAX_BYTES = 64 * 1024 * 1024;

/** Decide what to copy: `{ copy: [{ from, to }], skipped: [{ file, reason }] }`. Reads metadata only. */
export function planCopies(files, { copyDir = defaultCopyDir(), home = os.homedir() } = {}) {
  const copy = [], skipped = [];
  for (const file of new Set(files)) {
    const skip = reason => skipped.push({ file, reason });
    if (typeof file !== 'string' || !path.isAbsolute(file)) { skip('not an absolute path'); continue; }
    if (!IMAGE_EXT.test(file)) { skip('not an image'); continue; }
    if (protectedRoot(file, home) === file) { skip('not in a protected folder'); continue; }
    let stat;
    try { stat = fs.lstatSync(file); } catch { skip('missing'); continue; }
    if (!stat.isFile()) { skip(stat.isSymbolicLink() ? 'symlink' : 'not a regular file'); continue; }
    if (stat.size > MAX_BYTES) { skip('over 64 MiB'); continue; }
    copy.push({ from: file, to: copyPathFor(file, copyDir), mtime: stat.mtime, atime: stat.atime, size: stat.size });
  }
  return { copy, skipped };
}

/** Copy through a temporary name, so the Explorer never sees half a file. */
export function copyOne({ from, to, mtime, atime }) {
  fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 });
  const temp = `${to}.${process.pid}.tmp`;
  try {
    fs.copyFileSync(from, temp);
    fs.utimesSync(temp, atime, mtime);
    fs.renameSync(temp, to);
  } finally { fs.rmSync(temp, { force: true }); }
}

async function main(argv) {
  const option = (name, fallback) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback; };
  const days = Number(option('--days', '90'));
  const explorer = option('--explorer', 'http://127.0.0.1:2527');
  const dryRun = argv.includes('--dry-run');
  const url = `${explorer}/api/images/collection?${new URLSearchParams({ days: String(days), scope: 'named' })}`;
  const response = await fetch(url).catch(error => { throw new Error(`The Explorer at ${explorer} did not answer: ${error.message}`); });
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  const { stats } = await response.json();
  const files = stats?.blockedFiles || [];
  const { copy, skipped } = planCopies(files);
  const copied = [];
  for (const item of copy) {
    if (dryRun) { copied.push(item); continue; }
    // This process may be refused the same folder; say so per file and go on.
    try { copyOne(item); copied.push(item); }
    catch (error) { skipped.push({ file: item.from, reason: ['EPERM', 'EACCES'].includes(error.code) ? 'this process may not read it either; run from Terminal' : error.message }); }
  }
  const copyDir = defaultCopyDir();
  console.log(`${dryRun ? 'Would copy' : 'Copied'} ${copied.length} of ${files.length} blocked image${files.length === 1 ? '' : 's'} into ${copyDir}`);
  for (const item of copied) console.log(`  ${item.from}`);
  for (const item of skipped) console.log(`  skipped (${item.reason}): ${item.file}`);
  if (skipped.some(item => item.reason.startsWith('this process'))) process.exitCode = 1;
  if (!files.length) console.log(`The Explorer reports no blocked images in the last ${days} days (${(stats?.blockedRoots || []).join(', ') || 'no blocked folders'}).`);
  else if (!dryRun && copied.length) console.log('The wall shows them on its next load; session review on its next listing.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
