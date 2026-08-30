# Hooks Indexing Backlog

The hooks (`plugins/session-cartographer/hooks/log-*.sh`) are the data layer that everything else searches over. Quality at *write-time* is foundational — no read-time algorithm fixes a thin event record. This document tracks improvements to that write-time signal.

Read-time improvements (temporal filters, delta serving, recency boost) live in `TODO.md` under Search.

## Reference frame: LongMemEval categories

The MenteDB-borrowed framing from `TODO.md`'s "Memory research" section. SC's coverage of [LongMemEval](https://arxiv.org/abs/2410.10813) (the standard memory benchmark, ICLR 2025):

| Category | Current state | Targeted by |
|---|---|---|
| Information extraction | Strong (hybrid BM25 + semantic) | — |
| Multi-session reasoning | Improving (write-side + `--thread` shipped 2026-04-22) | — |
| Knowledge updates | Weak | #4 event lifecycle |
| Temporal reasoning | Strong (since the `--since`/`--before` work shipped 2026-04-24) | — |
| Abstention | Detector shipped 2026-04-25; consumer pending | (#3 follow-up) |

Doing #1, #2, #3 (shipped) lifted coverage from 1.5/5 to ~3.5/5. Adding #4 gets to ~4.5/5.

`#4` was rewritten 2026-07-23 against the NuggetIndex lifecycle model — see the item for what changed and what was dropped.

---

## Shipped

- **#1 — Cross-event linkage via `parent_event_id`** — Write-side in `hooks/common.sh:find_parent_event_id` + all three `log-*.sh`. Read-side `--thread <event_id>` in `cartographer-search.sh` walks ancestors + descendants and prints the arc as a sorted timeline. `/remember` SKILL.md teaches the new query intent. Shipped 2026-04-22.
- **#2 — Salience scoring at write time** — Hooks emit a `salience` field ([0..1]) per event using event-type heuristics: `/wrapup` 0.9, feature/fix commits 0.7, research-paper fetches 0.7, chore/test/docs commits 0.4, tool_bash 0.2. `bm25-search.awk` extracts and emits as a 9th TSV column; `semantic_search_to_tsv()` reads from Qdrant payloads; `rank_fuse_and_display` uses it as a multiplicative weight on RRF. Defaults to 0.5 for old events without the field. Shipped 2026-04-22.
- **#3 — Phantom detection (detector only)** — Empty-results path in `cartographer-search.sh` scans the query for `evt-*`/`git-*` IDs and file paths (regex `[/A-Za-z0-9_.-]+\.[a-zA-Z0-9]{1,8}`), checks each against the JSONL corpus, and routes unknowns to `hooks/log-knowledge-gap.sh`. Writes a `knowledge_gap` event (salience 0.6) to `knowledge-gaps.jsonl` + `changelog.jsonl`. Surfaces inline as `(no results — flagged N unknown entities…)`. Consumer is a follow-up — `/focus <project>` reading recent gaps for that project would close the loop most cleanly. Shipped 2026-04-25.

## Active

### #3-consumer — `/focus` reads `knowledge-gaps.jsonl` (LOW effort, closes loop)

**Gap.** `#3` ships a detector but no reader. The `knowledge_gap` events accumulate in JSONL and search results but nothing actively surfaces them at the moment they would matter — when the agent is entering a project.

**Change.** `/focus <project>` (and the underlying `cartographer-search.sh "recent activity" --project <p>`) reads the last ~20 `knowledge_gap` events filtered to the requested project, dedupes by `query`, and prints a short "Unanswered questions" block at the top of the orientation. Only show gaps with recurrence ≥ 2 (one-off phantoms are noise; recurring ones are signal that the entity actually matters and auto-memory should capture it).

**Touches:** `plugins/session-cartographer/skills/focus/SKILL.md`; possibly a small awk reader inline.

**Payoff.** Closes the self-improvement loop. The recurrence signal also tells us whether `#3`'s detection heuristics are any good before we invest in `#4`'s harder problem.

---

### #4 — Event lifecycle: validity intervals + `active`/`deprecated`/`contested` (MEDIUM leverage)

**Gap.** Jsonl is append-only; "last write wins" is implicit but invisible to retrieval. A revert commit, a `/wrapup` decision that reverses an earlier one, a port number that moved — all logged independently from what they replace. `/remember` happily returns stale facts alongside their corrections, and time-decay ([SCORING.md](SCORING.md)) only nudges the stale one *slightly* down the ranking. Nothing tells the reader the two results are in conflict.

**Prior art.** [NuggetIndex](https://doi.org/10.1145/3805712.3809687) (Zerhoudi et al., SIGIR '26). Their model: each fact carries a validity interval `[start, end)` and a lifecycle state (`active` / `deprecated` / `contested`); invalid entries are filtered *before* ranking; contested facts surface as labelled disputes rather than being silently adjudicated. Reported −55% conflict rate. We adopt the vocabulary and the filter-position, not the machinery — see **Non-goals**.

#### Design

**Lifecycle states.** Three, with fixed retrieval semantics:

| Status | Default query | `--include-stale` |
|---|---|---|
| `active` | returned if the interval spans the query time | returned |
| `contested` | returned, labelled as disputed alongside its rival | returned |
| `deprecated` | excluded | returned, marked with what superseded it |

**Validity interval.** `[valid_from, valid_to)`. `valid_from` is the event's own timestamp; `valid_to` is `null` until something supersedes it, then the superseding event's timestamp. No inference — both endpoints are timestamps we already have. This is what makes point-in-time recall work: `--before 2026-05-01` currently filters on *when the event was logged*, so it returns a fact that was already dead by that date. With intervals it can instead ask *what was true then*, which is the query a `/remember` user actually means.

**Storage: append-only sidecar, no in-place rewrite.** NuggetIndex rewrites the ledger line when a status changes. We do not — append-only is a hard constraint across every log in this repo. Instead, `event-lifecycle.jsonl` accumulates state transitions; last record per `event_id` wins at read time:

```json
{"ts":"2026-05-12T09:14:00Z","event_id":"git-abc1234","subject":"session-cartographer:file:explorer/server/index.js","status":"deprecated","valid_from":"2026-03-01T11:02:00Z","valid_to":"2026-05-12T09:14:00Z","superseded_by":"git-def5678","reason":"revert","project":"session-cartographer"}
```

Original events in `changelog.jsonl` are never touched. The sidecar is regenerable and safe to delete.

**Conflict key.** NuggetIndex conflicts on `(subject, predicate, scope)`. Our analog is `(project, subject)` where `subject` is a namespaced slug emitted at write time. Two records conflict only when they share a key *and* their intervals overlap. Non-overlapping intervals are succession, not conflict — both stay `active`.

**Resolution.** Follows their asymmetric/symmetric split, mapped to whether we have authority:

- **Deterministic supersession → `deprecated`.** Git itself names the target, or the config write is unambiguously last-wins. Tighten the loser's `valid_to` to the winner's `valid_from`.
- **Detected but unadjudicated → `contested`.** Same key, overlapping intervals, no authority to pick. Both stay retrievable and are shown side by side with dates and provenance. We do not auto-resolve; that's the user's call.

#### Scope: three deterministic write-time signals only

1. **Revert commits.** `git log` bodies carry `This reverts commit <sha>` verbatim. That is a hard edge, no heuristics — the classifier at [log-tool-use.sh:110](../plugins/session-cartographer/hooks/log-tool-use.sh:110) already tags `COMMIT_TYPE="revert"`; extend it to read the body, resolve `<sha>` to the existing `git-<sha>` event id, and append a `deprecated` record for it.
2. **`/wrapup` decisions.** The one write path where an LLM is *already in the loop* — the skill is authoring prose about the session, so it can also emit a `decision_key` slug and, when it knows it's reversing a prior call, an explicit `supersedes: <event_id>`. Same-key wrapups with no explicit `supersedes` become `contested`, not `deprecated`. Touches [wrapup/SKILL.md:71](../plugins/session-cartographer/skills/wrapup/SKILL.md:71) (add the two fields to the `jq` object).
3. **Config values.** Edit/Write on a config-glob file where the diff is a single `KEY = VALUE` line change. Subject is `<project>:config:<file>#<KEY>`, and last write deterministically wins → prior value `deprecated`. Genuinely triple-shaped and requires no extraction. If the diff isn't a clean single-key change, emit nothing.

#### Read-time: filter before RRF

Both search paths gate at row ingestion, *before* scoring — the position is the point. Filtering after fusion still lets dead events consume top-K slots and distort the 10% score cutoff.

- **CLI** — load `event-lifecycle.jsonl` in the `BEGIN` block of `rank_fuse_and_display` (same pattern as the access ledger, [cartographer-search.sh:595](../scripts/cartographer-search.sh:595)), keyed by `event_id`, last line wins. Drop `deprecated` rows in the ingestion block next to delta-serving suppression at [cartographer-search.sh:669](../scripts/cartographer-search.sh:669) — i.e. before `score =` at [:677](../scripts/cartographer-search.sh:677). Mark `contested` keys for the display block.
- **API** — filter the input lists before `rrfFuse` at [search.js:365](../explorer/server/search.js:365), not after. Explorer renders `contested` pairs as a linked dispute.
- **New flag** — `--include-stale` disables the drop and annotates each result with its status and `superseded_by`. Orthogonal to `--all` (which governs delta-serving).

#### Non-goals

- **No corpus-wide triple extraction.** Nuggets are semantic facts; our events are episodic. Extracting SPO triples per event needs an LLM at hook time, which breaks the zero-dep bash/awk hook contract.
- **No `pip install nuggetindex`.** A second index alongside Qdrant, for a slice of the corpus this narrow, is not worth the dependency.
- **Dropped from the previous version of this item:** keyword-triggered supersession on `fix`, `actually`, or refactor-patterns. Those are inference dressed up as signal and would deprecate live events on a bad match. A false `deprecated` is worse than no lifecycle at all — it makes recall silently lossy. Only the three signals above qualify.

**Payoff.** LongMemEval knowledge-updates category (the sole remaining "weak" row above). Point-in-time `--before` semantics. And `/remember` becomes honest about which version of a contested decision is current, instead of ranking both and letting recency imply an answer.

**Measure.** Conflict rate on a hand-labelled set of known reversals; false-deprecation rate (must be ~0); no regression in the existing fixture tests.

---

## Queued

### #5 — Embed more than the summary

`scripts/index-event.sh` currently embeds only the `summary` field. For commits that's `Commit abc123: msg | files: a,b,c` — embedding wastes capacity on the prefix template. Build a richer payload of `summary + files-touched (paths only) + commit body first 200 chars` before sending to the embedding model. Same Qdrant call cost, better recall on file-name and intent queries.

### #6 — Pending-index queue for Qdrant resilience

When Qdrant is down, `index-event.sh` records the stage in
`.carto/index-errors.jsonl` and returns retryable exit 75, but detached live
hooks still have no durable retry queue — events remain in JSONL and miss the
semantic index until manual backfill. Add `pending-index.jsonl` that hooks
append to on non-200 responses; `index-event.sh` drains on next successful
invocation; startup check drains on Qdrant come-back.

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

Last refresh: 2026-07-23 (`#4` redesigned against NuggetIndex). Prior refresh 2026-04-24. Source: brainstorm during the LongMemEval / MenteDB study thread, prioritized by leverage × effort.

Items above are tracked separately from `TODO.md` so the strategic indexing roadmap stays distinct from day-to-day search/UI work. When an item ships, move it out of "Active" and add a one-liner to `CHANGELOG.md`.
