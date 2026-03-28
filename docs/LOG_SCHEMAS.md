# Log Schemas

Formal definitions for Session Cartographer's JSONL event formats. All logs are append-only, one JSON object per line.

Custom hooks should follow these schemas so events are searchable by both the CLI (BM25 awk) and Explorer (JS BM25 + Qdrant).

## Common Fields

Every event across all log types should include:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `event_id` | string | yes | Unique ID, format `evt-{12 alphanumeric}` |
| `timestamp` | ISO 8601 | yes | UTC timestamp |
| `type` | string | yes | Event type (see per-log tables below) |
| `project` | string | yes | Git repo basename or directory basename |
| `session_id` | string | recommended | Claude Code session UUID |
| `cwd` | string | optional | Working directory at event time |
| `transcript_path` | string | **required** | Path to session transcript JSONL — this is how search results link to full context |
| `summary` | string | recommended | Human-readable one-liner for display |

### Generating event IDs

```bash
EVENT_ID="evt-$(LC_ALL=C tr -dc 'a-z0-9' < /dev/urandom | head -c 12)"
```

### Resolving project name

```bash
GIT_REPO=$(cd "$CWD" 2>/dev/null && git rev-parse --show-toplevel 2>/dev/null)
PROJECT=$(basename "${GIT_REPO:-$CWD}")
```

## changelog.jsonl

Unified index — every event from every hook. This is the primary search surface.

| Field | Type | Description |
|-------|------|-------------|
| `event_id` | string | Unique event ID |
| `timestamp` | ISO 8601 | UTC |
| `type` | string | Event type (see table) |
| `session_id` | string | Session UUID |
| `project` | string | Project name |
| `cwd` | string | Working directory |
| `summary` | string | Display text |
| `deeplink` | string | `claude-history://` URL (optional) |
| `related_ids` | string[] | IDs of related events |

**Event types:**

| Type | Source hook |
|------|-----------|
| `research_fetch` | log-research.sh |
| `research_search` | log-research.sh |
| `milestone_compaction_auto` | log-session-milestones.sh |
| `milestone_compaction_manual` | log-session-milestones.sh |
| `milestone_session_end_*` | log-session-milestones.sh |
| `milestone_agent_Explore` | log-session-milestones.sh |
| `milestone_agent_Plan` | log-session-milestones.sh |
| `tool_file_edit` | log-tool-use.sh |
| `tool_bash` | log-tool-use.sh |
| `custom_*` | User-defined hooks |

## research-log.jsonl

WebFetch and WebSearch events with domain-specific detail.

### Auto-categorization

URLs are classified at capture time by `categorize_url()` in `log-research.sh`, so you don't need to classify at query time. Categories are assigned by domain pattern matching:

| Category | Domains |
|----------|---------|
| `research` | arxiv.org, pubmed, biorxiv.org, semanticscholar, springer.com/article, sciencedirect.com, jov.arvojournals |
| `docs` | github.com, docs.*, developer.*, mdn.*, readthedocs, deepwiki.com |
| `blog` | medium.com, dev.to, substack.com, *.blog, wordpress |
| `news` | news.*, sciencedaily, arstechnica, theverge, hackernews |
| `reference` | wikipedia.org, stackoverflow.com, stackexchange.com |
| `other` | Everything else |

To extend: add patterns to the `case` statement in `log-research.sh`. Categories are stored in the `category` field and are searchable via BM25.

### Fetch entry

| Field | Type | Description |
|-------|------|-------------|
| `event_id` | string | Same ID as changelog entry |
| `timestamp` | ISO 8601 | UTC |
| `type` | `"fetch"` | |
| `url` | string | URL that was fetched |
| `prompt` | string | The extraction prompt sent with the fetch |
| `category` | string | Auto-detected: `research`, `docs`, `blog`, `news`, `reference`, `other` |
| `project` | string | Project name |
| `session` | string | Session UUID |
| `transcript_path` | string | Path to transcript |

