# common.sh — shared helpers for cartographer hooks.
# Source from individual log-*.sh hooks via:
#   . "$(dirname "$0")/common.sh"
#
# All helpers are silent on missing dependencies (jq, date) so hooks
# degrade gracefully — never block a tool call because of indexing.

# find_parent_event_id <log_file> <session_id> <now_ts_iso>
#
# Returns the event_id of the most recent prior event in <log_file> that
# (a) shares the same session_id and (b) was logged within 60s of <now_ts_iso>.
# Echoes an empty string when no parent qualifies.
#
# Used to thread events into work-arcs ("tried X" → "X failed" → "switched to Y")
# so /remember can traverse a chain rather than returning disconnected snapshots.
# 60s is the heuristic working window — anything older is likely a different
# thread of work even within the same session.
find_parent_event_id() {
  local log="$1" sid="$2" now="$3"
  [ -z "$sid" ] && return 0
  [ -z "$now" ] && return 0
  [ ! -f "$log" ] && return 0
  command -v jq >/dev/null 2>&1 || return 0

  local last
  last=$(tail -1 "$log" 2>/dev/null)
  [ -z "$last" ] && return 0

  local parent_session parent_ts parent_id
  parent_session=$(echo "$last" | jq -r '.session_id // .session // empty' 2>/dev/null)
  parent_ts=$(echo "$last" | jq -r '.timestamp // empty' 2>/dev/null)
  parent_id=$(echo "$last" | jq -r '.event_id // empty' 2>/dev/null)

  [ "$parent_session" != "$sid" ] && return 0
  [ -z "$parent_ts" ] && return 0
  [ -z "$parent_id" ] && return 0

  # Compare timestamps (ISO 8601 with Z suffix). BSD date (macOS) uses
  # -j -f format input; GNU date (Linux) uses -d.
  local parent_epoch now_epoch diff
  parent_epoch=$(date -j -u -f '%Y-%m-%dT%H:%M:%SZ' "$parent_ts" +%s 2>/dev/null || \
                 date -d "$parent_ts" +%s 2>/dev/null)
  now_epoch=$(date -j -u -f '%Y-%m-%dT%H:%M:%SZ' "$now" +%s 2>/dev/null || \
              date -d "$now" +%s 2>/dev/null)
  [ -z "$parent_epoch" ] && return 0
  [ -z "$now_epoch" ] && return 0

  diff=$((now_epoch - parent_epoch))
  if [ "$diff" -ge 0 ] && [ "$diff" -le 60 ]; then
    echo "$parent_id"
  fi
}
