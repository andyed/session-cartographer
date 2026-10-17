#!/usr/bin/env node
// age-curve.js — known-item recall by record age, over both search engines.
//
// The question this answers: when a caller names a specific past record with
// its distinctive words, does that record come back, and does the answer depend
// on how old the record is? It should not. On 2026-10-16 it did: on the live
// corpus (202k events, semantic leg off) the shipped ranking found 97% of
// known items under a week old and 15% of those older than 90 days, while with
// decay off every bucket scored 98-100%. Nothing errored; old records were
// simply ranked past the page, or trimmed for their age before they could be.
//
// Two kinds of case are measured, so an arm cannot pass by never decaying:
//
//   known   a query built from a record's three highest-IDF tokens, kept only
//           when at most five documents contain all three (a known item).
//           Success is the record in the top 10, at any age.
//   recency a vague query whose tokens many records share across months.
//           Success is the newest of them in the top 10 — the "latest on X"
//           intent that time decay exists to serve.
//
// Both engines run on the same cases: hybridSearch in-process (the Turbo path)
// and the portable awk CLI as a child with CARTOGRAPHER_TURBO=0 and the same
// decay environment. Reported per age bucket: S@1, S@10, MRR@100, absent.
//
// The library half is imported by tests/unit/age-curve-gate.test.js, which
// runs it over a synthetic fixture in CI. The command-line half runs it over
// the real corpus, read-only:
//
//   node scripts/age-curve.js                         # shipped ranking, both engines
//   node scripts/age-curve.js --arm shipped --arm nodecay:api --arm noexempt:api
//   node scripts/age-curve.js --root /path/to/older/checkout --root . --arm shipped
//   node scripts/age-curve.js --json --out /tmp/curve.json
//   node scripts/age-curve.js --state /tmp/curve-state ...   # resumable; rerun the same line to continue
//
// An arm is `name[:engines]`; engines default to --engines (api,cli). The CLI
// costs ~17 s a query on a 200k-event corpus, so diagnostic arms are usually
// run on the API alone. Every arm and root in one invocation shares one
// snapshot and one case set; separate invocations would sample a corpus that
// grew in between.
//
// Read-only means three things here. The five logs are copied (an APFS clone
// on macOS, so it costs no disk) into a temporary directory first, and both
// engines read the copy, so the cases and both engines see one frozen corpus
// while the live logs keep growing. Every telemetry path the CLI writes — served
// log, access ledger, search-call log — is /dev/null, the session variables are
// unset, and the access ledger is empty, so promote-on-reuse does not colour
// the curve. And the cases are corpus text: they are written only to the
// temporary directory (or --state), and both --out and --state refuse a path
// inside this repository, so a query built from someone's prompt history
// cannot be committed by accident.

import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants as fsConstants, appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '..');

const DAY_MS = 86400e3;
export const DEPTH = 100; // MRR and "absent" are measured to this depth in both engines
export const BUCKETS = ['<7d', '7-30d', '30-90d', '90d+'];
const LEDGER_NAME = 'access-ledger.jsonl';
export const LOG_NAMES = {
  changelog: 'changelog.jsonl',
  research: 'research-log.jsonl',
  milestones: 'session-milestones.jsonl',
  'tool-use': 'tool-use-log.jsonl',
  prompts: 'prompt-history.jsonl',
};

const SESSION_VARS = ['CARTOGRAPHER_SESSION_ID', 'CLAUDE_SESSION_ID', 'CLAUDE_CODE_SESSION_ID',
  'CODEX_SESSION_ID', 'CODEX_THREAD_ID', 'HERMES_SESSION_ID', 'CARTOGRAPHER_PROVIDER'];
const RANKING_VARS = ['CARTOGRAPHER_DECAY_LAMBDA', 'CARTOGRAPHER_DECAY_LOOKUP_MAX'];

export function bucketOf(ageDays) {
  if (ageDays < 7) return '<7d';
  if (ageDays < 30) return '7-30d';
  if (ageDays < 90) return '30-90d';
  return '90d+';
}

