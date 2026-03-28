# Event Log Specification

## Overview

A persistent, append-only JSONL event log that aggregates Claude Code session events with unique IDs. Enables programmatic navigation (deep links), cross-event queries, and dashboard integration.

## Event ID Format

All events use the format `evt-{12 alphanumeric}`:

```
evt-abc123def456
```

Generated in bash:
```bash
EVENT_ID="evt-$(LC_ALL=C tr -dc 'a-z0-9' < /dev/urandom | head -c 12)"
```

## Files

| File | Purpose | Written by |
|------|---------|------------|
| `~/Documents/dev/changelog.jsonl` | Unified index of all events | All hooks |
| `~/Documents/dev/session-milestones.jsonl` | Session lifecycle events | `log-session-milestones.sh` |
| `~/Documents/dev/research-log.jsonl` | WebFetch/WebSearch URLs | `log-research.sh` |

Paths are configurable via `CARTOGRAPHER_DEV_DIR` environment variable.

## Event Envelope Schema

Every entry in `changelog.jsonl`:

```json
{
  "event_id": "evt-abc123def456",
  "timestamp": "2026-03-22T12:00:00Z",
  "type": "milestone_compaction_auto | research_fetch | research_search",
  "session_id": "uuid",
  "project": "project-name",
  "deeplink": "claude-history://session/%2FUsers%2F...",
  "summary": "Human-readable one-liner",
  "related_ids": ["evt-previous"]
}
```

### Fields

| Field | Type | Description |
|-------|------|-------------|
| `event_id` | string | Unique `evt-*` identifier |
| `timestamp` | ISO 8601 | UTC timestamp |
| `type` | string | Event type (prefixed by source) |
| `session_id` | string | Claude Code session UUID |
| `project` | string | Project directory basename |
| `deeplink` | string | `claude-history://` URL to session transcript |
| `summary` | string | Short description for display |
| `related_ids` | string[] | IDs of related events for graph traversal |

### Event Types

Event types are dynamic — they depend on which hooks you enable and how you use Claude Code. The table below shows types produced by the default hooks. Custom hooks ([docs/CUSTOM_HOOKS.md](CUSTOM_HOOKS.md)) and backfill scripts add their own types.

| Type | Source | Trigger |
|------|--------|---------|
| `milestone_compaction_auto` | milestones hook | PreCompact (auto) |
| `milestone_compaction_manual` | milestones hook | PreCompact (manual) |
| `milestone_agent_Explore` | milestones hook | SubagentStop (Explore) |
| `milestone_agent_Plan` | milestones hook | SubagentStop (Plan) |
| `milestone_session_end_*` | milestones hook | SessionEnd |
| `research_fetch` | research hook | WebFetch |
| `research_search` | research hook | WebSearch |
| `tool_file_edit` | tool-use hook | Edit/Write (opt-in) |
| `tool_bash` | tool-use hook | Bash (opt-in) |
| `git_commit` | tool-use hook / backfill | Git commits |
| `git_push` | tool-use hook | Git pushes |
| `memory_*` | backfill-memories.sh | Claude Code memory files |

Discover your actual type distribution:
```bash
jq -r '.type' ~/Documents/dev/changelog.jsonl | sort | uniq -c | sort -rn
```

## Related IDs & Graph Traversal

Events link to each other via `related_ids`:

- **Search results** → parent search event: `["evt-parent-search"]`
- **Milestones** → empty by default: `[]`

This enables queries like "find all events related to this one":
```bash
jq 'select(.related_ids[]? == "evt-abc123")' changelog.jsonl
```

## Query Examples

```bash
# All events for a project
jq 'select(.project == "scrutinizer")' ~/Documents/dev/changelog.jsonl

# Get deep link for a specific event
jq 'select(.event_id == "evt-abc123") | .deeplink' ~/Documents/dev/changelog.jsonl

# Recent activity (last 20 events)
tail -20 ~/Documents/dev/changelog.jsonl | jq -r '"\(.timestamp) \(.type) \(.summary)"'

# Count events by type
jq -r '.type' ~/Documents/dev/changelog.jsonl | sort | uniq -c | sort -rn
```

## Integration Points

### claude-code-history-viewer
- `deeplink` field contains `claude-history://` URLs
- `event_id` can serve as anchor for scroll-to-message navigation

### Embedding / Semantic Search
- `summary` field embedded for semantic search via Qdrant
- `event_id` as vector store point ID for deduplication
- Qdrant collection `session-cartographer` (ports 6333/8890)
- Real-time indexing via `index-event.sh` called from hooks
