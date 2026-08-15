# Session Cartographer

Hooks are the foundation — they produce JSONL event logs. Everything else is an independent lens on that data.

```
Hooks (produce JSONL)
  ├── /remember (CLI search, bash + awk)
  ├── /focus (project orientation from event logs)
  ├── /carto (web UI, Node + React)
  ├── /wrapup (strategic session-end preservation)
  ├── /trustmap (auto mode environment config)
  └── Qdrant indexer (semantic search)
```

- **`/remember`** — Claude uses this to recover context from past sessions. Agent's primary history tool.
- **`/focus`** — Orient on a project or family before diving in. Reads event logs, no git calls.
- **`/carto`** — Opens the Explorer web app for the human. Not an agent tool.
- **`/wrapup`** — End-of-session synthesis. Captures decisions, discoveries, and unfinished threads as a milestone event. Agent-initiated.
- **`/trustmap`** — Derives auto mode's `autoMode.environment` from the corpus. The same question Claude Code's setup wizard answers by rescanning the machine, answered instead from events already extracted — usage-weighted, cross-provider, and re-runnable so an update proposes only the delta.
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
  backfill-git-history.sh       — Import git commits into event logs
  backfill-memories.sh          — Index Claude Code memory files
  backfill-app-sessions.js      — Import desktop-app/Cowork session metadata (titles + VM-session prompts)
  retro-index.sh                — Backfill historical transcripts into Qdrant (turn-grouped)
  catch-up-transcripts.sh       — Checkpointed/cooldown transcript refresh used by SessionStart
  infer-codex-project.js        — Derive Codex repo attribution from tool workdirs when cwd is generic
  reconstruct-history.js        — Deep transcript analysis for backfill (turn-grouped)
  classify-prompt-intent.js     — Rule-based prompt-intent classifier (17 categories, zero-dep)
  backfill-prompt-intents.js    — Tag already-indexed turns with prompt_intent (payload-only, no re-embed)
  prompt-intent-report.js       — Corpus-wide intent distribution + per-bucket sampling (retuning tool)
  hit-rate-report.js            — Joins served-log.jsonl + access-ledger.jsonl: search hit rate by rank/source/project
  session-digest.js             — Compact per-session panel (tempo, commits, files, recall, dirty repos); used by /wrapup
  trust-digest.js               — Derives infrastructure actually touched (orgs, LAN hosts, buckets, CLIs) for auto mode's autoMode.environment; used by /trustmap
  build-profile.js              — Derives .carto/profile.md: standing summary of projects, preferences, decisions, work shape, cadence
  sentinels.js                  — isResolved()/firstResolved(): the one definition of "field carries no real value"
  session-windows.js            — Shared session time-window construction (enrich + repair consume it)
  session-match.js              — Strict orphan→session matching (project + proximity, refuses ambiguity)
  backfill-investigations.js    — Normalize /investigate hypotheses from .carto/events into the searched log
  repair-orphan-sessions.js     — One-time recovery of pre-0.5.0 milestones stamped session_id "unknown"
