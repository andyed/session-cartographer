# Assessment: utility / performance / opportunity — the Claude↔Codex bounce

*2026-07-16. Multi-agent probe (live-data, performance, landscape) + direct checks.
Two planned probes (provider-invariant code audit, bounce-UX walkthrough) died on a
session limit mid-run; their core questions were answered empirically by the
live-data probe. All numbers below were measured on this machine on 2026-07-16.*

## TL;DR

The architecture is right and the positioning is unique, but the bounce is
currently half-real: **Codex can recall Claude work, while Claude is nearly blind
to Codex work** — 23 Codex sessions over 4 days (52 MB, 2026-07-13→16) produced
exactly 1 captured event, a manual `/wrapup`. Meanwhile the daily `/remember`
call costs **7–15 s, not the documented 1.5 s**, because the CLI re-indexes
~29 MB of event logs with awk on every query. Fix those two things and the story
("one passive memory plane across competing agent CLIs") becomes true instead of
aspirational. The opportunity space that opens after that is **bounce-native
features** (handoff baton, provider facet, cross-provider thread view), not a
third provider.

## Utility: what's real today

- **Read path works cross-provider.** A live query returned the lone Codex event
  at rank 4, interleaved with Claude results. 18 of 23 Codex transcripts show
  `cartographer-search.sh` invocations, including a `--touch` reuse call —
  `/remember` genuinely runs from inside Codex.
- **The moat survived native memory.** Claude auto-memory (per-project
  `MEMORY.md` dirs) and Codex `~/.codex/memories` are both provider-siloed,
  per-project, and unranked. Cartographer still uniquely owns: cross-provider +
  cross-project recall, the event-level index with `claude-history://` deep
  links, the co-occurrence lenses, and the Explorer. In the surveyed landscape
  ([landscape-survey.md](landscape-survey.md)), nothing else does **passive hook
  capture** into one shared ranked index — MCP memory servers are
  provider-agnostic at the interface but require capture discipline, the failure
  mode TODO.md already calls out in mindmap-mcp.
- **But the moat is one event deep on the Codex side.** Codex was ~11% of
  session volume in the measured window and ~0.4% of captured events.

## Critical finding: the Codex write path is dead, and a version bump alone won't fix it

Three facts line up:

1. The installed Codex plugin was a stale pre-unification `0.3.0+codex` build
   (repo ships 0.4.0), installed from a `personal` marketplace rooted at the
   entire home directory. *(Fixed 2026-07-16: checkout registered as the
   `session-cartographer` marketplace, 0.4.0 installed, stale cache removed.)*
2. The 0.4.0 `.codex-plugin/plugin.json` declares `"skills": "./skills/"` but
   **no hooks key at all** — hook wiring exists only in the Claude-schema
   `hooks/hooks.json` with `${CLAUDE_PLUGIN_ROOT}` paths. There is no evidence
   Codex registers or fires those lifecycle hooks.
3. Zero hook-generated Codex lines exist in any log. The single Codex event came
   from a skill (`/wrapup`), which runs as an explicit command, not a hook.

**Falsifiable next step:** with 0.4.0 now installed, run one throwaway Codex
session and grep `changelog.jsonl` for a `provider=codex` hook event. If none
appears (expected), Codex capture should not bet on live hooks — the robust path
is **transcript-side ingestion**: a catch-up pass over `~/.codex/sessions`
rollout files (the 114-line `codex-transcript-to-turns.awk` adapter already
exists), triggered on SessionStart or cron. That also recovers the ~22
already-lost sessions, and it is the same mechanism that would make a third
provider cheap later. Skills remain the Codex write path for rich events
(`/wrapup`, `/investigate`).

### Related integrity leaks (same pass)

- **Provider metadata is nearly absent from the corpus.** Stamping began
  2026-07-13; 99.98% of Qdrant's 63,300 points and ~35k legacy log lines carry
  no provider field — a provider filter today silently excludes almost
  everything. Stamp legacy as `claude`; derive provider from `transcript_path`
  prefix at ingest.
- **`provider=unknown` wrapups.** Two rich manual wrapups landed with
  `session_id="unknown"` and empty `transcript_path`, dead-ending the most
  valuable artifact the system captures.
- **Concurrency footnote:** hooks append with bare `>>`, no `flock`. Fine for
  typical single-line events, but with two CLIs appending concurrently,
  multi-KB wrapup lines carry a small interleave risk. Cheap to flock.

