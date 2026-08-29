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
DEV="${CARTOGRAPHER_DEV_DIR:-$HOME/Documents/dev}"
STATE_DIR="$DEV/.carto"
ERROR_LOG="${CARTOGRAPHER_INDEX_ERROR_LOG:-$STATE_DIR/index-errors.jsonl}"
EMBED_TEXT_MAX="${CARTOGRAPHER_EMBED_TEXT_MAX:-1200}"

record_failure() {
  local stage="$1"
  mkdir -p "$STATE_DIR" 2>/dev/null || true
  if command -v jq >/dev/null 2>&1; then
    jq -n -c --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg eid "$EVENT_ID" \
      --arg stage "$stage" '{timestamp:$ts,event_id:$eid,stage:$stage}' \
      >> "$ERROR_LOG" 2>/dev/null || true
  fi
}

fail_index() {
  record_failure "$1"
  return 75
}

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
  PROMPT_INTENT=$(echo "$INPUT" | jq -r '.prompt_intent // empty')
  PROVIDER=$(echo "$INPUT" | jq -r '.provider // empty')
  TRANSCRIPT_PATH=$(echo "$INPUT" | jq -r '.transcript_path // empty')
  CANONICAL=$(echo "$INPUT" | jq -r 'if has("canonical") then (.canonical | tostring) else "" end')
  NOISE_CLASS=$(echo "$INPUT" | jq -r '.noise_class // empty')
  DERIVED_FROM=$(echo "$INPUT" | jq -c '.derived_from // empty')
  SUMMARY_HASH=$(echo "$INPUT" | jq -r '.summary_hash // empty')
  COMPACTION_TRIGGER=$(echo "$INPUT" | jq -r '.compaction_trigger // empty')
fi

[ -z "$EVENT_ID" ] || [ -z "$TEXT" ] && exit 0

# Flatten control chars: payload summaries must be single-line (the search
# TSV emitter and CLI display are line-based), and embedding quality doesn't
# care about line breaks.
TEXT=$(printf '%s' "$TEXT" | tr '\n\t\r' '   ' | tr -s ' ')
EMBED_TEXT=$(printf '%.*s' "$EMBED_TEXT_MAX" "$TEXT")

# Quick health check. Hooks still degrade gracefully, but batch callers now
# receive a non-zero status and can avoid checkpointing data that never landed.
curl -sf "$QDRANT_URL/collections/$COLLECTION" >/dev/null 2>&1 || { fail_index "qdrant_unavailable"; exit $?; }
curl -sf "${EMBED_URL%/v1/embeddings}/health" >/dev/null 2>&1 || { fail_index "embedder_unavailable"; exit $?; }

# Get embedding — body built with jq, not string interpolation: a summary
# containing quotes or backslashes would otherwise produce invalid JSON and
# the event would silently never get indexed.
EMBED_BODY=$(jq -n -c --arg m "$EMBED_MODEL" --arg i "$EMBED_TEXT" '{model: $m, input: $i}') || { fail_index "embed_request_invalid"; exit $?; }
if ! EMBED_RESPONSE=$(curl -sf "$EMBED_URL" \
  -H "Content-Type: application/json" \
  -d "$EMBED_BODY" 2>/dev/null); then
  # Code-dense text can exceed an embedder's token budget even under the
  # character cap. Retry once at half length before treating it as a service
  # failure; the complete normalized summary still remains in Qdrant payload.
  RETRY_TEXT_MAX=$((EMBED_TEXT_MAX / 2))
  [ "$RETRY_TEXT_MAX" -lt 256 ] && RETRY_TEXT_MAX=256
  RETRY_TEXT=$(printf '%.*s' "$RETRY_TEXT_MAX" "$TEXT")
  RETRY_BODY=$(jq -n -c --arg m "$EMBED_MODEL" --arg i "$RETRY_TEXT" '{model: $m, input: $i}') || { fail_index "embed_retry_request_invalid"; exit $?; }
  EMBED_RESPONSE=$(curl -sf "$EMBED_URL" \
    -H "Content-Type: application/json" \
    -d "$RETRY_BODY" 2>/dev/null) || { fail_index "embedding_failed"; exit $?; }
fi

# Extract vector — need jq for this
command -v jq &>/dev/null || exit 0
VECTOR=$(echo "$EMBED_RESPONSE" | jq -c '.data[0].embedding // empty' 2>/dev/null)
[ -z "$VECTOR" ] && { fail_index "embedding_missing_vector"; exit $?; }

# Stable point ID from event_id: first 13 hex chars of SHA-256 = 52 bits.
# Must stay byte-identical to embed-events.js hashToInt(). 52 bits keeps the
# value an exact JS Number (< 2^53) while making collisions vanish: the old
# 32-bit cksum expected ~1 collision at 96k points, and a collision silently
# overwrites an unrelated event on upsert.
cartographer_point_id() {
  local _hex
  if command -v shasum >/dev/null 2>&1; then
    _hex=$(printf '%s' "$1" | shasum -a 256 | cut -c1-13)
  else
    _hex=$(printf '%s' "$1" | sha256sum | cut -c1-13)
  fi
  printf '%s' "$((16#$_hex))"
}

# Hash event_id to numeric point ID (same as embed-events.js)
POINT_ID=$(cartographer_point_id "$EVENT_ID")

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
# prompt_intent (set on transcript turns by reconstruct-history.js) is optional
# and omitted when absent — awk-backfilled turns simply carry no intent tag.
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
  --arg provider "${PROVIDER:-}" \
  --arg transcript_path "${TRANSCRIPT_PATH:-}" \
  --arg canonical "${CANONICAL:-}" \
  --arg noise_class "${NOISE_CLASS:-}" \
  --argjson derived_from "${DERIVED_FROM:-null}" \
  --arg summary_hash "${SUMMARY_HASH:-}" \
  --arg compaction_trigger "${COMPACTION_TRIGGER:-}" \
  --argjson salience "${SALIENCE:-0.5}" \
  --arg parent_id "${PARENT_EVENT_ID:-}" \
  --arg intent "${PROMPT_INTENT:-}" \
  '{points: [{id: ($id | tonumber), vector: $vec, payload: ({event_id: $eid, source: $src, timestamp: $ts, project: $proj, cwd: $cwd, summary: $summ, session: $sess, salience: $salience} + (if $provider != "" then {provider: $provider} else {} end) + (if $transcript_path != "" then {transcript_path: $transcript_path} else {} end) + (if $canonical != "" then {canonical: ($canonical == "true")} else {} end) + (if $noise_class != "" then {noise_class: $noise_class} else {} end) + (if $derived_from != null then {derived_from: $derived_from} else {} end) + (if $summary_hash != "" then {summary_hash: $summary_hash} else {} end) + (if $compaction_trigger != "" then {compaction_trigger: $compaction_trigger} else {} end) + (if $parent_id != "" then {parent_event_id: $parent_id} else {} end) + (if $intent != "" then {prompt_intent: $intent} else {} end))}]}')

curl -sf "$QDRANT_URL/collections/$COLLECTION/points" \
  -H "Content-Type: application/json" \
  -X PUT \
  -d "$PAYLOAD" \
  >/dev/null 2>&1 || { fail_index "qdrant_upsert_failed"; exit $?; }

exit 0
