#!/usr/bin/env bash
# index-event.sh — Index a single event into Qdrant in real-time.
# Called by hooks after writing to JSONL. Service failures are retryable (75),
# malformed inputs are data errors (65), and callers can opt into a one-line JSON
# receipt with CARTOGRAPHER_INDEX_RECEIPT=1.
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
REJECT_LOG="${CARTOGRAPHER_INDEX_REJECT_LOG:-$STATE_DIR/index-rejects.jsonl}"
EMBED_TEXT_MAX="${CARTOGRAPHER_EMBED_TEXT_MAX:-1200}"
RECEIPT_ENABLED="${CARTOGRAPHER_INDEX_RECEIPT:-0}"
PE_GATE_REJECT="${PE_GATE_REJECT:-0.85}"

EVENT_ID=""
TEXT=""
PROJECT=""
CWD=""
TIMESTAMP=""
SOURCE=""
SESSION=""
SALIENCE="0.5"
PARENT_EVENT_ID=""
PROMPT_INTENT=""
PROVIDER=""
TRANSCRIPT_PATH=""
CANONICAL=""
NOISE_CLASS=""
DERIVED_FROM=""
SUMMARY_HASH=""
COMPACTION_TRIGGER=""
POINT_ID=""
TOP_SCORE=""

emit_receipt() {
  [ "$RECEIPT_ENABLED" = "1" ] || return 0
  local outcome="$1"
  local stage="$2"
  local verified="${3:-false}"
  if command -v jq >/dev/null 2>&1; then
    jq -n -c \
      --arg eid "$EVENT_ID" \
      --arg outcome "$outcome" \
      --arg stage "$stage" \
      --arg point_id "$POINT_ID" \
      --arg source "$SOURCE" \
      --arg score "$TOP_SCORE" \
      --arg threshold "$PE_GATE_REJECT" \
      --argjson verified "$verified" \
      '{event_id: (if $eid == "" then null else $eid end), outcome: $outcome, stage: $stage}
       + (if $point_id != "" then {point_id: $point_id} else {} end)
       + (if $source != "" then {source: $source} else {} end)
       + (if $score != "" then {
            score: (try ($score | tonumber) catch $score),
            threshold: (try ($threshold | tonumber) catch $threshold)
          } else {} end)
       + (if $verified then {verified: true} else {} end)'
  else
    # jq_missing is the only reachable no-jq path. Keep the fallback static so
    # untrusted input never gets interpolated into JSON without escaping.
    printf '%s\n' '{"event_id":null,"outcome":"precondition_failed","stage":"jq_missing"}'
  fi
}

record_failure() {
  local stage="$1"
  local outcome="${2:-service_failed}"
  mkdir -p "$STATE_DIR" 2>/dev/null || true
  if command -v jq >/dev/null 2>&1; then
    jq -n -c --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg eid "$EVENT_ID" \
      --arg stage "$stage" --arg outcome "$outcome" \
      '{timestamp:$ts,event_id:(if $eid == "" then null else $eid end),stage:$stage,outcome:$outcome}' \
      >> "$ERROR_LOG" 2>/dev/null || true
  else
    printf '{"timestamp":"%s","event_id":null,"stage":"jq_missing","outcome":"precondition_failed"}\n' \
      "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$ERROR_LOG" 2>/dev/null || true
  fi
}

fail_index() {
  local stage="$1"
  local outcome="${2:-service_failed}"
  local code="${3:-75}"
  record_failure "$stage" "$outcome"
  emit_receipt "$outcome" "$stage"
  return "$code"
}

record_rejection() {
  mkdir -p "$STATE_DIR" 2>/dev/null || true
  jq -n -c \
    --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --arg eid "$EVENT_ID" \
    --arg source "$SOURCE" \
    --arg score "$TOP_SCORE" \
    --arg threshold "$PE_GATE_REJECT" \
    '{timestamp:$ts,event_id:$eid,outcome:"gate_rejected",source:$source,
      score:(try ($score|tonumber) catch $score),threshold:(try ($threshold|tonumber) catch $threshold)}' \
    >> "$REJECT_LOG" 2>/dev/null || true
}