## Performance: one bottleneck dominates, and it's not the one in TODO.md

- **Measured 6.7–14.6 s per `/remember`** vs the README's 1.5 s claim. The cost
  is the CLI keyword path re-running a two-pass awk BM25 over ~29 MB of logs
  (corpus grew ~20× past the docs), **sequentially** across four files
  (3.5 + 1.5 + 1.4 + 0.4 s), then double insertion-sorting up to 10k rows in
  awk (`rank_fuse_and_display`, "fine for small N" — N is now 10k+). The
  semantic path is nearly free (+0.3 s); Qdrant is healthy (63,300 points,
  green).
- **The fix is small:** cap `bm25-search.awk` output at top-500 per source
  (FUSION_DEPTH is already 500 — no behavior change), pipe to `sort(1)` instead
  of the O(n²) awk sorts, and parallelize the four source scans → ~3.5 s. The
  M-sized follow-up — query the Explorer server's already-amortized in-memory
  index when alive — gets sub-second and *also* unblocks ranking experiments,
  since the SDM-lite revert's real lesson was that indexing cost **is** query
  latency when there is no persistent index.
- **TODO.md's named bottleneck is stale.** The transcript-BM25 fallback is now
  opt-in (`--transcript`), grep-only, and adds ~2 s; the 120 s eval timeout no
  longer triggers by default (eval never passes `--transcript`).
- **Bounce-specific fallback bug:** the transcript fallback's 20-file cap is
  shared and Claude-first — measured 350 matching Claude files vs 10 Codex files
  for "facets", so **Codex transcripts can never enter the fallback window** for
  any common term, and which 20 Claude files get grepped is arbitrary traversal
  order. Fix: mtime sort + a small per-provider quota (Codex `rg` costs 15 ms).
- **The eval cannot steer ranking work.** Nine self-referential truth queries
  (README says 4), P@5 granularity 0.2/query, and a matcher fix that alone moved
  P@5 2.4× (0.18→0.44). Expand to 10–15 queries from non-SC projects and freeze
  the matcher before any further ranking investment.

## Opportunity space, ranked

**P0 — make the moat true (prerequisites):**

1. Codex capture via transcript ingestion (catch-up over `~/.codex/sessions`),
   not live hooks; backfill the lost sessions. *(S–M)*
2. Provider backfill + derive-from-path stamping; fix the `provider=unknown`
   wrapup path. *(S)*

**P1 — daily-experience tax:**

3. The three-line latency fix (7–15 s → ~3.5 s), then index amortization via the
   Explorer server (→ sub-second). *(S, then M)*
4. Refresh the stale benchmark docs — README's grep-vs-cartographer table
   (1.5 s), "4 labeled queries", "1.5 MB index", RANK_FUSION.md's "~1–2 s" —
   they understate real latency 4–10× and hide this problem from triage. *(S)*

**P2 — bounce-native features (the actual new opportunity):**

5. **`/handoff` recency baton.** `/remember` covers archival recall; the
   bounce's #1 pain is *recency* — the other agent is blind to what happened 10
   minutes ago. A compact state-of-thread event on wrapup/stop, injected by the
   existing `surface-focus-on-start.sh` when the **other provider** opens the
   same project within ~24 h. Reuses shipped machinery, pure bash+jq. *(S)*
6. **Provider as a first-class dimension** — `--provider` flag, Explorer facet
   pill, provider glyph in the planned board view. "What did Codex do" is
   currently unexpressable in one flag despite being stored on every event. *(S)*
7. **Ingest both native memory stores** as event sources — extend
   `backfill-memories.sh` to walk `~/.codex/memories` and per-project
   `~/.claude/projects/*/memory/` dirs. Position native auto-memory as a feed,
   not a competitor. *(S)*
8. **Cross-provider thread view + duplicate-work guard** — group same-project
   same-day sessions across providers (the G² day-grain engine already treats
   the day as the document); warn at session start when the other provider
   touched overlapping `files_changed` within 24 h. Targets the two worst bounce
   failure modes: duplicated work and conflicting edits. *(M)*
9. Transcript-fallback provider quota (see Performance). *(S)*

**Deprioritized / closed:**

- **Third-provider adapter** — do the registry refactor (collapse the ≥4
  hardcoded provider sites) opportunistically, not the adapter; no third CLI can
  feed live capture anyway, and a backfill-only provider adds maintenance
  without daily value.
