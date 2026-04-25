# Hooks Indexing Backlog

The hooks (`plugins/session-cartographer/hooks/log-*.sh`) are the data layer that everything else searches over. Quality at *write-time* is foundational — no read-time algorithm fixes a thin event record. This document tracks improvements to that write-time signal.

Read-time improvements (temporal filters, delta serving, recency boost) live in `TODO.md` under Search.

## Reference frame: LongMemEval categories

The MenteDB-borrowed framing from `TODO.md`'s "Memory research" section. SC's coverage of [LongMemEval](https://arxiv.org/abs/2410.10813) (the standard memory benchmark, ICLR 2025):

| Category | Current state | Targeted by |
|---|---|---|
| Information extraction | Strong (hybrid BM25 + semantic) | — |
| Multi-session reasoning | **Weak** | #1 parent_event_id |
| Knowledge updates | Weak | #4 event_relations |
| Temporal reasoning | Strong (since the `--since`/`--before` work shipped 2026-04-24) | — |
| Abstention | Weak | #3 phantom detection |

Doing #1, #2, #3, #4 lifts coverage from 1.5/5 to 4.5/5. The remaining gap (full multi-session reasoning) requires #1 to be in place plus query-side traversal, queued as a follow-up.

---

## Active

### #1 — Cross-event linkage via `parent_event_id` (HIGH leverage)

**Gap.** Each event today is atomic. Conversations have arcs ("tried X" → "X failed because Y" → "switched to Z" → "Z worked, committed"); the JSONL captures each step but not the linkage. `/remember` returns disconnected snapshots even when the user is asking about a coherent thread of work.

**Change.** Add a `parent_event_id` field to every emitted event. Compute it by reading the last line of the per-type log (or the unified changelog) on each write — if the prior event is in the same `session_id` and within 60s of `now`, link to it. Otherwise leave null.

**Read-side.** New CLI flag `--thread <event_id>` traverses the parent chain (or its descendants by reverse-lookup) and surfaces the entire arc rather than individual events. `/remember` skill teaches Claude to use this when the user asks "show me how I got to X."

**Touches:** new `plugins/session-cartographer/hooks/common.sh` for the parent-lookup helper; all three `log-*.sh` to populate; `cartographer-search.sh` for `--thread`; `SKILL.md` for the new query intent.

**Payoff.** Targets LongMemEval's multi-session reasoning category. Over weeks of activity, this turns the JSONL from a flat event log into a queryable graph — same data, dramatically richer recall on "show me the arc" questions.

---

### #2 — Salience scoring at write time (HIGH leverage, LOW effort)

**Gap.** Every event has equal weight in RRF today. Andy's `/wrapup` milestone and a routine typo-fix commit rank identically when their summary text matches the query. This dilutes the top-K with noise.

**Change.** Hooks emit a `salience: 0.0–1.0` field per event using event-type-specific heuristics:
- `log-research.sh`: research-domain fetch → 0.7; docs/reference → 0.5; blog/news → 0.4; search query itself → 0.5; search result → 0.3.
- `log-session-milestones.sh`: `/wrapup`-style milestones → 0.9; compaction → 0.4; session_end → 0.5.
- `log-tool-use.sh`: commit_type feature/fix → 0.7, docs/test/chore → 0.4, revert → 0.6; +0.1 if files-changed > 5; +0.1 if message starts with "Release" or matches `v\d+\.`.
- `tool_bash` → 0.2 (mostly noise).

`cartographer-search.sh:rank_fuse_and_display` reads salience and uses it as a third RRF dimension. Old events without the field default to 0.5 (back-compat).

**Touches:** all three `log-*.sh`; `bm25-search.awk` to extract + emit; `semantic-search.js` to extract from Qdrant payload; `rank_fuse_and_display` for the multiplier.

**Payoff.** Single change improves *every* downstream search. Smallest code surface, biggest perceived improvement on "find the important X" queries.

---

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
