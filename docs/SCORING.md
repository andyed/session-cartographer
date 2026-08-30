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

Three multipliers adjust the fused RRF score before display. They reorder results; they never remove them.

**Salience** (write-time prior). Hooks stamp each event with a strategic-weight score in [0..1]: `/wrapup` milestones 0.9, feature/fix commits 0.7, research-paper fetches 0.7, neutral default 0.5, chore commits 0.4, routine bash 0.2. Multiplies directly into the RRF score.

**Time decay** (Ebbinghaus). `score *= exp(-lambda * hours_since_last_use)` with `CARTOGRAPHER_DECAY_LAMBDA` defaulting to 0.001 (~30-day half-life). "Last use" is the event timestamp — unless the event has recorded reuse accesses, in which case the most recent access counts instead (reuse refreshes recency).

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
