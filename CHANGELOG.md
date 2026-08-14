# Changelog

## Unreleased

## 0.5.0 — 2026-08-14

### fix(attribution): read the session id Claude Code actually exports

Every consumer resolved the active session from `CLAUDE_SESSION_ID`. Claude Code
has never set that variable — the name it exports to tool calls is
`CLAUDE_CODE_SESSION_ID`. Nothing crashed and nothing was logged, so the failure
went unnoticed for the life of the feature.

Two consequences, both silent:

**Delta serving never ran.** It suppresses event_ids already returned earlier in
a session so repeat `/remember` calls surface fresh material. It gates on the
session id, so it has been dormant since it shipped: 4,361 of 4,361 served rows
carried an empty `session_id`. If you wondered why calling `/remember` twice
returned much the same thing, this is why. It works now — expect repeat calls in
one session to return genuinely different results.

**Milestones lost their transcripts.** `/wrapup` and `/investigate` build their
records with inline bash that read the same broken chain, so they stamped
`session_id: "unknown"`, which then defeated the transcript lookup and wrote an
empty `transcript_path`. On the reference corpus 437 of 507 wrapup milestones
(86%) were affected. They still ranked at the top of `/remember` results —
wrapups carry the highest salience in the corpus — while being dead ends.

The resolution chain is now `CARTOGRAPHER_SESSION_ID → CLAUDE_SESSION_ID →
CLAUDE_CODE_SESSION_ID → CODEX_SESSION_ID` in every consumer, with provider
derived from whichever entry resolved rather than re-testing the legacy name
independently (the same defect had left 369 records with no provider).
`/wrapup` and `/investigate` now warn on stderr when the session will not
resolve, so a silent `"unknown"` can never accumulate unnoticed again.
`tests/unit/session-id-chain.test.js` asserts on the written log row, since that
is the only place the original failure was visible.

Test harnesses now unset the session variables. With delta serving actually
working, a harness that inherits a live session id loses repeat results and
fails tests that are fine.

### feat(search): `--get` for exact, untruncated fetch by event_id

Search output is lossy by construction — summaries are single-line and
truncated for display. `--get evt-a,evt-b` returns the complete records,
including `transcript_path`, `files_changed`, and `diff_shape`, so a shortlist
can be verified before committing to reading a 100MB transcript. Ids that
resolve to nothing are reported as missing rather than silently dropped;
returning four records for five ids is how an agent ends up confidently
answering from a gap.

### feat(profile): standing corpus summary at `.carto/profile.md`

`scripts/build-profile.js` derives a length-budgeted summary of active
projects, standing preferences, durable decisions, work shape, and cadence, so
recall can start from the top of the pyramid rather than always from a record
lookup. Fully derived — delete it and it rebuilds. Commits count toward the
profile only when the author matches the owner set or the commit carries a
`session_id`, so backfilled history from cloned repos cannot describe a
composite of every author whose repo was ever cloned.

### fix(scripts): one definition of an unresolved field

The event pipeline spells absence three ways — `""`, `"unknown"`, and `null` —
and `/wrapup` alone has written all three across different eras of the skill.
Readers each re-derived the set inline and diverged.

This never surfaces as an error. `"unknown"` is truthy and equal to itself, so
`if (sid)` passes and grouping by it silently merges every unattributed record
into one phantom entity. During this release's orphan repair that phantom built
a session window spanning the entire corpus, "matched" 148 orphans, and
overstated the recovery rate by 54% before it was caught.

`scripts/sentinels.js` now holds the single definition (`isResolved`,
`firstResolved`), and the session-window builder, digest, and repair tool all
use it. A unit test asserts no window can ever be keyed by a sentinel.

### feat(scripts): recover orphaned sessions from before this release

`scripts/repair-orphan-sessions.js` walks milestone records stamped
`session_id: "unknown"` back to their session by project and nearest-event
proximity. Existing users should run it once — see "Recovering Orphaned
Sessions" in `docs/SETUP.md`. Dry run by default; `--write` takes a `.bak` and
rewrites only repaired lines.

The matching policy is deliberately stricter than `enrich-sessions.js`: a
project match is required, ambiguity is refused rather than guessed at, and the
transcript is verified to exist and to cover the timestamp before it is
written. A wrong session id is worse than a missing one — it points `/remember`
at an unrelated conversation and presents it as the real thing.

