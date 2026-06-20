# Evaluating the Co-occurrence Graph

How do we know the graph is *right*? There is no labeled ground-truth co-occurrence graph to score against — the edges are descriptive claims about Andy's own work. So validity has to come from two places: the **human oracle** (Andy knows which threads are real) for face validity, and **self-supervised predictive structure** (does the past predict the future?) for rigor that needs no labels.

This is the structural sibling of [`eval-search.js`](../scripts/eval-search.js): that harness scores *retrieval* (precision@k vs. labeled truth queries); this one scores *structure* (predictive validity, stability) with no labels. Different paradigm, same repo discipline (Node, zero new deps).

## What we're actually testing — three separable claims

1. **Project co-activity edges are real research threads, not calendar coincidences.** (e.g. `allserp-paper ↔ ettac-paper` real; `blog ↔ psychodeli-osx-vx` at k=2 a fluke.)
2. **The ranking statistic earns its keep** — Dunning G² beats raw count, Jaccard, and lume's z-score+tanh. This is the one design decision the whole feature rests on; it should be validated empirically, not just by the saturation algebra.
3. **Maneuver signatures detect real maneuvers** (precision) without missing them (recall).

Each claim wants a different test.

---

## Tier 0 — Face validity (human oracle, ~30 min, do first)

The sanity floor. Dump the top-N edges of each graph; Andy labels each `real / coincidence / wrong`.

- `--audit` mode prints top-20 project edges, maneuver compositions, and transfer edges as a checklist.
- **Metric:** precision@10, precision@20 per graph.
- **Why it's legitimate:** Andy *is* the ground-truth oracle for his own corpus. No one else can label "is approach-retreat↔ettac a real thread."
- **Target:** precision@10 ≥ 0.8 on project edges. Lower is fine on maneuver transfer (N=19 signals, known-thin).

## Tier 1 — Predictive validation (self-supervised, the centerpiece)

The rigorous, label-free test: **does co-activity structure learned on the past predict co-activity in the future?** If the graph captures stable structure rather than noise, a high-scored edge in the training window should keep co-occurring in the held-out window.

- **Split:** train = first 80% of days, test = last 20% (temporal holdout, not random — respects the arrow of time).
- **Procedure:** build the project graph on train only. For every project pair active in train, score it by each method below. Label = did the pair co-occur on ≥1 day in the *test* window (binary)?
- **Metric:** ROC-AUC and average precision per scorer at predicting test co-occurrence.
- **Baselines (this is where claim 2 is settled):**
  | scorer | formula |
  |---|---|
  | raw count | `k` |
  | Jaccard | `k / (a + b − k)` |
  | z + tanh (lume) | `tanh(sign(z)·ln(1+|z|)/3)` |
  | **Dunning G² (ours)** | `2·Σ Oᵢⱼ·ln(Oᵢⱼ/Eᵢⱼ)` |
  | (optional) PMI / npmi | `ln(k·N/(a·b))` |
- **What good looks like:** G² AUC ≥ z-tanh AUC, both meaningfully above raw-count and above 0.5. **The headline number is the G² − z-tanh delta** — it turns "z saturates" from an algebra argument into a measured win (or tells us the algebra didn't matter at this corpus size, which is also worth knowing).
- **Caveat:** maneuver data is too thin (~29 sessions) for a powered predictive test — run this on the *project* graph; report maneuvers as descriptive-only until the corpus deepens.

## Tier 2 — Stability / robustness (bootstrap)

Quantifies the "punctual / thin" worry directly: which edges are load-bearing vs. lucky?

- **Procedure:** resample days with replacement (B = 1000), rebuild the graph each time, track each top-N edge's rank.
- **Metric:** how often each top-20 edge stays top-20 across resamples; Kendall's τ of the top-list across bootstraps.
- **Expected:** `scrutinizer-www↔scrutinizer2025` (19 shared days) rock-stable; the k=2 edges thrash. 
- **Payoff:** the stability score can *gate what `/focus` shows* — surface only edges stable in ≥90% of resamples, so thin coincidences never reach the user.

## Tier 3 — Maneuver signature precision / recall

Validates the signature catalog (claim 3) and finds gaps.

- **Precision:** sample N events tagged with each signal; confirm the command/commit genuinely is that maneuver. (Manual spot-check or a stricter rule audit.) Signatures are deliberately specific, so expect ≥ 0.9.
- **Recall:** find known maneuver-sessions by an independent route (e.g. sessions containing both a `git tag` and a `gh release` = a release), check the catalog caught them. Misses → new signatures to add.
- **Metric:** per-signal precision/recall, catalog F1. Output doubles as a worklist for catalog tuning.

## Tier 4 — Downstream utility (deferred, qualitative)

The real question — *does the `/focus` related-threads block actually surface a useful cross-project connection during live orientation?* — resists clean measurement. Track anecdotally: the test is whether Andy follows a surfaced thread he'd forgotten. This is the LongMemEval **multi-session-reasoning** capability (the cross-session join the project graph provides; see [TODO.md](../TODO.md)) made concrete for this corpus.

---

## Success criteria (one glance)

| Tier | Metric | Target |
|---|---|---|
| 0 face validity | precision@10 (project edges) | ≥ 0.80 |
| 1 predictive | AUC: G² vs z-tanh | G² ≥ z-tanh, both > raw-count, > 0.5 |
| 2 stability | top-10 edges stable across bootstrap | ≥ 90% |
| 3 signatures | per-signal precision | ≥ 0.90 |

## Implementation

`scripts/eval-cooccurrence.js`, sibling of `eval-search.js`. Modes:

- `--audit` — Tier 0 top-N dump for human labeling.
- `--predict` — Tier 1 temporal split + the AUC baseline table (the centerpiece run).
- `--stability` — Tier 2 bootstrap rank-stability.
- `--signatures` — Tier 3 precision/recall sampling.

Reuses the builder's scoring functions (export `dunningLLR`, `zSig`-equivalent, `jaccard` from `cooccurrence-graph.js`). No new dependencies; deterministic except the bootstrap, which takes a fixed seed passed on the CLI (the builder forbids `Math.random()` in some contexts, so seed explicitly).

## Recommended order

Run **Tier 1 first** — it's the rigorous validation of the core decision (G² over lume's z), needs no human time, and produces the single most defensible number. Then Tier 0 (cheap human pass) and Tier 2 (gates the `/focus` UX). Tier 3 when tuning the signature catalog; Tier 4 is ongoing.
