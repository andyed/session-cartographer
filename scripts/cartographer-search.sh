#!/usr/bin/env bash
# cartographer-search.sh — Unified search across all Claude Code session history.
#
# Usage: cartographer-search.sh <query> [--project NAME] [--limit N]
#
# Searches (in order):
#   1. Qdrant semantic search (if available)
#   2. JSONL event logs (changelog, milestones, research) via grep+jq
#   3. Session transcripts via grep+jq
#
# Environment:
#   CARTOGRAPHER_DEV_DIR         — default: ~/Documents/dev
#   CARTOGRAPHER_TRANSCRIPTS_DIR — default: ~/.claude/projects
#   CARTOGRAPHER_QDRANT_URL      — default: http://localhost:6333
#   CARTOGRAPHER_EMBED_URL       — default: http://localhost:8890/v1/embeddings
#   CARTOGRAPHER_EMBED_MODEL     — default: mxbai-embed-large
#   CARTOGRAPHER_COLLECTION      — default: session-cartographer

set -o pipefail

QUERY="${1:?Usage: cartographer-search.sh \"<query>\" [--project NAME] [--limit N]}"
shift

LIMIT=15
PROJECT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --project)  PROJECT="$2"; shift 2 ;;
    --limit)    LIMIT="$2"; shift 2 ;;
    *) shift ;;
  esac
done

DEV="${CARTOGRAPHER_DEV_DIR:-$HOME/Documents/dev}"
TRANSCRIPTS="${CARTOGRAPHER_TRANSCRIPTS_DIR:-$HOME/.claude/projects}"
QDRANT="${CARTOGRAPHER_QDRANT_URL:-http://localhost:6333}"
EMBED_URL="${CARTOGRAPHER_EMBED_URL:-http://localhost:8890/v1/embeddings}"
EMBED_MODEL="${CARTOGRAPHER_EMBED_MODEL:-mxbai-embed-large}"
COLLECTION="${CARTOGRAPHER_COLLECTION:-session-cartographer}"

FOUND=0

# ─── Check for jq ───
if ! command -v jq &>/dev/null; then
  echo "ERROR: jq is required. Install with: brew install jq"
  exit 1
fi

