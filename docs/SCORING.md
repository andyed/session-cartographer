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
4. **Lookup exemption and lift**: when the query names a handful of records, those records skip the decay and their score is multiplied by 3.

**Salience** (write-time prior). Hooks stamp each event with a strategic-weight score in [0..1]: `/wrapup` milestones 0.9, feature/fix commits 0.7, research-paper fetches 0.7, neutral default 0.5, chore commits 0.4, routine bash 0.2. Multiplies directly into the RRF score.

**Noise trim** (relevance). Items whose RRF × salience is under a tenth of the top item's are dropped. It is taken before any age weighting. Until 2026-10-16 the API path trimmed *after* decay, which cut old records for being old: a near-exact match on a 120-day-old record decays to ~6% of its score and fell under a tenth of a recent partial match. In the live measurement below, 50 of the 60 known items older than 90 days were not ranked low but absent from the pool. The CLI had no trim at all, so the two engines also disagreed about the pool.

**Time decay** (Ebbinghaus). `score *= exp(-lambda * hours_since_last_use)` with `CARTOGRAPHER_DECAY_LAMBDA` defaulting to 0.001 (~29-day half-life). "Last use" is the event timestamp — unless the event has recorded reuse accesses, in which case the most recent access counts instead (reuse refreshes recency). Power-law and ACT-R base-level forms were measured against it on 2026-10-17 and lost topical precision ("Choosing the browse curve", below).

**Lookup exemption** (query-aware decay). A query *names* a record when only a few candidates contain every one of its tokens: a colleague's name plus "feedback", three odd words from a decision, a half-remembered commit subject. Age says nothing about whether a named record is the answer. So when between 1 and `CARTOGRAPHER_DECAY_LOOKUP_MAX` (default 10, one page) candidates contain every query token, those candidates are not decayed; everything else still is. A query whose tokens many records share ("deploy fix", "shader") is a browse, recency is the right tiebreak there, and it decays exactly as before. The count is by presence only, not idf, so both engines agree on it although their corpus statistics differ: `full` on `scoreBM25` results, column 10 of `bm25-search.awk`. It is taken after scope, window and stale filtering and before delta serving. Wildcard queries are never lookups. Set the variable to 0 to turn the exemption off.

**Lookup lift.** The named candidates' scores are then multiplied by `CARTOGRAPHER_DECAY_LOOKUP_LIFT` (default 3; 1 turns it off; a value under 1 or not a number reads as 3, in both engines). Skipping decay keeps a named record on the page. The lift puts it first: without it, a recent milestone at salience 0.8 that shares part of the query outranks a 0.4 web fetch that holds all of it. It is a score change, not a sort tier, so `--min-score` still cuts a sorted list. Measured in "Lifting named records", below.

Why a switch and not a gentler curve: fusion is rank-based, and RRF has almost no dynamic range. Rank 1 in a ladder scores 1/61 and rank 10 scores 1/70, and a rank-1 *partial* match in another ladder (one shared word in a routine recent event) also scores 1/61. A known item stays in the top 10 only if its age multiplier stays within a few percent of 1. Any decay strong enough to order a browse by recency therefore buries every old lookup, whatever its shape. The measurement below is how the switch was chosen over the curves.

### The age curve (the gate)

`scripts/age-curve.js` measures known-item recall by record age on both engines: the in-process `hybridSearch` (the Turbo path) and the portable CLI with `CARTOGRAPHER_TURBO=0`, under the same decay settings. It runs two kinds of case:

- **known**: a query built from a record's three highest-IDF tokens, kept when at most five documents contain all three. Success is that record in the top 10.
- **recency**: two tokens that 15–400 records share across months, at least a third of them older than 30 days. Success is the newest of those records in the top 10. An arm that never decays fails these, so it cannot win the gate by switching decay off.

`tests/unit/age-curve-gate.test.js` runs the same harness in CI over a synthetic corpus spanning 180 days. It first proves the fixture reproduces the loss: with the exemption off, both engines bury the archival items; with decay off, both lose the recency cases. Then it gates the shipped curve. Before the fix, the fixture gave S@10 of 1.00/1.00/0.50/0.00 by age on both engines. The same file holds the lift to rank 1, against rivals that win it when the lift is off.

Run it over the real corpus, read-only (the logs are cloned to a temp dir, telemetry goes to `/dev/null`, and `--out` refuses a path inside the repository because the cases are corpus text):

