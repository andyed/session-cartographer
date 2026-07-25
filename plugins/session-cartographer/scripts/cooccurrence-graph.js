#!/usr/bin/env node
// cooccurrence-graph.js — Significance-weighted entity co-occurrence graph (SKG) over carto event logs.
//
// Two graphs, one engine. Entities are STRUCTURED fields from the logs — never tokenized prose.
//
//   • projects  — document = calendar DAY, entity = project active that day.
//       Surfaces cross-project research threads. Measured: 97% of sessions touch a single project,
//       so the cross-thread signal lives in same-DAY co-activity (3-5 concurrent sessions/day),
//       not same-session. N = number of active days.   →  /focus "related threads"
//
//   • maneuvers — technical maneuvers detected from command / commit / config-file text via a
//       signature catalog (entities = markers like ff-merge, gh-release, cloudflare-pages…).
//       Two derived views:
//         composition: signal × signal, document = SESSION — which markers fire together (= a maneuver).
//         transfer:    project × project, document = SIGNAL — which projects share a procedure profile.
//
// Edge weight: Dunning's log-likelihood ratio (G²), the canonical "surprise and coincidence" statistic
// (Dunning 1993). We follow lume / the Grainger-Hatcher Semantic Knowledge Graph in scoring observed-vs-
// expected co-occurrence, but rank by G² rather than lume's z-score+tanh: for a perfectly-correlated pair
// (a=b=k) the z-score collapses to √N regardless of count, so a 3-session fluke and a 30-session pattern
// score identically — it saturates. We rank by G²; the z/tanh variant is documented, not persisted.
//
// Offline indexing tool (sibling of embed-events.js), NOT the query-time scorer. Node is fine here; the
// "BM25 in awk" zero-dependency rule governs the search hot path, not the index build.
//
// Usage:
//   node scripts/cooccurrence-graph.js                     # build, write JSON, print top edges
//   node scripts/cooccurrence-graph.js --show maneuvers    # projects | maneuvers | both
//   node scripts/cooccurrence-graph.js --related <project>  # projects co-active with <project>
//   node scripts/cooccurrence-graph.js --maneuvers <proj>   # a project's maneuver profile + transfer peers
//   node scripts/cooccurrence-graph.js --signal <maneuver>  # which projects run a maneuver (release|deploy|merge…)
//   node scripts/cooccurrence-graph.js --top 40 --out <path>
//
// Default output: $CARTOGRAPHER_GRAPH or $CARTOGRAPHER_DEV_DIR/cooccurrence-graph.json

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

// ─── Config ───

const DEV = process.env.CARTOGRAPHER_DEV_DIR || join(homedir(), 'Documents', 'dev');
const PROJECT_LOGS = ['changelog.jsonl', 'research-log.jsonl', 'session-milestones.jsonl', 'tool-use-log.jsonl'];
const MANEUVER_LOG = 'changelog.jsonl'; // commands, commits and config edits all land here

function arg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}
const OUT = arg('--out', process.env.CARTOGRAPHER_GRAPH || join(DEV, 'cooccurrence-graph.json'));
const TOP = parseInt(arg('--top', '25'), 10);
const SHOW = arg('--show', 'both'); // projects | maneuvers | both
const RELATED = arg('--related', null);
const MANEUVERS_OF = arg('--maneuvers', null);
const SIGNAL_OF = arg('--signal', null);
const KQ = parseInt(arg('--k', '8'), 10);

// "Projects" that are really cwd-encoded filesystem path fragments, not real projects. Editable.
const PROJECT_BLOCKLIST = new Set([
  'andyed', 'Users-andyed', 'Users', 'Documents-dev', 'Documents', 'Downloads', 'Desktop', 'Library', 'home',
  'workspace', 'images', 'tmp', 'var', 'private', 'node_modules', 'dev',
]);

