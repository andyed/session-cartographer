# Changelog

## Unreleased

### feat(skill): /investigate — root-cause diagnosis gate

New skill that enforces diagnosis before bug-fix code. `/investigate <bug summary>` runs a five-step contract: reproduce the failure, read the failing path end-to-end, classify the root-cause layer (logic / state / boundary / validation-gap / config-build), write a hypothesis with **cause + mechanism + disproof**, then log it to the event log and stop — no fix code until the diagnosis is confirmed.

Built to break the "plausible fix shipped before the failure mode was understood" cycle. Includes a skip clause: obvious bugs (cause in the error message, one-line fixes) bypass the ~5–10K token overhead.

**Files:**
- `plugins/session-cartographer/skills/investigate/SKILL.md` *(new)* — the skill. `Bash/Read/Grep/Glob` only; by design it cannot write fix code. Logs an `investigation`-type event so `/remember` can later surface the hypothesis.

### feat(retro-index): resumable backfill

`retro-index.sh` now checkpoints each session — by id + transcript mtime — to `$CARTOGRAPHER_DEV_DIR/.carto/retro-index-progress` as soon as it finishes. A run killed partway through (a multi-hour full-history backfill rarely survives in one sitting) skips the completed sessions on restart; only the interrupted session onward is reprocessed, so no embedding work is repeated. A transcript that has grown since it was indexed (changed mtime) is reprocessed automatically — the overlap dedupes via the deterministic `turn-<sid>-<idx>` point IDs.

**Files:**
- `scripts/retro-index.sh` — per-session checkpoint + skip-on-resume; `--fresh` flag clears the checkpoint for a full reindex; portable `file_mtime` (BSD/GNU `stat`).

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