```bash
node scripts/age-curve.js --arm shipped --arm nodecay:api --arm noexempt:api
node scripts/age-curve.js --root /path/to/older/checkout --root . --arm shipped
```

Measured 2026-10-16 on the live corpus: 204,341 events, semantic leg off, an empty access ledger unless noted, 240 known items (60 per age bucket), and 40 recency cases (every target under a week old). Known-item S@10 and MRR are by age bucket <7d / 7-30d / 30-90d / 90d+. "Absent" counts known items missing from the top 100.

| Arm | Engine | Known S@10 | Known MRR | Absent | Recency S@10 | Recency MRR |
|---|---|---|---|---|---|---|
| **before** (041f3e1), exp λ=0.001 | API | 0.98 / 0.85 / 0.62 / 0.15 | 0.53 / 0.43 / 0.32 / 0.15 | 55 | 0.65 | 0.42 |
| **before** (041f3e1), exp λ=0.001 | CLI | 0.93 / 0.88 / 0.65 / 0.22 | 0.70 / 0.58 / 0.35 / 0.19 | 29 | 0.65 | 0.37 |
| before, λ=0 | API | 0.98 / 0.98 / 1.00 / 1.00 ‡ | 0.87 / 0.91 / 0.88 / 0.99 ‡ | 0 | 0.40 | 0.26 |
| **after**, exp λ=0.001 + lookup exemption (shipped) | API | 0.98 / 1.00 / 0.98 / 1.00 | 0.54 / 0.71 / 0.79 / 0.89 | 0 | 0.65 | 0.42 |
| **after**, shipped | CLI | paired subsample, below | | | | |
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

‡ An artifact. Before the fix, the API path skipped the re-sort after salience whenever decay was off, so its λ=0 ranking was plain RRF. The CLI applies salience at ingestion and never had this. With salience applied, λ=0 is the row "after, λ=0".

**Both engines, before and after, on the same cases.** The portable CLI costs about 17 s a query on this corpus, and five times that on a busy machine. So the post-fix CLI ran on a paired subsample: the first 30 cases of each bucket (all 60 under a week), and the first 30 recency cases. Each cell is that same set of cases, before → after.

| Cases (n) | CLI S@10 | CLI MRR | API S@10 | API MRR |
|---|---|---|---|---|
| known <7d (60) | 0.93 → 0.93 | 0.70 → 0.71 | 0.98 → 0.98 | 0.53 → 0.54 |
| known 7-30d (30) | 0.83 → 0.93 | 0.53 → 0.82 | 0.77 → 1.00 | 0.40 → 0.67 |
| known 30-90d (30) | 0.67 → 0.97 | 0.29 → 0.92 | 0.60 → 0.97 | 0.29 → 0.83 |
| known 90d+ (30) | 0.23 → 1.00 | 0.19 → 0.88 | 0.13 → 1.00 | 0.13 → 0.93 |
| recency (30) | 0.73 → 0.73 | 0.42 → 0.42 | 0.70 → 0.70 | 0.47 → 0.47 |

On the CLI, 12 of the 30 oldest targets were missing from the top 100 before the fix, and none after. The CLI misses the same 4 recent known items before and after; they do not depend on age.

The ACT-R rows use base-level activation B = ln Σ_j t_j^-d over the event and each recorded reuse (Anderson & Schooler 1991). It enters as a factor e^B = Σ t_j^-d, because ACT-R activation adds to the log odds of retrieval. t is in days, floored and scaled to 1 at 30 minutes, and the separate reuse boost is off. The claude-mem rows use `ln(1 + t^-d + α Σ t_k^-d)` with α = 1 as the factor. Both read a frozen copy of the real access ledger as rehearsals. Only 3 of the 280 targets have any reuse in it, so these rows measure the event-age term, not the rehearsal term.

What the table says:

- **The trim order was half the API loss.** Moving the trim before decay brings the 55 absent known items down to 27 and moves the oldest bucket's S@10 from 0.15 to 0.23. The items are back in the pool, but still ranked past the page.
- **No single curve keeps both kinds of case.** Across the ACT-R sweep, d trades the archive for the week. At d=0.05 the oldest bucket reaches 0.72, but the 7-30d bucket falls to 0.53 and recency to 0.47. At d=0.5, recency is 0.70 and the oldest bucket 0.30. Power-law and claude-mem's form land in the same place.
- **The exemption is what fixes the archive.** With it, every curve tested scores 0.97–1.00 in every bucket, and the shipped exp arm keeps recency exactly where it was (0.65).

### Choosing the browse curve