// Maneuver signature catalog — [signal, regex] tested against each event's (summary + files_changed).
// Entities for the maneuver graph. Coarse-to-specific by design; the composition graph shows the nesting.
const SIGNATURES = [
  // branch / history maneuvers
  ['ff-merge',         /merge\s+--ff-only|--ff-only/i],
  ['no-ff-merge',      /merge\s+--no-ff/i],
  ['merge',            /\bgit merge\b/i],
  ['merge-check',      /merge-base\s+--is-ancestor/i],
  ['rebase',           /\brebase\b/i],
  ['cherry-pick',      /cherry-pick/i],
  ['worktree',         /\bworktree\b/i],
  // release maneuvers
  ['version-tag',      /\bgit tag\b/i],
  ['gh-release',       /\bgh release\b/i],
  ['version-bump',     /npm version|version bump|bump\b[^.]*version|version[^.]*bump/i],
  ['lfs',              /\bgit lfs\b|lfs binaries/i],
  // deploy / CDN maneuvers
  ['cloudflare-pages', /wrangler\s+pages\s+deploy/i],
  ['cloudflare-api',   /api\.cloudflare\.com/i],
  ['wrangler-config',  /wrangler\.(toml|json)/i],
  ['wrangler',         /\bwrangler\b/i],
  ['netlify',          /\bnetlify\b/i],
  ['gh-actions',       /\.github\/workflows/i],
  ['deploy',           /\bdeploy\b/i],
  // paper sync
  ['overleaf-sync',    /\boverleaf\b/i],
];

// Thresholds
const PROJ_MIN_K = 2;        // a project pair must share >= 2 days
const COMP_MIN_K = 3;        // a signal pair must co-occur in >= 3 sessions
const COMP_LLR_GATE = 10.83; // χ²(1df) at p≈0.001
const XFER_MIN_K = 2;        // a project pair must share >= 2 maneuver-signals
const XFER_LLR_GATE = 6.63;  // χ²(1df) at p≈0.01 (N = #signals is small, so a looser gate)

// Related-threads LENS gate (display-only — the projEdges graph + JSON stay unfiltered). A pair
// surfaces only if significant (G² ≥ 6.63, p≈0.01) AND not a thin two-day fluke: a k<3 pair must
// clear the stricter p≈0.001 bar (10.83). Cheap stand-in for Tier-2 bootstrap stability — it cuts
// solo-project coincidence (session-cartographer 8→1 related edges) while keeping real low-k
// threads (allserp↔trail-telegraph: k=2, G²=14). See docs/COOCCURRENCE_EVAL.md Tier 2.
const REL_LLR_FLOOR = 6.63;
const REL_THIN_K = 3;
const REL_THIN_LLR = 10.83;

// ─── Scoring ───

// Dunning's log-likelihood ratio (G²) on the 2×2 co-occurrence table. Primary ranking statistic.
function dunningLLR(a, b, k, N) {
  const k11 = k, k12 = a - k, k21 = b - k, k22 = N - a - b + k;
  const e11 = (a * b) / N, e12 = (a * (N - b)) / N, e21 = ((N - a) * b) / N, e22 = ((N - a) * (N - b)) / N;
  const cell = (o, e) => (o > 0 && e > 0 ? o * Math.log(o / e) : 0); // 0·ln0 ≔ 0
  const g2 = 2 * (cell(k11, e11) + cell(k12, e12) + cell(k21, e21) + cell(k22, e22));
  return { llr: isFinite(g2) ? g2 : 0, direction: k11 - e11, expected: e11 };
}

// (lume's z-score+tanh — the saturating variant — removed; we persist G² only. Saturation finding in docs.)

function jaccard(a, b, k) {
  const union = a + b - k;
  return union > 0 ? k / union : 0;
}

// ─── Load & assemble documents ───

function field(rec, ...keys) {
  for (const k of keys) if (rec[k]) return rec[k];
  return null;
}

const dayProjects = new Map();    // day     -> Set(project)        — project graph
const sessionSignals = new Map(); // session -> Set(signal)         — maneuver composition
const signalProjects = new Map(); // signal  -> Set(project)        — maneuver transfer
let nEvents = 0, nFiles = 0, nSignalHits = 0;

for (const name of PROJECT_LOGS) {
  const path = join(DEV, name);
  if (!existsSync(path)) continue;
  nFiles++;
  const scanManeuvers = name === MANEUVER_LOG;
  const lines = readFileSync(path, 'utf-8').split('\n');
  for (const line of lines) {
    if (!line) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; } // skip malformed rows, never crash the build
    nEvents++;

    const project = field(rec, 'project', 'repo');
    const ts = field(rec, 'timestamp', 'time') || '';
    const day = ts.slice(0, 10);
    if (project && day && !PROJECT_BLOCKLIST.has(project)) {
      if (!dayProjects.has(day)) dayProjects.set(day, new Set());
      dayProjects.get(day).add(project);
    }

    if (!scanManeuvers || !project || PROJECT_BLOCKLIST.has(project)) continue;
    const session = field(rec, 'session_id', 'sessionId');
    const text = (field(rec, 'summary', 'description') || '') + ' ' + (rec.files_changed || '');
    for (const [signal, re] of SIGNATURES) {
      if (!re.test(text)) continue;
      nSignalHits++;
      if (session) {
        if (!sessionSignals.has(session)) sessionSignals.set(session, new Set());
        sessionSignals.get(session).add(signal);
      }
      if (!signalProjects.has(signal)) signalProjects.set(signal, new Set());
      signalProjects.get(signal).add(project);
    }
  }
}

