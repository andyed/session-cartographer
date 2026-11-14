#!/usr/bin/env node
/**
 * codex-call-evidence.js — which Codex session made a recall call the
 * telemetry could not attribute.
 *
 * Why this exists. Codex gives an MCP child no session id, so every recall
 * made through cartographer-mcp.js under Codex is written with
 * attribution_status "no_session", and every mark against it omits call_id
 * (docs/MCP.md). The Memory Desk then lists the call under Unattributed and
 * the marks as stray. Measured 2026-11-13 over 30 days: 953 of 1,277 `mcp`
 * calls had no session, all of them Codex (docs/MCP_CALL_ATTRIBUTION.md).
 *
 * The Codex rollout is exact evidence of who made the call. Each MCP tool call
 * leaves one `event_msg` / `item_completed` row whose `item.type` is
 * `McpToolCall`, carrying the arguments the agent sent and the text the server
 * answered. Two facts are read from it, and nothing else:
 *
 *   minted  The result's first line prints a call id the arguments do not
 *           contain. The server made that id for this call, so the call
 *           belongs to this rollout's session. (get and mark_used echo the
 *           call_id they were handed; an echo is not a mint.)
 *   named   get or mark_used was called with {call_id, event_ids}. That
 *           session fetched or marked exactly those results of that call.
 *
 * A call id that merely appears in a rollout proves nothing: 428 of the 953
 * appeared as text in more than one, because agents quote ids, subagents
 * inherit them, and sessions read each other's logs. Only the two row shapes
 * above count.
 *
 * This module reads rollouts and writes nothing. scripts/recall-join.js owns
 * what the evidence means for a call (buildRecallIndex's callEvidence).
 *
 * Rollouts older than about a week are zstd-compressed in place
 * (rollout-….jsonl.zst, in both the sessions tree and archived_sessions), so
 * both spellings are read. Node without zlib zstd (before 22.15) reports those
 * files as unreadable instead of skipping them silently.
 *
 * Usage (a read-only report over the live logs):
 *   node scripts/codex-call-evidence.js                 # last 30 days
 *   node scripts/codex-call-evidence.js --days 7
 *   node scripts/codex-call-evidence.js --session <id>  # list that session's calls
 *   node scripts/codex-call-evidence.js --json
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { isResolved } from './sentinels.js';
import { FETCHED_SOURCE, USED_SOURCE, buildRecallIndex, namedKey, parseJsonl } from './recall-join.js';

export const CALL_DERIVATION = 'codex_rollout';

// rollout-<local timestamp>-<session uuid>.jsonl, optionally .zst. The id is
// the tail of the basename, the same relationship codexSessionIndex() reads.
const ROLLOUT_NAME = /^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-(.+?)\.jsonl(\.zst)?$/;
const HEADER_CALL_ID = /· call_id (call-[A-Za-z0-9-]+)/g;
// The access-ledger source each tool writes (cartographer-search.sh --get / --touch).
const NAMING_TOOLS = { get: FETCHED_SOURCE, mark_used: USED_SOURCE };

export const canReadZstd = typeof zlib.createZstdDecompress === 'function';

/** Both Codex stores, under the same variables resolve-transcript.sh reads. */
export function codexRolloutRoots(env = process.env, home = os.homedir()) {
  return [
    path.resolve(env.CARTOGRAPHER_CODEX_TRANSCRIPTS_DIR || path.join(home, '.codex', 'sessions')),
    path.resolve(env.CARTOGRAPHER_CODEX_ARCHIVED_DIR || path.join(home, '.codex', 'archived_sessions')),
  ];
}

function walkRollouts(dir, out, depth = 0) {
  if (depth > 6) return out;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkRollouts(full, out, depth + 1);
    else if (ROLLOUT_NAME.test(entry.name)) out.push(full);
  }
  return out;
}

/** The session a rollout file belongs to, from its name; null for any other file. */
export function rolloutSessionId(file) {
  const id = ROLLOUT_NAME.exec(path.basename(file))?.[1];
  return isResolved(id) ? id : null;
}

/**
 * Every rollout last written at or after `since`. A row naming a call is
 * written at or after the call, and compression keeps the file's mtime, so a
 * rollout untouched since before a call cannot hold evidence about it.
 */