Decided 2026-10-17: **exp λ=0.001 stays the browse curve.** With the exemption on, the power-law family scored higher than exp on both gate metrics, but both reward a steeper curve on non-exempt items: it pushes recent partial matches under the undecayed named record, and orders a browse more strictly by date. At the limit, infinite decay would score perfectly on both. So the choice was made with a third case kind that rewards relevance among browse results.

**The topical kind.** `scripts/age-curve.js --truth <dir>` adds the nine graded `demo/truth` queries (gitignored; they exist only in the maintainer's checkout) and scores each arm's top 50 through `scripts/truth-score.js`, the scorer `scripts/eval-search.js` now shares. The metrics are P@10 (unjudged counts as not relevant), judged P@10 (a condensed list: the first ten *labeled* results), and gain@10 (mean grade over the top grade). On the live corpus eight of the nine are browses, and one has ≤ 10 full matches. On the as-of snapshot below, six of the nine are lookups, naming 2–9 records each, so there the exemption ranks their named records the same way in every arm and the curves differ only on the rest. (Corrected 2026-10-17. This page said all nine were browses on both snapshots.)

**Two snapshots, because the labels are dated.** They were written 2026-03-30 to 04-04 against sessions then a few days old. On today's corpus every labeled session is 199–205 days old, so the live snapshot only tests the long range, and newer work on each topic is unjudged by construction (about 9 of every top 10). `--as-of 2026-04-04T23:59:59Z` rebuilds the corpus as it stood when the labels were written: 17,851 events, timestamps shifted so that moment is "now", with the labeled sessions 4–10 days old and about half of each top 10 judged. The as-of snapshot is the one that tests a browse.

**The rule was fixed before the topical numbers came in.** A candidate replaces exp only if it loses no known-item S@10 bucket by more than one case, does not lower recency S@10, and does not lower topical P@10 or judged P@10 on either snapshot, with per-query wins at least equal to losses.

Topical, in-process API engine, semantic leg off. (+w/−l) counts the queries where the arm beat or trailed exp:

| Arm | As-of P@5 | As-of P@10 | As-of judged P@10 | As-of gain@10 | As-of rows <1 day old in the top 10 | Live P@10 | Live judged P@10 |
|---|---|---|---|---|---|---|---|
| exp λ=0.001 + exemption (shipped) | 0.47 | **0.48** | 0.80 | **0.37** | 1.1 | 0.10 | 0.33 |
| no decay | 0.33 (+1/−5) | 0.32 (+0/−5) | 0.73 | 0.23 | 0.3 | 0.26 (+6/−1) | 0.80 |
| ACT-R base-level d=0.3 + exemption | 0.53 (+2/−1) | 0.42 (+0/−2) | 0.81 | 0.33 | 3.1 | 0.08 (+1/−2) | 0.55 |
| ACT-R base-level d=0.5 + exemption | 0.53 (+2/−1) | 0.40 (+0/−3) | 0.78 | 0.32 | 3.7 | 0.09 (+1/−1) | 0.42 |
| power-law t^-0.5 (1-day floor) + exemption | 0.51 (+2/−1) | 0.40 (+0/−3) | 0.78 | 0.32 | 2.8 | 0.11 (+1/−0) | 0.43 |
| t^-0.3 since last use, reuse boost kept, + exemption | 0.53 (+2/−1) | 0.42 (+0/−2) | 0.81 | 0.33 | 3.1 | 0.09 (+1/−1) | 0.55 |

The last row is the form that would have shipped: ACT-R's age term in the slot exp(−λt) holds, keeping the capped reuse boost, so it ports to the CLI with the data that path already has. It differs from the ACT-R arm only on records with recorded reuse (8 of 289 targets).

The other two kinds, on the same snapshots. Every arm with the exemption keeps known-item S@10 at 0.97–1.00 in every bucket on both, so S@1 is where they differ:

| Arm | Live known S@1 <7d / 7-30d / 30-90d / 90d+ | Live recency S@10 (n=40) | As-of known S@1 <7d / 7-30d / 30-90d | As-of recency S@10 (n=19) |
|---|---|---|---|---|
| exp λ=0.001 + exemption (shipped) | 0.55 / 0.52 / 0.62 / 0.87 | 0.63 | 0.97 / 0.88 / 0.88 | 0.63 |
| ACT-R d=0.3 + exemption | 0.85 / 0.97 / 0.93 / 0.98 | 0.63 | 1.00 / 0.95 / 0.93 | 0.74 |
| ACT-R d=0.5 + exemption | 0.85 / 0.98 / 0.97 / 1.00 | 0.60 | 1.00 / 0.95 / 0.93 | 0.79 |
| t^-0.5 + exemption | 0.68 / 0.87 / 0.92 / 0.97 | 0.63 | 0.97 / 0.93 / 0.90 | 0.79 |
| t^-0.3 since last use + exemption | 0.85 / 0.97 / 0.93 / 0.98 | 0.63 | 1.00 / 0.95 / 0.93 | 0.74 |

(The as-of corpus starts 2026-01-27, so it has no 90d+ bucket.) On the portable CLI, the shipped arm over the same as-of cases scored topical P@10 0.53, judged P@10 0.76 and gain@10 0.44. The two engines rank differently (per-file IDF, dual-write credit; CLAUDE.md, "Two Search Paths"). Its known S@10 (0.95 / 0.90 / 0.90) and recency (0.47) on this snapshot also trail the API's, and that gap was not examined here. The curve arms are seams of the in-process engine, so the comparison above is API-only.

What the tables say:

- **No candidate passes.** On the as-of snapshot every power-law form loses topical P@10 on two or three of the nine queries and wins none: 0.40–0.42 against 0.48, and gain@10 0.32–0.33 against 0.37. Nine queries cannot show that loss is significant (0 of 2 and 0 of 3 are not), but the rule asks a candidate to show it does not lose, and none can.
- **The cost lands where a browse's material is.** In log-log terms exp(−λt) falls at a slope of λt, and t^-d at a constant d. With λ = 0.024 a day, exp is the gentler curve for anything younger than d/λ — 21 days at d=0.5, 12.5 days at d=0.3 — and the steeper one beyond. As of the labels' date the relevant sessions were 4–10 days old, inside that window. A week-old record weighed against yesterday's partial match keeps 0.87 of its score under exp, 0.56 under d=0.3 and 0.38 under d=0.5 or t^-0.5. Last-day rows took the freed slots: 2.8–3.7 of each top 10, against 1.1. The candidates' gain at P@5 (+2/−1) is the top of the list. The loss is below it.
- **What the power family does win is the far tail and the named record's rank.** Live, where the labeled sessions are 200 days old, it lifts judged P@10 from 0.33 to 0.42–0.55, because there exp is the steeper curve (200 days against 30: 0.017 of the score kept, against 0.39–0.57). And it puts the named record at rank 1 far more often (live known S@1 0.85–0.98 at d=0.3, against 0.52–0.87), again by pushing recent partial matches down. The exemption already keeps every named record in the top 10. Lifting it to rank 1 is a question about the exemption, not about the browse curve, and "Lifting named records" below answers it without touching the curve.
- **The first read of this was wrong, and the instrument was why.** With the matcher eval-search.js had used until then, the as-of snapshot put ACT-R d=0.3 ahead (P@10 0.58 against 0.56) and it was the only candidate passing the rule. Every one of its gains came from one-word matches: a two-word label about the timeline's legends credited a gaze-plot prompt from another project, which shared only the word "timeline", to the Explorer's concurrent-timeline feature, and 94 of the 142 labels have three content words or fewer. Steep curves put more recent one-word matches on the page, so the bug favoured exactly the arms under test. The matcher now needs at least two shared words, honours a label's `relevant: false`, and matches by `event_id` where the label has one (`tests/unit/truth-score.test.js`).
- **Not covered.** The semantic leg was off for every arm (the as-of snapshot cannot use it: the index carries real timestamps and everything written since). The power-law arms are seams of the in-process engine only. The rehearsal term of ACT-R is still unmeasured: 446 events in the ledger, 8 of the 289 live targets with any reuse.

On d itself: ACT-R's d is fitted to need probability, so the nearest environmental estimate here is the access ledger. Its log-log slope of P(use | age), across 14 bins from 30 minutes to 330 days, is −0.79 (d ≈ 0.8). That is an upper bound, since every use in the ledger is of a result the exp-decayed ranker chose to show. Either way it points steeper than d=0.3–0.5, the direction this measurement found costly. So this corpus does not validate ACT-R's curve as the browse ranker's age weight: within the month it costs topical precision. Whether it describes how *use* falls off with age is a separate question, and the ledger cannot answer it while the ranker chooses what gets used.

Reproduce (read-only; `--state` and `--out` refuse paths inside the repository, because the cases carry corpus text and the labels):

```bash
T=~/Documents/dev/session-cartographer/demo/truth
ARMS="--arm shipped --arm nodecay --arm actr-d0.3+exempt --arm actr-d0.5+exempt --arm power+exempt --arm lastuse-d0.3+exempt"
node scripts/age-curve.js --state /tmp/curve-live --truth $T --engines api $ARMS
node scripts/age-curve.js --state /tmp/curve-asof --truth $T --as-of 2026-04-04T23:59:59Z --engines api $ARMS
```

`scripts/eval-search.js` reports the same scorer per engine, on the live corpus and the shipped ranking. Measured 2026-10-17 with the fixed matcher, 9 queries: P@5 0.09 for the CLI keyword arm, 0.11 for CLI hybrid, 0.11 for the in-process API with the semantic leg on; judged P@10 0.29–0.31 and session recall 11% on all three. The old matcher had reported 0.22 / 0.24 / 0.31 for the same ranking. Most of the difference is the one-word credit, though that run's API arm also lost its semantic leg on 4 of 9 queries. All three sit near the floor that label age sets: exp leaves a 200-day-old session 0.8% of its score, and with decay off the API's live P@10 is 0.26 (semantic off, table above).

**Promote-on-reuse** (read-time posterior). When `/remember` actually reads the transcript behind a result, it records the access via `--touch` into `access-ledger.jsonl`. At query time each accessed event gets `boost = 1 + w * Σ 1/sqrt(days_since_access)` capped at 2.0, with `w = CARTOGRAPHER_REUSE_WEIGHT` (default 0.3, 0 disables). The shape is ACT-R base-level activation: recent rehearsals count more, repeats compound with diminishing returns. Reused results show a `(used xN)` tag in CLI output and a `_reuseCount` field in the API. Events never touched score exactly as if the layer did not exist.

The intended division of labor: BM25/semantic measure *relevance to this query*, salience encodes *how deliberate the moment was when written*, reuse encodes *how useful the memory has proven since*. A capped 2× reuse boost breaks ties and lifts proven events but cannot overcome a relevance gap.

### Lifting named records

Decided 2026-10-17: **a lookup's named candidates are multiplied by 3 after decay**, in both engines (`CARTOGRAPHER_DECAY_LOOKUP_LIFT`, `liftNamed()` in `explorer/server/search.js`, the lookup-lift block in `cartographer-search.sh`). The browse curve is unchanged.

**Why the exemption was not enough.** It keeps the named record in the top 10 (live known S@10 234 of 240), but at rank 1 only 148 times. Of the 92 misses, 14 lost to another named record, which no lift reorders. The other 78 lost to a record missing some query token, and 72 of those sat at salience 0.7–0.8: mostly milestones, median age 7.6 days. The targets were mostly web fetches at 0.25–0.5. RRF gives a rank-1 hit 1/61 in any ladder, and a week of exp decay costs 15%, so salience decides. The power-law curves in the previous section won S@1 by decaying the rivals harder, which also cost topical P@10.

**What the case kinds can and cannot show.** A uniform lift over the named set cannot lower a named target's rank, so known-item S@10 and MRR can only rise, and any drop would be a defect. No recency case is a lookup (each query's two tokens are shared by at least 15 records), so recency must not move at all. Only lookups among the topical queries can move: one of nine live, six of nine as of the labels' date. The rule, fixed before any run: pooled known S@1 up by at least 0.05 on both snapshots with no bucket lower; known S@10 and MRR no lower; recency identical; topical P@10 and judged P@10 no lower on both snapshots, with per-query losses no more than wins; and among passing lifts, the smallest whose pooled S@1 is within 0.02 of the best. The smallest lift wins because a lift raises absolute scores, which `--min-score` reads.