# Parse args or read from stdin
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
  command -v jq >/dev/null 2>&1 || { fail_index "jq_missing" "precondition_failed" 69; exit $?; }
  printf '%s' "$INPUT" | jq -e . >/dev/null 2>&1 \
    || { fail_index "invalid_json" "precondition_failed" 65; exit $?; }
  EVENT_ID=$(printf '%s' "$INPUT" | jq -r '.event_id // empty')
  TEXT=$(printf '%s' "$INPUT" | jq -r \
    '.summary // .description // .prompt // .url // .query // .event_id // .milestone // empty')
  PROJECT=$(printf '%s' "$INPUT" | jq -r '.project // empty')
  [ -n "$PROJECT" ] && TEXT="$TEXT | project: $PROJECT"
  CWD=$(printf '%s' "$INPUT" | jq -r '.cwd // empty')
  TIMESTAMP=$(printf '%s' "$INPUT" | jq -r '.timestamp // empty')
  # Milestone records carry `.milestone`, never `.type`. Without this fallback
  # every /wrapup indexed as source "" at the 0.5 default salience. Routine
  # lifecycle events get their own source so they cannot flood "milestones"
  # (13,434 of them against 564 wrapups as of 2026-08-29).
  SOURCE=$(printf '%s' "$INPUT" | jq -r '
    .type // (
      if   .milestone == "session_wrapup" then "milestones"
      elif .milestone                     then "session_lifecycle"
      else empty end)')
  SESSION=$(printf '%s' "$INPUT" | jq -r '(.session // .session_id // empty)')
  SALIENCE=$(printf '%s' "$INPUT" | jq -r '
    .salience // (
      if   .milestone == "session_wrapup"            then 0.9
      elif .milestone == "compaction_manual"         then 0.6
      elif (.milestone // "") | startswith("agent_") then 0.5
      elif .milestone                                then 0.25
      else 0.5 end)')
  PARENT_EVENT_ID=$(printf '%s' "$INPUT" | jq -r '.parent_event_id // empty')
  PROMPT_INTENT=$(printf '%s' "$INPUT" | jq -r '.prompt_intent // empty')
  PROVIDER=$(printf '%s' "$INPUT" | jq -r '.provider // empty')
  TRANSCRIPT_PATH=$(printf '%s' "$INPUT" | jq -r '.transcript_path // empty')
  CANONICAL=$(printf '%s' "$INPUT" | jq -r 'if has("canonical") then (.canonical | tostring) else "" end')
  NOISE_CLASS=$(printf '%s' "$INPUT" | jq -r '.noise_class // empty')
  DERIVED_FROM=$(printf '%s' "$INPUT" | jq -c '.derived_from // empty')
  SUMMARY_HASH=$(printf '%s' "$INPUT" | jq -r '.summary_hash // empty')
  COMPACTION_TRIGGER=$(printf '%s' "$INPUT" | jq -r '.compaction_trigger // empty')
fi

command -v jq >/dev/null 2>&1 || { fail_index "jq_missing" "precondition_failed" 69; exit $?; }
[ -n "$EVENT_ID" ] || { fail_index "missing_event_id" "precondition_failed" 65; exit $?; }
[ -n "$TEXT" ] || { fail_index "missing_text" "precondition_failed" 65; exit $?; }

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

# Prediction error gate: skip noisy near-duplicates, but never discard an
# authored /wrapup synthesis. Event ids already make repeat indexing idempotent,
# and two semantically similar sessions may carry different decisions.
if [ "$SOURCE" != "milestones" ]; then
  SEARCH_RESULT=$(curl -sf "$QDRANT_URL/collections/$COLLECTION/points/search" \
    -H "Content-Type: application/json" \
    -X POST \
    -d "{\"vector\":$VECTOR,\"limit\":1,\"with_payload\":false}" 2>/dev/null) \
    || { fail_index "gate_search_failed"; exit $?; }

  TOP_SCORE=$(echo "$SEARCH_RESULT" | jq -r '.result[0].score // 0' 2>/dev/null)
  # Compare using awk since bash can't do float comparison
  GATE=$(echo "$TOP_SCORE $PE_GATE_REJECT" | awk '{print ($1 > $2) ? "reject" : "accept"}')
  if [ "$GATE" = "reject" ]; then
    record_rejection
    emit_receipt "gate_rejected" "novelty_gate"
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

curl -sf "$QDRANT_URL/collections/$COLLECTION/points?wait=true" \
  -H "Content-Type: application/json" \
  -X PUT \
  -d "$PAYLOAD" \
  >/dev/null 2>&1 || { fail_index "qdrant_upsert_failed"; exit $?; }

# A successful waited upsert is enough for detached hooks. Human-facing callers
# opt into a receipt; only they pay for an independent read-back before the
# indexer says the exact event landed.
if [ "$RECEIPT_ENABLED" = "1" ]; then
  VERIFY_RESPONSE=$(curl -sf "$QDRANT_URL/collections/$COLLECTION/points/$POINT_ID" 2>/dev/null) \
    || { fail_index "qdrant_verify_failed"; exit $?; }
  VERIFIED_EVENT_ID=$(printf '%s' "$VERIFY_RESPONSE" | jq -r '.result.payload.event_id // empty' 2>/dev/null)
  [ "$VERIFIED_EVENT_ID" = "$EVENT_ID" ] \
    || { fail_index "qdrant_verify_mismatch"; exit $?; }
  emit_receipt "indexed" "qdrant_readback" true
fi
exit 0
