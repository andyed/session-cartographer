#!/usr/bin/env bash
# remember-search.sh — Search conversation history via logs and transcripts.
# Usage: remember-search.sh <query> [--max-results N] [--project NAME] [--transcripts]
#
# Searches across:
#   1. changelog.jsonl (unified event index with event IDs)
#   2. session-milestones.jsonl (session lifecycle with deep links)
#   3. research-log.jsonl (WebFetch/WebSearch URLs)
#   4. Transcript JSONL files (actual conversation content, with --transcripts)
#
# Returns matching events with event_id, deeplink, timestamp, and context excerpt.
#
# Environment variables for custom paths:
#   CARTOGRAPHER_DEV_DIR — default: ~/Documents/dev
#   CARTOGRAPHER_TRANSCRIPTS_DIR — default: ~/.claude/projects

QUERY="${1:?Usage: remember-search.sh <query> [--max-results N] [--project NAME] [--transcripts]}"
shift

# Defaults
MAX_RESULTS=10
PROJECT_FILTER=""
SEARCH_TRANSCRIPTS=false

# Parse options
while [ $# -gt 0 ]; do
  case "$1" in
    --max-results) MAX_RESULTS="$2"; shift 2 ;;
    --project)  PROJECT_FILTER="$2"; shift 2 ;;
    --transcripts) SEARCH_TRANSCRIPTS=true; shift ;;
    *) shift ;;
  esac
done

DEV="${CARTOGRAPHER_DEV_DIR:-$HOME/Documents/dev}"
CHANGELOG="$DEV/changelog.jsonl"
MILESTONES="$DEV/session-milestones.jsonl"
RESEARCH="$DEV/research-log.jsonl"
TRANSCRIPTS_DIR="${CARTOGRAPHER_TRANSCRIPTS_DIR:-$HOME/.claude/projects}"

echo "=== Searching for: $QUERY ==="
[ -n "$PROJECT_FILTER" ] && echo "=== Project filter: $PROJECT_FILTER ==="
echo ""

# Search a JSONL file, format results
search_jsonl() {
  local file="$1"
  local label="$2"
  [ -f "$file" ] || return 0

  local matches
  matches=$(grep -i "$QUERY" "$file" 2>/dev/null || true)
  [ -z "$matches" ] && return 0

  # Apply project filter if set
  if [ -n "$PROJECT_FILTER" ]; then
    matches=$(echo "$matches" | jq -c "select(.project // \"\" | test(\"$PROJECT_FILTER\"; \"i\"))" 2>/dev/null || true)
    [ -z "$matches" ] && return 0
  fi

  echo "$matches" | head -"$MAX_RESULTS" | jq -r --arg src "$label" '
    "[\(.timestamp // "?")] [\($src)] \(.event_id // .milestone // .type // "no-id")" +
    "\n  " + (.summary // .description // .prompt // .url // .query // "?") +
    "\n  project: " + (.project // "?") +
    (if .deeplink and .deeplink != "" and .deeplink != "none" then "\n  deeplink: " + .deeplink else "" end) +
    (if .transcript_path and .transcript_path != "" then "\n  transcript: " + .transcript_path else "" end) +
    "\n"
  ' 2>/dev/null || true
}

echo "--- Changelog ---"
search_jsonl "$CHANGELOG" "changelog"

echo "--- Milestones ---"
search_jsonl "$MILESTONES" "milestone"

echo "--- Research Log ---"
search_jsonl "$RESEARCH" "research"

# Search transcripts (heavier — only with flag or if few results above)
if [ "$SEARCH_TRANSCRIPTS" = true ]; then
  echo "--- Transcripts ---"
  for transcript in "$TRANSCRIPTS_DIR"/*/*.jsonl; do
    [ -f "$transcript" ] || continue

    # Quick grep — skip non-matching files
    grep -qi "$QUERY" "$transcript" 2>/dev/null || continue

    session_file=$(basename "$transcript")
    session_id="${session_file%.jsonl}"
    project_dir=$(basename "$(dirname "$transcript")")

    # Apply project filter
    if [ -n "$PROJECT_FILTER" ]; then
      echo "$project_dir" | grep -qi "$PROJECT_FILTER" || continue
    fi

    # Extract matching user/assistant messages
    jq -r --arg q "$QUERY" '
      select(.type == "user" or .type == "assistant") |
      select(.message.content | type == "string") |
      select(.message.content | test($q; "i")) |
      "[\(.timestamp // "?")] [transcript:\(.type)] \(.uuid // "?")" +
      "\n  " + (.message.content[:150] | gsub("\n"; " ")) +
      "\n  session: '"$session_id"'" +
      "\n  project: '"$project_dir"'" +
      "\n"
    ' "$transcript" 2>/dev/null | head -$((MAX_RESULTS * 5))
  done
fi

echo "=== Done ==="