project-registry.json             — Project aliases for multi-repo families (used by search + /focus)
plugins/session-cartographer/
  skills/remember/SKILL.md      — /remember skill (Claude's context recovery tool)
  skills/focus/SKILL.md         — /focus skill (project orientation from event logs)
  skills/carto/SKILL.md         — /carto skill (launches Explorer web app for humans)
  skills/wrapup/SKILL.md        — /wrapup skill (strategic session-end preservation)
  skills/trustmap/SKILL.md      — /trustmap skill (derive/update auto mode's autoMode.environment from the corpus)
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
  landscape-survey.md           — 30+ Claude Code memory projects compared
  LONGMEMEVAL.md                — What a LongMemEval run would/wouldn't validate; ingestion + reader config
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
- **Hooks call `index-event.sh` for real-time Qdrant indexing.** Qdrant remains optional, but failures are recorded in `.carto/index-errors.jsonl` and return nonzero so backfills do not checkpoint incomplete sessions.
- **Explorer binds to 127.0.0.1 only.** Never 0.0.0.0. Path traversal protection on transcript endpoints. DOMPurify on rendered content.
- **Ports:** 2526 (API), 2527 (UI), 6333 (Qdrant), 8890 (embeddings).
- **`project-families.json` is gitignored.** Run `generate-families.sh` to bootstrap from event logs.
- **Enrichment scripts modify `changelog.jsonl` in place.** Back up before running on large datasets.
- **Only four logs are searched:** `changelog.jsonl`, `research-log.jsonl`, `session-milestones.jsonl`, `tool-use-log.jsonl`. Anything written elsewhere is write-only. `/investigate` wrote 64 diagnoses to `.carto/events/` before anyone noticed. A new event writer must append to one of the four, use `event_id`/`timestamp`, put its searchable text in `summary`, and call `index-event.sh` — miss any one and the record is unreachable.
- **Never treat a sentinel as an identity. Use `scripts/sentinels.js`.** The event pipeline spells absence three ways — `""`, `"unknown"`, and `null` — and `/wrapup` alone has written all three. `"unknown"` is truthy and equal to itself, so `if (sid)` passes and `groupBy(sid)` merges every unattributed record into one phantom entity. Nothing errors; the numbers are just wrong. That phantom cost a 54% overstated recovery rate during the 0.5.0 repair. Any code that groups, matches, or keys on `session_id`, `provider`, or `project` must go through `isResolved()` rather than re-deriving the set inline (six sites had already diverged).
- **The session-id env var is `CLAUDE_CODE_SESSION_ID`.** `CLAUDE_SESSION_ID` is a legacy name Claude Code never sets. Reading only the legacy name left every served row unattributed and delta serving dormant for the whole life of the feature. Any new consumer must read the chain `CARTOGRAPHER_SESSION_ID → CLAUDE_SESSION_ID → CLAUDE_CODE_SESSION_ID → CODEX_SESSION_ID`.
- **Test harnesses must unset the session vars.** Delta serving is real now; a harness that inherits a live session id silently loses repeat results and fails passing tests.
- **Retrieval telemetry is exact for new calls.** Served rows and `--touch` records share `call_id`; purpose, session, and provider are carried alongside it. `access-ledger.jsonl` is append-only. Do not rewrite it in place, and keep the CLI/API activation implementations in sync. Legacy inference is report-only and opt-in.
- **`.carto/profile.md` is derived, never hand-authored.** `build-profile.js` rebuilds it from the corpus; hand edits are lost on the next run. CLAUDE.md owns hand-written context — duplicating it into the profile creates two sources of truth that drift. Two filters are load-bearing: backfilled git history contains other authors' commits (a profile without the owner filter describes everyone whose repo you ever cloned), and `project` is cwd-derived, so the home directory and workspace root show up as the busiest "projects" unless excluded.
- **`trust-digest.js` emits identifiers, never arguments.** Commands reduce to their leading word, URLs to their host. The output is meant to be pasteable into a settings file without a secret review, and a full command line from `tool-use-log.jsonl` cannot make that promise. Two heuristics there are load-bearing and were both wrong on the first pass: command tokens are resolved against `PATH` (splitting compound lines also splits the inside of inline `node -e`/`python -c` payloads, so `const` and `then` outranked `adb`), and hostnames are shape-checked (summaries clip at ~200 chars, so a URL near the end yields fragments like `huggingfa` that read as single-label internal hosts). Both replaced a guess with a fact — do not revert either to a stoplist.
- **`.carto/` is gitignored, and that default must survive.** Cartographer's event logs are agent-session transcripts, which auto mode's classifier treats as sensitive data belonging in no repo. A project that wants its history versioned deliberately un-ignores its own path; the default for a repo that merely *runs* cartographer stays "don't commit the logs."
- **`--get` uses `rg` when available, `grep` as fallback.** BSD grep over the four event logs costs ~1s per invocation, which turns a five-id fetch into three seconds and teaches an agent to avoid the cheapest verification step in the system. `rg` does the same pass in 0.02s.
- **RRF score cutoff at 10% of top score** to trim the semantic noise tail.
- **Diff-shape quadrant labels:** bootstrap, construct, surgical, rework. Not "dangerous."

## Two Search Paths

1. **CLI** (`cartographer-search.sh`): bash + awk BM25. Used by `/remember` skill. No server needed.
2. **API** (`explorer/server/`): JS BM25 + Express. In-memory index, sub-millisecond queries. Used by the Explorer UI (`/carto`). Proxies Qdrant for semantic search.

Both use the same scoring algorithm (BM25 k1=1.2, b=0.75) and fusion strategy (RRF k=60).

## How Claude should use this

When a user says "remember X" or needs context from a past session, use `/remember`. The skill runs the search, returns ranked results with transcript paths. **Read the transcript** to recover full context — the search result is the map, the transcript is the territory.

When a user says "explore" or wants to browse history visually, use `/carto` to start the web app and open the browser. That's a human tool — don't try to scrape it.

At the end of a productive session — or when a user says "wrap up" — use `/wrapup` to synthesize decisions, discoveries, and open threads into a milestone event. The milestone gets indexed and becomes searchable via `/remember`.

## Testing

- `bash tests/private/run-tests.sh` — 11 tests against live data
- `bash tests/private/run-fixture-tests.sh` — 14 tests against synthetic fixtures
- `bash tests/private/benchmark.sh` — 8-query speed comparison (grep vs. cartographer)
- `bash tests/private/head-to-head.sh "query"` — side-by-side comparison for a single query
- **No MCP-based browser testing.** Test the Explorer UI manually — don't puppet Chrome via desktop-control MCP.