On the reference corpus (439 orphans) this recovered 145 with a verified
transcript and 10 whose transcript had expired, refused 101 as ambiguous, and
found 183 unrecoverable. Wrapup milestones with a working transcript went from
65 to 210. Concurrent sessions in one project are the limiting factor.

Window construction is now shared with `enrich-sessions.js` through
`scripts/session-windows.js`; behavior of the existing tool is unchanged.

### feat(wrapup): render a session digest before writing the synthesis

`/wrapup` now opens with `scripts/session-digest.js`, a compact panel covering
span and tempo, commits with type and diff-shape mix, hottest files, research
hosts, `/remember` served-vs-used, and the live uncommitted/unpushed state of
every repo the session touched. Every line traces to a logged event or to
`git`, so a wrong claim is visible rather than merely plausible.

The panel is shown to you, and the agent writes its synthesis against it rather
than from its own recollection of the conversation. Digest scalars are attached
to the milestone under `digest`, so a session stays checkable after its
transcript passes Claude Code's ~30-day TTL.

## 0.4.1 — 2026-07-24

### fix(release): self-contained repository marketplace installs

Direct installs from a cloned checkout previously copied
`plugins/session-cartographer` without the search runtime, project registry, or
Explorer that `scripts/build-release.sh` added only to release archives. The
installed skills resolved their plugin root correctly and then failed because
`scripts/cartographer-search.sh` was absent.

The checked-in marketplace source now carries the same assembled runtime as the
release archive. `scripts/copy-plugin-runtime.sh` is the shared assembly path,
`tests/source-marketplace-smoke.sh` exercises real isolated Codex and Claude
managed-cache installs when their CLIs are available, and CI guards the checkout
marketplace independently of tagged release builds.

### feat(indexing): derived PostCompact summaries and transcript refresh

The lifecycle bridge records redacted, provenance-marked compact summaries as
derived evidence without replacing canonical transcripts. Session start also
runs checkpointed transcript catch-up, while project inference and Qdrant
payloads retain cross-provider provenance.

### feat(search): exact recall-use telemetry

Search calls and `--touch` reuse events now share stable call identifiers,
purpose, provider, and session metadata. `hit-rate-report.js` computes explicit
result-use hit rate and MRR without crediting later searches that happened to
serve the same event.

### docs: cross-provider assessment and event-lifecycle roadmap

The release includes the July cross-provider recall assessment and redesigns
the knowledge-update backlog around validity intervals plus
`active`/`deprecated`/`contested` lifecycle states, with the NuggetIndex
citation verified against arXiv and CrossRef.

## 0.4.0 — 2026-07-13

Promoted after the release candidate passed clean managed-cache installs in
both plugin layouts, the full search suite, Explorer build, and published-asset
checksum verification.

### feat(providers): shared Claude Code and Codex history

Hooks now detect provider provenance per event instead of relying on a global
mode, so Claude Code and Codex can run concurrently and consume each other's
history. Codex JSONL gets its own turn adapter, transcript search scans both
provider stores, Qdrant payloads retain provider and transcript path, and the
Explorer normalizes both formats behind one secure transcript endpoint.

### feat(release): self-contained cross-provider plugin bundle

The plugin no longer depends on the developer checkout after installation.
Release builds place search/index scripts, the project registry, and Explorer
inside the plugin, while hook and skill runtime resolution prefers that bundled
copy. `scripts/build-release.sh` creates a version-checked local-marketplace
archive plus SHA-256 checksum; `tests/release-smoke.sh` extracts it and proves
bundled hook resolution and keyword recall. Tags matching `v*` now run unit and
release smoke tests before GitHub publishes the archive.

## 0.3.0 — 2026-06-23

### feat(graph): significance-weighted co-occurrence graph + maneuver map

