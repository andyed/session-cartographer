#!/bin/bash
# SessionStart context: when Turbo is active, remind the agent that shared
# recall is cheap enough to use before guessing. This never runs a search.

command -v node >/dev/null 2>&1 || exit 0
command -v jq >/dev/null 2>&1 || exit 0

INPUT=$(cat)
SOURCE=$(printf '%s' "$INPUT" | jq -r '.source // empty' 2>/dev/null)
case "$SOURCE" in compact) exit 0 ;; esac

. "$(dirname "$0")/common.sh"
CONTROL=$(cartographer_script cartographer-turbo.js) || exit 0
RESOLVED=$(node "$CONTROL" resolve --json 2>/dev/null) || exit 0
ACTIVE=$(printf '%s' "$RESOLVED" | jq -r '.enabled // false' 2>/dev/null)
ACTIVATION_SOURCE="shared_config"

# Match the standard search wrapper's session-level override precedence. A
# session that explicitly bypasses Turbo should not be told that it is active.
if [ "${CARTOGRAPHER_TURBO+x}" = "x" ]; then
  ACTIVATION_SOURCE="environment"
  case "$CARTOGRAPHER_TURBO" in
    1|true|yes|on) ACTIVE="true" ;;
    0|false|no|off|'') ACTIVE="false" ;;
    *) exit 0 ;;
  esac
fi
case "${CARTOGRAPHER_SEARCH_BACKEND:-}" in
  explorer) ACTIVE="true"; ACTIVATION_SOURCE="backend_override" ;;
  cli) ACTIVE="false"; ACTIVATION_SOURCE="backend_override" ;;
  '') ;;
  *) exit 0 ;;
esac
[ "$ACTIVE" = "true" ] || exit 0

SESSION_ID=$(printf '%s' "$INPUT" | jq -r '.session_id // empty' 2>/dev/null)
TRANSCRIPT=$(printf '%s' "$INPUT" | jq -r '.transcript_path // empty' 2>/dev/null)
CWD=$(printf '%s' "$INPUT" | jq -r '.cwd // empty' 2>/dev/null)
PROVIDER=$(detect_provider "$INPUT")
PROJECT=""
[ -n "$CWD" ] && PROJECT=$(cartographer_project "$CWD")

# Record one exposure receipt per stable session key. The context itself may be
# reinjected on resume/clear so a restored session remains aware; repeated
# receipts would inflate the denominator used to evaluate downstream recall.
SESSION_KEY="$SESSION_ID"
[ -n "$SESSION_KEY" ] || SESSION_KEY="$TRANSCRIPT"
if [ -n "$SESSION_KEY" ]; then
  DEV="${CARTOGRAPHER_DEV_DIR:-$HOME/Documents/dev}"
  RECEIPTS="$DEV/.carto/turbo-awareness.jsonl"
  if mkdir -p "$(dirname "$RECEIPTS")" 2>/dev/null; then
    if ! jq -e --arg key "$SESSION_KEY" \
      'select((if (.session_id // "") != "" then .session_id else (.transcript_path // "") end) == $key)' \
      "$RECEIPTS" >/dev/null 2>&1; then
      jq -n -c \
        --arg ts "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" \
        --arg session "$SESSION_ID" \
        --arg transcript "$TRANSCRIPT" \
        --arg provider "$PROVIDER" \
        --arg source "$SOURCE" \
        --arg project "$PROJECT" \
        --arg cwd "$CWD" \
        --arg activation_source "$ACTIVATION_SOURCE" \
        '{timestamp:$ts,type:"turbo_awareness",shown:true,session_id:$session,transcript_path:$transcript,provider:$provider,source:$source,project:$project,cwd:$cwd,activation_source:$activation_source}' \
        >> "$RECEIPTS" 2>/dev/null || true
    fi
  fi
fi

CTX="[Session Cartographer · Turbo active]
Warm shared recall is available across Claude Code and Codex. When this task depends on prior decisions, fixes, research, or recent project state, use Session Cartographer's remember or focus skill before guessing. Skip recall for self-contained requests; do not run focus automatically."

jq -n --arg ctx "$CTX" \
  '{hookSpecificOutput:{hookEventName:"SessionStart",additionalContext:$ctx}}'

exit 0
