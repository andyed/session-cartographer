# Session Cartographer

Claude Code plugin for mapping and searching session history.

## Project Structure

```
scripts/
  cartographer-search.sh        — Unified search: semantic → keyword+awk RRF → transcripts
  embed-events.js               — Index JSONL events into Qdrant
  semantic-search.js             — Query Qdrant by vector similarity
plugins/session-cartographer/
  .claude-plugin/plugin.json    — Plugin metadata
  skills/remember/SKILL.md      — /remember skill definition
  scripts/remember-search.sh    — Legacy keyword-only search (superseded by cartographer-search.sh)
  hooks/
    hooks.json                  — Hook registrations (PostToolUse, PreCompact, SessionEnd, SubagentStop)
    log-research.sh             — Logs WebFetch/WebSearch to research-log.jsonl + changelog.jsonl
    log-session-milestones.sh   — Logs compactions, session ends, agent stops
docs/
  CHANGELOG_SPEC.md             — Event log format specification
  RANK_FUSION.md                — How awk-based RRF scoring works
  SETUP.md                      — Work machine setup guide
  energy-viz.html               — Project energy allocation dashboard
  landscape-survey.md           — Survey of 30+ Claude Code memory projects
tests/private/                  — gitignored test cases and fixtures
```

## Key Design Decisions

- **Not a memory store.** Cartographer maps session territory — events, deep links, energy topology. It doesn't write facts into future sessions.
- **Event-centric.** Everything is a timestamped event with an ID and optional deep link. The changelog is the index.
- **Shell-native.** Core search is bash + grep + awk. No Node/Python runtime required for keyword search.
- **Configurable paths.** `CARTOGRAPHER_DEV_DIR` and `CARTOGRAPHER_TRANSCRIPTS_DIR` env vars override defaults for different machine setups.

## Implementation Constraints — READ THESE

- **Rank fusion is intentionally implemented in awk** for zero-dependency operation. Do not port to Node or Python. The awk pipeline (grep → field extraction → RRF scoring → dedup → sort) runs without jq for the keyword path. jq is only required for semantic search (Qdrant API calls).
- **Field extraction uses awk `extract()` with a fallback chain** (`summary → description → prompt → url → query`) to handle diverse JSONL schemas across log types. Do not hardcode a single field name.
- **Transcripts participate in rank fusion as equal citizens.** They emit the same TSV intermediate format as JSONL sources and compete in RRF scoring. Do not append them at the bottom.
- **`LC_ALL=C` on grep and awk calls** prevents multibyte conversion errors on unicode/emoji in JSONL content.

## Semantic Search

Embedding layer uses Qdrant + llama.cpp (mxbai-embed-large-v1, 1024-dim). Configurable via env vars. Falls back gracefully to keyword search when services aren't running. The embedding infra is a service dependency — no code imported from interests2025 or any other project.

## Testing

Private test cases in `tests/private/` (gitignored). Run: `bash tests/private/run-tests.sh`
11 tests covering context recovery, research retrieval, cross-project search, cold start, and edge cases.
