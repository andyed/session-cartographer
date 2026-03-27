# Custom Hooks

Session Cartographer ships with hooks for WebFetch, WebSearch, PreCompact, SessionEnd, and SubagentStop. But the most important events for your workflow might be different — code edits, test runs, deploys, PR merges.

You can log anything to the cartographer index. Any event written to `changelog.jsonl` in the envelope format is immediately searchable via `/remember` (keyword) and, if services are running, via semantic search.

## Writing a custom hook

A hook is a shell script that receives JSON on stdin from Claude Code. It extracts what it needs, writes a JSONL line, and exits 0.

### Minimal template

```bash
#!/usr/bin/env bash
# my-custom-hook.sh — PostToolUse hook for [your tool]

DEV="${CARTOGRAPHER_DEV_DIR:-$HOME/Documents/dev}"
CHANGELOG="$DEV/changelog.jsonl"
INPUT=$(cat)
EVENT_ID="evt-$(LC_ALL=C tr -dc 'a-z0-9' < /dev/urandom | head -c 12)"

TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty')
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty')
CWD=$(echo "$INPUT" | jq -r '.cwd // empty')
PROJECT=$(basename "$CWD")
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# Your logic here — extract what matters from the tool input/response
SUMMARY="Did something interesting"

# Write to changelog (the envelope format)
jq -n -c \
    --arg eid "$EVENT_ID" \
    --arg ts "$TIMESTAMP" \
    --arg type "custom_my_event" \
    --arg session "$SESSION_ID" \
    --arg project "$PROJECT" \
    --arg summary "$SUMMARY" \
    '{event_id: $eid, timestamp: $ts, type: $type, session_id: $session, project: $project, summary: $summary, related_ids: []}' \
    >> "$CHANGELOG"

# Real-time indexing (optional — silent fail if services aren't running)
INDEXER="$(dirname "$0")/path/to/scripts/index-event.sh"
if [ -x "$INDEXER" ]; then
  tail -1 "$CHANGELOG" | "$INDEXER" &
fi

exit 0
```

### Register in your Claude Code settings

Add the hook to `~/.claude/settings.json` (not the plugin's `hooks.json` — your custom hooks live in your personal settings):

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Edit",
        "command": "/path/to/my-custom-hook.sh",
        "async": true
      }
    ]
  }
}
```

## Examples

### Log file edits

Capture every Edit/Write with the file path and a summary:

```bash
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty')
[ "$TOOL_NAME" = "Edit" ] || [ "$TOOL_NAME" = "Write" ] || exit 0

FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')
SUMMARY="Modified: $FILE_PATH"
```

### Log bash commands

Capture commands run (useful for tracking deploys, test runs):

```bash
[ "$TOOL_NAME" = "Bash" ] || exit 0

COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty' | head -c 200)
SUMMARY="Ran: $COMMAND"
```

### Log user prompts (intent capture)

Use a `UserPromptSubmit` hook to capture what the user asked for:

```bash
# In hooks.json or settings.json:
# "event": "UserPromptSubmit"

PROMPT=$(echo "$INPUT" | jq -r '.prompt // empty' | head -c 200)
SUMMARY="User: $PROMPT"
TYPE="user_intent"
```

### Log git commits

Use a `PostToolUse` hook on Bash, filter for `git commit`:

```bash
[ "$TOOL_NAME" = "Bash" ] || exit 0
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')
echo "$COMMAND" | grep -q "git commit" || exit 0

SUMMARY="Committed: $(echo "$COMMAND" | grep -o -- '-m "[^"]*"' | head -1)"
```

## The envelope format

Every entry in `changelog.jsonl` must have these fields:

```json
{
  "event_id": "evt-abc123def456",
  "timestamp": "2026-03-26T12:00:00Z",
  "type": "your_event_type",
  "session_id": "uuid",
  "project": "project-name",
  "summary": "Human-readable description",
  "related_ids": []
}
```

Optional fields: `deeplink`, `url`, `transcript_path`, `description`, `prompt`, `query`. The search script's field fallback chain will find text in any of these.

## Tips

- **Use `async: true`** in hook registration. Hooks should never block the user.
- **Always `exit 0`**. A failing hook disrupts the session.
- **Keep summaries short** (under 200 chars). They're the primary search surface.
- **Use a descriptive `type` prefix** (e.g., `custom_deploy`, `custom_test_run`). This lets you filter by type in jq queries.
- **Pipe to `index-event.sh`** for real-time semantic search. Without it, keyword search still works immediately.
- **Don't log secrets.** Summaries end up in plaintext JSONL. Sanitize file paths and commands.
