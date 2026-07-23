#!/usr/bin/env bash
# Incrementally catch transcript stores up to Qdrant without blocking a session.

set -u

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
DEV="${CARTOGRAPHER_DEV_DIR:-$HOME/Documents/dev}"
STATE_DIR="$DEV/.carto"
LOCK_DIR="$STATE_DIR/transcript-catch-up.lock"
LAST_RUN="$STATE_DIR/transcript-catch-up.last"
LOG_FILE="$STATE_DIR/transcript-catch-up.jsonl"
INTERVAL="${CARTOGRAPHER_CATCHUP_INTERVAL_SECONDS:-900}"
LIMIT_DAYS="${CARTOGRAPHER_CATCHUP_LIMIT_DAYS:-7}"
PROVIDER="codex"
FORCE=0

while [ $# -gt 0 ]; do
  case "$1" in
    --provider) PROVIDER="$2"; shift 2 ;;
    --force) FORCE=1; shift ;;
    *) shift ;;
  esac
done

mkdir -p "$STATE_DIR"
now=$(date +%s)
if [ "$FORCE" -eq 0 ] && [ -f "$LAST_RUN" ]; then
  last=$(cat "$LAST_RUN" 2>/dev/null || echo 0)
  case "$last" in ''|*[!0-9]*) last=0 ;; esac
  [ $((now - last)) -lt "$INTERVAL" ] && exit 0
fi

mkdir "$LOCK_DIR" 2>/dev/null || exit 0
trap 'rmdir "$LOCK_DIR" 2>/dev/null || true' EXIT

start_ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
output=$(TURN_BODY_MAX="${TURN_BODY_MAX:-1200}" PE_GATE_REJECT="${PE_GATE_REJECT:-2.0}" \
  bash "$SCRIPT_DIR/retro-index.sh" --provider "$PROVIDER" --limit-days "$LIMIT_DAYS" 2>&1)
status=$?
end_ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
summary=$(printf '%s\n' "$output" | tail -1)

jq -n -c --arg start "$start_ts" --arg end "$end_ts" --arg provider "$PROVIDER" \
  --arg summary "$summary" --argjson status "$status" \
  '{started_at:$start,finished_at:$end,provider:$provider,status:$status,summary:$summary}' \
  >> "$LOG_FILE" 2>/dev/null || true

if [ "$status" -eq 0 ]; then
  printf '%s\n' "$now" > "$LAST_RUN"
fi
exit "$status"