- **LongMemEval as a target** — answer TODO.md's open question "no": SC is
  human-driven session search; native memory now owns the substrate role on both
  sides. Keep the categories as a diagnostic frame only.
- **Phrase matching / SDM bigrams** — parked correctly; revisit only after index
  amortization + truth-set expansion.
- **Stale TODO items** — transcript-BM25 2-3s/file and the 120 s eval timeout
  are already resolved in code; reword to keep only the tokenizer fix (stop
  expanding filenames into independent tokens).

## Actions taken (2026-07-16)

- Local `main` was a stale pre-rebase line (9 patch-equivalent commits);
  rebased onto `origin/main` (9c6d5b0, the merged 0.4.0 release).
- Registered the checkout as the `session-cartographer` Codex marketplace,
  removed the stale `0.3.0+codex` install from the `personal` marketplace
  (rooted at `$HOME`), installed 0.4.0. Claude Code side was already at 0.4.0.
- Next verification: one Codex session, then
  `jq -r 'select(.provider=="codex")' ~/Documents/dev/changelog.jsonl` — hook
  events appearing would falsify the "Codex never fires Claude-schema hooks"
  hypothesis above.
- **Manual Codex recompute (P0 #1) executed:** `retro-index.sh --provider codex`
  now indexes all 26 Codex sessions — Qdrant went from 1 → 332 codex points, and
  a live query returns codex turns with resolvable rollout paths interleaved
  with Claude results. Getting there exposed two silent-drop bugs (below); the
  working invocation is
  `TURN_BODY_MAX=1200 PE_GATE_REJECT=1.1 bash scripts/retro-index.sh --provider codex`.

## Bugs found during the recompute (2026-07-16)

1. **`index-event.sh` silently drops any turn longer than the embedder's
   budget.** The mxbai server (llama.cpp, batch 512) returns HTTP 500 for
   inputs over ~512 tokens (~1,500 chars of code-dense text); every
   `curl -sf … || exit 0` swallows it. Both turn adapters default
   `TURN_BODY_MAX` to 50,000 chars and real turns run 20–49 KB, so the first
   codex backfill "completed" while indexing ~2% of turns — and **historical
   Claude transcript indexing has the same silent holes** (long Claude turns
   never made it into Qdrant). Fix: truncate the embed input in
   `index-event.sh` itself (~1,200 chars, front-truncation keeps the user
   prompt), log drops instead of `exit 0`, and consider re-indexing Claude
   history with the same truncation to fill the holes.
2. **The prediction-error gate (`PE_GATE_REJECT=0.85`) is wrong for
   backfills.** It rejects a new point if its nearest neighbor scores >0.85 —
   sensible for live hook spam, but a provider backfill's content is
   semantically near the other provider's account of the same work, which is
   exactly what should be indexed. Even after the length fix it would have
   gated most codex turns. Fix: `retro-index.sh` should set
   `PE_GATE_REJECT=1.1` (or a `--no-gate` flag) for backfill runs.
3. Minor: running `codex-transcript-to-turns.awk` without `-v sid=` emits
   colliding `turn-codex--N` event_ids across sessions; the awk script should
   fail loudly when `sid` is empty rather than emit colliding IDs.

## Implementation update (2026-07-19)

The first value-instrumentation pass is now implemented:

- `/remember` searches and result-use touches share an exact `call_id`, plus
  purpose/session/provider attribution. The MRR report excludes ambiguous
  legacy traffic by default and no longer lets one later touch credit multiple
  search calls.
- A non-blocking SessionStart catch-up incrementally ingests recent Codex
  transcripts. The first live run added 267 Codex turns (332 → 599) and moved
  freshness from July 17 to the current July 19 session.
- Embed input is bounded independently from the stored turn body. Service and
  embedding failures are logged and return nonzero; incomplete sessions stay
  retryable instead of being silently checkpointed.
- Codex desktop sessions rooted at the generic `~/Documents/dev` workspace are
  attributed from the dominant repository workdir in tool calls. Without this,
  484 of 599 Codex points were incorrectly filed under project `dev` and hidden
  by normal project filters.
- A live recall check exposed and fixed an over-escaped jq control-character
  range that deleted most letters `a` through `u` from semantic result display.
  Stored summaries and embeddings were intact; the fused CLI output is now
  readable and regression-covered.

The pre-change MRR value (0.058 across 31 calls) is not a trustworthy baseline:
it mixes audit/benchmark traffic and ambiguous event-only touch attribution.
The useful baseline begins with post-change `purpose=remember` calls.
