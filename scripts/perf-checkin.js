#!/usr/bin/env node
// perf-checkin.js — one command that answers "is recall still fast, and is
// Turbo still robust?" with numbers you can paste into a release note.
//
// It measures the three paths a user actually pays for, against one corpus:
//
//   in-process   readAllEvents → buildIndex → scoreBM25 / hybridSearch /
//                census / tempo / delta, the same functions Turbo and the
//                Explorer call, timed with no HTTP in the way;
//   portable CLI cartographer-search.sh with Turbo off and Qdrant unreachable,
//                i.e. the bash + awk path every fresh install starts on;
//   Turbo        the managed controller spawns the real turbo-server.js against
//                the corpus; the probe measures time-to-ready, warm /api/recall
//                and /api/facts latency (server-side and through the CLI), then
//                exercises the failure modes the spec says are handled: a burst
//                of concurrent requests, a contract rejection (must be fast and
//                must not fall back to the file spool), malformed JSON, a live
//                append reaching the index without a restart, and a clean stop.
//
// Every number is a measurement of THIS machine and THIS corpus. The reference
// figures in docs/FACTS.md and docs/TURBO_MODE_SPEC.md are from the maintainer
// corpus (127k events). Comparing shapes across machines is fine; comparing
// absolute milliseconds is not, so the report prints the corpus size next to
// every latency.
//
// Usage:
//   node scripts/perf-checkin.js                  # CARTOGRAPHER_DEV_DIR, or a
//                                                 # synthetic corpus if it has no logs
//   node scripts/perf-checkin.js --synthetic 127000
//   node scripts/perf-checkin.js --json > perf.json
//   node scripts/perf-checkin.js --skip-turbo     # in-process + CLI only
//
// Telemetry is redirected to disposable files (served log, access ledger,
// Turbo config and state), so a benchmark never contaminates utility cohorts —
// see docs/TURBO_MODE_SPEC.md "Benchmark runs".

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const option = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
const JSON_OUT = flag('--json');
const SKIP_TURBO = flag('--skip-turbo');
const SKIP_CLI = flag('--skip-cli');

// Delta serving and time decay both make a benchmark lie: a live session id
// suppresses repeat results, and a fixed corpus ages under decay. Same
// precautions as tests/release-smoke.sh and scripts/eval-search.js.
for (const key of ['CARTOGRAPHER_SESSION_ID', 'CLAUDE_SESSION_ID', 'CLAUDE_CODE_SESSION_ID', 'CODEX_SESSION_ID']) {
  delete process.env[key];
}
process.env.CARTOGRAPHER_SEMANTIC = '0';
process.env.CARTOGRAPHER_QDRANT_URL = 'http://127.0.0.1:1';

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-perf-'));
const LOG_NAMES = ['changelog.jsonl', 'research-log.jsonl', 'session-milestones.jsonl', 'tool-use-log.jsonl', 'prompt-history.jsonl'];

// ---------------------------------------------------------------------------
// Corpus
// ---------------------------------------------------------------------------

function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A corpus with the shape of a real one: five logs, twelve projects, two
 * providers, ~13k sessions, summaries drawn from a Zipfian vocabulary with
 * file paths and commit hashes mixed in, timestamps over 400 days with the
 * last 24h holding about 1% of rows, and ~15% of research rows dual-logged
 * into the changelog under the same event_id so dedup has work to do.
 */
