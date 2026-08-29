#!/bin/bash
# log-knowledge-gap.sh — Log a phantom-entity miss as a knowledge_gap event.
#
# Called by cartographer-search.sh when a query returns zero results AND
# mentions entity-shaped tokens (file paths, event IDs, project filter) that
# the index has nothing on. Each gap becomes a future-capture target.
#
# Usage: log-knowledge-gap.sh --query "..." --entities "evt-abc,foo.js" [--project NAME]
#
# Output: knowledge-gaps.jsonl + changelog.jsonl envelope
# Environment: CARTOGRAPHER_DEV_DIR overrides ~/Documents/dev

DEV="${CARTOGRAPHER_DEV_DIR:-$HOME/Documents/dev}"
LOG_FILE="$DEV/knowledge-gaps.jsonl"
CHANGELOG="$DEV/changelog.jsonl"

QUERY=""
ENTITIES=""
PROJECT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --query)    QUERY="$2"; shift 2 ;;
    --entities) ENTITIES="$2"; shift 2 ;;
    --project)  PROJECT="$2"; shift 2 ;;
    *) shift ;;
  esac
done

[ -z "$QUERY" ] && exit 0
[ -z "$ENTITIES" ] && exit 0
command -v jq >/dev/null 2>&1 || exit 0
. "$(dirname "$0")/common.sh"

EVENT_ID="evt-$(LC_ALL=C tr -dc 'a-z0-9' < /dev/urandom | head -c 12)"
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
# CLAUDE_CODE_SESSION_ID is the variable Claude Code exports; CLAUDE_SESSION_ID
# is a legacy name it never sets. Reading only the legacy name is what left 86%
# of milestone records unattributed before 0.5.0.
CLAUDE_SID="${CLAUDE_SESSION_ID:-${CLAUDE_CODE_SESSION_ID:-}}"
SESSION_ID="${CARTOGRAPHER_SESSION_ID:-${CLAUDE_SID:-${CODEX_SESSION_ID:-}}}"
PROVIDER="${CARTOGRAPHER_PROVIDER:-unknown}"
[ "$PROVIDER" = "unknown" ] && [ -n "$CLAUDE_SID" ] && PROVIDER="claude"
CWD=$(pwd)

# Knowledge gaps carry mid-high salience — they are signals worth surfacing
# in future related queries (potential consumer hook for /focus, etc.).
SALIENCE="0.6"

SUMMARY="Knowledge gap: '$QUERY' returned no results; unknown: $ENTITIES"

jq -n -c \
  --arg eid "$EVENT_ID" \
  --arg ts "$TIMESTAMP" \
  --arg query "$QUERY" \
  --arg entities "$ENTITIES" \
  --arg project "$PROJECT" \
  --arg cwd "$CWD" \
  --arg session "$SESSION_ID" \
  --arg provider "$PROVIDER" \
  --argjson salience "$SALIENCE" \
  '{event_id: $eid, timestamp: $ts, type: "knowledge_gap", provider: $provider, query: $query, unknown_entities: ($entities | split(",")), project_filter: $project, cwd: $cwd, session: $session, salience: $salience}' \
  >> "$LOG_FILE"

CHANGELOG_EVENT=$(jq -n -c \
  --arg eid "$EVENT_ID" \
  --arg ts "$TIMESTAMP" \
  --arg session "$SESSION_ID" \
  --arg provider "$PROVIDER" \
  --arg project "$PROJECT" \
  --arg cwd "$CWD" \
  --arg summary "$SUMMARY" \
  --argjson salience "$SALIENCE" \
  '{event_id: $eid, timestamp: $ts, type: "knowledge_gap", provider: $provider, session_id: $session, project: $project, cwd: $cwd, summary: $summary, related_ids: [], salience: $salience}')
if [ -n "$CHANGELOG_EVENT" ]; then printf '%s\n' "$CHANGELOG_EVENT" >> "$CHANGELOG"; fi

# Real-time indexing (silent fail if services aren't running)
INDEXER=$(cartographer_script index-event.sh)
if [ -x "$INDEXER" ]; then
  [ -n "$CHANGELOG_EVENT" ] && printf '%s\n' "$CHANGELOG_EVENT" | "$INDEXER" &
fi

exit 0
