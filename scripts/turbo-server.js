#!/usr/bin/env node
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { buildIndex, addToIndex } from '../explorer/server/bm25.js';
import { CORPUS_ROOT, readAllEvents, watchFiles, mergeDuplicateEvent } from '../explorer/server/jsonl.js';
import { executeRecall, recallHealth, recallIndexGeneration } from '../explorer/server/recall.js';
import { RecallContractError } from '../explorer/server/recall-contract.js';
import { executeFacts } from '../explorer/server/facts.js';
import { createMemoryHandler } from '../explorer/server/memory.js';
import {
  FACTS_CONTRACT_VERSION,
  FACTS_VERBS,
  FactsContractError,
} from '../explorer/server/facts-contract.js';
import { turboPaths, validateTurboUrl, writeJsonAtomic } from './turbo-common.js';

const paths = turboPaths();
let runtimeVersion = 'unknown';
try {
  runtimeVersion = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version || 'unknown';
} catch {}
const url = new URL(validateTurboUrl(process.env.CARTOGRAPHER_TURBO_URL || 'http://127.0.0.1:2526'));
const spoolOnly = process.env.CARTOGRAPHER_TURBO_SPOOL_ONLY === '1';
// Minutes without a request before this process exits; 0 or unset never. The
// controller sets it from the machine's memory plan (30 under 16 GB of RAM), so
// a smaller machine gets its memory back when recall goes quiet. The next
// search restarts the service, paying one cold load.
const idleMinutes = Math.max(0, Number(process.env.CARTOGRAPHER_TURBO_IDLE_MINUTES) || 0);
let lastActivity = Date.now();
let openResponses = 0;
const touchActivity = () => { lastActivity = Date.now(); };

