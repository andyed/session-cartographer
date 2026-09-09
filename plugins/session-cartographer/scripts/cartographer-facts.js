#!/usr/bin/env node
/**
 * The facts client.
 *
 * `turbo-search-client.js` asks the warm service which records are relevant to a
 * phrase. This asks what is true of the corpus. The transports are deliberately
 * identical — same HTTP-then-spool fallback, same timeout handling, same atomic
 * writes — because the reason the spool exists is unchanged: a Codex sandbox is
 * denied the loopback connect outright, and a client that only spoke HTTP would
 * report "turbo unavailable" for a service running fine three inches away.
 *
 * What is different is the writing. The recall client appends served rows and
 * call rows to retrieval telemetry; this one appends nothing, ever.
 * `scripts/cartographer-search.sh` is the single writer of `served-log.jsonl`
 * and `access-ledger.jsonl`, and a census counted against the corpus is not a
 * search result served to anyone — logging it would inflate the hit-rate report
 * with rows no one could ever `--touch`.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { FACTS_VERBS, validateFactsResponse } from '../explorer/server/facts-contract.js';
import { turboPaths, validateTurboUrl, writeJsonAtomic } from './turbo-common.js';

function argsToObject(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith('--')) continue;
    out[key.slice(2)] = argv[i + 1] ?? '';
    i += 1;
  }
  return out;
}

const args = argsToObject(process.argv.slice(2));
const timeoutMs = Math.max(100, Math.min(30000, Number(args.timeout || 1500)));
const url = validateTurboUrl(args.url || 'http://127.0.0.1:2526');
const outputFormat = args.format === 'json' ? 'json' : 'text';
const verb = args.verb || 'census';

// Checked here as well as at the server because a typo'd verb is otherwise paid
// for twice: the HTTP call returns a 400, the client treats any HTTP failure as
// a reason to try the spool, and the spool then waits out its own deadline
// before repeating the same rejection. Fail on the local fact instead.
if (!FACTS_VERBS.includes(verb)) {
  console.error(`cartographer-facts: unsupported --verb '${verb}'; expected ${FACTS_VERBS.join(', ')}`);
  process.exit(2);
}

/**
 * `top`, `sample` and `budget` are contract integers with server-side defaults,
 * and the contract computes `Number(value ?? fallback)`. An absent flag must
 * therefore arrive as `undefined` (dropped by JSON.stringify, so the fallback
 * applies) and never as the empty string, which coerces to 0 and is rejected as
 * below `top`'s minimum of 1 — a missing flag would read as a malformed one.
 */
function optionalInt(value) {
  if (value === undefined || value === '') return undefined;
  return Number(value);
}

const cursorFile = args['cursor-file'] || '';

/**
 * Read a stored cursor.
 *
 * Written as a JSON envelope so the token carries the corpus and verb it was
 * issued for, but a bare token is accepted too: an operator who pasted one into
 * the file by hand should get a resumed delta, not a silent baseline. A missing
 * file is a baseline call and is not an error — that is how a scheduled job
 * makes its first run.
 */
function readCursorFile(file) {
  if (!file) return '';
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && typeof parsed.cursor === 'string') return parsed.cursor;
  } catch {}
  return text.trim();
}

const request = {
  contract_version: 1,
  verb,
  call_id: args['call-id'] || `facts-${new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15)}-${process.pid}`,
  project: args.project || '',
  since: args.since || '',
  before: args.before || '',
  top: optionalInt(args.top),
  sample: optionalInt(args.sample),
  budget: optionalInt(args.budget),
  purpose: args.purpose || 'facts',
  corpus_root: args['corpus-root'] || '',
  // The contract rejects a cursor on any verb but delta, so a `--cursor-file`
  // left in a wrapper script must not silently turn a census into an error.
  cursor: verb === 'delta' ? (args.cursor || readCursorFile(cursorFile)) : '',
};

