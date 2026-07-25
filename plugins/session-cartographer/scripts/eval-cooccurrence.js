#!/usr/bin/env node
// eval-cooccurrence.js — Evaluate the project co-occurrence graph (sibling of eval-search.js).
//
// Tier 1 (predictive temporal holdout) — the centerpiece. Build day-grain project co-occurrence on
// the first SPLIT fraction of days; score each train pair by {activity, rawCount, jaccard, z-tanh
// (lume), Dunning G² (ours)}; measure how well each score predicts co-occurrence in the held-out
// tail (ROC-AUC, ties handled by average ranks). The headline is G² vs z-tanh: does ranking by G²
// actually beat lume's saturating statistic on held-out structure? See docs/COOCCURRENCE_EVAL.md.
//
//   node scripts/eval-cooccurrence.js            # predictive AUC table (default)
//   node scripts/eval-cooccurrence.js --split 0.7

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const DEV = process.env.CARTOGRAPHER_DEV_DIR || join(homedir(), 'Documents', 'dev');
const LOGS = ['changelog.jsonl', 'research-log.jsonl', 'session-milestones.jsonl', 'tool-use-log.jsonl'];
const BLOCK = new Set(['Users-andyed', 'Users', 'Documents-dev', 'Documents', 'Downloads', 'Desktop',
  'Library', 'workspace', 'images', 'tmp', 'var', 'private', 'node_modules', 'dev']);

function arg(f, d) { const i = process.argv.indexOf(f); return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : d; }
const SPLIT = parseFloat(arg('--split', '0.8'));

// ── load: day → Set(project) ──
const dayProjects = new Map();
for (const name of LOGS) {
  const p = join(DEV, name);
  if (!existsSync(p)) continue;
  for (const line of readFileSync(p, 'utf-8').split('\n')) {
    if (!line) continue;
    let r; try { r = JSON.parse(line); } catch { continue; }
    const proj = r.project || r.repo, ts = r.timestamp || r.time || '', day = ts.slice(0, 10);
    if (proj && day && !BLOCK.has(proj)) {
      if (!dayProjects.has(day)) dayProjects.set(day, new Set());
      dayProjects.get(day).add(proj);
    }
  }
}

// ── temporal split ──
const days = [...dayProjects.keys()].sort();
const cut = Math.floor(days.length * SPLIT);
const trainDays = days.slice(0, cut), testDays = days.slice(cut);

function cooc(daysList) {
  const pair = new Map(), df = new Map();
  for (const d of daysList) {
    const items = [...dayProjects.get(d)].sort();
    for (const p of items) df.set(p, (df.get(p) || 0) + 1);
    for (let i = 0; i < items.length; i++)
      for (let j = i + 1; j < items.length; j++) {
        const key = items[i] + '\t' + items[j];
        pair.set(key, (pair.get(key) || 0) + 1);
      }
  }
  return { pair, df };
}
const tr = cooc(trainDays), te = cooc(testDays);
const Ntr = trainDays.length;

// ── scorers ──
function g2(a, b, k, N) { // signed Dunning log-likelihood ratio (attraction positive)
  const k11 = k, k12 = a - k, k21 = b - k, k22 = N - a - b + k;
  const e11 = a * b / N, e12 = a * (N - b) / N, e21 = (N - a) * b / N, e22 = (N - a) * (N - b) / N;
  const c = (o, e) => (o > 0 && e > 0 ? o * Math.log(o / e) : 0);
  const g = 2 * (c(k11, e11) + c(k12, e12) + c(k21, e21) + c(k22, e22));
  const val = isFinite(g) ? g : 0;
  return (k11 - e11) >= 0 ? val : -val;
}
function zTanh(a, b, k, N) { // lume's statistic
  const E = a * b / N, v = E * (1 - a / N) * (1 - b / N);
  if (!(v > 0)) return 0;
  const z = (k - E) / Math.sqrt(v);
  return isFinite(z) ? Math.tanh(Math.sign(z) * Math.log1p(Math.abs(z)) / 3) : 0;
}
const jac = (a, b, k) => { const u = a + b - k; return u > 0 ? k / u : 0; };

// ── candidate rows: pairs that co-occurred in TRAIN; label = co-occur in TEST ──
const rows = [];
for (const [key, k] of tr.pair) {
  const [a, b] = key.split('\t'), da = tr.df.get(a), db = tr.df.get(b);
  rows.push({
    activity: da * db, rawCount: k, jaccard: jac(da, db, k), zTanh: zTanh(da, db, k, Ntr), g2: g2(da, db, k, Ntr),
    label: (te.pair.get(key) || 0) > 0 ? 1 : 0,
    bothActiveTest: te.df.has(a) && te.df.has(b),
  });
}

// ── ROC-AUC via Mann-Whitney U (average ranks for ties) ──
function auc(data, field) {
  const xs = data.map(r => ({ s: r[field], y: r.label })).sort((p, q) => p.s - q.s);
  const n = xs.length, rank = new Array(n);
  let i = 0;
  while (i < n) { let j = i; while (j + 1 < n && xs[j + 1].s === xs[i].s) j++; const avg = (i + 1 + j + 1) / 2; for (let t = i; t <= j; t++) rank[t] = avg; i = j + 1; }
  let sumPos = 0, nPos = 0, nNeg = 0;
  for (let t = 0; t < n; t++) { if (xs[t].y) { sumPos += rank[t]; nPos++; } else nNeg++; }
  return nPos && nNeg ? { auc: (sumPos - nPos * (nPos + 1) / 2) / (nPos * nNeg), nPos, nNeg } : { auc: NaN, nPos, nNeg };
}

// ── report ──
const SCORERS = [
  ['activity   (a·b baseline)', 'activity'],
  ['rawCount   (k)', 'rawCount'],
  ['jaccard', 'jaccard'],
  ['z-tanh     (lume)', 'zTanh'],
  ['G²         (ours)', 'g2'],
];
function tableFor(label, data) {
  const m0 = auc(data, 'g2');
  console.log(`\n${label}`);
  console.log(`  candidates: ${data.length}   positives (co-occur in test): ${m0.nPos}   negatives: ${m0.nNeg}`);
  if (!m0.nPos || !m0.nNeg) { console.log('  (degenerate — not enough of one class to compute AUC)'); return; }
  console.log(`  ${'scorer'.padEnd(28)} AUC`);
  for (const [name, field] of SCORERS) {
    const a = auc(data, field).auc;
    console.log(`  ${name.padEnd(28)} ${a.toFixed(4)}`);
  }
}

console.log(`Temporal holdout (split ${SPLIT}): ${trainDays.length} train days, ${testDays.length} test days`);
console.log(`Predicting: does a train pair's score predict its co-occurrence in the held-out tail?`);
tableFor('▸ Set A — all train-co-occurring pairs', rows);
tableFor('▸ Set B — restricted to pairs whose BOTH projects are still active in the test window', rows.filter(r => r.bothActiveTest));
console.log('\n(0.500 = random. Headline comparison: G² vs z-tanh, and both vs the activity baseline.)\n');
