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
 * Only the budget differs: a fold costs 12-368 ms, so this keeps 1500 ms where
 * recall, whose semantic stage runs to 2.7 s, waits longer.
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
import { renderText } from './facts-render.js';

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
  } catch (error) {
    // Our own deadline: the service accepted the connection and has the request.
    if (!error.serviceAnswered && controller.signal.aborted) {
      const timeout = new Error(`no answer within ${timeoutMs} ms`);
      timeout.timedOut = true;
      throw timeout;
    }
    throw error;
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
  // refused connection, a sandbox denying the loopback syscall — is worth
  // trying the file transport for. A timeout is neither: the service is still
  // running the request, and a spool retry would run it a second time.
  if (error.serviceAnswered) {
    console.error(`facts request rejected: ${error.message}`);
    process.exit(error.status >= 500 ? 75 : 2);
  }
  if (error.timedOut) {
    console.error(`turbo timed out: HTTP ${error.message}; not retried on the file transport`);
    process.exit(75);
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