fs.mkdirSync(paths.requests, { recursive: true, mode: 0o700 });
// The orphan-reaping regression holds a child before its first ready publish.
// This opt-in test seam makes that ordering independent of suite load.
if (process.env.CARTOGRAPHER_TURBO_TEST_STARTUP_DELAY_MS) {
  const delay = Number(process.env.CARTOGRAPHER_TURBO_TEST_STARTUP_DELAY_MS);
  if (Number.isFinite(delay) && delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
}

let events;
let index;
// event_id → the stored event, so a second copy can be folded into it.
let byEventId;
function indexEventsById(list) {
  const map = new Map();
  for (const event of list) {
    if (event.event_id && !map.has(event.event_id)) map.set(event.event_id, event);
  }
  return map;
}

// See jsonl.js: an in-place rewrite invalidates everything already indexed,
// so appending cannot repair it. Reload.
function reloadCorpus(source) {
  events = readAllEvents();
  index = buildIndex(events);
  byEventId = indexEventsById(events);
  console.error(`turbo: reloaded corpus after in-place rewrite of ${source} (${events.length} events)`);
}

// Armed before the load (see watchFiles). The load takes about a second at
// 157k events, and a watcher armed after it started past every event appended
// in that second, while its offsets matched the disk and status read live.
//
// A second copy of an id is folded into the stored event, as readAllEvents does
// at load, never skipped. The hooks write one event to its domain log and to
// changelog, each copy with fields the other lacks, and a row the load read
// arrives again from the watcher's first pass. Skipping kept only the
// first-arriving copy's fields and `_source` until the next restart, so recall
// and census disagreed with a freshly started service. The BM25 doc keeps a
// reference to the stored event, so recall returns the merged fields.
const stopWatching = watchFiles((newEvents) => {
  for (const event of newEvents) {
    const id = event.event_id;
    if (id && byEventId.has(id)) {
      mergeDuplicateEvent(byEventId.get(id), event, event._source);
      continue;
    }
    if (id) byEventId.set(id, event);
    events.unshift(event);
    addToIndex(index, event);
  }
}, reloadCorpus);
events = readAllEvents();
index = buildIndex(events);
byEventId = indexEventsById(events);
const handleMemory = createMemoryHandler({ getEvents: () => events });

function errorPayload(error) {
  const contractual = error instanceof RecallContractError || error instanceof FactsContractError;
  return {
    status: contractual ? error.status : 500,
    body: { error: error.message || 'request failed' },
  };
}

async function handleRecall(raw) {
  try {
    return { status: 200, body: await executeRecall({ events, index }, raw) };
  } catch (error) {
    console.error('[turbo recall]', error.message);
    return errorPayload(error);
  }
}

function handleFacts(raw) {
  try {
    return {
      status: 200,
      body: executeFacts({ events, index }, raw, {
        // Passed as a thunk so the generation is sampled at answer time. The
        // watcher mutates `events` in place, so a value captured at request
        // entry could describe a corpus the answer was not computed over.
        indexGeneration: () => recallIndexGeneration(events, index),
      }),
    };
  } catch (error) {
    console.error('[turbo facts]', error.message);
    return errorPayload(error);
  }
}

// The spool envelope predates a second endpoint, so an envelope with no `kind`
// is a recall request from an older client. Defaulting rather than rejecting
// keeps a packaged client working against a newer service.
async function handleSpooled(envelope) {
  return envelope.kind === 'facts'
    ? handleFacts(envelope.request)
    : handleRecall(envelope.request);
}

const processing = new Set();
async function processRequestFile(file) {
  if (!file.endsWith('.request.json') || processing.has(file)) return;
  processing.add(file);
  const requestPath = path.join(paths.requests, file);
  const responsePath = path.join(paths.requests, file.replace(/\.request\.json$/, '.response.json'));
  try {
    touchActivity();
    touchActivity();
    const envelope = JSON.parse(fs.readFileSync(requestPath, 'utf8'));
    const result = await handleSpooled(envelope);
    writeJsonAtomic(responsePath, {
      request_token: envelope.request_token,
      ...result,
    });
  } catch (error) {
    writeJsonAtomic(responsePath, {
      request_token: null,
      ...errorPayload(error),
    });
  } finally {
    try { fs.unlinkSync(requestPath); } catch {}
    processing.delete(file);
  }
}

function scanRequests() {
  let files = [];
  try { files = fs.readdirSync(paths.requests); } catch {}
  for (const file of files) void processRequestFile(file);
}

// File transport deliberately polls a tiny private directory instead of adding
// another fs.watch handle. Long-running Explorer instances already watch the
// event logs, and macOS can otherwise reject this extra watcher with EMFILE.
const requestInterval = setInterval(scanRequests, 40);
scanRequests();

let httpServer = null;
let httpStatus = spoolOnly ? 'disabled' : 'starting';

if (!spoolOnly) {
  httpServer = http.createServer(async (req, res) => {
    // A response still open (the Memory Desk's live stream) is activity for as
    // long as it stays open, so an Explorer tab keeps the service warm.
    touchActivity();
    openResponses += 1;
    res.on('close', () => { openResponses -= 1; touchActivity(); });
    if (await handleMemory(req, res)) return;
    if (req.method === 'GET' && req.url === '/api/recall/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(recallHealth({ events, index, watch: stopWatching.positions() })));
      return;
    }
    // Advertised separately so a client can discover which verbs this service
    // answers instead of probing them. A verb added later must not look like a
    // malformed request to an older client.
    if (req.method === 'GET' && req.url === '/api/facts/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok',
        contract_version: FACTS_CONTRACT_VERSION,
        backend: 'explorer',
        corpus_root: CORPUS_ROOT,
        verbs: FACTS_VERBS,
        events: events.length,
        index_generation: recallIndexGeneration(events, index),
      }));
      return;
    }
    const isRecall = req.method === 'POST' && req.url === '/api/recall';
    const isFacts = req.method === 'POST' && req.url === '/api/facts';
    if (!isRecall && !isFacts) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
      return;
    }
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1024 * 1024) req.destroy();
    });
    req.on('end', async () => {
      let body;
      try { body = JSON.parse(raw); } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid JSON' }));
        return;
      }
      const result = isFacts ? handleFacts(body) : await handleRecall(body);
      res.writeHead(result.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result.body));
    });
  });
  httpServer.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      httpStatus = 'port_in_use';
      console.error(`[turbo] ${url.origin} already in use; file transport remains available`);
      publishReady();
      return;
    }
    // A sandboxed spawn (Codex seatbelt, a hardened Bash tool) is denied the
    // listen syscall outright. That is a capability of the environment, not a
    // fault to debug: the file transport is a complete recall path and is the
    // one this process will serve. Say so, and keep the two cases apart so an
    // operator reading `status` is not sent hunting for a broken server.
    if (error.code === 'EPERM' || error.code === 'EACCES') {
      httpStatus = 'blocked';
      console.error(
        `[turbo] loopback listen denied by the sandbox (${error.code}); `
        + 'file transport is serving recall',
      );
      publishReady();
      return;
    }
    console.error(`[turbo] HTTP server error: ${error.message}`);
    httpStatus = 'failed';
    publishReady();
  });
  httpServer.listen(Number(url.port || 80), url.hostname.replace(/^\[|\]$/g, ''), () => {
    httpStatus = 'listening';
    console.log(`[turbo] HTTP recall ready at ${url.origin}`);
    publishReady();
  });
}