function synthesize(dir, count) {
  const rand = mulberry32(20260914);
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const projects = ['session-cartographer', 'psychodeli-webgl-port', 'camerastein', 'frakbot', 'tessera',
    'attentional-foraging', 'mbp-dash', 'kangentic', 'lume', 'psychodeli-tvos', 'notes', 'infra'];
  const types = ['tool_file_edit', 'tool_bash', 'commit', 'fetch', 'search', 'milestone', 'session_end', 'compaction', 'prompt'];
  const vocab = Array.from({ length: 4000 }, (_, i) => `w${i.toString(36)}`);
  const anchors = ['shader', 'seam', 'bm25', 'fusion', 'qdrant', 'transcript', 'worktree', 'hook', 'milestone',
    'facets', 'timeline', 'turbo', 'recall', 'census', 'tempo', 'delta', 'cursor', 'window', 'project', 'session',
    'electron', 'netlify', 'playwright', 'vitest', 'audio', 'motion', 'palette', 'preset', 'lorenz', 'attractor'];
  const files = ['js/app.js', 'js/audio-reactivity.js', 'explorer/server/search.js', 'scripts/cartographer-search.sh',
    'docs/FACTS.md', 'shaders/main.frag', 'js/ae/ae-tracing.js', 'explorer/src/views/Memory.jsx', 'README.md'];
  const zipf = () => vocab[Math.min(vocab.length - 1, Math.floor(Math.pow(rand(), 2.2) * vocab.length))];
  const dayMs = 86_400_000;
  const now = Date.now();
  const sessions = Array.from({ length: Math.max(50, Math.round(count / 9.4)) }, (_, i) => `sess-${i.toString(36)}`);

  const streams = Object.fromEntries(LOG_NAMES.map((name) => [name, fs.openSync(path.join(dir, name), 'w')]));
  const buffers = Object.fromEntries(LOG_NAMES.map((name) => [name, []]));
  const flush = (name, force = false) => {
    if (buffers[name].length >= 2000 || force) {
      fs.writeSync(streams[name], `${buffers[name].join('\n')}\n`);
      buffers[name] = [];
    }
  };

  let inWindow = 0;
  for (let i = 0; i < count; i++) {
    const r = rand();
    const log = r < 0.55 ? 'changelog.jsonl' : r < 0.80 ? 'tool-use-log.jsonl' : r < 0.88 ? 'session-milestones.jsonl'
      : r < 0.94 ? 'research-log.jsonl' : 'prompt-history.jsonl';
    // 1% of rows in the last day, the rest spread over the preceding 400 days.
    const recent = rand() < 0.01;
    const ts = recent ? now - rand() * dayMs : now - dayMs - rand() * 400 * dayMs;
    if (recent) inWindow++;
    const words = Array.from({ length: 6 + Math.floor(rand() * 18) }, () => (rand() < 0.15 ? pick(anchors) : zipf()));
    if (rand() < 0.4) words.push(pick(files));
    if (rand() < 0.2) words.push(`Commit ${Math.floor(rand() * 0xfffffff).toString(16).padStart(7, '0')}`);
    const event = {
      event_id: `evt-${i.toString(36)}`,
      timestamp: new Date(ts).toISOString(),
      type: log === 'research-log.jsonl' ? pick(['fetch', 'search']) : log === 'session-milestones.jsonl'
        ? pick(['milestone', 'session_end', 'compaction']) : log === 'prompt-history.jsonl' ? 'prompt' : pick(types),
      provider: rand() < 0.7 ? 'claude' : 'codex',
      project: pick(projects),
      session_id: pick(sessions),
      summary: words.join(' '),
    };
    if (log === 'research-log.jsonl') event.url = `https://example.org/${zipf()}/${zipf()}`;
    if (event.type === 'tool_file_edit') event.file_path = `/home/u/${event.project}/${pick(files)}`;
    const line = JSON.stringify(event);
    buffers[log].push(line);
    flush(log);
    if (log === 'research-log.jsonl' && rand() < 0.15) { buffers['changelog.jsonl'].push(line); flush('changelog.jsonl'); }
  }
  for (const name of LOG_NAMES) { flush(name, true); fs.closeSync(streams[name]); }
  return { count, inWindow };
}

function corpusFromEnv() {
  const dir = process.env.CARTOGRAPHER_DEV_DIR || path.join(os.homedir(), 'Documents', 'dev');
  const present = LOG_NAMES.filter((name) => fs.existsSync(path.join(dir, name)));
  return present.length ? { dir, present } : null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const quantile = (xs, q) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};
