# Scoring Guide

How to read the scores in `/remember` output.

## Keyword search (RRF)

Reciprocal Rank Fusion scores are computed as `1/(60 + rank)` per source, summed across sources where the same event appears.

| Score | Meaning | Example |
|-------|---------|---------|
| 0.033 | Top result in two sources | Event matched as #1 in both changelog and research log: `1/61 + 1/61 = 0.033` |
| 0.016 | Top result in one source | Event matched as #1 in one source only: `1/61 = 0.016` |
| 0.014 | Second result, one source | `1/62 = 0.014` |
| 0.008 | Result #60+ in one source | Tail of a long match list |

**Rules of thumb:**
- Scores above 0.020 appeared in multiple sources — high confidence, worth reading.
- Scores 0.014-0.020 are strong single-source hits (top 5 in that source).
- Scores below 0.010 are deep in one list — scan the summary, don't chase the transcript unless the excerpt looks relevant.
- RRF scores don't measure relevance to your query. They measure rank position. A score of 0.016 means "first match in one file" — the match quality depends on whether grep found it because of a core keyword or a tangential mention.

## Score modifiers (applied after fusion)

Both engines apply the same four steps, in this order, to the fused RRF score:

1. **Salience** multiplies in.
2. **Noise trim** drops what scores under 10% of the best result. This is the only step that removes anything.
3. **Promote-on-reuse** and **time decay** multiply in. They reorder; they remove nothing.
4. **Lookup exemption**: when the query names a handful of records, those records skip the decay.

**Salience** (write-time prior). Hooks stamp each event with a strategic-weight score in [0..1]: `/wrapup` milestones 0.9, feature/fix commits 0.7, research-paper fetches 0.7, neutral default 0.5, chore commits 0.4, routine bash 0.2. Multiplies directly into the RRF score.

**Noise trim** (relevance). Items whose RRF × salience is under a tenth of the top item's are dropped. It is taken before any age weighting. Until 2026-10-16 the API path trimmed *after* decay, which cut old records for being old: a near-exact match on a 120-day-old record decays to ~6% of its score and fell under a tenth of a recent partial match. In the live measurement below, 50 of the 60 known items older than 90 days were not ranked low but absent from the pool. The CLI had no trim at all, so the two engines also disagreed about the pool.

**Time decay** (Ebbinghaus). `score *= exp(-lambda * hours_since_last_use)` with `CARTOGRAPHER_DECAY_LAMBDA` defaulting to 0.001 (~29-day half-life). "Last use" is the event timestamp — unless the event has recorded reuse accesses, in which case the most recent access counts instead (reuse refreshes recency).

**Lookup exemption** (query-aware decay). A query *names* a record when only a few candidates contain every one of its tokens: "blauch feedback", three odd words from a decision, a half-remembered commit subject. Age says nothing about whether a named record is the answer. So when between 1 and `CARTOGRAPHER_DECAY_LOOKUP_MAX` (default 10, one page) candidates contain every query token, those candidates are not decayed; everything else still is. A query whose tokens many records share ("deploy fix", "shader") is a browse, recency is the right tiebreak there, and it decays exactly as before. The count is by presence only, not idf, so both engines agree on it although their corpus statistics differ: `full` on `scoreBM25` results, column 10 of `bm25-search.awk`. It is taken after scope, window and stale filtering and before delta serving. Wildcard queries are never lookups. Set the variable to 0 to turn the exemption off.

Why a switch and not a gentler curve: fusion is rank-based, and RRF has almost no dynamic range. Rank 1 in a ladder scores 1/61 and rank 10 scores 1/70, and a rank-1 *partial* match in another ladder (one shared word in a routine recent event) also scores 1/61. A known item stays in the top 10 only if its age multiplier stays within a few percent of 1. Any decay strong enough to order a browse by recency therefore buries every old lookup, whatever its shape. The measurement below is how the switch was chosen over the curves.

### The age curve (the gate)

`scripts/age-curve.js` measures known-item recall by record age on both engines: the in-process `hybridSearch` (the Turbo path) and the portable CLI with `CARTOGRAPHER_TURBO=0`, under the same decay settings. It runs two kinds of case:

- **known**: a query built from a record's three highest-IDF tokens, kept when at most five documents contain all three. Success is that record in the top 10.
- **recency**: two tokens that 15–400 records share across months, at least a third of them older than 30 days. Success is the newest of those records in the top 10. An arm that never decays fails these, so it cannot win the gate by switching decay off.

`tests/unit/age-curve-gate.test.js` runs the same harness in CI over a synthetic corpus spanning 180 days. It first proves the fixture reproduces the loss: with the exemption off, both engines bury the archival items; with decay off, both lose the recency cases. Then it gates the shipped curve. Before the fix, the fixture gave S@10 of 1.00/1.00/0.50/0.00 by age on both engines.