Two orientation lenses search can't provide, from one Dunning-G² engine over the **structured** fields of the event logs (project, detected tech-signals) — never tokenized prose (a prose term-graph just rebuilt machinery cliques and duplicated the Qdrant path). **Project co-activity** (`--related <project>`) uses the calendar *day* as the document — 97% of sessions are single-project, so the cross-thread signal lives in same-day concurrency, not same-session — surfacing research threads like `allserp-paper ↔ ettac-paper`. **Maneuver map** (`--maneuvers <project>`) detects tech-signals (`gh-release`, `cloudflare-pages`, `overleaf-sync`, …) from a signature catalog over `summary + files_changed`, in two views: *composition* (signal × signal, doc = session — `gh-release + version-tag + lfs` = the Psychodeli DMG release) and *transfer* (project × project, doc = signal — which projects share a procedure).

Edges rank by **Dunning's log-likelihood ratio (G², 1993)**, not lume's z-score+tanh: for a perfectly-correlated pair the z-score collapses to `√N` regardless of count, so a 3-session fluke ties a 30-session pattern — it saturates. A temporal-holdout eval confirmed G² beats z-tanh in every split, and also that *prediction is the wrong yardstick* (raw count dominates both — forecasting recurrence rewards the base rate significance is designed to remove); `/focus` wants distinctive threads, not predictable ones. The artifact is an **index, not a store** (~46 KB; maneuver layer 3.3 KB): it records which `(project, signal)` cells are non-empty, never the commands — those stay in the changelog and are recovered on demand, so no secrets (CF tokens / zone IDs) are indexed. Inspired by DeepBlueDynamics/lume's Semantic Knowledge Graph layer.

**Files:**
- `scripts/cooccurrence-graph.js` *(new)* — the G² engine + `--related` / `--maneuvers` / `--signal` query modes; writes `cooccurrence-graph.json`.
- `scripts/eval-cooccurrence.js` *(new)* — temporal-holdout predictive eval (the diagnostic that demoted prediction as the success metric).
- `plugins/session-cartographer/skills/focus/SKILL.md` — Step 3 surfaces related threads + maneuvers.
- `plugins/session-cartographer/skills/remember/SKILL.md` — `--signal` procedural recall ("how do I deploy X").
- `docs/COOCCURRENCE.md` *(new)*, `docs/COOCCURRENCE_EVAL.md` *(new)* — method + evaluation plan.
- `README.md` — *Co-occurrence graph* section + lume inspiration.

### feat(hook): auto-focus on session start — experimental, opt-in

`SessionStart` hook that injects the graph's related-threads + maneuver lenses as session context on entering a project, so cross-thread connections surface without a manual `/focus`. **Dormant by default** — enable with `CARTOGRAPHER_FOCUS_ON_START=1`. Abstains on home-dir / non-project launches (early-exit, no graph build) and surfaces at most **once per project per day** — the same banner on every launch is wallpaper. Logs every fire to `focus-on-start-trial.jsonl` (`fired` = had signal, `shown` = actually injected) so hit-rate and follow-through are measurable. Trial finding (155 fires): home-dir noise and repetition dominated until both were suppressed; the maneuver half is reliably useful, and the related-threads half is now gated by a cheap G² stability heuristic (significant *and* not a two-day fluke) that cuts solo-project coincidence — full Tier-2 bootstrap stability remains the principled version.

**Files:**
- `plugins/session-cartographer/hooks/surface-focus-on-start.sh` *(new)* — env-gated, silent-fail, skips compaction.
- `plugins/session-cartographer/hooks/hooks.json` — `SessionStart` registration (inert until the env var is set).

### feat(search): promote-on-reuse — access ledger + activation scoring

Write-time salience was a static prior; this makes it a learned posterior. When `/remember` actually reads the transcript behind a result, it records the access via a new `--touch EVENT_IDS` flag into an append-only `access-ledger.jsonl`. At query time, rank fusion folds the ledger in as an activation layer: reuse refreshes the event's recency (time decay runs from the most recent access, not the event timestamp) and compounds an ACT-R-style frequency boost `1 + w·Σ 1/sqrt(days_since_access)`, capped at 2× so reuse breaks ties without overpowering relevance. Reused results show a `(used xN)` tag. Searching is free; using is vouching — only transcript reads record accesses, never mere serving.

Inspired by mindmap-mcp-server's promote-on-reuse lifecycle ("reusing it = vouching for it"), implemented continuously in the scoring layer instead of as discrete hot/warm/cold tiers. Untouched events score exactly as before; `CARTOGRAPHER_REUSE_WEIGHT=0` disables (default 0.3).