const stats = (xs) => ({ n: xs.length, median: r2(quantile(xs, 0.5)), p95: r2(quantile(xs, 0.95)), max: r2(Math.max(...xs)) });
const r2 = (x) => (x === null || x === undefined ? null : Math.round(x * 100) / 100);
const timed = async (fn) => { const t = performance.now(); const value = await fn(); return { ms: performance.now() - t, value }; };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

function childEnv(extra) {
  const env = { ...process.env, ...extra };
  for (const key of ['CARTOGRAPHER_SESSION_ID', 'CLAUDE_SESSION_ID', 'CLAUDE_CODE_SESSION_ID', 'CODEX_SESSION_ID']) delete env[key];
  return env;
}

function rssMb(pid) {
  try {
    const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
    const m = status.match(/VmRSS:\s+(\d+) kB/);
    return m ? Math.round(Number(m[1]) / 1024) : null;
  } catch {
    const out = spawnSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim();
    return out ? Math.round(Number(out) / 1024) : null;
  }
}

const QUERIES = ['shader seam', 'bm25 fusion', 'qdrant transcript', 'worktree hook milestone', 'turbo recall census',
  'facets timeline', 'electron netlify deploy', 'audio motion palette'];

const report = { generated_at: new Date().toISOString(), node: process.version, platform: `${os.platform()} ${os.arch()}`, cpus: os.cpus().length, corpus: {}, in_process: {}, cli: {}, turbo: {}, checks: [] };
const check = (name, ok, detail = '') => { report.checks.push({ name, ok: Boolean(ok), detail }); return ok; };

// ---------------------------------------------------------------------------
// 1. Corpus
// ---------------------------------------------------------------------------

let corpusDir;
const synthetic = flag('--synthetic') || !corpusFromEnv();
if (synthetic) {
  corpusDir = path.join(work, 'corpus');
  fs.mkdirSync(corpusDir);
  const count = Number(option('--synthetic', '127000')) || 127000;
  const t = performance.now();
  const made = synthesize(corpusDir, count);
  report.corpus = { source: 'synthetic', dir: corpusDir, rows_written: made.count, rows_in_last_24h: made.inWindow, synthesize_ms: r2(performance.now() - t) };
} else {
  const found = corpusFromEnv();
  corpusDir = found.dir;
  report.corpus = { source: 'live', dir: corpusDir, logs: found.present };
}
report.corpus.bytes = LOG_NAMES.reduce((sum, name) => {
  try { return sum + fs.statSync(path.join(corpusDir, name)).size; } catch { return sum; }
}, 0);
process.env.CARTOGRAPHER_DEV_DIR = corpusDir;
process.env.CARTOGRAPHER_ACCESS_LEDGER = path.join(work, 'access-ledger.jsonl');
process.env.CARTOGRAPHER_SERVED_LOG = path.join(work, 'served-log.jsonl');

// ---------------------------------------------------------------------------
// 2. In-process
// ---------------------------------------------------------------------------

// Imported after CARTOGRAPHER_DEV_DIR is set: jsonl.js binds its paths at load.
const { readAllEvents, LOG_FILES } = await import('../explorer/server/jsonl.js');
const { buildIndex, scoreBM25 } = await import('../explorer/server/bm25.js');
const { hybridSearch } = await import('../explorer/server/search.js');
const { executeFacts } = await import('../explorer/server/facts.js');

