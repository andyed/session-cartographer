#!/usr/bin/env node
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { buildIndex, addToIndex } from '../explorer/server/bm25.js';
import { CORPUS_ROOT, readAllEvents, watchFiles } from '../explorer/server/jsonl.js';
import { executeRecall, recallHealth, recallIndexGeneration } from '../explorer/server/recall.js';
import { RecallContractError } from '../explorer/server/recall-contract.js';
import { executeFacts } from '../explorer/server/facts.js';
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

fs.mkdirSync(paths.requests, { recursive: true, mode: 0o700 });

let events = readAllEvents();
let index = buildIndex(events);
let eventIds = new Set(events.map((event) => event.event_id).filter(Boolean));
// See jsonl.js: an in-place rewrite invalidates everything already indexed,
// so appending cannot repair it. Reload.
function reloadCorpus(source) {
  events = readAllEvents();
  index = buildIndex(events);
  eventIds = new Set(events.map((event) => event.event_id).filter(Boolean));
  console.error(`turbo: reloaded corpus after in-place rewrite of ${source} (${events.length} events)`);
}

const stopWatching = watchFiles((newEvents) => {
  for (const event of newEvents) {
    if (event.event_id && eventIds.has(event.event_id)) continue;
    if (event.event_id) eventIds.add(event.event_id);
    events.unshift(event);
    addToIndex(index, event);
  }
}, reloadCorpus);

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
  httpServer = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/api/recall/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(recallHealth({ events, index })));
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

function publishReady() {
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
}

publishReady();
console.log(`[turbo] loaded ${events.length} events / ${index.docs.size} docs; file transport ready at ${paths.requests}`);

function shutdown() {
  clearInterval(requestInterval);
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