Run it over the real corpus, read-only (the logs are cloned to a temp dir, telemetry goes to `/dev/null`, and `--out` refuses a path inside the repository because the cases are corpus text):

```bash
node scripts/age-curve.js --arm shipped --arm nodecay:api --arm noexempt:api
node scripts/age-curve.js --root /path/to/older/checkout --root . --arm shipped
```

Measured 2026-10-16 on the live corpus: 204,341 events, semantic leg off, an empty access ledger unless noted, 240 known items (60 per age bucket), and 40 recency cases (every target under a week old). Known-item S@10 and MRR are by age bucket <7d / 7-30d / 30-90d / 90d+. "Absent" counts known items missing from the top 100.

| Arm | Engine | Known S@10 | Known MRR | Absent | Recency S@10 | Recency MRR |
|---|---|---|---|---|---|---|
| **before** (041f3e1), exp λ=0.001 | API | 0.98 / 0.85 / 0.62 / 0.15 | 0.53 / 0.43 / 0.32 / 0.15 | 55 | 0.65 | 0.42 |
| **before** (041f3e1), exp λ=0.001 | CLI | 0.93 / 0.88 / 0.65 / 0.23 † | 0.70 / 0.58 / 0.35 / 0.20 † | 26 † | pending | pending |
| before, λ=0 | API | 0.98 / 0.98 / 1.00 / 1.00 ‡ | 0.87 / 0.91 / 0.88 / 0.99 ‡ | 0 | 0.40 | 0.26 |
| **after**, exp λ=0.001 + lookup exemption (shipped) | API | 0.98 / 1.00 / 0.98 / 1.00 | 0.54 / 0.71 / 0.79 / 0.89 | 0 | 0.65 | 0.42 |
| **after**, shipped | CLI | pending | pending | pending | pending | pending |
| after, trim reordered, exemption off | API | 0.98 / 0.85 / 0.62 / 0.23 | 0.53 / 0.43 / 0.32 / 0.18 | 27 | 0.65 | 0.42 |
| after, λ=0 | API | 0.35 / 0.43 / 0.63 / 0.85 | 0.21 / 0.30 / 0.38 / 0.52 | 0 | 0.03 | 0.03 |
| power-law t^-0.5 (days, 1-day floor) | API | 0.98 / 0.77 / 0.62 / 0.30 | 0.67 / 0.39 / 0.32 / 0.21 | 6 | 0.72 | 0.44 |
| power-law + exemption | API | 1.00 / 1.00 / 1.00 / 1.00 | 0.76 / 0.92 / 0.90 / 0.96 | 0 | 0.72 | 0.44 |
| ACT-R base-level, d=0.05 | API | 0.80 / 0.53 / 0.60 / 0.72 | 0.36 / 0.31 / 0.30 / 0.43 | 0 | 0.47 | 0.32 |
| ACT-R base-level, d=0.1 | API | 0.90 / 0.60 / 0.62 / 0.67 | 0.48 / 0.34 / 0.30 / 0.38 | 1 | 0.57 | 0.41 |
| ACT-R base-level, d=0.2 | API | 0.98 / 0.62 / 0.62 / 0.52 | 0.56 / 0.36 / 0.31 / 0.27 | 1 | 0.70 | 0.47 |
| ACT-R base-level, d=0.3 | API | 0.98 / 0.60 / 0.62 / 0.43 | 0.56 / 0.36 / 0.31 / 0.23 | 2 | 0.70 | 0.48 |
| ACT-R base-level, d=0.5 | API | 0.97 / 0.70 / 0.60 / 0.30 | 0.57 / 0.38 / 0.30 / 0.21 | 6 | 0.70 | 0.46 |
| ACT-R d=0.1 + exemption | API | 0.98 / 1.00 / 0.97 / 1.00 | 0.67 / 0.76 / 0.71 / 0.79 | 0 | 0.57 | 0.41 |
| ACT-R d=0.3 + exemption | API | 1.00 / 1.00 / 1.00 / 1.00 | 0.86 / 0.97 / 0.93 / 0.99 | 0 | 0.70 | 0.48 |
| ACT-R d=0.5 + exemption | API | 1.00 / 1.00 / 1.00 / 1.00 | 0.86 / 0.97 / 0.93 / 0.99 | 0 | 0.70 | 0.46 |
| claude-mem form, d=0.5 | API | 0.98 / 0.67 / 0.62 / 0.33 | 0.59 / 0.38 / 0.31 / 0.21 | 6 | 0.72 | 0.48 |
| claude-mem form + exemption | API | 1.00 / 1.00 / 1.00 / 1.00 | 0.86 / 0.97 / 0.94 / 0.98 | 0 | 0.72 | 0.48 |