// The arms measured on 2026-10-16. `env` is applied to both engines; `ranking`
// reaches only an in-process hybridSearch that accepts it (this checkout), so
// an arm that carries one is API-only. `shipped` clears the decay variables, so
// each engine runs its own defaults — which is the point when --root names an
// older checkout. `ledger` arms read a frozen copy of the real access ledger;
// every other arm reads an empty one, so promote-on-reuse does not colour it.
export const ARMS = {
  shipped: { env: {} },
  'shipped+ledger': { env: {}, ledger: true },
  nodecay: { env: { CARTOGRAPHER_DECAY_LAMBDA: '0' } },
  noexempt: { env: { CARTOGRAPHER_DECAY_LOOKUP_MAX: '0' } },
  // Power-law forgetting, t^-0.5 in days (ARCHIVAL_RECALL.md option 1): a
  // 237-day gap costs ~15x instead of exp's ~290x. Not shipped; measured.
  power: { env: { CARTOGRAPHER_DECAY_LOOKUP_MAX: '0' }, ranking: { decay: powerDecay(0.5) }, apiOnly: true },
  'power+exempt': { env: {}, ranking: { decay: powerDecay(0.5) }, apiOnly: true },
};

// Parametric arms, built from the name:
//   actr-d<d>[+exempt]  ACT-R base-level activation, B = ln Σ_j t_j^-d over the
//                       event and every recorded reuse (Anderson & Schooler
//                       1991). In ACT-R, activation adds to the log odds of
//                       retrieval, so it enters a relevance score as e^B — a
//                       factor of Σ t_j^-d. Rehearsals come from the ledger;
//                       the separate reuse boost is off, since B already has
//                       them.
//   cmem-d<d>[+exempt]  claude-mem's opt-in ranking (2026-09-30), taken here
//                       as a factor: ln(1 + t^-d + α Σ t_k^-d) with α = 1.
// t is in days, floored at 0.02 (30 minutes), the floor the ledger reader uses.
// Each curve is scaled to 1 at that floor, as exp(-λt) is at 0: the scale does
// not change how non-exempt items order among themselves, but an exempt item
// keeps a factor of exactly 1, and a curve that rose above 1 for items under a
// day old would beat it for no reason but the units.
const FLOOR_DAYS = 0.02;
export function resolveArm(name) {
  if (ARMS[name]) return ARMS[name];
  const m = /^(actr|cmem)-d([0-9]*\.?[0-9]+)(\+exempt)?$/.exec(name);
  if (!m) return null;
  const d = Number(m[2]);
  const decay = m[1] === 'actr' ? actrDecay(d) : cmemDecay(d, 1);
  return {
    env: m[3] ? {} : { CARTOGRAPHER_DECAY_LOOKUP_MAX: '0' },
    ranking: { decay, reuseBoost: false }, apiOnly: true, ledger: true,
  };
}

const days = (h) => Math.max(FLOOR_DAYS, h / 24);

export function powerDecay(d) {
  return ({ hours }) => Math.pow(Math.max(1, hours / 24), -d);
}

export function actrDecay(d) {
  const unit = Math.pow(FLOOR_DAYS, -d);
  return ({ eventHours, accessHours }) => {
    let sum = Math.pow(days(eventHours), -d);
    for (const h of accessHours) sum += Math.pow(days(h), -d);
    return sum / unit;
  };
}

export function cmemDecay(d, alpha) {
  const unit = Math.log(1 + Math.pow(FLOOR_DAYS, -d));
  return ({ eventHours, accessHours }) => {
    let rehearsal = 0;
    for (const h of accessHours) rehearsal += Math.pow(days(h), -d);
    return Math.log(1 + Math.pow(days(eventHours), -d) + alpha * rehearsal) / unit;
  };
}

// ─── Deterministic sampling ───

export function lcg(seed) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 4294967296);
}