// ─── Document frequencies ───

const projectDF = new Map();
for (const set of dayProjects.values()) for (const p of set) projectDF.set(p, (projectDF.get(p) || 0) + 1);

const signalSessionDF = new Map(); // signal -> #sessions
for (const set of sessionSignals.values()) for (const s of set) signalSessionDF.set(s, (signalSessionDF.get(s) || 0) + 1);

const projectSignalDF = new Map(); // project -> #distinct signals it uses
for (const set of signalProjects.values()) for (const p of set) projectSignalDF.set(p, (projectSignalDF.get(p) || 0) + 1);

const N_days = dayProjects.size;
const N_sigSessions = sessionSignals.size;
const N_signals = signalProjects.size;

// ─── Co-occurrence (only pairs that actually co-occur) ───

function countPairs(docs) {
  const pair = new Map(); // "a\tb" (a<b) -> k
  for (const set of docs.values()) {
    const items = [...set].sort();
    for (let i = 0; i < items.length; i++)
      for (let j = i + 1; j < items.length; j++)
        pair.set(items[i] + '\t' + items[j], (pair.get(items[i] + '\t' + items[j]) || 0) + 1);
  }
  return pair;
}

function buildEdges(pairK, df, N, minK, minLLR) {
  const edges = [];
  for (const [key, k] of pairK) {
    if (k < minK) continue;
    const [a, b] = key.split('\t');
    const da = df.get(a), dbf = df.get(b);
    const { llr, direction, expected } = dunningLLR(da, dbf, k, N);
    if (direction <= 0 || llr < minLLR) continue; // attraction only, above the confidence gate
    edges.push({
      a, b, k, a_df: da, b_df: dbf,
      expected: +expected.toFixed(3), llr: +llr.toFixed(2), jaccard: +jaccard(da, dbf, k).toFixed(4),
    });
  }
  edges.sort((x, y) => y.llr - x.llr || y.k - x.k);
  return edges;
}

const projEdges = buildEdges(countPairs(dayProjects), projectDF, N_days, PROJ_MIN_K, 0);
const compEdges = buildEdges(countPairs(sessionSignals), signalSessionDF, N_sigSessions, COMP_MIN_K, COMP_LLR_GATE);
const xferEdges = buildEdges(countPairs(signalProjects), projectSignalDF, N_signals, XFER_MIN_K, XFER_LLR_GATE);

// ─── Query modes (consumed by /focus) — print and exit, no file write ───

function neighbors(edges, node) {
  const out = [];
  for (const e of edges) {
    if (e.a === node) out.push({ n: e.b, k: e.k, llr: e.llr });
    else if (e.b === node) out.push({ n: e.a, k: e.k, llr: e.llr });
  }
  return out;
}

// Tolerate /focus aliases & partial names (e.g. "scrutinizer" → "scrutinizer2025"): exact, then
// case-insensitive, then substring either direction, choosing the highest-df match.
function resolveProject(name) {
  if (projectDF.has(name)) return name;
  const lower = name.toLowerCase();
  const exact = [...projectDF.keys()].find((p) => p.toLowerCase() === lower);
  if (exact) return exact;
  const subs = [...projectDF.keys()].filter((p) => p.toLowerCase().includes(lower) || lower.includes(p.toLowerCase()));
  return subs.length ? subs.sort((a, b) => projectDF.get(b) - projectDF.get(a))[0] : name;
}

if (RELATED !== null) {
  const P = resolveProject(RELATED);
  const nbrs = neighbors(projEdges, P).filter(
    (e) => e.llr >= REL_LLR_FLOOR && (e.k >= REL_THIN_K || e.llr >= REL_THIN_LLR),
  );
  if (!nbrs.length) console.log(`(no co-active projects for "${P}")`);
  else {
    console.log(`Related threads — projects co-active with ${P} (shared days · G²):`);
    for (const n of nbrs.slice(0, KQ)) console.log(`  ${n.n.padEnd(30)} ${String(n.k).padStart(3)}d  G²=${n.llr}`);
  }
  process.exit(0);
}

