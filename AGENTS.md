# Session Cartographer

Hooks are the foundation — they produce JSONL event logs. Everything else is an independent lens on that data.

```
Hooks (produce JSONL)
  ├── /remember (CLI search, bash + awk)
  ├── /focus (project orientation from event logs)
  ├── /carto (web UI, Node + React)
  ├── /wrapup (strategic session-end preservation)
  └── Qdrant indexer (semantic search)
```

- **`/remember`** — Codex uses this to recover context from past sessions. Agent's primary history tool.
- **`/focus`** — Orient on a project or family before diving in. Reads event logs, no git calls.
- **`/carto`** — Opens the Explorer web app for the human. Not an agent tool.
- **`/wrapup`** — End-of-session synthesis. Captures decisions, discoveries, and unfinished threads as a milestone event. Agent-initiated.
- **CLI** (`cartographer-search.sh`) — Standalone search, no install needed. Used by all skills.

## Project Structure

```
scripts/
  cartographer-search.sh        — CLI search: BM25 (awk) + semantic + RRF fusion
  bm25-search.awk               — BM25 scorer (two-pass TF-IDF, pure awk)
  transcript-to-turns.awk       — Turn-group transcripts (user→next-user boundary) before BM25
  embed-events.js               — Batch index JSONL events into Qdrant
  semantic-search.js             — Query Qdrant by vector similarity
  index-event.sh                — Real-time single-event indexing (called by hooks)
  record-wrapup.sh              — Durable wrapup write + verified index receipt
  wrapup-coverage.js            — Derived material-session coverage + pending queue
  backfill-git-history.sh       — Import git commits into event logs
  backfill-memories.sh          — Index Codex memory files
  backfill-app-sessions.js      — Import desktop-app/Cowork session metadata (titles + VM-session prompts)
  retro-index.sh                — Backfill historical transcripts into Qdrant (turn-grouped)
  catch-up-transcripts.sh       — Checkpointed/cooldown transcript refresh used by SessionStart
  infer-codex-project.js        — Derive Codex repo attribution from tool workdirs when cwd is generic
  reconstruct-history.js        — Deep transcript analysis for backfill (turn-grouped)
  classify-prompt-intent.js     — Rule-based prompt-intent classifier (17 categories, zero-dep)
  backfill-prompt-intents.js    — Tag already-indexed turns with prompt_intent (payload-only, no re-embed)
  prompt-intent-report.js       — Corpus-wide intent distribution + per-bucket sampling (retuning tool)
  hit-rate-report.js            — Joins served-log.jsonl + access-ledger.jsonl: search hit rate by rank/source/project
project-registry.json             — Project aliases for multi-repo families (used by search + /focus)
plugins/session-cartographer/
  skills/remember/SKILL.md      — /remember skill (Codex's context recovery tool)
  skills/focus/SKILL.md         — /focus skill (project orientation from event logs)
  skills/carto/SKILL.md         — /carto skill (launches Explorer web app for humans)
  skills/wrapup/SKILL.md        — /wrapup skill (strategic session-end preservation)
  scripts/remember-search.sh    — Legacy keyword-only search (superseded by cartographer-search.sh)
  hooks/
    hooks.json                  — Hook registrations, including background transcript catch-up
    log-research.sh             — WebFetch/WebSearch → research-log.jsonl + changelog.jsonl
    log-session-milestones.sh   — Compactions, session ends, agent stops (with git context)
    log-tool-use.sh             — Edit/Write/Bash + git commits with classification (opt-in)
explorer/
  server/
    index.js                    — Express API (:2526), SSE stream, search proxy
    bm25.js                     — BM25 scorer (JS port for API path)
    search.js                   — Hybrid search: BM25 + Qdrant proxy + RRF
    jsonl.js                    — Resilient JSONL reader with fs.watch
  src/                          — React 19 + Vite + Tailwind UI (:2527)
docs/
  RANK_FUSION.md                — BM25 + RRF scoring architecture
  SCORING.md                    — Score interpretation guide
  SETUP.md                      — Install, Qdrant, cold start backfill, disk usage
  MIGRATION_TURNS.md            — Existing-user guide for turn-based transcript migration
  CUSTOM_HOOKS.md               — How to log your own events
  EXPLORER_SPEC.md              — Explorer implementation spec
  companion_explorer_spec.md    — Explorer product spec
  CHANGELOG_SPEC.md             — Event log format
  landscape-survey.md           — 30+ Codex memory projects compared
tests/private/                  — Gitignored: test cases, fixtures, benchmarks
```

## Implementation Constraints — READ THESE

