/**
 * tests/unit/age-curve-gate.test.js
 *
 * Known-item recall must not depend on a record's age, and the fix for that
 * must not cost the recency that time decay exists for. Both engines are held
 * to it: hybridSearch in-process (the Turbo path) and the portable CLI as a
 * child with CARTOGRAPHER_TURBO=0, over one synthetic corpus whose timestamps
 * span 180 days (tests/unit/helpers/age-curve-fixture.js).
 *
 * The defect is an absence, so the first tests prove the fixture can fail:
 * with the lookup exemption switched off, the shipped decay must bury the
 * archival known items in both engines, and with decay switched off the
 * recency cases must fail. Only then does the gate mean anything. Measured
 * when this was written, on the code before the fix: S@10 by age
 * <7d/7-30d/30-90d/90d+ was 1.00/1.00/0.50/0.00 in both engines, and the API
 * had trimmed 7 of the 8 archival targets out of its pool entirely. The live
 * corpus showed the same shape (0.97/0.93/0.58/0.15); scripts/age-curve.js
 * measures that one.
 *
 * Run with: node --test tests/unit/age-curve-gate.test.js
 */
process.env.CARTOGRAPHER_SEMANTIC = '0';

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OFFLINE_INDEX_ENV } from './helpers/offline-index.js';
import { fixtureLogFiles, writeAgeCurveFixture } from './helpers/age-curve-fixture.js';
import { measurementEnv, rankApi, rankCli, s10By, snapshotCorpus, summarize, topicalCases } from '../../scripts/age-curve.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CLI = path.join(ROOT, 'scripts', 'cartographer-search.sh');
const AWK = path.join(ROOT, 'scripts', 'bm25-search.awk');

let dir;
let cases;
let index;
let hybridSearch;
let scoreBM25;

const known = () => cases.filter((c) => c.kind === 'known');
const recency = () => cases.filter((c) => c.kind === 'recency');
const cliEnv = (arm = {}) => measurementEnv(dir, { ...OFFLINE_INDEX_ENV, ...arm });

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-age-curve-'));
  cases = writeAgeCurveFixture(dir);
  // search.js reads the access ledger path at module load, and promote-on-reuse
  // from a developer's real ledger must not colour a fixture ranking.
  process.env.CARTOGRAPHER_ACCESS_LEDGER = path.join(dir, 'no-ledger.jsonl');
  for (const key of ['CARTOGRAPHER_DECAY_LAMBDA', 'CARTOGRAPHER_DECAY_LOOKUP_MAX']) delete process.env[key];
  const { readAllEvents } = await import('../../explorer/server/jsonl.js');
  const bm25 = await import('../../explorer/server/bm25.js');
  ({ hybridSearch } = await import('../../explorer/server/search.js'));
  scoreBM25 = bm25.scoreBM25;
  index = bm25.buildIndex(readAllEvents(fixtureLogFiles(dir)));
});

after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('the fixture is what it claims: four buckets, known items, recency families', () => {
  const buckets = new Set(known().map((c) => c.bucket));
  assert.deepEqual([...buckets], ['<7d', '7-30d', '30-90d', '90d+']);
  assert.equal(recency().length, 3);
  const ages = [...index.docs.values()].map((d) => (Date.now() - Date.parse(d.event.timestamp)) / 86400e3);
  assert.ok(Math.max(...ages) > 120, `timestamps must span more than 120 days (oldest ${Math.max(...ages).toFixed(0)}d)`);
  for (const c of known()) {
    const { items } = scoreBM25(index, c.query);
    assert.equal(items[0].id, c.id, `${c.query}: the target must be its query's best BM25 match`);
    assert.equal(items.filter((it) => it.full).length, 1, `${c.query}: exactly one record contains all three tokens`);
    assert.ok(items.length >= 15, `${c.query}: recent partial matches must compete (got ${items.length})`);
  }
  for (const c of recency()) {
    const { items } = scoreBM25(index, c.query);
    assert.equal(items.filter((it) => it.full).length, 14, `${c.query}: a family is a browse, not a lookup`);
    assert.ok(items.findIndex((it) => it.id === c.id) >= 10,
      `${c.query}: BM25 alone must rank the newest member past the page`);
  }
});

test('the fixture reproduces the archival loss when the exemption is off, in both engines', async () => {
  const api = await rankApi(hybridSearch, index, cases, { ranking: { lookupMax: 0 } });
  const cli = await rankCli(CLI, cases, cliEnv({ CARTOGRAPHER_DECAY_LOOKUP_MAX: '0' }));
  for (const [engine, results] of [['api', api], ['cli', cli]]) {
    const s10 = s10By(results);
    assert.equal(s10['<7d'], 1, `${engine}: recent known items are found under decay`);
    assert.ok(s10['30-90d'] <= 0.75, `${engine}: decay must bury 30-90d known items (S@10 ${s10['30-90d']})`);
    assert.ok(s10['90d+'] <= 0.25, `${engine}: decay must bury 90d+ known items (S@10 ${s10['90d+']})`);
  }
});

