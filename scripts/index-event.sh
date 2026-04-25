#!/usr/bin/env bash
# index-event.sh — Index a single event into Qdrant in real-time.
# Called by hooks after writing to JSONL. Fails silently if services aren't running.
#
# Usage: echo '{"event_id":"...","summary":"..."}' | index-event.sh
# Or:    index-event.sh --event-id EVT --text "summary text" --project NAME --timestamp TS
#
# Environment:
#   CARTOGRAPHER_EMBED_URL   — default: http://localhost:8890/v1/embeddings
#   CARTOGRAPHER_EMBED_MODEL — default: mxbai-embed-large
#   CARTOGRAPHER_QDRANT_URL  — default: http://localhost:6333
#   CARTOGRAPHER_COLLECTION  — default: session-cartographer

EMBED_URL="${CARTOGRAPHER_EMBED_URL:-http://localhost:8890/v1/embeddings}"
EMBED_MODEL="${CARTOGRAPHER_EMBED_MODEL:-mxbai-embed-large}"
QDRANT_URL="${CARTOGRAPHER_QDRANT_URL:-http://localhost:6333}"
COLLECTION="${CARTOGRAPHER_COLLECTION:-session-cartographer}"

# Parse args or read from stdin
EVENT_ID=""
TEXT=""
PROJECT=""
TIMESTAMP=""
SOURCE=""

if [ "$1" = "--event-id" ]; then
  # Arg mode
  while [ $# -gt 0 ]; do
    case "$1" in
      --event-id)  EVENT_ID="$2"; shift 2 ;;
      --text)      TEXT="$2"; shift 2 ;;
      --project)   PROJECT="$2"; shift 2 ;;
      --timestamp) TIMESTAMP="$2"; shift 2 ;;
      --source)    SOURCE="$2"; shift 2 ;;
      *) shift ;;
    esac
  done
else
  # Stdin mode — read JSON, extract fields
  INPUT=$(cat)
  command -v jq &>/dev/null || exit 0
  EVENT_ID=$(echo "$INPUT" | jq -r '.event_id // empty')
  TEXT=$(echo "$INPUT" | jq -r '(.summary // .description // .prompt // .url // .query // "") + " | project: " + (.project // "")')
  PROJECT=$(echo "$INPUT" | jq -r '.project // empty')
  CWD=$(echo "$INPUT" | jq -r '.cwd // empty')
  TIMESTAMP=$(echo "$INPUT" | jq -r '.timestamp // empty')
  SOURCE=$(echo "$INPUT" | jq -r '.type // empty')
  SESSION=$(echo "$INPUT" | jq -r '(.session // .session_id // empty)')
  SALIENCE=$(echo "$INPUT" | jq -r '(.salience // 0.5)')
  PARENT_EVENT_ID=$(echo "$INPUT" | jq -r '.parent_event_id // empty')
fi

[ -z "$EVENT_ID" ] || [ -z "$TEXT" ] && exit 0

# Quick health check — fail fast, fail silent
curl -sf "$QDRANT_URL/collections/$COLLECTION" >/dev/null 2>&1 || exit 0
curl -sf "${EMBED_URL%/v1/embeddings}/health" >/dev/null 2>&1 || exit 0

# Get embedding
EMBED_RESPONSE=$(curl -sf "$EMBED_URL" \
  -H "Content-Type: application/json" \
  -d "{\"model\":\"$EMBED_MODEL\",\"input\":\"$TEXT\"}" 2>/dev/null) || exit 0

# Extract vector — need jq for this
command -v jq &>/dev/null || exit 0
VECTOR=$(echo "$EMBED_RESPONSE" | jq -c '.data[0].embedding // empty' 2>/dev/null)
[ -z "$VECTOR" ] && exit 0

# Hash event_id to numeric point ID (same as embed-events.js)
POINT_ID=$(echo -n "$EVENT_ID" | cksum | awk '{print $1}')

# Prediction error gate: skip if too similar to an existing entry
PE_GATE_REJECT="${PE_GATE_REJECT:-0.85}"
SEARCH_RESULT=$(curl -sf "$QDRANT_URL/collections/$COLLECTION/points/search" \
  -H "Content-Type: application/json" \
  -X POST \
  -d "{\"vector\":$VECTOR,\"limit\":1,\"with_payload\":false}" 2>/dev/null)

if [ -n "$SEARCH_RESULT" ]; then
  TOP_SCORE=$(echo "$SEARCH_RESULT" | jq -r '.result[0].score // 0' 2>/dev/null)
  # Compare using awk since bash can't do float comparison
  GATE=$(echo "$TOP_SCORE $PE_GATE_REJECT" | awk '{print ($1 > $2) ? "reject" : "accept"}')
  if [ "$GATE" = "reject" ]; then
    exit 0
  fi
fi

# Upsert to Qdrant safely building the JSON with jq to avoid quote injection.
# Salience and parent_event_id are read by cartographer-search.sh's semantic
# TSV emitter (and by --thread traversal) to weight ranking and walk arcs.
PAYLOAD=$(jq -n -c \
  --arg id "$POINT_ID" \
  --argjson vec "$VECTOR" \
  --arg eid "$EVENT_ID" \
  --arg src "$SOURCE" \
  --arg ts "$TIMESTAMP" \
  --arg proj "$PROJECT" \
  --arg cwd "$CWD" \
  --arg summ "$TEXT" \
  --arg sess "$SESSION" \
  --argjson salience "${SALIENCE:-0.5}" \
  --arg parent_id "${PARENT_EVENT_ID:-}" \
  '{points: [{id: ($id | tonumber), vector: $vec, payload: ({event_id: $eid, source: $src, timestamp: $ts, project: $proj, cwd: $cwd, summary: $summ, session: $sess, salience: $salience} + (if $parent_id != "" then {parent_event_id: $parent_id} else {} end))}]}')

curl -sf "$QDRANT_URL/collections/$COLLECTION/points" \
  -H "Content-Type: application/json" \
  -X PUT \
  -d "$PAYLOAD" \
  >/dev/null 2>&1

exit 0
