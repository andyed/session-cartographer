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

- **`/remember`** — Claude uses this to recover context from past sessions. Agent's primary history tool.
- **`/focus`** — Orient on a project or family before diving in. Reads event logs, no git calls.
- **`/carto`** — Opens the Explorer web app for the human. Not an agent tool.
- **`/wrapup`** — End-of-session synthesis. Captures decisions, discoveries, and unfinished threads as a milestone event. Agent-initiated.
- **CLI** (`cartographer-search.sh`) — Standalone search, no install needed. Used by all skills.

## Project Structure

```
scripts/
  cartographer-search.sh        — CLI search: BM25 (awk) + semantic + RRF fusion
  bm25-search.awk               — BM25 scorer (two-pass TF-IDF, pure awk)
  embed-events.js               — Batch index JSONL events into Qdrant
  semantic-search.js             — Query Qdrant by vector similarity
  index-event.sh                — Real-time single-event indexing (called by hooks)
  backfill-git-history.sh       — Import git commits into event logs
  backfill-memories.sh          — Index Claude Code memory files
  retro-index.sh                — Backfill historical transcripts into Qdrant
  reconstruct-history.js        — Deep transcript analysis for backfill
project-registry.json             — Project aliases for multi-repo families (used by search + /focus)
plugins/session-cartographer/
  skills/remember/SKILL.md      — /remember skill (Claude's context recovery tool)
  skills/focus/SKILL.md         — /focus skill (project orientation from event logs)
  skills/carto/SKILL.md         — /carto skill (launches Explorer web app for humans)
  skills/wrapup/SKILL.md        — /wrapup skill (strategic session-end preservation)
  scripts/remember-search.sh    — Legacy keyword-only search (superseded by cartographer-search.sh)
  hooks/
    hooks.json                  — Hook registrations (8 hooks)
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
  CUSTOM_HOOKS.md               — How to log your own events
  EXPLORER_SPEC.md              — Explorer implementation spec
  companion_explorer_spec.md    — Explorer product spec
  CHANGELOG_SPEC.md             — Event log format
  landscape-survey.md           — 30+ Claude Code memory projects compared
tests/private/                  — Gitignored: test cases, fixtures, benchmarks
```

## Implementation Constraints — READ THESE

- **BM25 in awk is intentional.** `bm25-search.awk` is the CLI search scorer. Zero dependencies (no Node, no jq). Do not port to Python. The JS port in `explorer/server/bm25.js` exists separately for the API path.
- **Field extraction uses a fallback chain** (`summary → description → prompt → url → query → event_id → milestone`) across diverse JSONL schemas. Do not hardcode a single field.
- **Transcripts are first-class citizens in RRF.** They compete equally with event log results. Do not append them at the bottom.
- **`LC_ALL=C` on grep and awk** prevents multibyte errors on unicode in JSONL.
- **Transcript search uses `find -exec grep {} +`** to batch file matching in one process. Do not revert to per-file subprocess loops (1,839 files = 40x slower).
- **Hooks call `index-event.sh` for real-time Qdrant indexing.** Silent fail if services aren't running. Do not make Qdrant a hard dependency.
- **Explorer binds to 127.0.0.1 only.** Never 0.0.0.0. Path traversal protection on transcript endpoints. DOMPurify on rendered content.
- **Ports:** 2526 (API), 2527 (UI), 6333 (Qdrant), 8890 (embeddings).
- **`project-families.json` is gitignored.** Run `generate-families.sh` to bootstrap from event logs.
- **Enrichment scripts modify `changelog.jsonl` in place.** Back up before running on large datasets.
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
