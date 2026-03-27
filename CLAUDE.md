# Session Cartographer

Claude Code plugin (installed via `claude install`). Contains the `/carto` skill, event-logging hooks, and search scripts. Companion Explorer web app for visual browsing.

## Project Structure

```
scripts/
  cartographer-search.sh        — CLI search: BM25 (awk) + semantic + RRF fusion
  bm25-search.awk               — BM25 scorer (two-pass TF-IDF, pure awk)
  embed-events.js               — Batch index JSONL events into Qdrant
  semantic-search.js             — Query Qdrant by vector similarity
  index-event.sh                — Real-time single-event indexing (called by hooks)
  retro-index.sh                — Backfill historical transcripts into Qdrant
  reconstruct-history.js        — Deep transcript analysis for backfill
plugins/session-cartographer/
  .claude-plugin/plugin.json    — Plugin metadata
  skills/carto/SKILL.md         — /carto skill (launches Explorer web app)
  skills/remember/SKILL.md     — /remember skill (CLI search)
  scripts/remember-search.sh   — Legacy keyword-only search (superseded by cartographer-search.sh)
  hooks/
    hooks.json                  — Hook registrations (8 hooks)
    log-research.sh             — WebFetch/WebSearch → research-log.jsonl + changelog.jsonl
    log-session-milestones.sh   — Compactions, session ends, agent stops
    log-tool-use.sh             — Edit/Write/Bash (opt-in: CARTOGRAPHER_LOG_TOOL_USE=true)
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

## Two Search Paths

1. **CLI** (`cartographer-search.sh`): bash + awk BM25. Used by `/carto` skill. No server needed.
2. **API** (`explorer/server/`): JS BM25 + Express. In-memory index, sub-millisecond queries. Used by the Explorer UI. Proxies Qdrant for semantic search.

Both use the same scoring algorithm (BM25 k1=1.2, b=0.75) and fusion strategy (RRF k=60).

## Testing

- `bash tests/private/run-tests.sh` — 11 tests against live data
- `bash tests/private/run-fixture-tests.sh` — 14 tests against synthetic fixtures
- `bash tests/private/benchmark.sh` — 8-query speed comparison (grep vs. cartographer)
- `bash tests/private/head-to-head.sh "query"` — side-by-side comparison for a single query
