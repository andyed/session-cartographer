# Session Cartographer

Claude Code plugin for mapping and searching session history.

## Project Structure

```
plugins/session-cartographer/
  .claude-plugin/plugin.json    — Plugin metadata
  skills/remember/SKILL.md      — /remember skill definition
  scripts/remember-search.sh    — Search implementation (bash + jq)
  hooks/
    hooks.json                  — Hook registrations (PostToolUse, PreCompact, SessionEnd, SubagentStop)
    log-research.sh             — Logs WebFetch/WebSearch to research-log.jsonl + changelog.jsonl
    log-session-milestones.sh   — Logs compactions, session ends, agent stops
docs/
  CHANGELOG_SPEC.md             — Event log format specification
  energy-viz.html               — Project energy allocation dashboard
  landscape-survey.md           — Survey of Claude Code memory projects
```

## Key Design Decisions

- **Not a memory store.** Cartographer maps session territory — events, deep links, energy topology. It doesn't write facts into future sessions.
- **Event-centric.** Everything is a timestamped event with an ID and optional deep link. The changelog is the index.
- **Shell-native.** Search is bash + grep + jq. No Node/Python runtime required for core functionality.
- **Configurable paths.** `CARTOGRAPHER_DEV_DIR` and `CARTOGRAPHER_TRANSCRIPTS_DIR` env vars override defaults for different machine setups.

## Embedding Upgrade Path

Current search is keyword-based (grep). Planned: semantic search via Qdrant embeddings. The integration should be a service dependency (call existing embedding server), not imported code from interests2025 or any other project.

## Testing

No test infrastructure yet. Manual testing via `/remember` queries.