† 236 of the 280 cases (the run was stopped to free the machine): all known items except the last four in the 90d+ bucket, and no recency cases. The checkpointed run resumes them.
‡ An artifact. Before the fix, the API path skipped the re-sort after salience whenever decay was off, so its λ=0 ranking was plain RRF. The CLI applies salience at ingestion and never had this. With salience applied, λ=0 is the row "after, λ=0".

The ACT-R rows use base-level activation B = ln Σ_j t_j^-d over the event and each recorded reuse (Anderson & Schooler 1991). It enters as a factor e^B = Σ t_j^-d, because ACT-R activation adds to the log odds of retrieval. t is in days, floored and scaled to 1 at 30 minutes, and the separate reuse boost is off. The claude-mem rows use `ln(1 + t^-d + α Σ t_k^-d)` with α = 1 as the factor. Both read a frozen copy of the real access ledger as rehearsals. Only 3 of the 280 targets have any reuse in it, so these rows measure the event-age term, not the rehearsal term.

What the table says:

- **The trim order was half the API loss.** Moving the trim before decay brings the 55 absent known items down to 27 and moves the oldest bucket's S@10 from 0.15 to 0.23. The items are back in the pool, but still ranked past the page.
- **No single curve keeps both kinds of case.** Across the ACT-R sweep, d trades the archive for the week. At d=0.05 the oldest bucket reaches 0.72, but the 7-30d bucket falls to 0.53 and recency to 0.47. At d=0.5, recency is 0.70 and the oldest bucket 0.30. Power-law and claude-mem's form land in the same place.
- **The exemption is what fixes the archive.** With it, every curve tested scores 0.97–1.00 in every bucket, and the shipped exp arm keeps recency exactly where it was (0.65).

### Choosing the browse curve

With the exemption on, the power-law family (power, ACT-R d=0.3–0.5, claude-mem) scored higher than exp on known-item MRR (0.86–0.99 against 0.54–0.89) and on recency (0.70–0.72 against 0.65). Exp stays the default anyway, for a measured reason. Both metrics here reward a steeper curve on non-exempt items: a steeper curve pushes recent partial matches down, under the undecayed named record, and orders a browse more strictly by date. At the limit, infinite decay would score perfectly on both. Neither metric can show what steepness costs a *topical* browse, a query like "shader palette" that wants relevant material rather than the latest. The steep candidates are also steep early: normalised at 30 minutes, ACT-R at d=0.5 weights an hour-old item 0.69 and a day-old one 0.14, where exp gives 0.999 and 0.976. Choosing between them needs a third case kind that rewards relevance among browse results: the graded `demo/truth` set through `scripts/eval-search.js`, which now measures the configuration it is given (`--lambda`, `--lookup-max`, one pinned engine per arm). Until that runs, the browse curve is the one that measurably lost nothing.

On d itself: with the exemption the curve is flat from d=0.3 to 0.5, and ACT-R's canonical 0.5 sits on that plateau. Anderson & Schooler fit d to need probability, so the closest environmental estimate here is the access ledger. Its log-log slope of P(use | age), across 14 bins from 30 minutes to 330 days, is −0.79 (d ≈ 0.8). That is an upper bound: every use in the ledger is of a result the exp-decayed ranker chose to show.

**Promote-on-reuse** (read-time posterior). When `/remember` actually reads the transcript behind a result, it records the access via `--touch` into `access-ledger.jsonl`. At query time each accessed event gets `boost = 1 + w * Σ 1/sqrt(days_since_access)` capped at 2.0, with `w = CARTOGRAPHER_REUSE_WEIGHT` (default 0.3, 0 disables). The shape is ACT-R base-level activation: recent rehearsals count more, repeats compound with diminishing returns. Reused results show a `(used xN)` tag in CLI output and a `_reuseCount` field in the API. Events never touched score exactly as if the layer did not exist.

The intended division of labor: BM25/semantic measure *relevance to this query*, salience encodes *how deliberate the moment was when written*, reuse encodes *how useful the memory has proven since*. A capped 2× reuse boost breaks ties and lifts proven events but cannot overcome a relevance gap.

## Measuring whether recall helps

Searches made by `/remember` carry a stable call ID, session/provider context,
and `purpose=remember`. When the skill actually uses a result, `--touch` records
that same call ID. This makes hit rate and mean reciprocal rank (MRR) attributable
to the exact result set instead of guessing from a later access to the same event.

```bash
node scripts/hit-rate-report.js
node scripts/hit-rate-report.js --json
node scripts/hit-rate-report.js --purpose all
```