async function viaHttp() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${url}/api/facts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
      signal: controller.signal,
    });
    const body = await response.json();
    if (!response.ok) {
      // An HTTP status means the service answered. The spool transport reaches
      // the same process, so retrying there cannot produce a different verdict
      // — it just runs the rejection twice and reports a composite error that
      // reads like two unrelated failures ("turbo unavailable: HTTP delta is
      // bounded by cursor...; file transport query must be a string"), sending
      // the reader after a transport problem that does not exist. Reaching the
      // service and being told no is an answer, not an outage.
      const error = new Error(body.error || `HTTP ${response.status}`);
      error.serviceAnswered = true;
      error.status = response.status;
      throw error;
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

async function viaSpool() {
  const paths = turboPaths();
  fs.mkdirSync(paths.requests, { recursive: true, mode: 0o700 });
  const id = `req-${process.pid}-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
  const token = crypto.randomBytes(16).toString('hex');
  const requestPath = path.join(paths.requests, `${id}.request.json`);
  const responsePath = path.join(paths.requests, `${id}.response.json`);
  // `kind` is what routes this to the facts handler. An envelope without it is
  // a recall request from an older client, so a service that predates this
  // endpoint will hand a facts body to the ranking contract and reject it —
  // which is the correct, loud failure, not a wrong answer.
  writeJsonAtomic(requestPath, { request_token: token, kind: 'facts', request });
  const deadline = Date.now() + Math.max(timeoutMs, 3000);
  try {
    while (Date.now() < deadline) {
      if (fs.existsSync(responsePath)) {
        const envelope = JSON.parse(fs.readFileSync(responsePath, 'utf8'));
        if (envelope.request_token !== token) throw new Error('spool response token mismatch');
        if (envelope.status !== 200) throw new Error(envelope.body?.error || `spool status ${envelope.status}`);
        return envelope.body;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('spool response timed out');
  } finally {
    try { fs.unlinkSync(requestPath); } catch {}
    try { fs.unlinkSync(responsePath); } catch {}
  }
}

// ─── Rendering ───

function num(value) {
  return Number(value ?? 0).toLocaleString('en-US');
}

function clip(value, max) {
  const text = String(value ?? '').replace(/[\r\n\t]+/g, ' ');
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * A bucket table, counts right-aligned against the widest count in the table.
 *
 * The sample ids are printed rather than summarized because they are the whole
 * reason the engine attaches them: a count you cannot check is a count you have
 * to trust, and these feed straight into `cartographer-search.sh --get`.
 */
function table(label, rows, { max = 20 } = {}) {
  if (!Array.isArray(rows) || rows.length === 0) return `  ${label}: none\n`;
  const visible = rows.slice(0, max);
  const nameWidth = Math.min(40, Math.max(label.length, ...visible.map((r) => String(r.name).length)));
  const countWidth = Math.max(5, ...visible.map((r) => num(r.count).length));
  let out = `  ${label.padEnd(nameWidth)}  ${'count'.padStart(countWidth)}  sample event_ids\n`;
  for (const row of visible) {
    const ids = Array.isArray(row.event_ids) ? row.event_ids.filter(Boolean).join(' ') : '';
    out += `  ${clip(row.name, nameWidth).padEnd(nameWidth)}  ${num(row.count).padStart(countWidth)}  ${ids}\n`;
  }
  if (rows.length > visible.length) out += `  … ${rows.length - visible.length} more bucket(s)\n`;
  return out;
}

function pairs(object) {
  const entries = Object.entries(object || {});
  if (entries.length === 0) return 'none';
  return entries.map(([key, value]) => `${key}=${num(value)}`).join('  ');
}

function header(response, transport) {
  const window = response.window || {};
  let out = `facts ${response.verb} · ${num(response.corpus_events)} events resident`
    + ` · ${response.stages_ms.total.toFixed(1)} ms (${transport})\n`;
  out += `  corpus ${response.corpus_root}  generation ${response.index_generation || 'unknown'}\n`;
  if (window.since || window.before || response.project) {
    out += `  window ${window.since || 'corpus start'} → ${window.before || 'now'}`
      + `${response.project ? `  project ${clip(response.project, 80)}` : ''}\n`;
  }
  return `${out}\n`;
}

function renderCensus(facts) {
  const span = facts.span || {};
  let out = `${num(facts.events)} events · ${num(facts.sessions?.resolved)} sessions`
    + ` · ${num(facts.commits?.length)} git events\n`;
  out += `  span        ${span.oldest || '—'} → ${span.newest || '—'}\n`;
  // Reported, never folded into a bucket: an "unknown" project is truthy and
  // equal to itself, so counting it as a project manufactures one phantom that
  // reads as the busiest thing in the corpus.
  out += `  unattributed ${pairs(facts.unattributed)}\n`;
  out += `  dropped     windowed_out=${num(facts.windowed_out)}  undated=${num(facts.undated_dropped)}\n\n`;
  out += table('by_project', facts.by_project);
  out += '\n';
  out += table('by_type', facts.by_type);
  out += '\n';
  out += table('by_source', facts.by_source);
  out += '\n';
  out += table('by_provider', facts.by_provider);
  const commits = facts.commits || [];
  out += `\n  commits (${num(commits.length)})\n`;
  for (const commit of commits.slice(0, 25)) {
    out += `  ${(commit.timestamp || '?').padEnd(26)} ${clip(commit.project || '—', 24).padEnd(24)}`
      + ` ${clip(commit.summary, 90)}\n`;
  }
  if (commits.length > 25) out += `  … ${commits.length - 25} more\n`;
  return out;
}

function renderTempo(facts) {
  const projects = facts.projects || [];
  let out = `${num(projects.length)} project(s) · undated dropped ${num(facts.undated_dropped)}\n\n`;
  if (projects.length === 0) return `${out}  (no dated, project-attributed events in this window)\n`;
  const nameWidth = Math.min(36, Math.max(7, ...projects.map((p) => String(p.project).length)));
  out += `  ${'project'.padEnd(nameWidth)}  ${'total'.padStart(7)}  ${'scored_day'.padEnd(10)}`
    + `  ${'count'.padStart(6)}  ${'baseline'.padStart(9)}  ${'z'.padStart(7)}  status                partial_day\n`;
  for (const p of projects) {
    // The current UTC day is still being written, so it is shown and explicitly
    // never scored — comparing two hours of a day against 24-hour days reads as
    // a collapse in activity for every project, every time.
    const partial = p.partial_day
      ? `${p.partial_day.day}:${num(p.partial_day.count)} (unscored)`
      : '—';
    out += `  ${clip(p.project, nameWidth).padEnd(nameWidth)}`
      + `  ${num(p.total).padStart(7)}`
      + `  ${(p.scored_day || '—').padEnd(10)}`
      + `  ${num(p.scored_count).padStart(6)}`
      + `  ${(p.baseline_mean === null ? '—' : p.baseline_mean.toFixed(2)).padStart(9)}`
      + `  ${(p.z === null ? '—' : p.z.toFixed(2)).padStart(7)}`
      + `  ${String(p.z_status).padEnd(20)}  ${partial}\n`;
  }
  return out;
}

function renderDelta(facts) {
  let out = '';
  // Stale first and unmissable. A stale source contributed nothing and had its
  // position re-baselined, so the caller's diff is incomplete for that source —
  // a fact that is worthless if it scrolls past under the event list.
  const stale = Object.entries(facts.stale || {});
  if (stale.length > 0) {
    out += `!! STALE SOURCES — this diff is INCOMPLETE for: ${stale.map(([s, why]) => `${s} (${why})`).join(', ')}\n`;
    out += '!! Those logs were rewritten or truncated under the cursor; their positions were re-baselined.\n\n';
  }
  if (facts.baseline) {
    out += 'baseline call · 0 events · cursor established\n';
    out += '  A first call records a position; it does not replay the corpus as "changes".\n';
  } else {
    out += `${num(facts.returned)} returned · ${num(facts.read)} read · pending ${pairs(facts.pending)}\n`;
  }
  out += `  cursor ${facts.cursor}\n`;
  if (!facts.baseline) {
    const summary = facts.summary || {};
    out += '\n';
    out += table('by_source', summary.by_source);
    out += '\n';
    out += table('by_project', summary.by_project);
    out += '\n';
    out += table('by_type', summary.by_type);
    out += '\n';
    for (const event of facts.events || []) {
      out += `[${event.timestamp || '?'}] [${event.source}] ${event.event_id || '(no event_id)'}\n`;
      out += `  ${clip(event.summary, 200)}\n`;
      if (event.project) out += `  project: ${event.project}\n`;
      if (event.type) out += `  type: ${event.type}\n`;
      if (event.session_id) out += `  session: ${event.session_id}\n`;
      out += '\n';
    }
  }
  return out;
}

function renderText(response, transport) {
  let out = header(response, transport);
  if (response.verb === 'census') out += renderCensus(response.facts);
  else if (response.verb === 'tempo') out += renderTempo(response.facts);
  else out += renderDelta(response.facts);
  out += `\n(call_id: ${response.call_id})\n`;
  return out;
}

// ─── Execute ───

let response;
let transport;
let httpError;
try {
  response = await viaHttp();
  transport = 'http';
} catch (error) {
  httpError = error;
  // A rejection from the service is final. Only an unreachable service — a
  // refused connection, a timeout, a sandbox denying the loopback syscall —
  // is worth trying the file transport for.
  if (error.serviceAnswered) {
    console.error(`facts request rejected: ${error.message}`);
    process.exit(error.status >= 500 ? 75 : 2);
  }
  try {
    response = await viaSpool();
    transport = 'file';
  } catch (spoolError) {
    console.error(`turbo unavailable: HTTP ${httpError.message}; file transport ${spoolError.message}`);
    process.exit(75);
  }
}

try {
  validateFactsResponse(response);
} catch (error) {
  // Rejected outright rather than rendered partially. Half a census is
  // indistinguishable from a small one, and the caller has no way to tell that
  // the number it just read describes less than it claims.
  console.error(`facts response rejected: ${error.message}`);
  process.exit(75);
}

const rendered = outputFormat === 'json'
  ? `${JSON.stringify(response, null, 2)}\n`
  : renderText(response, transport);
process.stdout.write(rendered);

// Only now. The durable cursor's entire value is that a scheduled job can trust
// the events between two runs were handed to it; advancing the stored token
// before the caller has actually seen the events would drop them permanently
// and silently on a render that threw.
if (cursorFile && verb === 'delta' && typeof response.facts?.cursor === 'string') {
  writeJsonAtomic(cursorFile, {
    cursor: response.facts.cursor,
    corpus_root: response.corpus_root,
    verb: response.verb,
    call_id: response.call_id,
    written_at: new Date().toISOString(),
  });
}
