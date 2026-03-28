# Permalink Specification

How Session Cartographer references Claude Code session history. One scheme, multiple viewers.

## The problem

Claude Code stores conversation transcripts as JSONL files at `~/.claude/projects/{project-hash}/{session-id}.jsonl`. These paths are:
- Machine-specific (absolute paths)
- Opaque (the project hash isn't human-readable)
- Ephemeral (Claude Code deletes transcripts after 30 days by default)

Cartographer needs a stable way to point into session history that works across viewers (Explorer, claude-code-history-viewer, CLI), survives across sessions, and is embeddable in search results.

## URI scheme

```
claude-history://session/{url-encoded-transcript-path}[?uuid={message-uuid}][&highlight={term}]
```

### Components

| Part | Example | Description |
|------|---------|-------------|
| Scheme | `claude-history://` | Protocol identifier |
| Authority | `session` | Resource type (only `session` defined today) |
| Path | `%2FUsers%2Fandyed%2F.claude%2Fprojects%2F...%2Fabc123.jsonl` | URL-encoded absolute path to transcript JSONL |
| `uuid` | `?uuid=7013bf4d-607a-...` | Jump to a specific message in the transcript |
| `highlight` | `&highlight=shader` | Highlight a search term in the viewer |

### Constructing a permalink

In bash (used by hooks):
```bash
ENCODED_PATH=$(echo "$TRANSCRIPT" | python3 -c \
  "import sys, urllib.parse; print(urllib.parse.quote(sys.stdin.read().strip(), safe=''))")
DEEPLINK="claude-history://session/${ENCODED_PATH}"
```

In JavaScript (used by Explorer):
```js
const deeplink = `claude-history://session/${encodeURIComponent(transcriptPath)}`;
```

### Resolving a permalink

The `claude-history://` scheme is not a registered protocol handler. It's resolved by the configured viewer:

| Viewer | Resolution |
|--------|-----------|
| **Explorer** (`:2527`) | `http://localhost:2527/session/{encoded-path}?uuid=...&highlight=...` |
| **claude-code-history-viewer** | Native `claude-history://` protocol handler (if registered) |
| **CLI** | `jq 'select(.uuid == "...")' {decoded-path}` |

### `CARTOGRAPHER_VIEWER_PREFIX`

Controls which viewer resolves `claude-history://` links:

```bash
# Explorer (default when running)
CARTOGRAPHER_VIEWER_PREFIX="http://localhost:2527/session/"

# claude-code-history-viewer
CARTOGRAPHER_VIEWER_PREFIX="claude-history://session/"
```

When `/carto` outputs a search result, the deeplink uses this prefix:
```
transcript: /Users/andyed/.claude/projects/.../abc123.jsonl
deeplink: http://localhost:2527/session/%2FUsers%2Fandyed%2F...
```

## Where permalinks appear

| Location | Format | Example |
|----------|--------|---------|
| `session-milestones.jsonl` | `deeplink` field | `claude-history://session/%2F...` |
| `/carto` CLI output | Footer link | `deeplink: http://localhost:2527/session/...` |
| Explorer event cards | Clickable link | Opens transcript viewer inline |
| Explorer URL bar | Shareable URL | `http://localhost:2527/session/%2F...?highlight=shader` |

## Event permalinks

Individual events are referenced by `event_id` (e.g., `evt-7qd3nbd8bmvq`). These are stable across log files (same event_id in changelog and research-log). To link to a specific event in the Explorer:

```
http://localhost:2527/?q=evt-7qd3nbd8bmvq
```

This searches by event ID and shows the matching event with its transcript link.

## Stability guarantees

| What | Stable? | Notes |
|------|---------|-------|
| `event_id` | Yes | Generated once, never changes |
| Transcript path | No | Moves if home directory changes, deleted after retention period |
| `claude-history://` URI | Yes | Path-encoded, resolvable if file exists |
| Explorer URL | No | Only works while Explorer is running on that port |
| `uuid` (message ID) | Yes | Assigned by Claude Code, immutable within transcript |

The most durable reference is `event_id` + `transcript_path`. If the transcript still exists, the event can be resolved. If it's been deleted, the event metadata in the JSONL logs survives.

## Roadmap: Fragment references

Full hypertext support — agents could emit anchors that link into specific moments:

```
claude-history://session/{path}#evt-7qd3nbd8bmvq
claude-history://session/{path}#uuid-abc123
claude-history://session/{path}#t=2026-03-27T14:30:00Z
```

Fragment types:
- `#evt-{id}` — scroll to the event that produced this log entry
- `#uuid-{id}` — scroll to a specific message in the transcript
- `#t={iso8601}` — scroll to a timestamp

This would enable agents to write structured references into their output:
```
Based on the approach we chose in [session from March 13](claude-history://session/...#uuid-d6cdedd2):
the DoG sigma should be computed in degrees, not pixels.
```

The Explorer would resolve fragments by scrolling the transcript viewer to the referenced point. External viewers could do the same via the protocol handler.

**Not implemented yet.** The URI scheme supports it syntactically — the fragment just needs viewer-side resolution.
