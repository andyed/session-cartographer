#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { validateRecallResponse } from '../explorer/server/recall-contract.js';
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
const outputFormat = args.format === 'jsonl' ? 'jsonl' : 'text';

function readExcluded(file) {
  if (!file) return [];
  try {
    return [...new Set(fs.readFileSync(file, 'utf8').split('\n').filter(Boolean))].slice(-500);
  } catch {
    return [];
  }
}

const request = {
  contract_version: 1,
  call_id: args['call-id'],
  query: args.query,
  project: args.project || '',
  since: args.since || '',
  before: args.before || '',
  limit: Number(args.limit || 15),
  purpose: args.purpose || 'remember',
  session_id: args['session-id'] || '',
  provider: args.provider || 'unknown',
  excluded_event_ids: readExcluded(args['served-in']),
};

async function viaHttp() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${url}/api/recall`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
      signal: controller.signal,
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
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
  writeJsonAtomic(requestPath, { request_token: token, request });
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

function appendJsonl(file, row) {
  if (!file) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(row)}\n`);
  } catch (error) {
    console.error(`cartographer-search: warning: cannot write Turbo telemetry at ${file}: ${error.message}`);
  }
}

function extrasFor(item) {
  const fields = [
    ['url', item.url],
    ['deeplink', item.deeplink],
    ['transcript', item.transcript_path],
    ['cwd', item.cwd],
    ['session', item.session_id || item.session],
    ['provider', item.provider],
    ['intent', item.prompt_intent],
  ];
  return fields.filter(([, value]) => value).map(([key, value]) => `${key}:${value}`).join('|');
}

function renderFacet(label, entries, max = 8) {
  if (!Array.isArray(entries) || entries.length === 0) return '';
  const visible = entries.slice(0, max).map(({ name, count }) => `${name}(${count})`).join(', ');
  return `  ${label.padEnd(10)}${visible}\n`;
}

function renderText(response, transport) {
  let out = `(turbo: warm Explorer via ${transport} · ${response.stages_ms.total.toFixed(1)} ms)\n\n`;
  const facets = response.facets || {};
  const total = response.meta?.eligible_count ?? response.results.length;
  if (total > 0) {
    out += `--- Facets (${Math.min(total, 500)} results) ---\n`;
    out += renderFacet('projects:', facets.projects);
    out += renderFacet('types:', facets.types);
    out += renderFacet('sources:', facets.sources);
    if (facets.time?.oldest && facets.time?.newest) {
      out += `  ${'span:'.padEnd(10)}${facets.time.oldest} to ${facets.time.newest}\n`;
      out += renderFacet('months:', facets.time.months, 6);
      out += renderFacet('days:', facets.time.days, 7);
    }
    out += '---\n\n';
  }
  for (const item of response.results) {
    const source = item._sources || 'keyword';
    const reuse = item._reuseCount ? ` (used x${item._reuseCount})` : '';
    const summary = String(item.summary || item.description || item.prompt || item.url || item.event_id)
      .replace(/[\r\n\t]+/g, ' ')
      .slice(0, 200);
    out += `[${item.timestamp || '?'}] [${source}] ${item.event_id}${reuse}\n`;
    out += `  ${summary}${summary.length === 200 ? '...' : ''}\n`;
    if (item.project) out += `  project: ${item.project}\n`;
    for (const pair of extrasFor(item).split('|').filter(Boolean)) {
      const colon = pair.indexOf(':');
      out += `  ${pair.slice(0, colon)}: ${pair.slice(colon + 1)}\n`;
    }
    out += '\n';
  }
  if ((response.meta?.excluded_count || 0) > 0) {
    const count = response.meta.excluded_count;
    out += `(delta serving: ${count} already-shown result${count === 1 ? '' : 's'} suppressed; --all to see)\n`;
  }
  return out;
}

function renderJsonl(response) {
  return response.results.map((item, index) => JSON.stringify({
    timestamp: item.timestamp || '?',
    source: item._sources || 'keyword',
    event_id: item.event_id,
    summary: item.summary || item.description || item.prompt || item.url || item.event_id,
    project: item.project || '',
    event_type: item.type || item.milestone || '',
    salience: Number(item.salience ?? 0.5),
    rank: index + 1,
    extras: extrasFor(item),
  })).join('\n') + (response.results.length ? '\n' : '');
}

const started = Date.now();
let response;
let transport;
let httpError;
try {
  response = await viaHttp();
  transport = 'http';
} catch (error) {
  httpError = error;
  try {
    response = await viaSpool();
    transport = 'file';
  } catch (spoolError) {
    console.error(`turbo unavailable: HTTP ${httpError.message}; file transport ${spoolError.message}`);
    process.exit(75);
  }
}

try {
  validateRecallResponse(response);
} catch (error) {
  console.error(`turbo response rejected: ${error.message}`);
  process.exit(75);
}

if (args['count-out']) fs.writeFileSync(args['count-out'], `${response.results.length}\n`);
if (args['served-out']) {
  fs.writeFileSync(args['served-out'], response.results.map((item) => item.event_id).join('\n') + (response.results.length ? '\n' : ''));
}

const servedAt = new Date().toISOString();
for (const [index, item] of response.results.entries()) {
  appendJsonl(args['served-log'], {
    timestamp: servedAt,
    call_id: request.call_id,
    purpose: request.purpose,
    session_id: request.session_id,
    provider: request.provider,
    query: request.query,
    event_id: item.event_id,
    rank: index + 1,
    source: item._sources || 'keyword',
    project: item.project || request.project,
    backend: 'explorer',
  });
}

appendJsonl(args['call-log'], {
  timestamp: servedAt,
  call_id: request.call_id,
  requested_backend: 'explorer',
  selected_backend: 'explorer',
  transport,
  purpose: request.purpose,
  session_id: request.session_id,
  provider: request.provider,
  query: request.query,
  project: request.project,
  since: request.since,
  before: request.before,
  result_count: response.results.length,
  elapsed_ms: Date.now() - started,
  stages_ms: response.stages_ms,
  index_generation: response.index_generation,
  semantic_status: response.semantic_status,
  fallback_reason: null,
});

process.stdout.write(outputFormat === 'jsonl' ? renderJsonl(response) : renderText(response, transport));