export function listCodexRollouts({ env = process.env, home = os.homedir(), since = null } = {}) {
  const out = [];
  for (const file of codexRolloutRoots(env, home).flatMap((root) => walkRollouts(root, []))) {
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      continue; // archived or compressed between the walk and the stat
    }
    if (since !== null && stat.mtimeMs < since) continue;
    out.push({ file, session_id: rolloutSessionId(file), size: stat.size, mtimeMs: stat.mtimeMs, ino: stat.ino });
  }
  return out;
}

/**
 * What one rollout line proves, or null. `threadId` is the thread the row says
 * it belongs to, so a caller can refuse a row copied in from another thread.
 */
export function rolloutLineEvidence(line) {
  if (!line.includes('"McpToolCall"')) return null; // nearly every line; skip the parse
  let row;
  try {
    row = JSON.parse(line);
  } catch {
    return null; // the unfinished last line of a live rollout
  }
  const item = row?.payload?.item;
  if (row?.type !== 'event_msg' || row.payload?.type !== 'item_completed' || item?.type !== 'McpToolCall') return null;

  const args = item.arguments && typeof item.arguments === 'object' ? item.arguments : {};
  const threadId = isResolved(row.payload.thread_id) ? String(row.payload.thread_id) : null;
  const named = [];
  const source = NAMING_TOOLS[item.tool];
  if (source && typeof args.call_id === 'string' && isResolved(args.call_id) && Array.isArray(args.event_ids)) {
    for (const eventId of args.event_ids) {
      if (typeof eventId === 'string' && eventId) named.push([args.call_id.trim(), eventId, source]);
    }
  }

  // An id the agent supplied (a query quoting one, a call_id argument) is in
  // the arguments; an id the server made for this call cannot be.
  const supplied = JSON.stringify(args);
  const first = Array.isArray(item.result?.content) ? item.result.content.find((part) => typeof part?.text === 'string') : null;
  const header = first ? first.text.split('\n', 1)[0] : '';
  const fresh = [...new Set([...header.matchAll(HEADER_CALL_ID)].map((match) => match[1]))].filter((id) => !supplied.includes(id));
  const minted = fresh.length === 1 ? fresh[0] : null;

  return minted || named.length ? { threadId, minted, named } : null;
}

function rolloutStream(file) {
  if (!file.endsWith('.zst')) return fs.createReadStream(file, { encoding: 'utf8' });
  const source = fs.createReadStream(file);
  const decoded = source.pipe(zlib.createZstdDecompress());
  source.on('error', (error) => decoded.destroy(error));
  return decoded.setEncoding('utf8');
}

/**
 * Read one rollout to its end. Structured-clone safe, so a worker can post it.
 * A row whose thread is not this rollout's own session is counted in
 * `foreign_rows` and proves nothing here: a rollout that carries another
 * thread's history must not claim that thread's calls.
 */
export async function scanRollout(file) {
  const sessionId = rolloutSessionId(file);
  const result = { file, session_id: sessionId, readable: true, reason: null, minted: [], named: [], foreign_rows: 0 };
  if (file.endsWith('.zst') && !canReadZstd) return { ...result, readable: false, reason: 'zstd' };
  try {
    const lines = readline.createInterface({ input: rolloutStream(file), crlfDelay: Infinity });
    for await (const line of lines) {
      const evidence = rolloutLineEvidence(line);
      if (!evidence) continue;
      if (evidence.threadId !== null && evidence.threadId !== sessionId) {
        result.foreign_rows++;
        continue;
      }
      if (evidence.minted) result.minted.push(evidence.minted);
      result.named.push(...evidence.named);
    }
  } catch (error) {
    return { ...result, readable: false, reason: error?.code || 'read', minted: [], named: [] };
  }
  return result;
}

/**
 * Many scans → the two lookups the join reads. Keyed by session, not by file:
 * a rollout seen at two paths (archived or compressed mid-scan) is one session.
 */
export function foldCallEvidence(scans) {
  const minted = new Map();
  const named = new Map();
  let rollouts = 0;
  const unreadable = [];
  const add = (map, key, session) => {
    if (!map.has(key)) map.set(key, new Set());
    map.get(key).add(session);
  };
  for (const scan of scans) {
    rollouts++;
    if (!scan.readable) {
      unreadable.push({ file: scan.file, reason: scan.reason });
      continue;
    }
    if (!isResolved(scan.session_id)) continue;
    for (const callId of scan.minted) add(minted, callId, scan.session_id);
    for (const [callId, eventId, source] of scan.named) add(named, namedKey(callId, eventId, source), scan.session_id);
  }
  return { derivation: CALL_DERIVATION, minted, named, rollouts, unreadable };
}