The default excludes old unattributed rows. Use `--include-legacy` only for a
historical comparison; each legacy touch is conservatively assigned to the
single latest eligible serve within the configured time window. Primary MRR is
computed per search call from the rank of the first explicitly accessed result;
last-access MRR is reported separately as an exploration-depth diagnostic. A
no-use call contributes zero.

Internals describes first-access MRR as a **precision proxy** because it is
top-heavy: it rewards putting the first result actually used near rank 1.
Last-access MRR is a **recall-depth proxy** because it shows how deep the caller
had to explore before its final use. These are directional product labels, not
literal precision or recall; Cartographer does not yet have relevance judgments
for every result needed to calculate those information-retrieval metrics.

Multi-result fetches and touches record `access_batch_id` plus a 1-based
`access_ordinal`, preserving the caller's result order even when every row has
the same timestamp. Historical same-time batches without ordinals remain
order-unknown rather than being ordered lexically or by file position. If
either boundary is ambiguous, the call is excluded from both MRR denominators
so first and last remain a matched comparison. No-use calls stay in that shared
cohort as zero. The report exposes measured and unknown instance counts beside
both values.

New standard recalls also append one call row to `.carto/search-calls.jsonl`.
Internals splits response p50/p95 and both access-order MRR values by requested
mode: Turbo on (`requested_backend=explorer`) versus Turbo off
(`requested_backend=cli`). A failed Turbo attempt that falls back to the CLI
remains in the Turbo-on cohort, so the comparison reflects the latency and
ranking experience produced by the setting the user enabled. The row retains
`selected_backend` and `fallback_reason` for diagnosis. Historical calls with
no backend or timing field remain visibly unclassified rather than being
backfilled by guesswork.

Internals also reports **hits consumed** and **consumption depth** for the same
overall and mode cohorts. Hits consumed counts distinct `call_id + event_id`
pairs that were explicitly fetched or touched, so repeated access-ledger rows do
not inflate it. Per-call averages include no-use calls as zero; the companion
successful-call average describes breadth after at least one hit was consumed.
Consumption depth is the deepest served rank reached within each call,
regardless of access order, and is summarized as p50/p95 across calls with a
known consumed rank. It complements last-access MRR: the final click and the
deepest-ranked click can be different results.

### Inspection, explicit use, and degraded search

The default `mrr` remains first-*access* MRR for comparability: a fetch or an
explicit use can supply its first rank. Both Internals and the command-line
report also expose `fetched` and `explicitUse` cohorts. A fetched record that was
subsequently discarded contributes to inspection metrics only, unless the caller
also marked it used. Explicit use is still a behavioral proxy, not verified
answer correctness. No-result and no-use calls remain in the denominator.

Normal search output includes a call ID. Carry that ID into `--get` and `--touch`
when several searches return the same event, using `--call-id`. The explicit pair
must belong to the same session and purpose. Without an explicit ID, previously
unambiguous access provenance is retained across re-serves; ambiguous cases are
reported without an attributed call rather than credited to the latest search.
This changes future attribution only and leaves append-only historical ledgers
intact. Mark only records that actually contributed, not the entire shortlist. Fetch-only
records no longer increase promote-on-reuse ranking boosts or reuse counts.
Explicit `result_used` records and historical transcript-read/source-less access
records retain their previous boost behavior; historical ledgers remain intact.

Mode cohorts are stratified by `semantic_status`. `unavailable` and `unknown`
remain distinct; low latency during a semantic outage must not masquerade as an
improvement in complete-search performance. The maximum response latency exposes
rare fallbacks that a p95 can miss.

## Semantic search (Qdrant cosine similarity)

When Qdrant is running, scores are cosine similarity between query and event embeddings.

| Score | Meaning |
|-------|---------|
| 0.80+ | Strong match — the event is about the same topic as your query |
| 0.65-0.80 | Related — shares concepts or vocabulary |
| 0.50-0.65 | Tangential — some overlap, likely a different topic that mentions similar terms |
| < 0.50 | Noise — shouldn't appear with reasonable limits |

Semantic scores ARE relevance measures, unlike RRF. A 0.85 hit for "foveated rendering" genuinely discusses foveated rendering. A 0.60 hit might discuss rendering in a different context.

## Source labels

Results show which source(s) contributed:

| Label | Source |
|-------|--------|
| `[changelog]` | Unified event index |
| `[research]` | WebFetch/WebSearch log |
| `[milestones]` | Session lifecycle events |
| `[transcript:user]` | User message from a past session |
| `[transcript:assistant]` | Agent response from a past session |
| `[changelog+research]` | Appeared in both — boosted score |
