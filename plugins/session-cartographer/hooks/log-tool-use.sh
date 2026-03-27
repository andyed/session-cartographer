#!/bin/bash
# PostToolUse hook: logs file modifications and bash commands.
# Captures the code generation events that research/milestones hooks miss.
#
# Logs:
#   Edit/Write → file path modified
#   Bash       → command run (truncated to 200 chars)
#
# Gated by CARTOGRAPHER_LOG_TOOL_USE=true (opt-in to avoid noise).
# Output: tool-use-log.jsonl + changelog.jsonl
# Environment: CARTOGRAPHER_DEV_DIR overrides ~/Documents/dev

# Opt-in gate — set CARTOGRAPHER_LOG_TOOL_USE=true to enable
[ "${CARTOGRAPHER_LOG_TOOL_USE:-false}" = "true" ] || exit 0

DEV="${CARTOGRAPHER_DEV_DIR:-$HOME/Documents/dev}"
LOG_FILE="$DEV/tool-use-log.jsonl"
CHANGELOG="$DEV/changelog.jsonl"
INPUT=$(cat)
EVENT_ID="evt-$(LC_ALL=C tr -dc 'a-z0-9' < /dev/urandom | head -c 12)"

TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty')
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty')
TRANSCRIPT=$(echo "$INPUT" | jq -r '.transcript_path // empty')
CWD=$(echo "$INPUT" | jq -r '.cwd // empty')
PROJECT=$(basename "$CWD")
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

case "$TOOL_NAME" in
  Edit|Write)
    FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')
    [ -z "$FILE_PATH" ] && exit 0
    # Skip noisy paths (node_modules, .git, lock files)
    case "$FILE_PATH" in
      */node_modules/*|*/.git/*|*/package-lock.json|*/yarn.lock|*/pnpm-lock.yaml) exit 0 ;;
    esac
    FILENAME=$(basename "$FILE_PATH")
    SUMMARY="Modified: $FILE_PATH"
    TYPE="tool_file_edit"
    ;;
  Bash)
    COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty' | head -c 200)
    [ -z "$COMMAND" ] && exit 0
    # Skip noisy commands (ls, cat, echo, pwd)
    case "$COMMAND" in
      ls*|cat\ *|echo\ *|pwd|cd\ *|which\ *) exit 0 ;;
    esac
    SUMMARY="Ran: $COMMAND"
    TYPE="tool_bash"
    ;;
  *)
    exit 0
    ;;
esac

# Write to tool-use log
jq -n -c \
    --arg eid "$EVENT_ID" \
    --arg ts "$TIMESTAMP" \
    --arg type "$TYPE" \
    --arg tool "$TOOL_NAME" \
    --arg summary "$SUMMARY" \
    --arg project "$PROJECT" \
    --arg session "$SESSION_ID" \
    --arg transcript "$TRANSCRIPT" \
    '{event_id: $eid, timestamp: $ts, type: $type, tool: $tool, summary: $summary, project: $project, session: $session, transcript_path: $transcript}' \
    >> "$LOG_FILE"

# Write to unified changelog
jq -n -c \
    --arg eid "$EVENT_ID" \
    --arg ts "$TIMESTAMP" \
    --arg type "$TYPE" \
    --arg session "$SESSION_ID" \
    --arg project "$PROJECT" \
    --arg summary "$SUMMARY" \
    '{event_id: $eid, timestamp: $ts, type: $type, session_id: $session, project: $project, summary: $summary, related_ids: []}' \
    >> "$CHANGELOG"

# Real-time indexing (silent fail if services aren't running)
INDEXER="$(dirname "$0")/../../../scripts/index-event.sh"
if [ -x "$INDEXER" ]; then
  tail -1 "$CHANGELOG" | "$INDEXER" &
fi

exit 0