// Fields both engines tokenize. explorer/server/bm25.js also reads `display`
// and `title`; bm25-search.awk also reads `cwd`. A query token taken from a
// field only one engine indexes would measure that difference instead of the
// ranking, so the sampler draws from the intersection.
const SHARED_FIELDS = ['summary', 'description', 'prompt', 'url', 'query', 'milestone'];

function sharedTokens(event, tokenize) {
  const text = SHARED_FIELDS.map((field) => event[field]).filter((v) => typeof v === 'string').join(' ');
  return [...new Set(tokenize(text))];
}

// A token the CLI would read as an entity (an event id, a path with an
// extension) can send a zero-result query down the knowledge-gap path, which
// appends to changelog.jsonl. Known-item tokens are alphanumeric runs, so this
// is belt and braces for the read-only promise.
const ENTITY_SHAPED = /^(evt|git)[a-z0-9]*$|^[0-9a-f]{7,}$/;

function eligibleToken(token, idTokens) {
  return token.length >= 4 && /[a-z]/.test(token) && !idTokens.has(token) && !ENTITY_SHAPED.test(token);
}

/**
 * Known-item cases, stratified by age bucket. A port of the 2026-10-16
 * reviewer's sampler: per bucket, draw candidate records from milestones,
 * research and prompts, build the query from the three highest-IDF tokens,
 * and keep it only when at most `maxFull` documents contain all three.
 */
export function sampleKnownItems(index, { tokenize, nowMs, perBucket = 60, seed = 12345,
  sources = ['milestones', 'research', 'prompts'], maxFull = 5 } = {}) {
  const rand = lcg(seed);
  const N = index.docs.size;
  const idf = (t) => Math.log((N - (index.df.get(t) || 0) + 0.5) / ((index.df.get(t) || 0) + 0.5));
  const pools = Object.fromEntries(BUCKETS.map((b) => [b, []]));
  for (const [id, doc] of index.docs) {
    const e = doc.event;
    if (!sources.includes(e._source)) continue;
    const ms = Date.parse(e.timestamp);
    if (!Number.isFinite(ms) || ms > nowMs) continue;
    pools[bucketOf((nowMs - ms) / DAY_MS)].push(id);
  }
  const cases = [];
  for (const bucket of BUCKETS) {
    const pool = pools[bucket];
    const picked = new Set();
    for (let guard = 0; picked.size < Math.min(perBucket * 4, pool.length) && guard < 100000; guard++) {
      picked.add(pool[Math.floor(rand() * pool.length)]);
    }
    let kept = 0;
    for (const id of picked) {
      if (kept >= perBucket) break;
      const doc = index.docs.get(id);
      const idTokens = new Set(tokenize(String(doc.event.event_id || '')));
      const cand = sharedTokens(doc.event, tokenize).filter((t) => eligibleToken(t, idTokens));
      if (cand.length < 3) continue;
      cand.sort((x, y) => idf(y) - idf(x) || (x < y ? -1 : 1));
      const terms = cand.slice(0, 3);
      let full = 0;
      for (const [, other] of index.docs) {
        if (terms.every((t) => other.tf.has(t)) && ++full > maxFull) break;
      }
      if (full > maxFull) continue;
      cases.push({ kind: 'known', bucket, id, query: terms.join(' '), source: doc.event._source });
      kept++;
    }
  }
  return cases;
}

/**
 * Recency-intent cases. Anchor on a recent record, pick two of its tokens that
 * a broad, long-lived set of records shares (between minFull and maxFull
 * documents contain both, at least a third of them older than 30 days), and
 * take the newest record in that set as the target. These are the queries an
 * arm that never decays gets wrong.
 */
