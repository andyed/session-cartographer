/**
 * The read side of the cross-agent mailbox: where notes live and what is
 * pending. Split from the sender/deliverer module so a reader (standup) can
 * count waiting notes without importing code that appends events and starts
 * the indexer. Nothing here writes.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isResolved } from './sentinels.js';

export function devDir(env = process.env) {
  return env.CARTOGRAPHER_DEV_DIR || path.join(os.homedir(), 'Documents', 'dev');
}

export function mailboxRoot(dev = devDir()) {
  return path.join(dev, '.carto', 'mailbox');
}

/** Session ids become directory names: allow only the characters real ids use. */
export function safeSessionId(value) {
  const id = String(value ?? '').trim();
  if (!isResolved(id)) return '';
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{3,127}$/.test(id) || id.includes('..')) return '';
  return id;
}

export function readNote(file) {
  try {
    const note = JSON.parse(fs.readFileSync(file, 'utf8'));
    return note && typeof note === 'object' && typeof note.text === 'string' ? note : null;
  } catch {
    return null;
  }
}

/** Pending notes for one session, oldest first, without claiming them. */
export function pendingNotes({ dev = devDir(), session }) {
  const id = safeSessionId(session);
  if (!id) return [];
  const dir = path.join(mailboxRoot(dev), id, 'pending');
  let names;
  try { names = fs.readdirSync(dir); } catch { return []; }
  return names.filter((n) => n.endsWith('.json') && !n.startsWith('.')).sort()
    .map((n) => ({ file: path.join(dir, n), note: readNote(path.join(dir, n)) }))
    .filter((x) => x.note);
}

/** {session id: pending count} across the mailbox, for standup. */
export function pendingCounts({ dev = devDir() } = {}) {
  const root = mailboxRoot(dev);
  const out = {};
  let sessions;
  try { sessions = fs.readdirSync(root); } catch { return out; }
  for (const sid of sessions) {
    if (!safeSessionId(sid)) continue;
    let names;
    try { names = fs.readdirSync(path.join(root, sid, 'pending')); } catch { continue; }
    const n = names.filter((x) => x.endsWith('.json') && !x.startsWith('.')).length;
    if (n) out[sid] = n;
  }
  return out;
}
