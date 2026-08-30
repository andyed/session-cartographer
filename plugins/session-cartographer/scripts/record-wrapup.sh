#!/usr/bin/env bash
# Persist one authored session_wrapup event, then index it with a truthful,
# machine-readable outcome. The JSONL write and semantic index are deliberately
# separate states: an indexing failure never erases the durable synthesis.

DEV="${CARTOGRAPHER_DEV_DIR:-$HOME/Documents/dev}"
LOG_FILE="${CARTOGRAPHER_MILESTONES:-$DEV/session-milestones.jsonl}"
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
INDEXER="${CARTOGRAPHER_INDEXER:-$SCRIPT_DIR/index-event.sh}"

wrapper_failure() {
  local stage="$1"
  local code="${2:-65}"
  local log_outcome="${3:-not_written}"
  if command -v jq >/dev/null 2>&1; then
    jq -n -c \
      --arg eid "${EVENT_ID:-}" \
      --arg log_outcome "$log_outcome" \
      --arg stage "$stage" \
      '{event_id:(if $eid == "" then null else $eid end),log_outcome:$log_outcome,
        index:{outcome:"not_attempted",stage:$stage}}'
  else
    printf '%s\n' '{"event_id":null,"log_outcome":"not_written","index":{"outcome":"not_attempted","stage":"jq_missing"}}'
  fi
  return "$code"
}

command -v jq >/dev/null 2>&1 || { wrapper_failure "jq_missing" 69; exit $?; }

INPUT=$(cat)
printf '%s' "$INPUT" | jq -e . >/dev/null 2>&1 \
  || { wrapper_failure "invalid_json" 65; exit $?; }

EVENT_ID=$(printf '%s' "$INPUT" | jq -r '.event_id // empty')
MILESTONE=$(printf '%s' "$INPUT" | jq -r '.milestone // empty')
DESCRIPTION=$(printf '%s' "$INPUT" | jq -r '.description // empty')

[ -n "$EVENT_ID" ] || { wrapper_failure "missing_event_id" 65; exit $?; }
[ "$MILESTONE" = "session_wrapup" ] \
  || { wrapper_failure "not_session_wrapup" 65; exit $?; }
[ -n "$DESCRIPTION" ] || { wrapper_failure "missing_description" 65; exit $?; }

mkdir -p "$(dirname "$LOG_FILE")" 2>/dev/null \
  || { wrapper_failure "milestone_directory_unwritable" 73; exit $?; }

# Idempotency is by event id. If a retry carries the same event and content,
# reuse the durable line. The same id with different content is a collision and
# must not silently rewrite append-only history.
EXISTING=""
if [ -f "$LOG_FILE" ]; then
  EXISTING=$(LC_ALL=C grep -F "\"event_id\":\"$EVENT_ID\"" "$LOG_FILE" 2>/dev/null | head -1)
fi

if [ -n "$EXISTING" ]; then
  INPUT_CANON=$(printf '%s' "$INPUT" | jq -S -c .)
  EXISTING_CANON=$(printf '%s' "$EXISTING" | jq -S -c . 2>/dev/null)
  [ "$INPUT_CANON" = "$EXISTING_CANON" ] \
    || { wrapper_failure "event_id_conflict" 65 "conflict"; exit $?; }
  LOG_OUTCOME="already_present"
else
  printf '%s\n' "$(printf '%s' "$INPUT" | jq -c .)" >> "$LOG_FILE" \
    || { wrapper_failure "milestone_write_failed" 73; exit $?; }
  LC_ALL=C grep -F "\"event_id\":\"$EVENT_ID\"" "$LOG_FILE" >/dev/null 2>&1 \
    || { wrapper_failure "milestone_verify_failed" 74; exit $?; }
  LOG_OUTCOME="written"
fi

[ -x "$INDEXER" ] \
  || { wrapper_failure "indexer_missing" 69 "$LOG_OUTCOME"; exit $?; }

INDEX_STATUS=0
INDEX_RECEIPT=$(printf '%s\n' "$INPUT" \
  | CARTOGRAPHER_INDEX_RECEIPT=1 "$INDEXER") || INDEX_STATUS=$?

printf '%s' "$INDEX_RECEIPT" | jq -e . >/dev/null 2>&1 \
  || { wrapper_failure "invalid_index_receipt" 70 "$LOG_OUTCOME"; exit $?; }

jq -n -c \
  --arg eid "$EVENT_ID" \
  --arg log_outcome "$LOG_OUTCOME" \
  --argjson index "$INDEX_RECEIPT" \
  '{event_id:$eid,log_outcome:$log_outcome,index:$index}'

exit "$INDEX_STATUS"