**Files:**
- `scripts/cartographer-search.sh` — `--touch` verb, ledger aggregation in the fusion awk BEGIN block, decay block generalized to an activation block (now uses the existing `ts_to_epoch` helper), `(used xN)` display tag
- `explorer/server/search.js` — same activation layer for the API path (`applyTimeDecay` → `applyActivation`), `_reuseCount` on results
- `plugins/session-cartographer/skills/remember/SKILL.md` — Step 3 now records reuse after reading a transcript; touch only what was used, not everything served
- `docs/SCORING.md` — new "Score modifiers" section documenting salience, decay, and reuse as one post-fusion layer

### feat(backfill): app-session metadata import — titles + Cowork prompts

New `scripts/backfill-app-sessions.js` walks the Claude desktop app's session-metadata stores (`~/Library/Application Support/Claude/{claude-code-sessions,local-agent-mode-sessions}`) and imports what the transcript pipeline never sees: human-readable session titles ("SPF trilogy") keyed to CLI session ids, and Cowork sessions — which run in VMs and never write transcripts to `~/.claude/projects` — whose title + initialMessage is the only locally recoverable record. Recon found 318 desktop sessions (13 with TTL'd transcripts where only the title survives) and 20 Cowork sessions that were entirely invisible to `/remember`.

Events land in `changelog.jsonl` as type `app_session` with deterministic ids (`app-<uuid>`), so re-runs are no-ops. Salience graded by uniqueness of the record: Cowork 0.7, orphaned desktop 0.6, transcript-backed desktop 0.5. `transcript_path` attached when the CLI transcript still exists. Store paths catalogued from mindmap-mcp-server's `import.ts`.

### feat(skill): /investigate — root-cause diagnosis gate

New skill that enforces diagnosis before bug-fix code. `/investigate <bug summary>` runs a five-step contract: reproduce the failure, read the failing path end-to-end, classify the root-cause layer (logic / state / boundary / validation-gap / config-build), write a hypothesis with **cause + mechanism + disproof**, then log it to the event log and stop — no fix code until the diagnosis is confirmed.

Built to break the "plausible fix shipped before the failure mode was understood" cycle. Includes a skip clause: obvious bugs (cause in the error message, one-line fixes) bypass the ~5–10K token overhead.

**Files:**
- `plugins/session-cartographer/skills/investigate/SKILL.md` *(new)* — the skill. `Bash/Read/Grep/Glob` only; by design it cannot write fix code. Logs an `investigation`-type event so `/remember` can later surface the hypothesis.

### feat(retro-index): resumable backfill

`retro-index.sh` now checkpoints each session — by id + transcript mtime — to `$CARTOGRAPHER_DEV_DIR/.carto/retro-index-progress` as soon as it finishes. A run killed partway through (a multi-hour full-history backfill rarely survives in one sitting) skips the completed sessions on restart; only the interrupted session onward is reprocessed, so no embedding work is repeated. A transcript that has grown since it was indexed (changed mtime) is reprocessed automatically — the overlap dedupes via the deterministic `turn-<sid>-<idx>` point IDs.

**Files:**
- `scripts/retro-index.sh` — per-session checkpoint + skip-on-resume; `--fresh` flag clears the checkpoint for a full reindex; portable `file_mtime` (BSD/GNU `stat`).

## 0.2.1 — 2026-06-12

### fix(events): single-line summaries everywhere — malformed top-ranked results eliminated

Multi-line bash commands (heredocs, `python -c`) flowed into event summaries with newlines intact. The JSONL stayed valid (escaped `\n`), but Qdrant payloads hold the parsed string, and the semantic TSV emitter printed it raw — one result row split into many, fragments mis-parsed as rank/key/timestamp, rank coerced to 0, and the garbage aggregate (`[]`/`[0.5]` timestamps, `+`-joined command fragments) outranked every real result on every query. Separately, a hand-written pretty-printed wrapup record sat as 41 invalid lines in both `changelog.jsonl` and `session-milestones.jsonl`, and `grep -c … || echo 0` in the milestones hook produced `"0\n0"` counts — corrupting summaries and silently failing the milestones-log write via `--argjson`.