{
  const before = process.memoryUsage().rss;
  const load = await timed(() => readAllEvents());
  const events = load.value;
  const index = await timed(() => buildIndex(events));
  const afterIndex = process.memoryUsage().rss;
  report.in_process.load = { ms: r2(load.ms), events: events.length };
  report.in_process.index = { ms: r2(index.ms), docs: index.value.docs.size, rss_delta_mb: Math.round((afterIndex - before) / 1048576) };
  const idx = index.value;

  const bm = [];
  const hy = [];
  for (let rep = 0; rep < 5; rep++) {
    for (const q of QUERIES) {
      bm.push((await timed(() => scoreBM25(idx, q, { limit: 500 }))).ms);
      hy.push((await timed(() => hybridSearch(idx, q, {}))).ms);
    }
  }
  report.in_process.bm25 = { ...stats(bm), queries: QUERIES.length, reps: 5 };
  report.in_process.hybrid_keyword_only = { ...stats(hy), queries: QUERIES.length, reps: 5 };

  // Windowed keyword: the source-bound window must still surface in-window rows
  // for a query whose global top-500 is almost entirely older. Composition, not
  // "results came back".
  const sinceMs = Date.now() - 86_400_000;
  const win = await timed(() => scoreBM25(idx, 'shader seam', { limit: 500, sinceMs }));
  const winRows = win.value.items;
  const inWindow = winRows.filter((r) => new Date(r.event.timestamp).getTime() >= sinceMs).length;
  report.in_process.bm25_windowed_24h = { ms: r2(win.ms), rows: winRows.length, rows_in_window: inWindow };
  check('windowed keyword rows all fall inside the window', winRows.length === inWindow && (winRows.length > 0 || !synthetic), `${inWindow}/${winRows.length}`);

  const factsCtx = { events, index: idx };
  const opts = { corpusRoot: corpusDir, logFiles: LOG_FILES };
  const since = new Date(sinceMs).toISOString();
  const census = await timed(() => executeFacts(factsCtx, { contract_version: 1, verb: 'census', call_id: 'perf-census', since }, opts));
  const tempo = await timed(() => executeFacts(factsCtx, { contract_version: 1, verb: 'tempo', call_id: 'perf-tempo' }, opts));
  const censusAll = await timed(() => executeFacts(factsCtx, { contract_version: 1, verb: 'census', call_id: 'perf-census-all' }, opts));
  report.in_process.facts = {
    census_24h: { ms: r2(census.ms), scan_ms: census.value.stages_ms.scan, total_events: census.value.facts.total ?? census.value.facts.events ?? null },
    census_all: { ms: r2(censusAll.ms), scan_ms: censusAll.value.stages_ms.scan },
    tempo: { ms: r2(tempo.ms), scan_ms: tempo.value.stages_ms.scan },
  };
  if (synthetic) {
    const counted = census.value.facts.total ?? census.value.facts.events;
    check('24h census count survives an independent scan', counted === report.corpus.rows_in_last_24h, `census ${counted} vs written ${report.corpus.rows_in_last_24h}`);
  }

  // Delta: baseline, then append 50 rows, then the cursor must report exactly 50.
  const baseline = await timed(() => executeFacts(factsCtx, { contract_version: 1, verb: 'delta', call_id: 'perf-delta-0' }, opts));
  const appended = Array.from({ length: 50 }, (_, i) => JSON.stringify({
    event_id: `evt-perf-append-${i}`, timestamp: new Date().toISOString(), type: 'milestone', provider: 'claude',
    project: 'session-cartographer', session_id: 'sess-perf', summary: `perf checkin appended row ${i} zzdeltatoken`,
  })).join('\n');
  fs.appendFileSync(LOG_FILES.milestones, `${appended}\n`);
  const next = await timed(() => executeFacts(factsCtx, { contract_version: 1, verb: 'delta', call_id: 'perf-delta-1', cursor: baseline.value.facts.cursor }, opts));
  const newCount = next.value.facts.events?.length ?? next.value.facts.new ?? next.value.facts.count ?? null;
  report.in_process.facts.delta = { baseline_ms: r2(baseline.ms), resume_ms: r2(next.ms), reported_new: newCount };
  check('delta cursor reports exactly the appended rows', newCount === 50, `reported ${newCount}, appended 50`);
}

// ---------------------------------------------------------------------------
// 3. Portable CLI (bash + awk), Turbo off, Qdrant unreachable
// ---------------------------------------------------------------------------

