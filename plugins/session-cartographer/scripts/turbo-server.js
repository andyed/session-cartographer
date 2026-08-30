#!/usr/bin/env node
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { buildIndex, addToIndex } from '../explorer/server/bm25.js';
import { readAllEvents, watchFiles } from '../explorer/server/jsonl.js';
import { executeRecall, recallHealth } from '../explorer/server/recall.js';
import { RecallContractError } from '../explorer/server/recall-contract.js';
import { turboPaths, validateTurboUrl, writeJsonAtomic } from './turbo-common.js';

const paths = turboPaths();
let runtimeVersion = 'unknown';
try {
  runtimeVersion = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version || 'unknown';
} catch {}
const url = new URL(validateTurboUrl(process.env.CARTOGRAPHER_TURBO_URL || 'http://127.0.0.1:2526'));
const spoolOnly = process.env.CARTOGRAPHER_TURBO_SPOOL_ONLY === '1';

fs.mkdirSync(paths.requests, { recursive: true, mode: 0o700 });

const events = readAllEvents();
const index = buildIndex(events);
const eventIds = new Set(events.map((event) => event.event_id).filter(Boolean));
const stopWatching = watchFiles((newEvents) => {
  for (const event of newEvents) {
    if (event.event_id && eventIds.has(event.event_id)) continue;
    if (event.event_id) eventIds.add(event.event_id);
    events.unshift(event);
    addToIndex(index, event);
  }
});

function errorPayload(error) {
  return {
    status: error instanceof RecallContractError ? error.status : 500,
    body: { error: error.message || 'recall failed' },
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

const processing = new Set();
async function processRequestFile(file) {
  if (!file.endsWith('.request.json') || processing.has(file)) return;
  processing.add(file);
  const requestPath = path.join(paths.requests, file);
  const responsePath = path.join(paths.requests, file.replace(/\.request\.json$/, '.response.json'));
  try {
    const envelope = JSON.parse(fs.readFileSync(requestPath, 'utf8'));
    const result = await handleRecall(envelope.request);
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
    if (req.method !== 'POST' || req.url !== '/api/recall') {
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
      const result = await handleRecall(body);
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