- **BM25 in awk is intentional.** `bm25-search.awk` is the CLI search scorer. Zero dependencies (no Node, no jq). Do not port to Python. The JS port in `explorer/server/bm25.js` exists separately for the API path.
- **Turn-grouping is an indexing-layer concern, not a query-layer concern.** `transcript-to-turns.awk` preprocesses transcripts into one document per turn (user prompt + assistant responses up to the next user prompt) and is used by `retro-index.sh` + hooks when ingesting into Qdrant. Event IDs are deterministic (`turn-<sid>-<idx>`). Do not run it per-query — the CLI keyword `--transcript` fallback is plain per-line grep by design; semantic search (Qdrant) owns turn-coherent transcript recall. See `docs/MIGRATION_TURNS.md` for historical context.
- **Field extraction uses a fallback chain** (`summary → description → prompt → url → query → event_id → milestone`) across diverse JSONL schemas. Do not hardcode a single field.
- **Event summaries are single-line.** Writers flatten `\n`/`\t` at the source (`tr` in hooks, gsub in the semantic TSV emitter, `index-event.sh`). The pipeline is TSV/line-based: a multi-line summary splits a TSV row, and the fragments mis-parse as rank/key/timestamp — rank coerces to 0 and outranks every real result. The fusion awk drops rows with an empty key or non-numeric rank as a backstop. Pretty-printed JSON must never be appended to the JSONL logs.
- **Transcripts are first-class citizens in RRF.** They compete equally with event log results. Do not append them at the bottom.
- **`LC_ALL=C` on grep and awk** prevents multibyte errors on unicode in JSONL.
- **Transcript search uses `find -exec grep {} +`** to batch file matching in one process. Do not revert to per-file subprocess loops (1,839 files = 40x slower).
- **Hooks call `index-event.sh` for real-time Qdrant indexing.** Qdrant remains optional, but failures are recorded in `.carto/index-errors.jsonl` and return nonzero so backfills do not checkpoint incomplete sessions. Novelty rejects are recorded separately in `.carto/index-rejects.jsonl`; synchronous callers opt into a JSON receipt with `CARTOGRAPHER_INDEX_RECEIPT=1`.
- **Turbo opt-in is user-global and provider-neutral.** Claude Code and Codex read the same `~/.config/session-cartographer/config.json`; do not add separate agent settings as competing sources of truth. Ordinary recall may use HTTP or the sandbox-safe private file transport, while control operations retain the portable CLI path.
- **Turbo awareness is guidance, not automatic retrieval.** When the shared preference is active, SessionStart may remind the agent to use `remember` or `focus` for tasks that depend on prior work. Do not turn that into unconditional startup search; measure deduplicated session exposures against explicit result use.
- **Explorer binds to 127.0.0.1 only.** Never 0.0.0.0. Path traversal protection on transcript endpoints. DOMPurify on rendered content.
- **Ports:** 2526 (API), 2527 (UI), 6333 (Qdrant), 8890 (embeddings).
- **`project-families.json` is gitignored.** Run `generate-families.sh` to bootstrap from event logs.
- **Enrichment scripts modify `changelog.jsonl` in place.** Back up before running on large datasets.
- **Retrieval telemetry is exact for new calls.** Served rows and `--touch` records share `call_id`; purpose, session, and provider are carried alongside it. `access-ledger.jsonl` is append-only. Do not rewrite it in place, and keep the CLI/API activation implementations in sync. Legacy inference is report-only and opt-in.
- **RRF score cutoff at 10% of top score** to trim the semantic noise tail.
- **Diff-shape quadrant labels:** bootstrap, construct, surgical, rework. Not "dangerous."

## Two Search Paths

1. **CLI** (`cartographer-search.sh`): bash + awk BM25. Used by `/remember` skill. No server needed.
2. **API** (`explorer/server/`): JS BM25 + Express. In-memory index, sub-millisecond queries. Used by the Explorer UI (`/carto`). Proxies Qdrant for semantic search.

Both use the same scoring algorithm (BM25 k1=1.2, b=0.75) and fusion strategy (RRF k=60).

## How Codex should use this

When a user says "remember X" or needs context from a past session, use `/remember`. The skill runs the search, returns ranked results with transcript paths. **Read the transcript** to recover full context — the search result is the map, the transcript is the territory.

When a user says "explore" or wants to browse history visually, use `/carto` to start the web app and open the browser. That's a human tool — don't try to scrape it.

At the end of a productive session — or when a user says "wrap up" — use `/wrapup` to synthesize decisions, discoveries, and open threads into a milestone event. The milestone gets indexed and becomes searchable via `/remember`.

## Testing

- `bash tests/private/run-tests.sh` — 11 tests against live data
- `bash tests/private/run-fixture-tests.sh` — 14 tests against synthetic fixtures
- `bash tests/private/benchmark.sh` — 8-query speed comparison (grep vs. cartographer)
- `bash tests/private/head-to-head.sh "query"` — side-by-side comparison for a single query
- **No MCP-based browser testing.** Test the Explorer UI manually — don't puppet Chrome via desktop-control MCP.