function runCli(query, extraEnv = {}) {
  const t = performance.now();
  const result = spawnSync('bash', [path.join(ROOT, 'scripts', 'cartographer-search.sh'), query, '--limit', '15'], {
    encoding: 'utf8', env: childEnv({ CARTOGRAPHER_TURBO: '0', CARTOGRAPHER_DECAY_LAMBDA: '0', ...extraEnv }), timeout: 300_000,
  });
  const ms = performance.now() - t;
  // One result per `[timestamp] [source] event_id` header line.
  const results = (result.stdout.match(/^\[\d{4}-\d\d-\d\d[^\]]*\] \[[a-z-]+\] \S+/gm) || []).length;
  return { ms, status: result.status, results, stdout: result.stdout, stderr: result.stderr };
}

if (!SKIP_CLI) {
  const runs = [];
  for (const q of QUERIES.slice(0, 3)) runs.push(runCli(q));
  report.cli.portable = { ...stats(runs.map((r) => r.ms)), queries: 3, results: runs.map((r) => r.results), status: runs.map((r) => r.status) };
  check('portable CLI returns ranked rows on every query', runs.every((r) => r.status === 0 && r.results > 0), runs.map((r) => `${r.status}/${r.results}`).join(' '));
}

// ---------------------------------------------------------------------------
// 4. Turbo — the managed controller, the real server, and its failure modes
// ---------------------------------------------------------------------------