In-process API engine, semantic leg off. Live: a new snapshot of 206,896 events, 240 known items (60 per bucket), 40 recency cases, 9 topical. As of 2026-04-04: 17,851 events, 180 known, 19 recency, 9 topical, the same cases as "Choosing the browse curve". Lift 1 reproduces that section's shipped arm on all 208 as-of cases.

| Arm | Live known S@1 <7d / 7-30d / 30-90d / 90d+ | Live S@1, pooled | Live S@10 | As-of known S@1 <7d / 7-30d / 30-90d | As-of topical P@5 / P@10 / judged P@10 |
|---|---|---|---|---|---|
| lift 1: exemption alone, as shipped 2026-10-16 | 0.43 / 0.57 / 0.57 / 0.90 | 148 (0.62) | 234 | 0.97 / 0.88 / 0.88 | 0.49 / 0.48 / 0.80 |
| lift 1.5 | 0.87 / 0.90 / 0.72 / 0.98 | 208 (0.87) | 239 | 1.00 / 0.95 / 0.93 | 0.58 (+2/−0) / 0.48 / 0.80 |
| lift 2 | 0.92 / 0.92 / 0.80 / 0.98 | 217 (0.90) | 240 | 1.00 / 0.95 / 0.93 | 0.58 (+2/−0) / 0.48 / 0.80 |
| **lift 3 (shipped)** | 0.92 / 0.95 / 0.83 / 0.98 | 221 (0.92) | 240 | 1.00 / 0.95 / 0.93 | 0.58 (+2/−0) / 0.48 / 0.80 |
| lift-first: every named record on top | 0.93 / 0.95 / 0.83 / 0.98 | 222 (0.93) | 240 | 1.00 / 0.95 / 0.93 | 0.58 (+2/−0) / 0.48 / 0.80 |