Writers now flatten at the source; the search pipeline sanitizes and guards at every layer; historical data cleaned in place (backups kept) including 261 Qdrant payloads.

**Files:**
- `plugins/session-cartographer/hooks/log-tool-use.sh` — flatten `\n`/`\t` in commands; read `tool_response.stdout` (object form) so commit parsing stops leaking raw JSON escapes into summaries
- `plugins/session-cartographer/hooks/log-session-milestones.sh` — `grep -c | head -1` + numeric guard for the session event count
- `scripts/cartographer-search.sh` — semantic TSV emitter strips control chars from summaries; fusion awk drops rows with an empty key or non-numeric rank (the backstop)
- `scripts/bm25-search.awk` — flatten `\n`/`\\n` escape sequences in event-log summaries before TSV emit (display-only; scoring unchanged)
- `scripts/index-event.sh` — embed request built with jq instead of string interpolation (summaries with quotes were silently never indexed); text flattened before embedding

## 0.2.0 — 2026-05-20

### feat(intent): prompt-intent classification for transcript turns

Every transcript turn opened by a human prompt is now classified into one of 17 intent categories (bug-fixes, research, planning-strategy, deploy-release, …). The intent is stored on the Qdrant turn payload and is searchable as both a filter and a facet.

The classifier is a zero-dependency rule cascade ported from [crispierry/codex-log-viewer](https://github.com/crispierry/codex-log-viewer) (`packages/analytics/src/prompt-intents.ts`), then retuned against this corpus: a noise gate routes injected `user` turns (task notifications, slash-command wrappers, skill preambles, compaction summaries) to `other`, pasted-image markers are stripped during normalization, and question/bug-report phrasings were widened.

**Files:**
- `scripts/classify-prompt-intent.js` *(new)* — the classifier. Exports `classifyPromptIntent()` + `promptIntentCategories`; also runnable as a CLI for spot-checks.
- `scripts/backfill-prompt-intents.js` *(new)* — patches `prompt_intent` onto already-indexed turn points via Qdrant set-payload. Payload-only — no re-embedding, no embedding server required. Idempotent, supports `--dry-run`.
- `scripts/prompt-intent-report.js` *(new)* — corpus-wide intent distribution plus de-duplicated per-bucket sampling. The tool for re-tuning the predicates as prompting style evolves.
- `scripts/reconstruct-history.js` — tags each turn with `prompt_intent` as it indexes (the human prompt only; tool-result turn fragments stay untagged).
- `scripts/index-event.sh` — threads an optional `prompt_intent` field from the event payload through to the Qdrant point payload.
- `scripts/cartographer-search.sh` — new `--intent KEY` filter (semantic-only; the keyword event logs carry no intent) and an `intents:` line in the facet summary.

**Backfill for existing users:** `node scripts/backfill-prompt-intents.js` tags turns that were indexed before this landed. Only turns opened by a real human prompt receive an intent — tool-result turn fragments do not.

### feat(transcripts): turn-based chunking replaces per-line indexing

Transcripts are now indexed **one document per conversation turn** instead of one document per JSONL line. A turn = a user prompt plus every assistant message up to the next user prompt. This keeps questions and their resolutions in the same document, which is how BM25 and semantic retrieval both want to see them.

Inspired by Dropbox's [witchcraft/pickbrain](https://github.com/dropbox/witchcraft) — same chunking unit, but the implementation stays in awk and keeps the existing Qdrant + event-log architecture.

**Files:**
- `scripts/transcript-to-turns.awk` *(new)* — zero-dep JSONL preprocessor. Walks each transcript, emits one turn per `user`→next-`user` boundary. Harvests text/content/file_path/command/url/query/name values cleanly (no more JSON scaffolding in summaries). Deterministic `turn-<sid>-<idx>` IDs so reruns dedupe.
- `scripts/cartographer-search.sh` — `grep_transcripts_to_tsv()` now preprocesses each matched transcript through the turn grouper before BM25 scoring. Uses `src=transcript-turn` label to bypass the legacy per-line transcript branch cleanly.
- `scripts/retro-index.sh` — replaced per-message jq extraction with turn grouping. One Qdrant event per turn.
- `scripts/reconstruct-history.js` — accumulator pattern, one Qdrant event per turn. Preserves synthesized `synth-*` tool-invocation events alongside turns for per-action retrieval.
- `scripts/bm25-search.awk` — **unchanged.** Turn documents flow through the event-log field extraction path via the new source label.

**Migration for existing users:** see [docs/MIGRATION_TURNS.md](docs/MIGRATION_TURNS.md). CLI users need nothing. Qdrant users run three commands: delete legacy `hist-*` points, re-run `retro-index.sh` with `PE_GATE_REJECT=2.0`, optionally refresh `reconstruct-history.js`.

### feat(devtools-adapted): import session parsing, token attribution, and compaction detection from claude-devtools

Raided [claude-devtools by matt1398](https://github.com/matt1398/claude-devtools) (MIT) for
three production-quality modules. Adapted TypeScript → plain ESM JavaScript, stripped Electron
IPC and React/Redux coupling, kept the pure parsing logic.

**New files under `src/lib/devtools-adapted/`:**

#### `session-parser.js` — Priority 1
Full `~/.claude/projects/` JSONL parser. Replaces the bare `readline` loop in
`reconstruct-history.js` when `DEVTOOLS_PARSER=true`.

- `parseJsonlFile(filePath)` — streaming line-by-line parse, skips malformed lines
- `parseJsonlLine(line)` — single-entry hydration with content blocks, timestamps, metadata
- `extractToolCalls(content)` / `extractToolResults(content)` — tool_use / tool_result extraction
- `deduplicateByRequestId(messages)` — drops duplicate streaming assistant entries; prevents
  output_token overcounting (Claude Code emits multiple entries per API response during streaming)
- `calculateMetrics(messages)` — session-level token + timing metrics post-dedup
- `isParsedUserChunkMessage()`, `isParsedHardNoiseMessage()`, `isParsedCompactMessage()` — type guards
- `enumerateSessions()` — scan all of `~/.claude/projects/`, sorted newest-first
- `parseSession(filePath)` — full parse with byType grouping, taskCalls, sidechain split
- `extractTextContent(msg)` — text extraction for indexing

#### `token-attribution.js` — Priority 2
6-category token breakdown per session. Intended as session-level metadata for the
cartographer index and future activation scoring.

Categories: `claudeMd` · `mentionedFiles` · `toolOutputs` · `thinkingText` ·
`taskCoordination` · `userMessages`

- Uses chars/4 heuristic (matches claude-devtools for consistency)
- Extracts system-reminder / CLAUDE.md injection blocks from user messages
- Separates Task/SendMessage/TeamCreate overhead from generic tool outputs
- `attributionFractions()` — normalized [0,1] breakdown for scoring

#### `compaction-detector.js` — Priority 3
Detects context compaction events (information-loss markers) and computes per-phase
token contributions.

- `checkMessagesOngoing(messages)` — activity-state machine: ongoing if AI activities
  (thinking, tool_use, tool_result) follow the last text output or interruption
- `detectCompactionPhases(messages)` — tracks pre/post compaction token levels;
  `contextConsumption` is the compaction-aware total (sum of per-phase contributions),
  more meaningful than raw final input_tokens

**`index.js`** — barrel export + `DEVTOOLS_PARSER_ENABLED` feature flag
**`analyzeSession(filePath)`** — convenience wrapper combining all three modules in one call

**`reconstruct-history.js`** — wired via `DEVTOOLS_PARSER=true` env flag
When active, `processTranscript()` calls `analyzeSession()` after its existing readline loop
and appends enriched fields to the `session_milestone` Qdrant payload:
`attribution`, `compaction_count`, `context_consumption`, `is_ongoing`, `total_tokens`.
Non-fatal: degraded gracefully to the existing basic milestone on any error.

**Tests:** `tests/unit/devtools-adapted.test.js` — 36 tests, 15 suites, Node built-in test runner.
Covers synthetic fixtures + a live smoke test against the most recent real session file.

**Attribution:** `THIRD_PARTY_NOTICES.md` added; `LICENSE` updated.

**What was NOT taken from claude-devtools:**
- Electron shell / window management
- React/Redux UI components and styling
- Alert / notification system
- SSH / remote features
- Subagent tree building or cross-session search
