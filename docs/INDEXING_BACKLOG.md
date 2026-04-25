# Hooks Indexing Backlog

The hooks (`plugins/session-cartographer/hooks/log-*.sh`) are the data layer that everything else searches over. Quality at *write-time* is foundational — no read-time algorithm fixes a thin event record. This document tracks improvements to that write-time signal.

Read-time improvements (temporal filters, delta serving, recency boost) live in `TODO.md` under Search.

## Reference frame: LongMemEval categories

The MenteDB-borrowed framing from `TODO.md`'s "Memory research" section. SC's coverage of [LongMemEval](https://arxiv.org/abs/2410.10813) (the standard memory benchmark, ICLR 2025):

| Category | Current state | Targeted by |
|---|---|---|
| Information extraction | Strong (hybrid BM25 + semantic) | — |
| Multi-session reasoning | Improving (write-side + `--thread` shipped 2026-04-22) | — |
| Knowledge updates | Weak | #4 event_relations |
| Temporal reasoning | Strong (since the `--since`/`--before` work shipped 2026-04-24) | — |
| Abstention | Weak | #3 phantom detection |

Doing #1 and #2 (shipped) lifted coverage from 1.5/5 to ~3/5. Adding #3 + #4 gets to ~4.5/5.

---

## Shipped

- **#1 — Cross-event linkage via `parent_event_id`** — Write-side in `hooks/common.sh:find_parent_event_id` + all three `log-*.sh`. Read-side `--thread <event_id>` in `cartographer-search.sh` walks ancestors + descendants and prints the arc as a sorted timeline. `/remember` SKILL.md teaches the new query intent. Shipped 2026-04-22.
- **#2 — Salience scoring at write time** — Hooks emit a `salience` field ([0..1]) per event using event-type heuristics: `/wrapup` 0.9, feature/fix commits 0.7, research-paper fetches 0.7, chore/test/docs commits 0.4, tool_bash 0.2. `bm25-search.awk` extracts and emits as a 9th TSV column; `semantic_search_to_tsv()` reads from Qdrant payloads; `rank_fuse_and_display` uses it as a multiplicative weight on RRF. Defaults to 0.5 for old events without the field. Shipped 2026-04-22.

## Active

### #3 — Phantom detection signal (HIGH leverage)

**Gap.** When a query mentions an entity SC has zero info on (project name from registry, file path under `$DEV/`, identifier matching `evt-*`/`git-*`), the script silently returns "No results found." That's an *abstention failure*: the system can't distinguish "we genuinely don't know" from "your query was too narrow."

**Change.** When `cartographer-search.sh` is about to return zero results, run an entity scan over the query: extract project-name candidates (compare against `project-registry.json`), file paths (anything matching `[\w/.-]+\.\w+`), and event identifiers. For unknown ones, emit a `knowledge_gap` event log entry via a new `log-knowledge-gap.sh` hook driver — turning every empty query into a future-capture target. Surface to the user: "(no results — flagged 2 unknown entities for next-session capture)".

**Touches:** `cartographer-search.sh` final block; new `plugins/session-cartographer/hooks/log-knowledge-gap.sh`.

**Payoff.** Targets LongMemEval abstention. Also closes a self-improvement loop — empty queries become signals for what auto-memory should pick up.

---

### #4 — `event_relations.jsonl` sidecar for knowledge updates (MEDIUM leverage)

**Gap.** Jsonl is append-only; "last write wins" is implicit but invisible to retrieval. A revert commit, a "supersedes" decision, an "actually let's do Y" message — all logged independently from what they replace. `/remember` happily returns stale facts alongside their corrections.

**Change.** When a commit message contains `revert`, `fix`, `supersedes #N`, `actually`, or matches a refactor-pattern, emit an edge to `event_relations.jsonl`: `{from: <new-event>, to: <previous-event>, type: Supersedes|Contradicts}`. Search-time can then suppress superseded events from default ranking, surface them only with `--include-stale`.

**Touches:** new analyzer in the commit-classification path of `log-tool-use.sh`; small read in `rank_fuse_and_display` to suppress superseded keys.

**Payoff.** LongMemEval knowledge-update category. Also makes `/remember` honest about which version of a contested decision is current.

---

## Queued

### #5 — Embed more than the summary

`scripts/index-event.sh` currently embeds only the `summary` field. For commits that's `Commit abc123: msg | files: a,b,c` — embedding wastes capacity on the prefix template. Build a richer payload of `summary + files-touched (paths only) + commit body first 200 chars` before sending to the embedding model. Same Qdrant call cost, better recall on file-name and intent queries.

### #6 — Pending-index queue for Qdrant resilience

When Qdrant is down, `index-event.sh` silently fails — events end up in JSONL but not the semantic index until manual backfill. Add `pending-index.jsonl` that hooks append to on non-200 responses; `index-event.sh` drains on next successful invocation; startup check drains on Qdrant come-back.

### #7 — Content-hash dedup at write time

Multiple hooks can fire on similar actions, producing near-duplicate JSONL records that compete for top-K slots. Hash `summary + project + ts-bucketed-to-minute`, skip writes within 60s of an existing identical hash. Implement in a shared `hooks/common.sh:dedup_check()`.

### #8 — Multi-aspect embeddings

Index each event with two vectors: one for *intent* (the summary), one for *content* (files, body, code). Qdrant supports multi-vector collections. Search fuses both per-query. Higher recall on diverse query types ("what was I trying to do" vs "where's the file with X"). Bigger Qdrant footprint (~2× index size) and modest latency cost.

### #9 — Retrieval engagement loop

When a user reads a transcript file linked from a `/remember` result, that's a salience signal. Stream Explorer click events back to `read-engagement.jsonl`; rolling 30-day per-event-id aggregate boosts subsequent retrieval. Closes the loop between *what we surface* and *what proved useful*. CLI side could substitute on `read_transcript` tool calls in conversation context.

### #10 — JSONL retention compaction

After ~6 months, `tool-use-log.jsonl` is multi-GB. Tier strategy: roll older-than-90d into `archive/<year>-<quarter>.jsonl.gz`; hot search ignores archives, `--archive` flag includes them. Reduces hot-search bytes by ~10× without losing data. Cron-able utility at `scripts/compact-logs.sh`.

---

## Status

Last refresh: 2026-04-24. Source: brainstorm during the LongMemEval / MenteDB study thread, prioritized by leverage × effort.

Items above are tracked separately from `TODO.md` so the strategic indexing roadmap stays distinct from day-to-day search/UI work. When an item ships, move it out of "Active" and add a one-liner to `CHANGELOG.md`.