export function sampleRecencyCases(index, { tokenize, nowMs, count = 40, seed = 777,
  minFull = 15, maxFull = 400 } = {}) {
  const rand = lcg(seed);
  const recent = [];
  for (const [id, doc] of index.docs) {
    const ms = Date.parse(doc.event.timestamp);
    if (Number.isFinite(ms) && ms <= nowMs && nowMs - ms < 7 * DAY_MS
      && ['milestones', 'research', 'prompts', 'changelog'].includes(doc.event._source)) recent.push(id);
  }
  const postings = new Map(); // token -> doc ids, built lazily per token
  const docsWith = (t) => {
    if (!postings.has(t)) {
      const ids = [];
      for (const [id, doc] of index.docs) if (doc.tf.has(t)) ids.push(id);
      postings.set(t, ids);
    }
    return postings.get(t);
  };
  const cases = [];
  const seen = new Set();
  for (let guard = 0; cases.length < count && guard < count * 20 && recent.length > 0; guard++) {
    const anchor = index.docs.get(recent[Math.floor(rand() * recent.length)]);
    const idTokens = new Set(tokenize(String(anchor.event.event_id || '')));
    const toks = sharedTokens(anchor.event, tokenize)
      .filter((t) => eligibleToken(t, idTokens))
      .filter((t) => { const df = index.df.get(t) || 0; return df >= minFull && df <= index.docs.size / 20; });
    if (toks.length < 2) continue;
    const a = toks[Math.floor(rand() * toks.length)];
    const b = toks[Math.floor(rand() * toks.length)];
    if (a === b) continue;
    const query = [a, b].sort().join(' ');
    if (seen.has(query)) continue;
    seen.add(query);
    const bSet = new Set(docsWith(b));
    const both = docsWith(a).filter((id) => bSet.has(id));
    if (both.length < minFull || both.length > maxFull) continue;
    let newest = null; let newestMs = -Infinity; let old = 0;
    for (const id of both) {
      const ms = Date.parse(index.docs.get(id).event.timestamp);
      if (!Number.isFinite(ms) || ms > nowMs) continue;
      if (nowMs - ms > 30 * DAY_MS) old++;
      if (ms > newestMs) { newestMs = ms; newest = id; }
    }
    if (!newest || old < both.length / 3) continue;
    cases.push({ kind: 'recency', bucket: bucketOf((nowMs - newestMs) / DAY_MS), id: newest, query, full: both.length });
  }
  return cases;
}

// ─── Engines ───

/**
 * Rank every case through an in-process hybridSearch. `done` (index → result)
 * and `onResult(index, result)` are the checkpoint: cases already in `done`
 * are not re-run, and each new result is handed out as soon as it exists.
 */
export async function rankApi(hybridSearch, index, cases, { ranking, done = null, onResult = null } = {}) {
  const out = new Array(cases.length);
  for (let i = 0; i < cases.length; i++) {
    if (done?.has(i)) { out[i] = done.get(i); continue; }
    const c = cases[i];
    const res = await hybridSearch(index, c.query, ranking ? { ranking } : {});
    const pos = res.items.findIndex((it) => it.event_id === c.id);
    out[i] = { ...c, rank: pos >= 0 && pos < DEPTH ? pos + 1 : null, pool: res.items.length };
    onResult?.(i, out[i]);
  }
  return out;
}

/**
 * The environment a measurement child gets. Telemetry goes to /dev/null, the
 * session chain is unset (no delta serving), Turbo and the semantic leg are
 * off, and both service URLs point at a refusing port so no path can reach the
 * live index.
 */
export function measurementEnv(devDir, overrides = {}) {
  const env = { ...process.env };
  for (const key of [...SESSION_VARS, ...RANKING_VARS]) delete env[key];
  const none = path.join(devDir, '.age-curve-none');
  return {
    ...env,
    CARTOGRAPHER_DEV_DIR: devDir,
    CARTOGRAPHER_SERVED_LOG: '/dev/null',
    CARTOGRAPHER_ACCESS_LEDGER: '/dev/null',
    CARTOGRAPHER_SEARCH_CALL_LOG: '/dev/null',
    CARTOGRAPHER_TURBO: '0',
    CARTOGRAPHER_SEMANTIC: '0',
    CARTOGRAPHER_QDRANT_URL: 'http://127.0.0.1:1',
    CARTOGRAPHER_EMBED_URL: 'http://127.0.0.1:1/v1/embeddings',
    CARTOGRAPHER_CONFIG: path.join(none, 'config.json'),
    CARTOGRAPHER_TRANSCRIPTS_DIR: none,
    CARTOGRAPHER_CODEX_TRANSCRIPTS_DIR: none,
    CARTOGRAPHER_CODEX_ARCHIVED_DIR: none,
    TMPDIR_BASE: devDir,
    ...overrides,
  };
}

