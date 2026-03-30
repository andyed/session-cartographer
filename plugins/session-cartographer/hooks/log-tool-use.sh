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
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

GIT_REPO=$(cd "$CWD" 2>/dev/null && git rev-parse --show-toplevel 2>/dev/null)
if [ -n "$GIT_REPO" ]; then
    PROJECT=$(basename "$GIT_REPO")
else
    PROJECT=$(basename "$CWD")
fi

case "$TOOL_NAME" in
  Edit|Write)
    FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')
    [ -z "$FILE_PATH" ] && exit 0
    # Refine project via file path's git repo
    FILE_REPO=$(cd "$(dirname "$FILE_PATH")" 2>/dev/null && git rev-parse --show-toplevel 2>/dev/null)
    [ -n "$FILE_REPO" ] && PROJECT=$(basename "$FILE_REPO")
    
    # Skip noisy paths (node_modules, .git, lock files)
    case "$FILE_PATH" in
      */node_modules/*|*/.git/*|*/package-lock.json|*/yarn.lock|*/pnpm-lock.yaml) exit 0 ;;
    esac
    FILENAME=$(basename "$FILE_PATH")
    SUMMARY="Modified: $FILE_PATH"
    TYPE="tool_file_edit"
    ;;
  Bash)
    COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty' | head -c 500)
    [ -z "$COMMAND" ] && exit 0
    # Skip noisy commands (ls, cat, echo, pwd)
    case "$COMMAND" in
      ls*|cat\ *|echo\ *|pwd|cd\ *|which\ *|wc\ *|head\ *|tail\ *) exit 0 ;;
    esac

    # Detect git commit — extract commit hash, message, and changed files
    if echo "$COMMAND" | grep -q "git commit"; then
      # Parse the commit output from tool_response
      RESPONSE=$(echo "$INPUT" | jq -r '.tool_response // empty' | head -c 2000)
      COMMIT_HASH=$(echo "$RESPONSE" | grep -oE '[a-f0-9]{7,}' | head -1)
      COMMIT_MSG=$(echo "$RESPONSE" | grep -oE '\] .+' | head -1 | sed 's/^\] //')

      # Get changed files from the commit if we can
      CHANGED_FILES=""
      if [ -n "$COMMIT_HASH" ] && [ -n "$GIT_REPO" ]; then
        CHANGED_FILES=$(cd "$GIT_REPO" && git diff-tree --no-commit-id --name-only -r "$COMMIT_HASH" 2>/dev/null | head -20 | tr '\n' ', ' | sed 's/,$//')
      fi

      # Extract diff shape metadata (Tier 3)
      DIFF_SHAPE=""
      if [ -n "$COMMIT_HASH" ] && [ -n "$GIT_REPO" ]; then
        DIFF_SHAPE=$(bash "$(dirname "$0")/../../../scripts/diff-shape.sh" "$COMMIT_HASH" "$GIT_REPO" 2>/dev/null || echo "")
      fi

      if [ -n "$COMMIT_HASH" ]; then
        # Classify commit from conventional-commit prefix or keywords
        COMMIT_TYPE="other"
        case "$COMMIT_MSG" in
          feat:*|feat\(*) COMMIT_TYPE="feature" ;;
          fix:*|fix\(*|bugfix:*) COMMIT_TYPE="fix" ;;
          refactor:*|refactor\(*) COMMIT_TYPE="refactor" ;;
          docs:*|docs\(*) COMMIT_TYPE="docs" ;;
          test:*|test\(*|tests:*) COMMIT_TYPE="test" ;;
          chore:*|chore\(*) COMMIT_TYPE="chore" ;;
          ci:*|ci\(*) COMMIT_TYPE="ci" ;;
          style:*|style\(*) COMMIT_TYPE="style" ;;
          perf:*|perf\(*) COMMIT_TYPE="perf" ;;
          build:*|build\(*) COMMIT_TYPE="build" ;;
          revert:*|revert\(*) COMMIT_TYPE="revert" ;;
          *[Aa]dd*|*[Ii]mplement*|*[Cc]reate*) COMMIT_TYPE="feature" ;;
          *[Ff]ix*|*[Rr]esolve*|*[Pp]atch*) COMMIT_TYPE="fix" ;;
          *[Rr]efactor*|*[Cc]lean*|*[Ss]implif*) COMMIT_TYPE="refactor" ;;
          *[Uu]pdate*|*[Ee]nhance*|*[Ii]mprov*) COMMIT_TYPE="enhancement" ;;
        esac

        SUMMARY="[${COMMIT_TYPE}] Commit ${COMMIT_HASH}: ${COMMIT_MSG}"
        [ -n "$CHANGED_FILES" ] && SUMMARY="${SUMMARY} | files: ${CHANGED_FILES}"
        TYPE="git_commit"

        # Build GitHub commit URL from remote
        COMMIT_URL=""
        if [ -n "$GIT_REPO" ]; then
          GITHUB_BASE=$(cd "$GIT_REPO" && git remote get-url origin 2>/dev/null | sed 's/\.git$//' | sed 's|git@github.com:|https://github.com/|')
          [ -n "$GITHUB_BASE" ] && COMMIT_URL="${GITHUB_BASE}/commit/${COMMIT_HASH}"
        fi
      else
        SUMMARY="Ran: $COMMAND"
        TYPE="tool_bash"
      fi
    # Detect git push
    elif echo "$COMMAND" | grep -q "git push"; then
      SUMMARY="Pushed: $COMMAND"
      TYPE="git_push"
    else
      SUMMARY="Ran: $(echo "$COMMAND" | head -c 200)"
      TYPE="tool_bash"
    fi
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
    --arg cwd "$CWD" \
    --arg session "$SESSION_ID" \
    --arg transcript "$TRANSCRIPT" \
    --arg commit_type "${COMMIT_TYPE:-}" \
    --arg commit_url "${COMMIT_URL:-}" \
    --argjson diff_shape "${DIFF_SHAPE:-null}" \
    '{event_id: $eid, timestamp: $ts, type: $type, tool: $tool, summary: $summary, project: $project, cwd: $cwd, session: $session, transcript_path: $transcript, diff_shape: $diff_shape}
     + if $commit_type != "" then {commit_type: $commit_type} else {} end
     + if $commit_url != "" then {commit_url: $commit_url} else {} end' \
    >> "$LOG_FILE"

# Write to unified changelog
jq -n -c \
    --arg eid "$EVENT_ID" \
    --arg ts "$TIMESTAMP" \
    --arg type "$TYPE" \
    --arg session "$SESSION_ID" \
    --arg project "$PROJECT" \
    --arg cwd "$CWD" \
    --arg summary "$SUMMARY" \
    --arg transcript "$TRANSCRIPT" \
    --arg commit_type "${COMMIT_TYPE:-}" \
    --argjson diff_shape "${DIFF_SHAPE:-null}" \
    '{event_id: $eid, timestamp: $ts, type: $type, session_id: $session, project: $project, cwd: $cwd, summary: $summary, transcript_path: $transcript, diff_shape: $diff_shape, related_ids: []}
     + if $commit_type != "" then {commit_type: $commit_type} else {} end' \
    >> "$CHANGELOG"

# Real-time indexing (silent fail if services aren't running)
INDEXER="$(dirname "$0")/../../../scripts/index-event.sh"
if [ -x "$INDEXER" ]; then
  tail -1 "$CHANGELOG" | "$INDEXER" &
fi

exit 0