- **Every arm passes, and 3 is the smallest within 0.02 of the ceiling.** No known case lost rank in any arm (81 of 240 rose at lift 3). Recency ranked identically in every arm on both snapshots (S@10 0.55 live, 0.63 as-of). Topical P@10, judged P@10 and gain@10 were identical on both, and P@5 rose on two as-of queries and fell on none. Pooled S@1 rose 0.30 live and 0.05 as-of (9 of 180, exactly the rule's threshold), where it already stood at 0.91. Lift 2 trails lift-first by 5 of 240 live, lift 3 by 1. lift-first, which computes per query whatever factor puts every named record on top, is the family's ceiling and stays a harness arm.
- **The semantic leg does not change it.** With the leg on (live; the as-of snapshot cannot use it), lift 1 scored S@1 140 of 240 and S@10 229. Lift 3 scored 222 and 240, with recency and topical unchanged and the leg answering on all 289 cases in both arms.
- **31% of real queries are lookups.** Replaying the 454 distinct (query, project) pairs in `search-calls.jsonl` on the live snapshot, without their windows: 139 are lookups, naming a median of 2 records. Lift 3 changes the rank-1 result of 68 of them and keeps 94% of each top 10.
- **Real use leans the lift's way, on a small sample.** For lookup calls with exact `result_used` marks, 32 calls and 64 marked records (22 of which the replay no longer returns, since the calls ran with windows or the semantic leg), the marked records' S@1 went 2 → 4, S@10 16 → 16, MRR 0.10 → 0.12. Three moved up (to ranks 1, 1 and 6) and eight moved down, each by one place except one that went from 15 to 18. Only 6 of the 42 replayed marks were named records. Position bias favours lift 1 here, since agents marked what lift 1 showed them.
- **The score floor moves.** Named records score 3× more, so more of them clear `--min-score`. Among the 139 real lookups, 73 have a top-10 hit at 0.010 or more against 24 at lift 1. 0.010 is the prompt-cue trial's floor, tuned on replays from before the exemption existed. That hook has searched once in 649 evaluated prompts and never fired, so the exposure is untested rather than observed: re-run its replay before baking it in.
- **On the CLI the lift closes the gap to the API.** Over the same as-of cases at lift 1, the portable CLI found known items at rank 1 106 times of 180 and in the top 10 165 times (the S@10 gap noted in "Choosing the browse curve"). At lift 3: 173 and 180, 69 cases up and none down, recency unchanged, topical P@10 0.53 → 0.57 and judged P@10 0.76 → 0.78. Lift 1 differs from that section's CLI run on 7 known ranks, each 1–3 places higher here: the snapshot is clock-relative, so 6.8 hours later every row has aged and the undecayed named record gains 0.7% on its decayed neighbours, enough to flip a near-tie in the CLI's flatter ladders.
- **Not covered.** The 14 misses to another named record. The CLI on the live corpus (about 17 s a query there); it is held to the API by the fixture gate.

Reproduce (read-only, as above):

```bash
T=~/Documents/dev/session-cartographer/demo/truth
ARMS="--arm lift1 --arm lift1.5 --arm lift2 --arm shipped --arm lift-first"
node scripts/age-curve.js --state /tmp/lift-live --truth $T --engines api $ARMS
node scripts/age-curve.js --state /tmp/lift-asof --truth $T --as-of 2026-04-04T23:59:59Z --engines api $ARMS
```

`lift<x>` sets `CARTOGRAPHER_DECAY_LOOKUP_LIFT` for both engines, so `--engines api,cli` measures the CLI too. `lift-first` is in-process only.

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