// ── CLI: the measurement, reproducible ────────────────────────────────────

async function main(argv) {
  const opt = (name, fallback = null) => {
    const at = argv.indexOf(`--${name}`);
    return at === -1 ? fallback : argv[at + 1];
  };
  const days = Number(opt('days', 30));
  if (!Number.isFinite(days) || days <= 0) throw new Error('--days must be a positive number');
  const session = opt('session');
  const dev = process.env.CARTOGRAPHER_DEV_DIR || path.join(os.homedir(), 'Documents', 'dev');
  const logs = {
    servedRows: parseJsonl(process.env.CARTOGRAPHER_SERVED_LOG || path.join(dev, 'served-log.jsonl')).rows,
    accessRows: parseJsonl(process.env.CARTOGRAPHER_ACCESS_LEDGER || path.join(dev, 'access-ledger.jsonl')).rows,
    searchCallRows: parseJsonl(process.env.CARTOGRAPHER_SEARCH_CALL_LOG || path.join(dev, '.carto', 'search-calls.jsonl')).rows,
  };
  const from = Date.now() - days * 24 * 60 * 60 * 1000;
  const files = listCodexRollouts({ since: from });
  const scans = [];
  for (const { file } of files) scans.push(await scanRollout(file));
  const evidence = foldCallEvidence(scans);
  const recorded = buildRecallIndex(logs);
  const derived = buildRecallIndex({ ...logs, callEvidence: evidence });

  const inWindow = (call) => call.timestamp !== null && call.timestamp >= from;
  const target = [...derived.calls.values()].filter((call) => inWindow(call) && call.purpose === 'mcp' && call.session_id === null);
  const one = target.filter((call) => call.derived_session_id !== null);
  const many = target.filter((call) => call.derivation_conflict > 0);
  const sum = (calls, field) => calls.reduce((total, call) => total + call[field], 0);
  const before = [...recorded.calls.values()].filter((call) => inWindow(call) && call.purpose === 'mcp' && call.session_id === null);
  const report = {
    window_days: days,
    rollouts: { scanned: evidence.rollouts, unreadable: evidence.unreadable.length, compressed: files.filter(({ file }) => file.endsWith('.zst')).length },
    mcp_calls: [...derived.calls.values()].filter((call) => inWindow(call) && call.purpose === 'mcp').length,
    no_session: target.length,
    minted_in_one_rollout: one.length,
    minted_in_none: target.length - one.length - many.length,
    minted_in_several: many.length,
    sessions: new Set(one.map((call) => call.derived_session_id)).size,
    marks: {
      stray_before: sum(before, 'stray_marks'),
      stray_after: sum(target, 'stray_marks'),
      results_marked_used_per_transcript: sum(one, 'derived_used'),
      results_fetched_per_transcript: sum(one, 'derived_fetched'),
    },
  };
  if (session) {
    report.session = session;
    report.session_calls = one.filter((call) => call.derived_session_id === session)
      .sort((a, b) => a.timestamp - b.timestamp)
      .map((call) => ({ call_id: call.call_id, at: new Date(call.timestamp).toISOString(), query: call.query, served: call.served, derived_used: call.derived_used, derived_fetched: call.derived_fetched, stray_marks: call.stray_marks }));
  }
  if (argv.includes('--json')) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(`mcp recall calls, last ${days} days: ${report.mcp_calls}; recorded without a session: ${report.no_session}`);
  console.log(`  minted in exactly one Codex rollout: ${report.minted_in_one_rollout} (${report.sessions} sessions)`);
  console.log(`  minted in none: ${report.minted_in_none}    minted in several: ${report.minted_in_several}`);
  console.log(`rollouts scanned: ${report.rollouts.scanned} (${report.rollouts.compressed} compressed, ${report.rollouts.unreadable} unreadable)`);
  console.log(`marks on those calls: ${report.marks.stray_before} stray as recorded, ${report.marks.stray_after} stray with transcripts;`
    + ` ${report.marks.results_marked_used_per_transcript} results marked used and ${report.marks.results_fetched_per_transcript} fetched per transcript`);
  for (const call of report.session_calls || []) {
    console.log(`  ${call.call_id}  ${call.at}  served ${call.served} · used ${call.derived_used} · fetched ${call.derived_fetched} · stray ${call.stray_marks}  ${JSON.stringify(call.query)}`);
  }
  if (session && !report.session_calls.length) console.log(`  no call minted in session ${session}`);
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  // Falls off the end instead of calling process.exit, so a piped reader gets every byte.
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