test('the recency cases fail with decay off, in both engines', async () => {
  const api = await rankApi(hybridSearch, index, recency(), { ranking: { lambda: 0 } });
  const cli = await rankCli(CLI, recency(), cliEnv({ CARTOGRAPHER_DECAY_LAMBDA: '0' }));
  assert.equal(s10By(api, 'recency')['<7d'], 0, 'api: an arm that never decays must lose the newest record');
  assert.equal(s10By(cli, 'recency')['<7d'], 0, 'cli: an arm that never decays must lose the newest record');
});

test('the noise trim runs on relevance: decay demotes archival items but does not remove them', async () => {
  const archival = known().filter((c) => c.bucket === '90d+');
  let wouldHaveBeenCut = 0;
  for (const c of archival) {
    const { items } = await hybridSearch(index, c.query, { ranking: { lookupMax: 0 } });
    const target = items.find((it) => it.event_id === c.id);
    assert.ok(target, `${c.query}: the target must stay in the pool`);
    // Trimming after decay, as the code did until 2026-10-16, cut whatever
    // scored under a tenth of the top *decayed* score.
    if (target._score < 0.1 * items[0]._score) wouldHaveBeenCut++;
  }
  assert.ok(wouldHaveBeenCut >= archival.length / 2,
    `the fixture must put archival targets under the old age-weighted cut (got ${wouldHaveBeenCut}/${archival.length})`);
});

test('gate: the shipped ranking keeps known items at every age and keeps recency, in both engines', async () => {
  const api = await rankApi(hybridSearch, index, cases);
  const cli = await rankCli(CLI, cases, cliEnv());
  for (const [engine, results] of [['api', api], ['cli', cli]]) {
    for (const row of summarize(results)) {
      assert.ok(row.s10 >= 0.875, `${engine} ${row.kind} ${row.bucket}: S@10 ${row.s10.toFixed(2)} (n=${row.n})`);
      assert.equal(row.absent, 0, `${engine} ${row.kind} ${row.bucket}: ${row.absent} absent`);
    }
    assert.equal(s10By(results, 'recency')['<7d'], 1, `${engine}: every recency case keeps its newest record`);
  }
});

test('the switch is the count: widen lookupMax past a family and its recency case is lost', async () => {
  // Families have 14 full matches, over the default of 10, so they decay. Raise
  // the bound and they become lookups — undecayed, BM25-ordered, newest last.
  // Proves the exemption is gated by the count and not by something incidental.
  const api = await rankApi(hybridSearch, index, recency(), { ranking: { lookupMax: 20 } });
  const cli = await rankCli(CLI, recency(), cliEnv({ CARTOGRAPHER_DECAY_LOOKUP_MAX: '20' }));
  assert.equal(s10By(api, 'recency')['<7d'], 0);
  assert.equal(s10By(cli, 'recency')['<7d'], 0);
});

test('a checkpointed subsample files each result under its own case index', async () => {
  // The live harness resumes from per-case checkpoints keyed by index. A
  // subsample run once ranked a filtered copy of the case list, so its indices
  // named other cases: it skipped work it had not done and filed 89 results
  // under the wrong case. Run one case out of the middle, with an unrelated
  // index already "done", and check what comes back under which number.
  const filed = new Map();
  const target = 5;
  const stale = { ...cases[0], rank: 1 };
  await rankCli(CLI, cases, cliEnv(), {
    only: new Set([0, target]),
    done: new Map([[0, stale]]),
    onResult: (i, r) => filed.set(i, r),
  });
  assert.deepEqual([...filed.keys()], [target], 'only the undone case in the subsample runs');
  assert.equal(filed.get(target).id, cases[target].id);
  assert.equal(filed.get(target).query, cases[target].query);
});

test('both engines mark the same records as containing every query token', () => {
  // The two scorers keep different corpus statistics (one global index here,
  // one per log in the awk), so the flag is defined by presence alone. If the
  // engines ever disagree on it, they disagree on which queries are lookups.
  for (const c of [...known().filter((_, i) => i % 4 === 0), ...recency()]) {
    const js = scoreBM25(index, c.query).items.filter((it) => it.full).map((it) => it.id).sort();
    const awk = [];
    for (const [source, file] of Object.entries(fixtureLogFiles(dir))) {
      const out = execFileSync('awk', ['-f', AWK, '-v', `query=${c.query}`, '-v', `src=${source}`,
        '-v', 'max_results=500', file, file], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } });
      for (const line of out.split('\n').filter(Boolean)) {
        const cols = line.split('\t');
        if (cols[9] === '1') awk.push(cols[2]);
      }
    }
    assert.deepEqual(awk.sort(), js, `${c.query}: full-coverage records differ between engines`);
  }
});