if (MANEUVERS_OF !== null) {
  const P = resolveProject(MANEUVERS_OF);
  const sigs = [...(signalProjects.entries())].filter(([, ps]) => ps.has(P)).map(([s]) => s);
  if (!sigs.length) { console.log(`(no maneuvers detected for "${P}")`); process.exit(0); }
  console.log(`Maneuvers in ${P}: ${sigs.sort().join(', ')}`);
  const peers = neighbors(xferEdges, P);
  if (peers.length) {
    console.log(`Shares a maneuver profile with (shared signals · G²):`);
    for (const p of peers.slice(0, KQ)) console.log(`  ${p.n.padEnd(30)} ${String(p.k).padStart(2)} shared  G²=${p.llr}`);
  }
  process.exit(0);
}

if (SIGNAL_OF !== null) {
  // Inverse of --maneuvers (for /remember "how do I X"): fuzzy-match a maneuver → which projects run it + what it composes with.
  const lower = SIGNAL_OF.toLowerCase();
  const matched = [...signalProjects.keys()].filter((s) => s.toLowerCase().includes(lower) || lower.includes(s.toLowerCase()));
  if (!matched.length) { console.log(`(no maneuver signal matching "${SIGNAL_OF}")`); process.exit(0); }
  for (const s of matched.sort()) {
    console.log(`${s} — run by: ${[...signalProjects.get(s)].sort().join(', ')}`);
    const comp = neighbors(compEdges, s);
    if (comp.length) console.log(`  composes with: ${comp.slice(0, KQ).map((c) => `${c.n} (G²=${c.llr})`).join(', ')}`);
  }
  process.exit(0);
}

// ─── Emit JSON ───

const graph = {
  meta: {
    generated: new Date().toISOString(),
    scoring: 'dunning_llr_g2 (rank) + z_tanh sig (reference)',
    generated_from: PROJECT_LOGS.filter((n) => existsSync(join(DEV, n))),
    n_events: nEvents, n_days: N_days, n_signal_hits: nSignalHits,
    n_signal_sessions: N_sigSessions, n_signals: N_signals,
    thresholds: { PROJ_MIN_K, COMP_MIN_K, COMP_LLR_GATE, XFER_MIN_K, XFER_LLR_GATE },
    version: 3,
  },
  projects: {
    nodes: [...projectDF.entries()].sort((a, b) => b[1] - a[1]).map(([id, df_days]) => ({ id, df_days })),
    edges: projEdges,
  },
  maneuvers: {
    signals: [...signalSessionDF.entries()].sort((a, b) => b[1] - a[1]).map(([id, df_sessions]) => ({
      id, df_sessions, projects: [...(signalProjects.get(id) || [])].sort(),
    })),
    composition: compEdges, // signal × signal (document = session)
    transfer: xferEdges,    // project × project (document = signal)
  },
};
writeFileSync(OUT, JSON.stringify(graph, null, 0) + '\n');

// ─── Human-readable summary ───

const dim = (s) => `\x1b[2m${s}\x1b[0m`;
function table(title, edges, kLabel, n) {
  console.log(`\n${title}`);
  console.log(dim(`  ${'A'.padEnd(24)} ${'B'.padEnd(24)} ${kLabel.padStart(5)} ${'exp'.padStart(7)} ${'G²'.padStart(7)} ${'jac'.padStart(5)}`));
  for (const e of edges.slice(0, n))
    console.log(`  ${e.a.padEnd(24)} ${e.b.padEnd(24)} ${String(e.k).padStart(5)} ${String(e.expected).padStart(7)} ${String(e.llr).padStart(7)} ${String(e.jaccard).padStart(5)}`);
  if (edges.length > n) console.log(dim(`  … +${edges.length - n} more edges`));
}

console.log(`\nco-occurrence graph built from ${nEvents} events in ${nFiles} logs`);
console.log(`  projects: ${projectDF.size} over ${N_days} days · ${projEdges.length} edges`);
console.log(`  maneuvers: ${N_signals} signals, ${nSignalHits} hits over ${N_sigSessions} sessions · ${compEdges.length} composition · ${xferEdges.length} transfer edges`);
console.log(`  written: ${OUT}`);
if (SHOW === 'projects' || SHOW === 'both')
  table('▸ Cross-project threads  (project × project, document = day)', projEdges, 'days', TOP);
if (SHOW === 'maneuvers' || SHOW === 'both') {
  table('▸ Maneuver composition  (signal × signal, document = session)', compEdges, 'sess', TOP);
  table('▸ Maneuver transfer  (project × project sharing maneuvers, document = signal)', xferEdges, 'sig', TOP);
}
console.log('');