/**
 * Rank every case through the portable CLI, `concurrency` children at a time.
 * `done` and `onResult` checkpoint it as in rankApi; on a 200k-event corpus a
 * query costs ~17 s, so an interrupted run should lose only what was in flight.
 */
export async function rankCli(cliPath, cases, env, { concurrency = 6, done = null, onResult = null } = {}) {
  const out = new Array(cases.length);
  const todo = [];
  for (let i = 0; i < cases.length; i++) {
    if (done?.has(i)) out[i] = done.get(i); else todo.push(i);
  }
  let next = 0;
  const one = (c) => new Promise((resolve) => {
    execFile('bash', [cliPath, c.query, '--limit', String(DEPTH), '--format', 'jsonl', '--all', '--no-turbo'],
      { env, maxBuffer: 64 * 1024 * 1024, timeout: 600e3 }, (error, stdout) => {
        // Exit 1 is "no results", which is a measurement, not a failure.
        const rows = String(stdout || '').split('\n').filter((l) => l.startsWith('{')).map((l) => {
          try { return JSON.parse(l); } catch { return null; }
        }).filter(Boolean);
        const pos = rows.findIndex((r) => r.event_id === c.id);
        resolve({ ...c, rank: pos >= 0 ? pos + 1 : null, pool: rows.length,
          ...(error && error.code !== 1 ? { error: String(error.message || error).slice(0, 200) } : {}) });
      });
  });
  await Promise.all(Array.from({ length: Math.min(concurrency, todo.length) }, async () => {
    while (next < todo.length) {
      const i = todo[next++];
      out[i] = await one(cases[i]);
      onResult?.(i, out[i]);
    }
  }));
  return out;
}

// ─── Summary ───

export function summarize(results) {
  const table = {};
  for (const r of results) {
    const key = `${r.kind}:${r.bucket}`;
    const b = (table[key] ||= { kind: r.kind, bucket: r.bucket, n: 0, s1: 0, s10: 0, rr: 0, absent: 0 });
    b.n++;
    if (r.rank === 1) b.s1++;
    if (r.rank && r.rank <= 10) b.s10++;
    if (r.rank) b.rr += 1 / r.rank; else b.absent++;
  }
  const rows = Object.values(table).map((b) => ({
    kind: b.kind, bucket: b.bucket, n: b.n,
    s1: b.s1 / b.n, s10: b.s10 / b.n, mrr: b.rr / b.n, absent: b.absent,
  }));
  const order = (r) => (r.kind === 'known' ? 0 : 1) * 10 + BUCKETS.indexOf(r.bucket);
  return rows.sort((a, b) => order(a) - order(b));
}

/** S@10 by bucket for one kind: { '<7d': 0.97, ... }. */
export function s10By(results, kind = 'known') {
  return Object.fromEntries(summarize(results).filter((r) => r.kind === kind).map((r) => [r.bucket, r.s10]));
}

export function formatSummary(label, results) {
  const lines = [`${label}`];
  for (const r of summarize(results)) {
    lines.push(`  ${r.kind.padEnd(7)} ${r.bucket.padEnd(6)} n=${String(r.n).padStart(3)}  S@1=${r.s1.toFixed(2)}  `
      + `S@10=${r.s10.toFixed(2)}  MRR=${r.mrr.toFixed(3)}  absent=${r.absent}`);
  }
  const errors = results.filter((r) => r.error).length;
  if (errors) lines.push(`  (${errors} engine errors)`);
  return lines.join('\n');
}