// The ready file is a lease, not a notice. A server that finds its state dir
// gone, or its ready file missing or naming another pid, has lost its record:
// the controller cannot see it in `status` and cannot stop it through the
// handshake, so the only correct move is to leave. Without this, a server whose
// state dir was removed mid-load recreated the dir on publish and ran for days
// (2026-09-08, three of them). The check is cheap and runs on a coarse timer;
// a replacement server writing its own pid is seen the same way as a deletion.
const LEASE_INTERVAL_MS = 2000;
let leaseLost = false;
let readyPublished = false;

function loseLease(reason) {
  if (leaseLost) return;
  leaseLost = true;
  console.error(`[turbo] ${reason}; this server has no record and is exiting`);
  shutdown();
}

function checkLease() {
  if (leaseLost) return;
  if (!fs.existsSync(paths.state)) return loseLease('state dir is gone');
  let holder = null;
  try { holder = JSON.parse(fs.readFileSync(paths.ready, 'utf8')); } catch {}
  if (!holder) return loseLease('ready file is gone');
  if (Number(holder.pid) !== process.pid) return loseLease(`ready file names pid ${holder.pid}`);
}

function publishReady() {
  if (leaseLost) return;
  // The HTTP listen callback may arrive after a caller removed or replaced the
  // initial ready file. An update must honor that lost lease, not recreate it.
  if (readyPublished) checkLease();
  if (leaseLost) return;
  // Never resurrect a state dir that was removed under us — that is exactly the
  // orphan shape. `writeJsonAtomic` would mkdir it back.
  if (!fs.existsSync(paths.state)) return loseLease('state dir is gone');
  writeJsonAtomic(paths.ready, {
    pid: process.pid,
    contract_version: 1,
    runtime_version: runtimeVersion,
    instance_token: process.env.CARTOGRAPHER_TURBO_INSTANCE_TOKEN || null,
    ready_at: new Date().toISOString(),
    events: events.length,
    indexed_docs: index.docs.size,
    http: httpStatus,
    spool: paths.requests,
  });
  readyPublished = true;
}

publishReady();
console.log(`[turbo] loaded ${events.length} events / ${index.docs.size} docs; file transport ready at ${paths.requests}`);
const leaseInterval = setInterval(checkLease, LEASE_INTERVAL_MS);
leaseInterval.unref();

let idleInterval = null;
if (idleMinutes > 0) {
  const idleMs = idleMinutes * 60000;
  // Check often enough to exit within about a quarter of the window.
  idleInterval = setInterval(() => {
    if (openResponses > 0 || Date.now() - lastActivity < idleMs) return;
    console.log(`[turbo] idle for ${idleMinutes} min; exiting to free memory. The next search restarts it.`);
    shutdown();
  }, Math.max(250, Math.min(60000, idleMs / 4)));
  idleInterval.unref();
}

function shutdown() {
  clearInterval(requestInterval);
  clearInterval(leaseInterval);
  if (idleInterval) clearInterval(idleInterval);
  stopWatching();
  try {
    const ready = JSON.parse(fs.readFileSync(paths.ready, 'utf8'));
    if (Number(ready.pid) === process.pid) fs.unlinkSync(paths.ready);
  } catch {}
  if (httpServer?.listening) httpServer.close(() => process.exit(0));
  else process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