// ─── Harness mechanics for the topical kind (scripts/age-curve.js --truth) ───
//
// The topical cases score graded truth labels (scripts/truth-score.js has its
// own tests); these check how the harness buckets them, averages them, and
// rebuilds a corpus --as-of the date the labels were written.

const PRIMARY = 'aaaaaaaa-1111-2222-3333-444444444444';
const CONTEXT = 'bbbbbbbb-1111-2222-3333-444444444444';
const OTHER = 'cccccccc-1111-2222-3333-444444444444';
const truth = {
  query_id: 'widget-palette',
  query: 'widget palette',
  sessions: {
    [PRIMARY]: { relevant: true, role: 'primary' },
    [CONTEXT]: { relevant: true, role: 'context' },
    [OTHER]: { relevant: false },
  },
  events: [],
};

test('topical cases are bucketed by the age of their newest relevant session', () => {
  const now = Date.parse('2026-10-17T00:00:00Z');
  const doc = (session, ts) => ({ event: { session_id: session, timestamp: ts } });
  const index = { docs: new Map([
    ['e1', doc(PRIMARY, '2026-03-28T00:00:00Z')],
    ['e2', doc(CONTEXT, '2026-10-12T00:00:00Z')],
    ['e3', doc(OTHER, '2026-10-16T00:00:00Z')],
  ]) };
  const [withRecent] = topicalCases([truth], index, { nowMs: now });
  assert.equal(withRecent.bucket, '<7d', 'the context session is five days old; the irrelevant one does not count');
  const onlyPrimary = { ...truth, sessions: { [PRIMARY]: { relevant: true, role: 'primary' } } };
  assert.equal(topicalCases([onlyPrimary], index, { nowMs: now })[0].bucket, '90d+');
  assert.equal(topicalCases([{ ...truth, sessions: {} }], index, { nowMs: now })[0].bucket, 'n/a');
});

test('a topical engine error is counted, not averaged in as an empty list', () => {
  const ok = { kind: 'topical', bucket: '90d+', query: 'a', p5: 1, p10: 0.6, judgedP10: 1, gain10: 0.5, recall: 1,
    unjudged10: 4, under1d10: 0, age10: 30 };
  const [row] = summarize([ok, { kind: 'topical', bucket: '90d+', query: 'b', error: 'timeout' }]);
  assert.equal(row.n, 1);
  assert.equal(row.errors, 1);
  assert.equal(row.p10, 0.6);
});

test('--as-of keeps rows at or before the cut and shifts them, so "now" falls at the cut', () => {
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-asof-src-'));
  const dst = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-asof-dst-'));
  try {
    const rows = [
      { event_id: 'old', timestamp: '2026-04-01T12:00:00Z' },
      { event_id: 'offset', timestamp: '2026-04-03T20:00:00-07:00' }, // 04-04T03:00Z, kept
      { event_id: 'epoch', timestamp: String(Date.parse('2026-04-02T00:00:00Z') / 1000) },
      { event_id: 'late', timestamp: '2026-04-05T00:00:01Z' },
      { event_id: 'none' },
    ];
    fs.writeFileSync(path.join(src, 'changelog.jsonl'), `${rows.map((r) => JSON.stringify(r)).join('\n')}\nnot json\n`);
    const asOfMs = Date.parse('2026-04-05T00:00:00Z');
    const shiftMs = 194 * 86400e3;
    const kept = snapshotCorpus(src, dst, { asOfMs, shiftMs });
    const out = fs.readFileSync(path.join(dst, 'changelog.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(out.map((r) => r.event_id), ['old', 'offset', 'epoch']);
    assert.equal(kept['changelog.jsonl'], 3);
    assert.equal(out[0].timestamp, new Date(Date.parse('2026-04-01T12:00:00Z') + shiftMs).toISOString().replace('.000Z', 'Z'));
    assert.equal(Date.parse(out[1].timestamp), Date.parse('2026-04-04T03:00:00Z') + shiftMs);
    for (const r of out) assert.match(r.timestamp, /^20\d\d-\d\d-\d\dT\d\d:\d\d:\d\dZ$/, 'UTC, no offset, no milliseconds');
    assert.equal(fs.readFileSync(path.join(dst, 'research-log.jsonl'), 'utf8'), '', 'a missing log becomes an empty one');
  } finally {
    fs.rmSync(src, { recursive: true, force: true });
    fs.rmSync(dst, { recursive: true, force: true });
  }
});