### Search entry

| Field | Type | Description |
|-------|------|-------------|
| `event_id` | string | |
| `timestamp` | ISO 8601 | |
| `type` | `"search"` | |
| `query` | string | The search query text |
| `project` | string | |
| `session` | string | |

### Search result entry

| Field | Type | Description |
|-------|------|-------------|
| `event_id` | string | |
| `timestamp` | ISO 8601 | |
| `type` | `"search_result"` | |
| `url` | string | Result URL |
| `title` | string | Page title (if available) |
| `query` | string | Parent search query |
| `category` | string | Auto-detected domain category |
| `related_ids` | string[] | `[parent_search_event_id]` |

## session-milestones.jsonl

Session lifecycle events with deep links.

| Field | Type | Description |
|-------|------|-------------|
| `event_id` | string | |
| `timestamp` | ISO 8601 | |
| `milestone` | string | `compaction_auto`, `compaction_manual`, `session_end_*`, `agent_Explore`, `agent_Plan` |
| `description` | string | Human-readable description |
| `session_id` | string | |
| `transcript_path` | string | |
| `deeplink` | string | `claude-history://session/{encoded_path}` |
| `project` | string | |
| `event` | string | Hook trigger: `PreCompact`, `SessionEnd`, `SubagentStop` |

## tool-use-log.jsonl

File edits and bash commands. Opt-in via `CARTOGRAPHER_LOG_TOOL_USE=true`.

| Field | Type | Description |
|-------|------|-------------|
| `event_id` | string | |
| `timestamp` | ISO 8601 | |
| `type` | string | `tool_file_edit` or `tool_bash` |
| `tool` | string | `Edit`, `Write`, or `Bash` |
| `summary` | string | `Modified: /path/to/file` or `Ran: command` |
| `project` | string | |
| `cwd` | string | |
| `session` | string | |
| `transcript_path` | string | |

## ~/.claude/history.jsonl

Claude Code's own session history. Not written by Cartographer hooks — read-only.

| Field | Type | Description |
|-------|------|-------------|
| `display` | string | Human-readable event description |
| `timestamp` | number | Unix ms timestamp (not ISO 8601) |
| `type` | string | (varies) |
| `session_id` | string | (when present) |

**Note:** This file uses `display` instead of `summary`, and numeric timestamps instead of ISO 8601. The Explorer's BM25 extractor handles both.

## Cross-schema consistency

These fields must be consistent across all log types for the pipeline to work end-to-end:

| Field | Why it matters | Failure mode if missing |
|-------|---------------|----------------------|
| `event_id` | Dedup across changelog + domain logs | Same event appears twice in results |
| `transcript_path` | Search result → full conversation context | Agent finds event but can't read the transcript |
| `project` | Project filter, EventCard badges, energy viz | Event is unsearchable by project, invisible in filtered views |
| `timestamp` | Timeline ordering, "N ago" display | Event has no temporal context |

The `transcript_path` gap was the most impactful bug: changelog entries were missing it, so search results had no link to the raw conversation. All hooks now write `transcript_path` to both domain logs AND changelog.

## Searchable fields

BM25 and the Explorer extract display text using this fallback chain:

```
prompt → query → summary → description → display → title → url → event_id → milestone
```

When writing custom hooks, put the most human-useful text in `summary`. If your event has a URL, also include it — BM25 tokenizes URL paths so `arxiv.org` is searchable.

## Adding a custom event type

1. Pick a type name with a `custom_` prefix (e.g., `custom_deploy`, `custom_test_run`)
2. Write to `changelog.jsonl` using the common fields schema
3. Optionally write to a domain-specific log for richer fields
4. Pipe the changelog entry to `index-event.sh` for real-time Qdrant indexing

See [CUSTOM_HOOKS.md](CUSTOM_HOOKS.md) for full examples.