// ─── Command line: the live corpus ───

function parseArgs(argv) {
  const opts = { arms: [], roots: [], engines: ['api', 'cli'], perBucket: 60, recency: 40,
    cliPerBucket: null, json: false, out: null, corpus: path.join(os.homedir(), 'Documents', 'dev'),
    concurrency: 6, worker: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => { if (i + 1 >= argv.length) throw new Error(`${a} needs a value`); return argv[++i]; };
    if (a === '--arm') {
      const [name, engines] = val().split(':');
      opts.arms.push({ name, engines: engines ? engines.split(',').filter(Boolean) : null });
    }
    else if (a === '--root') opts.roots.push(path.resolve(val()));
    else if (a === '--engines') opts.engines = val().split(',').filter(Boolean);
    else if (a === '--per-bucket') opts.perBucket = Number(val());
    else if (a === '--recency') opts.recency = Number(val());
    else if (a === '--cli-per-bucket') opts.cliPerBucket = Number(val());
    else if (a === '--corpus') opts.corpus = path.resolve(val());
    else if (a === '--concurrency') opts.concurrency = Number(val());
    else if (a === '--json') opts.json = true;
    else if (a === '--out') opts.out = path.resolve(val());
    else if (a === '--worker') opts.worker = true;
    else if (a === '--state') opts.state = path.resolve(val());
    else if (a === '-h' || a === '--help') opts.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  if (opts.arms.length === 0) opts.arms = [{ name: 'shipped', engines: null }];
  if (opts.roots.length === 0) opts.roots = [REPO_ROOT];
  for (const arm of opts.arms) {
    if (!resolveArm(arm.name)) throw new Error(`unknown arm '${arm.name}' (${Object.keys(ARMS).join(', ')}, actr-d<d>, cmem-d<d>, +exempt)`);
    arm.engines ||= opts.engines;
  }
  return opts;
}

function insideRepo(p) {
  const rel = path.relative(REPO_ROOT, p);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Copy the five logs and the ledger into `dir`; a clone on APFS, a copy elsewhere. */
function snapshotCorpus(corpus, dir) {
  mkdirSync(dir, { recursive: true });
  for (const name of [...Object.values(LOG_NAMES), LEDGER_NAME]) {
    const src = path.join(corpus, name);
    const dst = path.join(dir, name);
    if (!existsSync(src)) { writeFileSync(dst, ''); continue; }
    copyFileSync(src, dst, fsConstants.COPYFILE_FICLONE);
  }
}

async function loadEngine(root) {
  const mod = (rel) => import(pathToFileURL(path.join(root, rel)).href);
  const [{ readAllEvents }, { buildIndex, tokenize }, search] = await Promise.all([
    mod('explorer/server/jsonl.js'), mod('explorer/server/bm25.js'), mod('explorer/server/search.js'),
  ]);
  return { readAllEvents, buildIndex, tokenize, hybridSearch: search.hybridSearch,
    // A checkout from before 2026-10-16 has no `ranking` option and would
    // quietly run its defaults under another arm's name.
    takesRanking: typeof search.rankingFromEnv === 'function',
    cli: path.join(root, 'scripts', 'cartographer-search.sh') };
}

function logFilesIn(dir) {
  return Object.fromEntries(Object.entries(LOG_NAMES).map(([source, name]) => [source, path.join(dir, name)]));
}

// Results are checkpointed one case per line, per (root, arm, engine), so a
// killed run resumes where it stopped: the first full live run lost 23 minutes
// of CLI work to an external kill because its results lived only in memory.
function checkpointPath(state, root, armName, engine) {
  const tag = `${path.basename(root)}-${createHash('sha1').update(root).digest('hex').slice(0, 6)}`;
  return path.join(state, 'results', `${tag}--${armName}--${engine}.jsonl`);
}

function readCheckpoint(file) {
  const done = new Map();
  if (!existsSync(file)) return done;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { const { i, r } = JSON.parse(line); done.set(i, r); } catch { /* torn last line from a kill */ }
  }
  return done;
}

function checkpointer(file) {
  mkdirSync(path.dirname(file), { recursive: true });
  return (i, r) => appendFileSync(file, `${JSON.stringify({ i, r })}\n`);
}

// One (root, arm) per worker process. An older checkout reads its decay rate
// once, at module load, so the arm's environment has to be in place before the
// engine is imported — which means a process of its own. The worker reports
// through its checkpoint files, not stdout, so a parent that dies takes
// nothing with it.
async function worker(opts) {
  const armName = opts.arms[0].name;
  const arm = resolveArm(armName);
  const root = opts.roots[0];
  const engine = await loadEngine(root);
  const cases = JSON.parse(readFileSync(path.join(opts.state, 'cases.json'), 'utf8'));
  if (arm.ranking && !engine.takesRanking) {
    process.stderr.write(`  ${armName}: ${root} has no ranking option; skipped\n`);
    return;
  }
  if (opts.engines.includes('api')) {
    const file = checkpointPath(opts.state, root, armName, 'api');
    const done = readCheckpoint(file);
    if (done.size < cases.length) {
      const index = engine.buildIndex(engine.readAllEvents(logFilesIn(opts.state)));
      await rankApi(engine.hybridSearch, index, cases, { ranking: arm.ranking, done, onResult: checkpointer(file) });
    }
  }
  if (opts.engines.includes('cli') && !arm.apiOnly) {
    const cliCases = opts.cliPerBucket ? cliSubsample(cases, opts.cliPerBucket) : cases;
    const file = checkpointPath(opts.state, root, armName, 'cli');
    await rankCli(engine.cli, cliCases, measurementEnv(opts.state, armEnv(arm, opts.state)),
      { concurrency: opts.concurrency, done: readCheckpoint(file), onResult: checkpointer(file) });
  }
}

function cliSubsample(cases, perBucket) {
  const counts = {};
  return cases.filter((c) => ((counts[`${c.kind}:${c.bucket}`] = (counts[`${c.kind}:${c.bucket}`] || 0) + 1) <= perBucket));
}

function armEnv(arm, state) {
  return { ...arm.env, ...(arm.ledger ? { CARTOGRAPHER_ACCESS_LEDGER: path.join(state, LEDGER_NAME) } : {}) };
}

function runWorker(root, { name: armName, engines }, opts, state) {
  const arm = resolveArm(armName);
  const args = [fileURLToPath(import.meta.url), '--worker', '--root', root, '--arm', armName,
    '--state', state, '--engines', engines.join(','), '--concurrency', String(opts.concurrency)];
  if (opts.cliPerBucket) args.push('--cli-per-bucket', String(opts.cliPerBucket));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { env: measurementEnv(state, armEnv(arm, state)), stdio: ['ignore', 'ignore', 'inherit'] });
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`worker ${armName} @ ${root} exited ${code}`))));
  });
}