# ─── 1. Semantic search (best results, needs services) ───
semantic_search() {
  # Quick health check — fail fast
  curl -sf "$QDRANT/collections/$COLLECTION" >/dev/null 2>&1 || return 1
  curl -sf "${EMBED_URL%/v1/embeddings}/health" >/dev/null 2>&1 || return 1

  # Get embedding
  local embed_response
  embed_response=$(curl -sf "$EMBED_URL" \
    -H "Content-Type: application/json" \
    -d "$(jq -n --arg m "$EMBED_MODEL" --arg q "Represent this sentence for retrieval: $QUERY" \
      '{model: $m, input: $q}')" 2>/dev/null) || return 1

  local vector
  vector=$(echo "$embed_response" | jq -c '.data[0].embedding // empty' 2>/dev/null)
  [ -z "$vector" ] && return 1

  # Build search body
  local search_body
  if [ -n "$PROJECT" ]; then
    search_body=$(jq -n --argjson v "$vector" --argjson l "$LIMIT" --arg p "$PROJECT" \
      '{vector: $v, limit: $l, with_payload: true, filter: {must: [{key: "project", match: {value: $p}}]}}')
  else
    search_body=$(jq -n --argjson v "$vector" --argjson l "$LIMIT" \
      '{vector: $v, limit: $l, with_payload: true}')
  fi

  local results
  results=$(curl -sf "$QDRANT/collections/$COLLECTION/points/search" \
    -H "Content-Type: application/json" \
    -d "$search_body" 2>/dev/null) || return 1

  local count
  count=$(echo "$results" | jq '.result | length' 2>/dev/null)
  [ "$count" = "0" ] || [ -z "$count" ] && return 1

  echo "=== Semantic search: $count results ==="
  echo ""
  echo "$results" | jq -r '.result[] |
    "[\(.payload.timestamp // "?")] [\(.payload.source // "?")] \(.payload.event_id // "no-id")  (score: \(.score | tostring | .[:5]))" +
    "\n  " + (.payload.summary // .payload.url // .payload.type // "?") +
    "\n  project: " + (.payload.project // "?") +
    (if .payload.url then "\n  url: " + .payload.url else "" end) +
    (if .payload.deeplink and .payload.deeplink != "" then "\n  deeplink: " + .payload.deeplink else "" end) +
    (if .payload.transcript_path and .payload.transcript_path != "" then "\n  transcript: " + .payload.transcript_path else "" end) +
    "\n"
  ' 2>/dev/null
  FOUND=1
  return 0
}

# ─── 2. Keyword search across JSONL logs ───
keyword_search() {
  local file="$1" label="$2"
  [ -f "$file" ] || return 0

  local matches
  matches=$(grep -i "$QUERY" "$file" 2>/dev/null) || true
  [ -z "$matches" ] && return 0

  # Apply project filter
  if [ -n "$PROJECT" ]; then
    matches=$(echo "$matches" | jq -c "select(.project // \"\" | test(\"$PROJECT\"; \"i\"))" 2>/dev/null) || true
    [ -z "$matches" ] && return 0
  fi

  local count
  count=$(echo "$matches" | wc -l | tr -d ' ')
  echo "--- $label ($count matches) ---"
  echo "$matches" | head -"$LIMIT" | jq -r --arg src "$label" '
    "[\(.timestamp // "?")] [\($src)] \(.event_id // .milestone // .type // "no-id")" +
    "\n  " + (.summary // .description // .prompt // .url // .query // "?") +
    "\n  project: " + (.project // "?") +
    (if .deeplink and .deeplink != "" and .deeplink != "none" then "\n  deeplink: " + .deeplink else "" end) +
    (if .transcript_path and .transcript_path != "" then "\n  transcript: " + .transcript_path else "" end) +
    "\n"
  ' 2>/dev/null || true
  FOUND=1
}

# ─── 3. Transcript search ───
transcript_search() {
  [ -d "$TRANSCRIPTS" ] || return 0

  local matched_files=0
  for transcript in "$TRANSCRIPTS"/*/*.jsonl; do
    [ -f "$transcript" ] || continue
    grep -qi "$QUERY" "$transcript" 2>/dev/null || continue

    local project_dir
    project_dir=$(basename "$(dirname "$transcript")")

    # Project filter
    if [ -n "$PROJECT" ]; then
      echo "$project_dir" | grep -qi "$PROJECT" || continue
    fi

    local session_file session_id
    session_file=$(basename "$transcript")
    session_id="${session_file%.jsonl}"

    if [ "$matched_files" -eq 0 ]; then
      echo "--- Transcripts ---"
    fi
    matched_files=$((matched_files + 1))

    jq -r --arg q "$QUERY" '
      select(.type == "user" or .type == "assistant") |
      select(.message.content | type == "string") |
      select(.message.content | test($q; "i")) |
      "[\(.timestamp // "?")] [transcript:\(.type)] \(.uuid // "?")" +
      "\n  " + (.message.content[:150] | gsub("\n"; " ")) +
      "\n  session: '"$session_id"'" +
      "\n  project: '"$project_dir"'" +
      "\n"
    ' "$transcript" 2>/dev/null | head -$((LIMIT * 3))
    FOUND=1

    # Stop after enough files
    [ "$matched_files" -ge 5 ] && break
  done
}

# ─── Run searches ───
echo "=== Searching for: \"$QUERY\" ==="
[ -n "$PROJECT" ] && echo "=== Project filter: $PROJECT ==="
echo ""

# Try semantic first (silent fail)
semantic_search 2>/dev/null

# Always run keyword search (catches things embeddings miss)
if [ "$FOUND" -eq 0 ]; then
  keyword_search "$DEV/changelog.jsonl" "changelog"
  keyword_search "$DEV/research-log.jsonl" "research"
  keyword_search "$DEV/session-milestones.jsonl" "milestones"
  transcript_search
fi

# ─── Cold start guidance ───
if [ "$FOUND" -eq 0 ]; then
  echo "No results found."
  echo ""

  # Check if logs exist at all
  local_logs=0
  [ -f "$DEV/changelog.jsonl" ] && local_logs=1
  [ -f "$DEV/research-log.jsonl" ] && local_logs=1
  [ -f "$DEV/session-milestones.jsonl" ] && local_logs=1

  if [ "$local_logs" -eq 0 ]; then
    echo "No event logs found in $DEV/"
    echo "Logs are created automatically by the session-cartographer hooks."
    echo "They'll start accumulating after your first WebFetch, WebSearch,"
    echo "compaction, or session end."
    echo ""
    echo "To search raw session transcripts now:"
    echo "  grep -r -i \"$QUERY\" $TRANSCRIPTS/ --include='*.jsonl' -l"
  else
    echo "Try broader keywords or check transcripts with --project filter."
  fi
fi

echo ""
echo "=== Done ==="