if (!SKIP_TURBO) {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const turboEnv = childEnv({
    CARTOGRAPHER_CONFIG: path.join(work, 'config.json'),
    CARTOGRAPHER_TURBO_STATE_DIR: path.join(work, 'turbo'),
    CARTOGRAPHER_TURBO_URL: url,
    CARTOGRAPHER_TURBO_TIMEOUT_MS: '1500',
    CARTOGRAPHER_DECAY_LAMBDA: '0',
  });
  const controller = (args) => spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'cartographer-turbo.js'), ...args], { encoding: 'utf8', env: turboEnv, timeout: 120_000 });
  const parse = (r) => { try { return JSON.parse(r.stdout); } catch { return null; } };

  const enable = await timed(() => controller(['enable', '--url', url, '--timeout', '1500']));
  const enabled = parse(enable.value);
  report.turbo.enable = { ms: r2(enable.ms), started: enabled?.service?.started ?? null, pid: enabled?.service?.pid ?? null, http: enabled?.service?.ready?.http ?? null, events: enabled?.service?.ready?.events ?? null };
  const pid = enabled?.service?.pid;
  // `enable` must report the terminal HTTP state, not the moment the corpus
  // finished loading. Poll health afterwards anyway so the report shows how
  // long after enable the port actually answered.
  let listeningAfterMs = null;
  if (pid) {
    const t = performance.now();
    for (let i = 0; i < 50; i++) {
      try { if ((await fetch(`${url}/api/recall/health`)).ok) { listeningAfterMs = performance.now() - t; break; } } catch {}
      await sleep(100);
    }
  }
  report.turbo.enable.listening_after_ms = r2(listeningAfterMs);
  check('controller spawns a Turbo service and reports it listening', enabled?.service?.started === true && enabled?.service?.ready?.http === 'listening' && listeningAfterMs !== null, `enable reported http=${enabled?.service?.ready?.http}; port answered ${r2(listeningAfterMs)} ms after enable returned`);

  if (pid) {
    const post = async (endpoint, body, timeoutMs = 5000) => {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), timeoutMs);
      const t = performance.now();
      try {
        const res = await fetch(`${url}${endpoint}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body), signal: ctl.signal });
        const json = await res.json().catch(() => null);
        return { ms: performance.now() - t, status: res.status, body: json };
      } finally { clearTimeout(timer); }
    };
    const recallBody = (query, n) => ({ contract_version: 1, call_id: `perf-recall-${n}`, query, project: '', since: '', before: '', limit: 15, purpose: 'remember', session_id: '', provider: 'claude', corpus_root: '', excluded_event_ids: [] });
    const rows = (body) => body?.results?.length ?? body?.items?.length ?? body?.events?.length ?? 0;

    const health = await timed(() => fetch(`${url}/api/recall/health`).then((r) => r.json()));
    report.turbo.health = { ms: r2(health.ms), events: health.value.events, indexed_docs: health.value.indexed_docs, backend: health.value.backend };

    // Warm recall, server-side latency (one HTTP hop, no node startup).
    const warm = [];
    let n = 0;
    for (let rep = 0; rep < 4; rep++) for (const q of QUERIES) warm.push(await post('/api/recall', recallBody(q, n++)));
    report.turbo.recall_http = { ...stats(warm.map((r) => r.ms)), status: [...new Set(warm.map((r) => r.status))], rows: stats(warm.map((r) => rows(r.body))).median, stages_ms_median: r2(quantile(warm.map((r) => r.body?.stages_ms?.total ?? NaN).filter(Number.isFinite), 0.5)) };
    check('warm /api/recall answers 200 with rows', warm.every((r) => r.status === 200 && rows(r.body) > 0), `${warm.filter((r) => r.status !== 200).length} non-200`);

    const facts = [];
    for (let rep = 0; rep < 5; rep++) {
      facts.push(await post('/api/facts', { contract_version: 1, verb: 'census', call_id: `perf-facts-${rep}`, since: new Date(Date.now() - 86_400_000).toISOString() }));
      facts.push(await post('/api/facts', { contract_version: 1, verb: 'tempo', call_id: `perf-tempo-${rep}` }));
    }
    report.turbo.facts_http = { ...stats(facts.map((r) => r.ms)), status: [...new Set(facts.map((r) => r.status))] };
    check('warm /api/facts answers 200', facts.every((r) => r.status === 200));

    // Burst: 20 concurrent recalls must all succeed, and the tail must stay
    // inside the 1500 ms budget the CLI gives the warm path.
    const burstT = performance.now();
    const burst = await Promise.all(Array.from({ length: 20 }, (_, i) => post('/api/recall', recallBody(QUERIES[i % QUERIES.length], `burst-${i}`))));
    report.turbo.burst_20 = { wall_ms: r2(performance.now() - burstT), ...stats(burst.map((r) => r.ms)), non_200: burst.filter((r) => r.status !== 200).length };
    check('20 concurrent recalls all succeed inside the 1500 ms budget', burst.every((r) => r.status === 200) && quantile(burst.map((r) => r.ms), 0.95) < 1500);

    // Contract rejection: an HTTP 4xx is an answer, not an outage. The server
    // must answer fast, and the client must exit non-zero WITHOUT waiting out
    // the file-spool deadline (the composite-error bug in CHANGELOG 0.7.5).
    const bad = await post('/api/recall', { ...recallBody('shader', 'bad'), limit: 99999 });
    const malformed = await post('/api/recall', '{not json');
    const clientT = performance.now();
    const client = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'turbo-search-client.js'), '--query', 'shader', '--limit', '99999', '--url', url, '--timeout', '1500', '--call-id', 'perf-bad-client'], { encoding: 'utf8', env: turboEnv, timeout: 30_000 });
    const clientMs = performance.now() - clientT;
    report.turbo.contract_rejection = { server_status: bad.status, server_ms: r2(bad.ms), malformed_status: malformed.status, client_exit: client.status, client_ms: r2(clientMs), client_stderr: client.stderr.trim().split('\n')[0]?.slice(0, 160) };
    check('contract rejection is a fast 4xx', bad.status >= 400 && bad.status < 500 && bad.ms < 200, `${bad.status} in ${r2(bad.ms)} ms`);
    check('malformed JSON is a 400', malformed.status === 400);
    check('client exits non-zero on rejection without spool fallback', client.status !== 0 && clientMs < 1400 && !/spool/i.test(client.stderr), `exit ${client.status} in ${r2(clientMs)} ms`);

    // Live append: a row written to a log after spawn must be recallable
    // without a restart. The watcher polls; allow it a few seconds.
    const token = `zzliveappend${Date.now().toString(36)}`;
    fs.appendFileSync(path.join(corpusDir, 'changelog.jsonl'), `${JSON.stringify({ event_id: `evt-${token}`, timestamp: new Date().toISOString(), type: 'milestone', provider: 'codex', project: 'session-cartographer', session_id: 'sess-perf', summary: `live append ${token} reached the warm index` })}\n`);
    const appendT = performance.now();
    let seenMs = null;
    for (let i = 0; i < 100; i++) {
      const r = await post('/api/recall', recallBody(token, `live-${i}`));
      if (rows(r.body) > 0) { seenMs = performance.now() - appendT; break; }
      await sleep(100);
    }
    report.turbo.live_append = { visible_after_ms: r2(seenMs) };
    check('a live append is recallable without a restart', seenMs !== null, seenMs === null ? 'not visible after 10 s' : `${r2(seenMs)} ms`);

    // CLI end to end with Turbo on: what /remember actually costs the agent.
    if (!SKIP_CLI) {
      const cliRuns = QUERIES.slice(0, 3).map((q) => runCli(q, { CARTOGRAPHER_TURBO: '1', CARTOGRAPHER_TURBO_URL: url, CARTOGRAPHER_CONFIG: turboEnv.CARTOGRAPHER_CONFIG, CARTOGRAPHER_TURBO_STATE_DIR: turboEnv.CARTOGRAPHER_TURBO_STATE_DIR }));
      const viaTurbo = cliRuns.filter((r) => /turbo/i.test(r.stdout) || /turbo/i.test(r.stderr)).length;
      report.cli.turbo = { ...stats(cliRuns.map((r) => r.ms)), queries: 3, results: cliRuns.map((r) => r.results), status: cliRuns.map((r) => r.status), runs_naming_turbo: viaTurbo };
      check('CLI with Turbo on returns ranked rows on every query', cliRuns.every((r) => r.status === 0 && r.results > 0), cliRuns.map((r) => `${r.status}/${r.results}`).join(' '));
    }

    report.turbo.server_rss_mb = rssMb(pid);
    const status = parse(controller(['status']));
    report.turbo.status = { running: status?.service?.running, compatible: status?.service?.compatible, transport: status?.transport, heap_used_mb: status?.service?.heap_used_mb };
    check('status reports a compatible managed service', status?.service?.running === true && status?.service?.compatible === true);

    const disable = await timed(() => controller(['disable']));
    const stopped = parse(disable.value);
    let alive = true;
    try { process.kill(pid, 0); } catch { alive = false; }
    report.turbo.disable = { ms: r2(disable.ms), stopped: stopped?.service?.stopped ?? null, process_alive_after: alive, ready_file_removed: !fs.existsSync(path.join(work, 'turbo', 'ready.json')) };
    check('disable stops the service and clears its state', stopped?.service?.stopped === true && !alive && !fs.existsSync(path.join(work, 'turbo', 'ready.json')));
  }
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

if (!flag('--keep')) fs.rmSync(work, { recursive: true, force: true });
else report.work_dir = work;

if (JSON_OUT) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const c = report.corpus;
  const ip = report.in_process;
  const lines = [];
  lines.push(`# Recall performance check-in — ${report.generated_at.slice(0, 10)}`, '');
  lines.push(`Corpus: ${c.source}${c.source === 'synthetic' ? ` (${c.rows_written.toLocaleString()} rows written, ${c.rows_in_last_24h} in the last 24 h)` : ''}, ${(c.bytes / 1048576).toFixed(1)} MB across the five logs. Node ${report.node}, ${report.platform}, ${report.cpus} CPUs.`, '');
  lines.push('| Path | Operation | Median | p95 | Note |', '|---|---|---:|---:|---|');
  lines.push(`| in-process | load five logs (readAllEvents) | ${ip.load.ms} ms | — | ${ip.load.events.toLocaleString()} events resident |`);
  lines.push(`| in-process | build BM25 index | ${ip.index.ms} ms | — | ${ip.index.docs.toLocaleString()} docs, +${ip.index.rss_delta_mb} MB RSS |`);
  lines.push(`| in-process | scoreBM25, limit 500 | ${ip.bm25.median} ms | ${ip.bm25.p95} ms | ${ip.bm25.queries} queries × ${ip.bm25.reps} |`);
  lines.push(`| in-process | hybridSearch, keyword leg only | ${ip.hybrid_keyword_only.median} ms | ${ip.hybrid_keyword_only.p95} ms | RRF + facets, semantic pinned off |`);
  lines.push(`| in-process | scoreBM25 with a 24 h window | ${ip.bm25_windowed_24h.ms} ms | — | ${ip.bm25_windowed_24h.rows_in_window}/${ip.bm25_windowed_24h.rows} rows in window |`);
  lines.push(`| in-process | facts census, 24 h | ${ip.facts.census_24h.ms} ms | — | scan ${ip.facts.census_24h.scan_ms} ms |`);
  lines.push(`| in-process | facts census, whole corpus | ${ip.facts.census_all.ms} ms | — | scan ${ip.facts.census_all.scan_ms} ms |`);
  lines.push(`| in-process | facts tempo | ${ip.facts.tempo.ms} ms | — | scan ${ip.facts.tempo.scan_ms} ms |`);
  lines.push(`| in-process | facts delta baseline / resume | ${ip.facts.delta.baseline_ms} / ${ip.facts.delta.resume_ms} ms | — | reported ${ip.facts.delta.reported_new} new after 50 appended |`);
  if (report.cli.portable) lines.push(`| CLI | cartographer-search.sh, Turbo off | ${report.cli.portable.median} ms | ${report.cli.portable.p95} ms | bash + awk, ${report.cli.portable.queries} queries, wall clock |`);
  if (report.cli.turbo) lines.push(`| CLI | cartographer-search.sh, Turbo on | ${report.cli.turbo.median} ms | ${report.cli.turbo.p95} ms | wall clock incl. node client startup |`);
  const t = report.turbo;
  if (t.enable) {
    lines.push(`| Turbo | enable → ready | ${t.enable.ms} ms | — | spawn + load ${t.enable.events?.toLocaleString?.() ?? '?'} events; http ${t.enable.http}, port answered ${t.enable.listening_after_ms ?? '?'} ms later |`);
    if (t.recall_http) lines.push(`| Turbo | POST /api/recall, warm | ${t.recall_http.median} ms | ${t.recall_http.p95} ms | server stages ${t.recall_http.stages_ms_median} ms median |`);
    if (t.facts_http) lines.push(`| Turbo | POST /api/facts census + tempo | ${t.facts_http.median} ms | ${t.facts_http.p95} ms | |`);
    if (t.burst_20) lines.push(`| Turbo | 20 concurrent recalls | ${t.burst_20.median} ms | ${t.burst_20.p95} ms | ${t.burst_20.wall_ms} ms wall, ${t.burst_20.non_200} failed |`);
    if (t.contract_rejection) lines.push(`| Turbo | contract rejection round trip | ${t.contract_rejection.server_ms} ms | — | HTTP ${t.contract_rejection.server_status}; client exit ${t.contract_rejection.client_exit} in ${t.contract_rejection.client_ms} ms |`);
    if (t.live_append) lines.push(`| Turbo | live append visible in recall | ${t.live_append.visible_after_ms ?? 'never'} ms | — | no restart |`);
    if (t.server_rss_mb) lines.push(`| Turbo | server RSS after the run | ${t.server_rss_mb} MB | — | heap ${t.status?.heap_used_mb ?? '?'} MB |`);
    if (t.disable) lines.push(`| Turbo | disable → stopped | ${t.disable.ms} ms | — | process alive after: ${t.disable.process_alive_after} |`);
  }
  lines.push('', '## Checks', '');
  for (const ck of report.checks) lines.push(`- ${ck.ok ? 'PASS' : 'FAIL'} — ${ck.name}${ck.detail ? ` (${ck.detail})` : ''}`);
  console.log(lines.join('\n'));
}

process.exitCode = report.checks.every((ck) => ck.ok) ? 0 : 1;