function collectRun(state, root, { name: armName, engines }) {
  const arm = resolveArm(armName);
  const run = { root, arm: armName };
  for (const engine of engines) {
    if (engine === 'cli' && arm.apiOnly) continue;
    const done = readCheckpoint(checkpointPath(state, root, armName, engine));
    if (done.size) run[engine] = [...done.entries()].sort((a, b) => a[0] - b[0]).map(([, r]) => r);
  }
  return run;
}

/**
 * Snapshot the corpus and sample the cases into `state`, or, when `state`
 * already holds them, reuse both. The cases are drawn once per state dir: a
 * second invocation against the live logs would sample a corpus that has grown
 * in between, and its numbers would not be comparable.
 */
async function prepareState(opts, state) {
  const casesFile = path.join(state, 'cases.json');
  const metaFile = path.join(state, 'meta.json');
  if (existsSync(casesFile) && existsSync(metaFile)) {
    const meta = JSON.parse(readFileSync(metaFile, 'utf8'));
    process.stderr.write(`resuming ${state}: ${meta.docs} docs, ${meta.cases} cases sampled ${meta.sampled_at}\n`);
    return meta;
  }
  const t0 = Date.now();
  snapshotCorpus(opts.corpus, state);
  const sampler = await loadEngine(REPO_ROOT);
  const nowMs = Date.now();
  const index = sampler.buildIndex(sampler.readAllEvents(logFilesIn(state)));
  const cases = [
    ...sampleKnownItems(index, { tokenize: sampler.tokenize, nowMs, perBucket: opts.perBucket }),
    ...sampleRecencyCases(index, { tokenize: sampler.tokenize, nowMs, count: opts.recency }),
  ];
  // How many targets the ledger arms can rehearse at all. Read the way the
  // engines read it: a fetch is inspection, not use.
  const rehearsed = new Set();
  for (const line of readFileSync(path.join(state, LEDGER_NAME), 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row.event_id && row.source !== 'result_fetched') rehearsed.add(row.event_id);
    } catch { /* a torn line is skipped, as the engines skip it */ }
  }
  const meta = {
    docs: index.docs.size, cases: cases.length, sampled_at: new Date(nowMs).toISOString(),
    known: cases.filter((c) => c.kind === 'known').length, recency: cases.filter((c) => c.kind === 'recency').length,
    ledger_events: rehearsed.size, targets_with_reuse: cases.filter((c) => rehearsed.has(c.id)).length,
  };
  writeFileSync(casesFile, JSON.stringify(cases));
  writeFileSync(metaFile, JSON.stringify(meta));
  process.stderr.write(`snapshot ${meta.docs} docs; ${meta.cases} cases (${meta.known} known, ${meta.recency} recency) `
    + `in ${Date.now() - t0} ms; ledger: ${meta.ledger_events} used events, ${meta.targets_with_reuse} targets with any reuse\n`);
  return meta;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n')
      .filter((l) => l.startsWith('//')).slice(0, 48).map((l) => l.slice(3)).join('\n') + '\n');
    return;
  }
  if (opts.worker) return worker(opts);
  for (const [flag, p] of [['--out', opts.out], ['--state', opts.state]]) {
    if (p && insideRepo(p)) {
      throw new Error(`${flag} ${p} is inside the repository; the cases are corpus text and must not be committed`);
    }
  }

  const state = opts.state || mkdtempSync(path.join(os.tmpdir(), 'carto-age-curve-'));
  try {
    const meta = await prepareState(opts, state);
    const runs = [];
    for (const root of opts.roots) {
      for (const arm of opts.arms) {
        const started = Date.now();
        await runWorker(root, arm, opts, state);
        process.stderr.write(`  ${arm.name} @ ${path.basename(root)}: ${Date.now() - started} ms\n`);
        runs.push(collectRun(state, root, arm));
      }
    }

    const summary = runs.map((run) => ({
      root: run.root, arm: run.arm,
      api: run.api ? summarize(run.api) : null,
      cli: run.cli ? summarize(run.cli) : null,
    }));
    if (opts.out) writeFileSync(opts.out, JSON.stringify({ meta, runs }, null, 0));
    if (opts.json) {
      process.stdout.write(`${JSON.stringify({ meta, summary }, null, 2)}\n`);
    } else {
      for (const run of runs) {
        const tag = `${run.arm} @ ${path.basename(run.root)}`;
        if (run.api) process.stdout.write(`${formatSummary(`[api] ${tag}`, run.api)}\n`);
        if (run.cli) process.stdout.write(`${formatSummary(`[cli] ${tag}`, run.cli)}\n`);
      }
    }
  } finally {
    // A --state dir is kept so the run can resume; a private temp dir is not.
    if (!opts.state) rmSync(state, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`age-curve: ${error.message}\n`);
    process.exit(1);
  });
}
