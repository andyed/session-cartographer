# Co-occurrence Graph & Maneuver Map — Method

`scripts/cooccurrence-graph.js` builds a significance-weighted co-occurrence graph over the **structured** fields of the event logs. One scoring engine (Dunning's G²), two graphs (project co-activity, maneuver map), zero external dependencies (`fs`/`path`/`os` only). It is an **offline index tool** — a sibling of `embed-events.js`, not the query-time scorer. The "BM25 in awk, zero-dependency" rule governs the search hot path; it does not govern an index build, so Node is fine here.

For *whether the graph is right* (validity, stability, signature precision) see [COOCCURRENCE_EVAL.md](COOCCURRENCE_EVAL.md). This doc is *how it works*.

## The one decision the feature rests on: structured entities, never prose

Entities are structured log fields — `project`, detected tech-signals — **never tokenized summary prose**. The prose term-graph was tried and abandoned: it produced machinery cliques (`agent` / `explore` / `completed`) and simply duplicated what the Qdrant semantic path already does. The lesson, kept here so it isn't re-derived: *we already had entities* — they're the typed fields, not the free text. Everything below follows from that.

## Two graphs, three views

| Graph | Document | Entity | Query | Answers |
|---|---|---|---|---|
| Project co-activity | calendar **day** | project active that day | `--related <project>` | "what else do I work on alongside this?" |
| Maneuver **composition** | **session** | detected tech-signal | (internal) | "which markers compose one maneuver?" |
| Maneuver **transfer** | **signal** | project running that signal | `--maneuvers <project>` | "which projects share this procedure?" |

### Grain is load-bearing

The project graph's document is a calendar **day**, not a session. Measured on the real corpus: **97% of sessions touch a single project**, so same-*session* co-occurrence is nearly empty — the cross-thread signal lives in same-*day* co-activity (3–5 concurrent sessions/day). Pick the session grain and the project graph is dead. This is why `--related` recovers research threads (`allserp-paper ↔ ettac-paper`) that no per-session view could see.

The maneuver views invert the document/entity roles to ask two different questions from one signal-detection pass: *composition* (entities = signals, doc = session) finds markers that fire together — `gh-release + version-tag + lfs` is the Psychodeli DMG release; *transfer* (entities = projects, doc = signal) finds projects with a shared procedure profile — the two mindbendingpixels sites share the Cloudflare deploy; `cikm` and `ettac` share the Overleaf dance.

## Scoring: Dunning's G², not lume's z-tanh

Each candidate pair gets a 2×2 contingency table (co-occur `k`, one-without-other `a−k` / `b−k`, neither `N−a−b+k`) scored by **Dunning's log-likelihood ratio (G², 1993)** — `2·Σ Oᵢⱼ·ln(Oᵢⱼ/Eᵢⱼ)`, the canonical "surprise and coincidence" statistic. We follow lume / the Grainger–Hatcher Semantic Knowledge Graph in scoring observed-vs-expected, but rank by G² rather than lume's z-score+tanh.

**Why not z-tanh:** it *saturates*. For a perfectly-correlated pair (`a = b = k`) the z-score collapses to `√N` regardless of count — a 3-session fluke and a 30-session pattern score identically. G² scales with the evidence. A temporal-holdout eval confirmed G² beats z-tanh in every split; the z/tanh variant is documented, not persisted.

**A caveat the eval surfaced, recorded so it isn't mistaken for a bug:** raw count *out-predicts* G² at forecasting recurrence (AUC 0.82 vs 0.56). That is by construction — predicting recurrence rewards the activity base rate that significance scoring deliberately *removes*. `/focus` wants **distinctive** threads, not predictable ones, so prediction is the wrong yardstick (see the eval doc). G² is correct for this feature precisely because it deflates the always-on pairs.

Each edge keeps `k`, `expected`, `llr` (G²), and `jaccard` (display/secondary). Only **attraction** edges survive (`observed > expected`); repulsion is dropped.

### Gates (tuned for the corpus, editable at the top of the script)

| Edge set | min co-occur `k` | G² gate | rationale |
|---|---|---|---|
| project co-activity | 2 days | 0 (rank only) | dense; rank surfaces the top, no hard floor |
| maneuver composition | 3 sessions | 10.83 (χ², p≈0.001) | strict — few signal-sessions, avoid flukes |
| maneuver transfer | 2 signals | 6.63 (χ², p≈0.01) | looser — N = #signals is small |

## Signature catalog (maneuver detection)

Maneuver entities come from a catalog of `[signal, regex]` pairs tested against each event's `summary + files_changed` (in `changelog.jsonl` only — commands, commits, and config edits all land there). ~19 signals, coarse-to-specific by design (the composition graph shows the nesting):

- **branch / history** — `ff-merge`, `no-ff-merge`, `merge`, `merge-check`, `rebase`, `cherry-pick`, `worktree`
- **release** — `version-tag`, `gh-release`, `version-bump`, `lfs`
- **deploy / CDN** — `cloudflare-pages`, `cloudflare-api`, `wrangler-config`, `wrangler`, `netlify`, `gh-actions`, `deploy`
- **paper sync** — `overleaf-sync`

Signatures are deliberately specific (expected precision ≥ 0.9). Adding a signal = one line; the catalog doubles as a tuning worklist (eval Tier 3).

## Index, not store

The artifact is a **~46 KB** graph JSON; the entire maneuver layer is **3.3 KB**. It records *which `(project, signal)` cells are non-empty* — **not** the commands themselves. That is deliberate:

1. **Secrets.** Sampled deploy commands embed Cloudflare account/zone IDs and OAuth-token extraction. Indexing the command text would index secrets. The map holds none.
2. **Redundant.** The actual command already lives in `changelog.jsonl` `tool_bash` summaries. It's one on-demand query away — `/remember`'s `--signal` mode recovers it (`jq 'select(.project==X and (.summary|test(SIGNAL)))'`), scrubbing as it goes.

So the map answers "*which* projects run a maneuver and what it composes with"; recovering the *replayable command* is a separate, on-demand step. Recipe reconstruction (a canonical command sequence per maneuver) is deliberately parked for these two reasons.

## Query modes (consumed by the skills)

```bash
node scripts/cooccurrence-graph.js                      # build, write JSON, print top edges
node scripts/cooccurrence-graph.js --related  <project> # projects co-active with <project>      → /focus
node scripts/cooccurrence-graph.js --maneuvers <project> # a project's maneuver profile + peers   → /focus
node scripts/cooccurrence-graph.js --signal   <maneuver> # which projects run it + composition    → /remember
node scripts/cooccurrence-graph.js --show maneuvers --top 40 --out <path>
```

Query modes print and exit without rewriting the JSON. Project names tolerate aliases / partials (`psychodeli` → `psychodeli-webgl-port`) via `resolveProject()`: exact, then case-insensitive, then substring either direction, choosing the highest-`df` match. `--signal` fuzzy-matches the maneuver name the same way. `PROJECT_BLOCKLIST` filters cwd-path fragments (`Users`, `Documents`, `tmp`, …) that aren't real projects.

Output env: `CARTOGRAPHER_GRAPH` or `$CARTOGRAPHER_DEV_DIR/cooccurrence-graph.json`.

## Properties to keep in mind

- **Maneuver data is intrinsically thin** (~29 maneuver-sessions) — maneuvers are *punctual* events. The map is high-precision and grows with corpus depth, not with more modeling. Report maneuver edges as descriptive, not predictive.
- **The related-threads lens needs a stability gate before it's reliably useful for narrow/solo projects** — low-`k` day-overlaps are calendar coincidence, not threads. Bootstrap stability (eval Tier 2) is the intended filter: surface only edges stable across resamples. Until then, `--related` on a solo tool (e.g. the cartographer repo itself) returns mostly noise; on thread-embedded projects (the papers, Psychodeli) it returns real structure.

## See also

- [COOCCURRENCE_EVAL.md](COOCCURRENCE_EVAL.md) — the three validity claims and the tiered eval (face-validity, stability, signature precision); why the predictive tier was demoted.
- `scripts/cooccurrence-graph.js` — the builder.
- `scripts/eval-cooccurrence.js` — the temporal-holdout predictive diagnostic.
- README → *Co-occurrence graph* and *Inspiration* (the lume lineage).
