#!/usr/bin/env bash
# cartographer-search.sh — Unified search across all Claude Code session history.
#
# Usage: cartographer-search.sh <query> [--project NAME] [--limit N] [--format text|jsonl]
#
# Searches (in order):
#   1. Qdrant semantic search (if available)
#   2. JSONL event logs + transcripts via grep+awk rank fusion
#
# Results are ranked via Reciprocal Rank Fusion (RRF) across sources,
# then deduplicated and sorted by combined score.
#
# Environment:
#   CARTOGRAPHER_DEV_DIR         — default: ~/Documents/dev
#   CARTOGRAPHER_CLAUDE_TRANSCRIPTS_DIR — default: ~/.claude/projects
#   CARTOGRAPHER_CODEX_TRANSCRIPTS_DIR  — default: ~/.codex/sessions
#   CARTOGRAPHER_TRANSCRIPTS_DIR        — legacy Claude-only override
#   CARTOGRAPHER_QDRANT_URL      — default: http://localhost:6333
#   CARTOGRAPHER_EMBED_URL       — default: http://localhost:8890/v1/embeddings
#   CARTOGRAPHER_EMBED_MODEL     — default: mxbai-embed-large
#   CARTOGRAPHER_COLLECTION      — default: session-cartographer
#   CARTOGRAPHER_DECAY_LAMBDA    — time-decay rate (default: 0.001, ~30-day half-life)
#   CARTOGRAPHER_SERVED_LOG      — default: $DEV/served-log.jsonl (every displayed result)
#   CARTOGRAPHER_ACCESS_LEDGER   — default: $DEV/access-ledger.jsonl (every --touch)
#
# Every displayed result is appended to CARTOGRAPHER_SERVED_LOG (query, rank,
# source, event_id). Joined against the access ledger, this is the input to
# scripts/hit-rate-report.js — what fraction of served results actually get
# touched, broken out by rank and source. Run it after a stretch of /remember
# use to see whether ranking order predicts usefulness.
#
# --intent KEY restricts results to transcript turns tagged with a given
# prompt-intent (see classify-prompt-intent.js for the 17 keys). Intent lives
# only on Qdrant turn points, so --intent runs semantic-only — the keyword
# JSONL logs carry no intent and are skipped when it is set.

set -o pipefail

QUERY="${1:?Usage: cartographer-search.sh \"<query>\" [--project NAME] [--limit N] [--format text|jsonl] [--transcript] [--since WHEN] [--before WHEN] [--intent KEY] [--purpose KIND] [--call-id ID] [--all] [--reset-served] [--thread EVENT_ID] [--get EVENT_IDS] [--touch EVENT_IDS]
       WHEN: today | yesterday | \"this morning\" | \"this afternoon\" | \"this evening\" | \"this week\" | \"last week\" | \"this month\" | \"last month\" | 7d | 2h | 30m | 1w | 2026-04-20
       Delta serving (auto when the session resolves — CARTOGRAPHER_SESSION_ID, CLAUDE_CODE_SESSION_ID, CLAUDE_SESSION_ID, or CODEX_SESSION_ID): suppresses event_ids returned in prior calls this session. --all bypasses; --reset-served wipes the per-session list.
       --intent KEY: restrict to transcript turns with a given prompt-intent (bug-fixes, implementation, research, ...). Semantic-only — keyword logs carry no intent.
       --thread EVENT_ID: walk the parent_event_id chain (ancestors + descendants) for that event and print the work-arc as a timeline. The query argument is ignored when --thread is set (pass any placeholder).
       --get EVENT_IDS: exact fetch. Print the complete untruncated record for each comma-separated event_id — the verification step after a search returns an id. Missing ids are reported, not silently dropped. The query argument is ignored (pass any placeholder).
       --purpose KIND: telemetry purpose (remember, focus, feed, eval, audit, manual). Defaults to CARTOGRAPHER_PURPOSE or manual.
       --call-id ID: stable search-call identifier. Pass the same ID to --touch for exact attribution; otherwise --touch infers the latest call that served the event.
       --touch EVENT_IDS: record result use (comma-separated ids, in access order) in the access ledger and exit. Called by /remember after actually using a result — reuse refreshes recency and boosts future ranking. The query argument is ignored (pass any placeholder).}"
shift

LIMIT=15
FUSION_DEPTH=500
PROJECT=""
SINCE=""
BEFORE=""
INTENT=""
ALL_MODE=0
RESET_SERVED=0
THREAD_ID=""
GET_IDS=""
TOUCH_IDS=""
CALL_ID=""
PURPOSE="${CARTOGRAPHER_PURPOSE:-manual}"
# Transcript fallback is expensive (turn-grouping awk runs per-query on raw
# transcripts; one 100MB+ session can hang search for minutes). Qdrant
# already holds turn-grouped embeddings for the semantic path, so the keyword
# transcript fallback stays off by default. Pass --transcript to opt in when
# semantic is unavailable or the query is a grep-style needle.
INCLUDE_TRANSCRIPTS=0
OUTPUT_FORMAT="text"
while [ $# -gt 0 ]; do
  case "$1" in
    --project)        PROJECT="$2"; shift 2 ;;
    --limit)          LIMIT="$2"; shift 2 ;;
    --format)         OUTPUT_FORMAT="$2"; shift 2 ;;
    --transcript)     INCLUDE_TRANSCRIPTS=1; shift ;;
    --no-transcript)  INCLUDE_TRANSCRIPTS=0; shift ;;
    --since)          SINCE="$2"; shift 2 ;;
    --before)         BEFORE="$2"; shift 2 ;;
    --intent)         INTENT="$2"; shift 2 ;;
    --all)            ALL_MODE=1; shift ;;
    --reset-served)   RESET_SERVED=1; shift ;;
    --thread)         THREAD_ID="$2"; shift 2 ;;
    --get)            GET_IDS="$2"; shift 2 ;;
    --touch)          TOUCH_IDS="$2"; shift 2 ;;
    --call-id)        CALL_ID="$2"; shift 2 ;;
    --purpose)        PURPOSE="$2"; shift 2 ;;
    *) shift ;;
  esac
done

case "$OUTPUT_FORMAT" in
  text|jsonl) ;;
  *)
    echo "cartographer-search: --format must be 'text' or 'jsonl'" >&2
    exit 2
    ;;
esac

case "$PURPOSE" in
  remember|focus|feed|eval|audit|manual) ;;
  *) echo "Error: --purpose must be remember, focus, feed, eval, audit, or manual" >&2; exit 2 ;;
esac
case "$CALL_ID" in
  *[!A-Za-z0-9_.:-]*|-) echo "Error: malformed --call-id '$CALL_ID'" >&2; exit 2 ;;
esac

# CLAUDE_CODE_SESSION_ID is the variable Claude Code actually exports to tool
# calls; CLAUDE_SESSION_ID was never set, which left every served row
# unattributed and delta serving permanently dormant. Keep both.
CLAUDE_SID="${CLAUDE_SESSION_ID:-${CLAUDE_CODE_SESSION_ID:-}}"
CONTEXT_SESSION_ID="${CARTOGRAPHER_SESSION_ID:-${CLAUDE_SID:-${CODEX_SESSION_ID:-}}}"
CONTEXT_PROVIDER="${CARTOGRAPHER_PROVIDER:-}"
if [ -z "$CONTEXT_PROVIDER" ]; then
  if [ -n "$CLAUDE_SID" ]; then
    CONTEXT_PROVIDER="claude"
  elif [ -n "${CODEX_SESSION_ID:-}" ] || [ -n "${CODEX_THREAD_ID:-}" ] || [ -n "${CODEX_HOME:-}" ]; then
    CONTEXT_PROVIDER="codex"
  else
    CONTEXT_PROVIDER="unknown"
  fi
fi

# ─── Temporal filter: parse --since / --before to epoch seconds ───
# Accepts (in priority order):
#   - Natural phrases:    today, yesterday, this morning, this afternoon,
#                         this evening, tonight, this week, last week,
#                         this month, last month, this hour
#   - Relative durations: 7d, 2h, 30m, 1w, 3mo (months ≈ 30d), 1y (years ≈ 365d)
#   - Absolute dates:     2026-04-01, 2026-04-01T12:00:00
# Returns echoed epoch seconds, or empty on parse failure.
#
# Designed around Claude Codes 30-day transcript TTL — the meaningful
# working window is sub-month, which is exactly where humans say "yesterday"
# and "this afternoon" rather than "26h" or "1296000s ago".
parse_time_arg() {
  local arg="$1"
  [ -z "$arg" ] && return 0

  # Normalize: lowercase, collapse whitespace
  local norm
  norm=$(echo "$arg" | tr '[:upper:]' '[:lower:]' | tr -s ' ')

  # ─── Natural-language phrases ───
  # BSD date (macOS): -v adjusts components in-place. We zero H/M/S to get
  # midnight, set H to a fixed hour for parts-of-day, or use -v-1d for
  # yesterday. Linux fallback uses date -d "today 00:00" style strings.
  case "$norm" in
    today|"this day")
      date -j -v0H -v0M -v0S +%s 2>/dev/null || date -d "today 00:00" +%s 2>/dev/null
      return 0
      ;;
    yesterday|"last night")
      date -j -v-1d -v0H -v0M -v0S +%s 2>/dev/null || date -d "yesterday 00:00" +%s 2>/dev/null
      return 0
      ;;
    "this morning")
      # Morning starts at 06:00 local time
      date -j -v6H -v0M -v0S +%s 2>/dev/null || date -d "today 06:00" +%s 2>/dev/null
      return 0
      ;;
    "this afternoon")
      # Afternoon starts at 12:00 local time
      date -j -v12H -v0M -v0S +%s 2>/dev/null || date -d "today 12:00" +%s 2>/dev/null
      return 0
      ;;
    "this evening")
      # Evening starts at 18:00 local time
      date -j -v18H -v0M -v0S +%s 2>/dev/null || date -d "today 18:00" +%s 2>/dev/null
      return 0
      ;;
    tonight)
      # Tonight starts at 21:00 local time
      date -j -v21H -v0M -v0S +%s 2>/dev/null || date -d "today 21:00" +%s 2>/dev/null
      return 0
      ;;
    "this hour")
      date -j -v0M -v0S +%s 2>/dev/null || date -d "$(date +%Y-%m-%dT%H:00:00)" +%s 2>/dev/null
      return 0
      ;;
    "this week")
      # Most recent Monday at 00:00. BSD: -v-mon goes to most recent Monday.
      date -j -v-mon -v0H -v0M -v0S +%s 2>/dev/null || date -d "monday this week 00:00" +%s 2>/dev/null
      return 0
      ;;
    "last week")
      # Monday of previous week (this weeks Monday minus 7 days)
      date -j -v-mon -v-7d -v0H -v0M -v0S +%s 2>/dev/null || date -d "monday last week 00:00" +%s 2>/dev/null
      return 0
      ;;
    "this month")
      # First of current month at 00:00
      date -j -v1d -v0H -v0M -v0S +%s 2>/dev/null || date -d "$(date +%Y-%m-01) 00:00" +%s 2>/dev/null
      return 0
      ;;
    "last month")
      # First of previous month at 00:00
      date -j -v-1m -v1d -v0H -v0M -v0S +%s 2>/dev/null || date -d "$(date -d 'last month' +%Y-%m-01) 00:00" +%s 2>/dev/null
      return 0
      ;;
  esac

  # Relative duration: NUMBER + UNIT (d=day, h=hour, m=min, w=week, mo=month, y=year)
  if echo "$arg" | grep -qE '^[0-9]+(d|h|m|w|mo|y)$'; then
    local num unit secs
    num=$(echo "$arg" | sed -E 's/^([0-9]+).*/\1/')
    unit=$(echo "$arg" | sed -E 's/^[0-9]+(.*)$/\1/')
    case "$unit" in
      h)  secs=$((num * 3600)) ;;
      m)  secs=$((num * 60)) ;;
      d)  secs=$((num * 86400)) ;;
      w)  secs=$((num * 604800)) ;;
      mo) secs=$((num * 2592000)) ;;     # ~30d
      y)  secs=$((num * 31536000)) ;;    # ~365d
      *)  return 0 ;;
    esac
    echo $(( $(date +%s) - secs ))
    return 0
  fi

  # Absolute date — try BSD date first (macOS), then GNU date (Linux)
  if echo "$arg" | grep -qE '^[0-9]{4}-[0-9]{2}-[0-9]{2}'; then
    local epoch
    # BSD date (macOS): -j -f format input +%s
    epoch=$(date -j -f '%Y-%m-%dT%H:%M:%S' "${arg}T00:00:00" +%s 2>/dev/null || \
            date -j -f '%Y-%m-%d' "$arg" +%s 2>/dev/null || \
            date -j -f '%Y-%m-%dT%H:%M:%S' "$arg" +%s 2>/dev/null || \
            date -d "$arg" +%s 2>/dev/null)
    [ -n "$epoch" ] && echo "$epoch"
    return 0
  fi
  return 0
}

SINCE_EPOCH=""
BEFORE_EPOCH=""
if [ -n "$SINCE" ]; then
  SINCE_EPOCH=$(parse_time_arg "$SINCE")
  if [ -z "$SINCE_EPOCH" ]; then
    echo "cartographer-search: --since '$SINCE' could not be parsed (try '7d', '2h', '2026-04-01')" >&2
    exit 2
  fi
fi
if [ -n "$BEFORE" ]; then
  BEFORE_EPOCH=$(parse_time_arg "$BEFORE")
  if [ -z "$BEFORE_EPOCH" ]; then
    echo "cartographer-search: --before '$BEFORE' could not be parsed (try '7d', '2h', '2026-04-01')" >&2
    exit 2
  fi
fi

# ─── Validate --intent against the known prompt-intent keys ───
# Keys mirror classify-prompt-intent.js. A typo would otherwise just yield an
# empty Qdrant filter result — fail loud instead, listing the valid options.
VALID_INTENTS="feature-design implementation bug-fixes git-commands deploy-release run-build-app code-review-qa planning-strategy research documentation testing-verification refactor-cleanup content-creation data-analysis feedback-context plan-approvals other"
if [ -n "$INTENT" ]; then
  case " $VALID_INTENTS " in
    *" $INTENT "*) ;;
    *)
      echo "cartographer-search: --intent '$INTENT' is not a known prompt-intent key." >&2
      echo "  valid keys: $VALID_INTENTS" >&2
      exit 2
      ;;
  esac
fi

# ─── Delta serving: per-session suppression of already-returned event_ids ───
# When Claude calls /remember iteratively in one session, semantic similarity
# is stable — call N+1 returns ~70% the same top-K events as call N. Wasted
# tokens, no new signal. Delta serving suppresses already-shown event_ids
# from subsequent calls so each /remember surfaces fresh material.
#
# Activated when CARTOGRAPHER_SESSION_ID, CLAUDE_CODE_SESSION_ID, or the legacy
# CLAUDE_SESSION_ID is set (skill context) and --all is not.
# The served-list file caps at the most recent 200 entries so old served IDs
# eventually fall off and re-surface in fresh queries. --reset-served wipes
# the per-session list. --all bypasses both reading and writing.
SERVED_FILE=""
SERVED_OUT=""
ACTIVE_SESSION_ID="${CARTOGRAPHER_SESSION_ID:-${CLAUDE_SID:-}}"
if [ -n "$ACTIVE_SESSION_ID" ] && [ "$ALL_MODE" -eq 0 ]; then
  SERVED_DIR="${TMPDIR_BASE:-/tmp}/cartographer-served"
  mkdir -p "$SERVED_DIR" 2>/dev/null
  SERVED_FILE="$SERVED_DIR/$ACTIVE_SESSION_ID.txt"
  if [ "$RESET_SERVED" -eq 1 ]; then
    rm -f "$SERVED_FILE"
    echo "(served-list reset for session $ACTIVE_SESSION_ID)" >&2
  fi
  touch "$SERVED_FILE" 2>/dev/null || SERVED_FILE=""
  # SERVED_OUT is assigned after mktemp below — $TMPDIR does not exist yet here.
  # macOS exports TMPDIR so referencing it early silently resolved to the system
  # temp dir; Linux leaves it unset, which made the path "/served-this-call.txt"
  # and failed the awk redirect outright.
fi

DECAY_LAMBDA="${CARTOGRAPHER_DECAY_LAMBDA:-0.001}"
DEV="${CARTOGRAPHER_DEV_DIR:-$HOME/Documents/dev}"
CLAUDE_TRANSCRIPTS="${CARTOGRAPHER_CLAUDE_TRANSCRIPTS_DIR:-${CARTOGRAPHER_TRANSCRIPTS_DIR:-$HOME/.claude/projects}}"
CODEX_TRANSCRIPTS="${CARTOGRAPHER_CODEX_TRANSCRIPTS_DIR:-$HOME/.codex/sessions}"
QDRANT="${CARTOGRAPHER_QDRANT_URL:-http://localhost:6333}"

# Resolve project aliases from registry
REGISTRY="$(dirname "$0")/../project-registry.json"
if [ -n "$PROJECT" ] && [ -f "$REGISTRY" ]; then
  EXPANDED=$(jq -r --arg a "$PROJECT" '.aliases[$a] // empty | join("|")' "$REGISTRY" 2>/dev/null)
  [ -n "$EXPANDED" ] && PROJECT="$EXPANDED"
fi
EMBED_URL="${CARTOGRAPHER_EMBED_URL:-http://localhost:8890/v1/embeddings}"
EMBED_MODEL="${CARTOGRAPHER_EMBED_MODEL:-mxbai-embed-large}"
COLLECTION="${CARTOGRAPHER_COLLECTION:-session-cartographer}"

# ─── Promote-on-reuse access ledger ───
# Append-only JSONL of "this result's transcript was actually read" moments,
# written by --touch (below), aggregated at query time in rank fusion. Serving
# a result is free (delta list); *using* it is vouching — reuse refreshes the
# event's recency and compounds a frequency boost, so events that keep proving
# useful rise across sessions without manual curation. Set the weight to 0 to
# disable the boost without losing the ledger.
ACCESS_LEDGER="${CARTOGRAPHER_ACCESS_LEDGER:-$DEV/access-ledger.jsonl}"
REUSE_WEIGHT="${CARTOGRAPHER_REUSE_WEIGHT:-0.3}"

# ─── Served log ───
# Append-only JSONL of "this result was displayed to the agent," one line per
# displayed result per call: query, rank, source, event_id, project. This is
# the other half of the access ledger — together they let hit-rate-report.js
# compute what fraction of served results actually get touched (read), broken
# out by rank and source. Skipped entirely for --thread/--touch calls (no
# results are served) and when --all is dry-running a reset.
SERVED_LOG="${CARTOGRAPHER_SERVED_LOG:-$DEV/served-log.jsonl}"
if [ -n "$SERVED_LOG" ] && ! ( : >> "$SERVED_LOG" ) 2>/dev/null; then
  echo "cartographer-search: warning: cannot write served log at $SERVED_LOG; continuing without served-result telemetry" >&2
  SERVED_LOG=""
fi
SERVE_TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
if [ -z "$TOUCH_IDS" ] && [ -z "$CALL_ID" ]; then
  CALL_ID="call-$(date -u +%Y%m%dT%H%M%S)-$$"
fi

# ─── --touch: record reuse accesses and exit ───
# Accepts comma-separated event_ids. No existence check: transcript-turn ids
# (turn-<sid>-<idx>) live only in Qdrant, so validating against the JSONL logs
# would wrongly reject them. A typo'd id is harmless — it never matches a
# search result, so it never boosts anything.
if [ -n "$TOUCH_IDS" ]; then
  now_iso=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  access_batch_id="touch-${now_iso}-$$"
  access_ordinal=0
  touched=0
  for tid in $(echo "$TOUCH_IDS" | tr ',' ' '); do
    case "$tid" in
      *[!A-Za-z0-9_-]*|""|-*) echo "touch: skipping malformed id '$tid'" >&2; continue ;;
    esac
    touch_call_id="$CALL_ID"
    if [ -z "$touch_call_id" ] && [ -f "$SERVED_LOG" ] && command -v jq >/dev/null 2>&1; then
      touch_call_id=$(tail -2000 "$SERVED_LOG" 2>/dev/null | jq -r -s \
        --arg eid "$tid" --arg sid "$CONTEXT_SESSION_ID" \
        '[.[] | select(.event_id == $eid) | select($sid == "" or (.session_id // "") == "" or .session_id == $sid)] | last | .call_id // empty' \
        2>/dev/null)
    fi
    access_ordinal=$((access_ordinal + 1))
    jq -n -c \
      --arg eid "$tid" --arg ts "$now_iso" --arg sid "$CONTEXT_SESSION_ID" \
      --arg provider "$CONTEXT_PROVIDER" --arg purpose "$PURPOSE" \
      --arg call_id "$touch_call_id" --arg access_batch_id "$access_batch_id" \
      --argjson access_ordinal "$access_ordinal" \
      '{event_id:$eid, timestamp:$ts, session_id:$sid, provider:$provider, purpose:$purpose, source:"result_used"}
       + {access_batch_id:$access_batch_id, access_ordinal:$access_ordinal}
       + if $call_id != "" then {call_id:$call_id} else {} end' \
      >> "$ACCESS_LEDGER"
    touched=$((touched + 1))
  done
  echo "(recorded $touched reuse access$([ "$touched" -eq 1 ] || echo es))"
  exit 0
fi

# ─── --get: exact fetch by event_id ───
# Search is lossy by construction — summaries are single-line, truncated for
# display, and ranked against each other. --get is the redemption step: hand it
# the ids a search returned and get the complete records back, untruncated, with
# transcript_path and diff_shape intact. Cheap enough to call on a shortlist
# before reading a 100MB transcript.
#
# Missing ids are reported rather than dropped. An id that resolves to nothing
# is real information (the event aged out, or the id was hallucinated), and
# silently returning four records for five ids is how an agent ends up
# confidently answering from a gap.
#
# Redemption telemetry: an id that this session was actually served, and now
# fetches in full, is the cleanest "served result got used" signal in the
# system — stronger than --touch, which relies on the consumer remembering to
# call it. Ids that were never served are fetched but not logged, so pasting an
# id in from elsewhere cannot inflate the hit rate.
if [ -n "$GET_IDS" ]; then
  get_logs=""
  for f in "$DEV/changelog.jsonl" "$DEV/research-log.jsonl" \
           "$DEV/session-milestones.jsonl" "$DEV/tool-use-log.jsonl"; do
    [ -f "$f" ] && get_logs="$get_logs $f"
  done
  if [ -z "$get_logs" ]; then
    echo "get: no event logs found in $DEV/" >&2
    exit 1
  fi

  get_found=0
  get_missing=0
  get_redeemed=""
  get_ids=""
  now_iso=$(date -u +%Y-%m-%dT%H:%M:%SZ)

  for gid in $(echo "$GET_IDS" | tr ',' ' '); do
    case "$gid" in
      *[!A-Za-z0-9_-]*|""|-*) echo "get: skipping malformed id '$gid'" >&2; continue ;;
    esac
    get_ids="${get_ids:+$get_ids }$gid"
  done
  [ -z "$get_ids" ] && { echo "get: no usable event ids" >&2; exit 2; }

  # One pass over ~70MB of logs for the whole id set, not one pass per id. The
  # surviving candidate lines are few, so the exact event_id match can be a
  # cheap awk over the shortlist.
  #
  # rg beats BSD grep by ~40x here (0.02s vs 0.96s on the same four files) and
  # is the difference between an exact fetch that feels free and one an agent
  # learns to avoid. grep stays as the fallback so the zero-dependency install
  # still works, just slower.
  GET_TMP=$(mktemp -d)
  trap 'rm -rf "$GET_TMP"' EXIT
  for gid in $get_ids; do printf '"%s"\n' "$gid"; done > "$GET_TMP/patterns"
  if command -v rg >/dev/null 2>&1; then
    rg -N -F -f "$GET_TMP/patterns" $get_logs > "$GET_TMP/candidates" 2>/dev/null
  else
    LC_ALL=C grep -h -F -f "$GET_TMP/patterns" $get_logs > "$GET_TMP/candidates" 2>/dev/null
  fi

  for gid in $get_ids; do
    line=$(LC_ALL=C awk -v want="$gid" '
          {
            if (match($0, /"event_id"[[:space:]]*:[[:space:]]*"/)) {
              v = substr($0, RSTART + RLENGTH)
              sub(/".*/, "", v)
              if (v == want) { print; exit }
            }
          }' "$GET_TMP/candidates")

    echo "=== $gid ==="
    if [ -z "$line" ]; then
      echo "(no event with that id in $DEV/*.jsonl — it may have aged out, live only in Qdrant as a transcript turn, or not exist)"
      echo ""
      get_missing=$((get_missing + 1))
      continue
    fi

    # jq gives the exact record with nested diff_shape intact; without it the
    # raw line is still an exact answer, just denser.
    if command -v jq >/dev/null 2>&1; then
      echo "$line" | jq '.' 2>/dev/null || echo "$line"
    else
      echo "$line"
    fi
    echo ""
    get_found=$((get_found + 1))
    get_redeemed="${get_redeemed:+$get_redeemed }$gid"
  done

  # Log redemptions for ids this session was served (see note above). One jq
  # pass for the whole id set — slurping the served log per id costs ~0.4s
  # each and turned a five-id fetch into a three-second call.
  if [ -n "$get_redeemed" ] && [ -f "$SERVED_LOG" ] && command -v jq >/dev/null 2>&1; then
    access_batch_id="get-${now_iso}-$$"
    tail -2000 "$SERVED_LOG" 2>/dev/null | jq -r -s -c \
      --arg ids "$get_redeemed" --arg ts "$now_iso" --arg sid "$CONTEXT_SESSION_ID" \
      --arg provider "$CONTEXT_PROVIDER" --arg purpose "$PURPOSE" \
      --arg access_batch_id "$access_batch_id" '
        ($ids | split(" ")) as $want
        | [ .[]
            # Bind the id before the pipe into index(): inside index(), `.` is
            # $want, so a bare .event_id there reads the array, not the row,
            # and every redemption silently fails to log.
            | select(.event_id as $e | $e != null and ($want | index($e)) != null)
            | select($sid == "" or (.session_id // "") == "" or .session_id == $sid) ] as $eligible
        | ($want | to_entries[]) as $requested
        | [ $eligible[] | select(.event_id == $requested.value) ]
        | last
        | select(.call_id != null and .call_id != "")
        | {event_id, timestamp:$ts, session_id:$sid, provider:$provider,
           purpose:$purpose, source:"result_fetched", call_id,
           access_batch_id:$access_batch_id, access_ordinal:($requested.key + 1)}
      ' 2>/dev/null >> "$ACCESS_LEDGER"
  fi

  echo "($get_found fetched, $get_missing missing)"
  [ "$get_found" -eq 0 ] && exit 1
  exit 0
fi

FOUND=0
TMPDIR=$(mktemp -d)
trap "rm -rf $TMPDIR" EXIT

# Delta serving's scratch file lives in the temp dir we own, so the trap cleans
# it up. Deferred to here because $TMPDIR does not exist at the point the
# served-list is resolved.
[ -n "$SERVED_FILE" ] && SERVED_OUT="$TMPDIR/served-this-call.txt"

# ─── Capture stdout so we can report context-window fill at the end ───
# /remember and /focus pipe this output into agent context — surface how much
# it costs, concisely. A named pipe preserves live streaming without Bash's
# /dev/fd process substitution, which is denied in the Codex sandbox.
OUTPUT_CAPTURE="$TMPDIR/_output.txt"
OUTPUT_PIPE="$TMPDIR/_output.pipe"
exec 3>&1
mkfifo "$OUTPUT_PIPE"
tee "$OUTPUT_CAPTURE" < "$OUTPUT_PIPE" >&3 &
TEE_PID=$!
exec 1> "$OUTPUT_PIPE"

# ─── Query rewriting: wildcard expansion ───
# "hallucinat*" → find all tokens starting with "hallucinat" in the logs,
# then pass them as the query to BM25 (which does exact token matching).
GREP_QUERY="$QUERY"
AWK_QUERY="$QUERY"
if echo "$QUERY" | grep -q '\*'; then
  # Build grep pattern for file matching
  GREP_QUERY=$(echo "$QUERY" | sed 's/\*/[a-z0-9]*/g')

  # Expand wildcard terms against actual tokens in the event logs
  EXPANDED=""
  for word in $QUERY; do
    if echo "$word" | grep -q '\*'; then
      prefix=$(echo "$word" | sed 's/\*//' | tr '[:upper:]' '[:lower:]')
      # Extract matching tokens from all JSONL files
      matches=$(LC_ALL=C grep -ohiE "${prefix}[a-z0-9]*" \
        "$DEV/changelog.jsonl" "$DEV/research-log.jsonl" \
        "$DEV/session-milestones.jsonl" "$DEV/tool-use-log.jsonl" \
        2>/dev/null | tr '[:upper:]' '[:lower:]' | sort -u | head -20)
      if [ -n "$matches" ]; then
        EXPANDED="$EXPANDED $matches"
      else
        EXPANDED="$EXPANDED $prefix"
      fi
    else
      EXPANDED="$EXPANDED $word"
    fi
  done
  AWK_QUERY=$(echo "$EXPANDED" | xargs)
  [ -n "$AWK_QUERY" ] && echo "(expanded: $AWK_QUERY)"
fi



# ─── Check for jq (needed for semantic search and transcript parsing) ───
HAS_JQ=false
command -v jq &>/dev/null && HAS_JQ=true

# ─── 1. Semantic search → TSV (for fusion with keyword results) ───
semantic_search_to_tsv() {
  $HAS_JQ || return 1
  curl -sf "$QDRANT/collections/$COLLECTION" >/dev/null 2>&1 || return 1
  curl -sf "${EMBED_URL%/v1/embeddings}/health" >/dev/null 2>&1 || return 1

  local embed_response
  embed_response=$(curl -sf "$EMBED_URL" \
    -H "Content-Type: application/json" \
    -d "$(jq -n --arg m "$EMBED_MODEL" --arg q "Represent this sentence for retrieval: $QUERY" \
      '{model: $m, input: $q}')" 2>/dev/null) || return 1

  local vector
  vector=$(echo "$embed_response" | jq -c '.data[0].embedding // empty' 2>/dev/null)
  [ -z "$vector" ] && return 1

  local search_body
  local depth=$FUSION_DEPTH

  # Build the Qdrant filter as a "must" array, appending one condition per
  # active facet (project, intent). A multi-project alias becomes a nested
  # should-group; a single project / intent is a plain match. No facets → no
  # filter key at all.
  local must_conditions="[]"
  if [ -n "$PROJECT" ]; then
    if echo "$PROJECT" | grep -q '|'; then
      local proj_should
      proj_should=$(echo "$PROJECT" | tr '|' '\n' | jq -R '{key: "project", match: {value: .}}' | jq -sc '{should: .}')
      must_conditions=$(echo "$must_conditions" | jq -c --argjson g "$proj_should" '. + [$g]')
    else
      must_conditions=$(echo "$must_conditions" | jq -c --arg p "$PROJECT" '. + [{key: "project", match: {value: $p}}]')
    fi
  fi
  if [ -n "$INTENT" ]; then
    must_conditions=$(echo "$must_conditions" | jq -c --arg i "$INTENT" '. + [{key: "prompt_intent", match: {value: $i}}]')
  fi

  if [ "$must_conditions" = "[]" ]; then
    search_body=$(jq -n --argjson v "$vector" --argjson l "$depth" \
      '{vector: $v, limit: $l, with_payload: true}')
  else
    search_body=$(jq -n --argjson v "$vector" --argjson l "$depth" --argjson m "$must_conditions" \
      '{vector: $v, limit: $l, with_payload: true, filter: {must: $m}}')
  fi

  local results
  results=$(curl -sf "$QDRANT/collections/$COLLECTION/points/search" \
    -H "Content-Type: application/json" \
    -d "$search_body" 2>/dev/null) || return 1

  local count
  count=$(echo "$results" | jq '.result | length' 2>/dev/null)
  [ "$count" = "0" ] || [ -z "$count" ] && return 1

  # Emit TSV in the same format as keyword sources — RRF fuses them together
  # Fields: src \t rank \t key \t ts \t proj \t summary \t extras \t etype \t salience
  # Salience defaults to 0.5 for old payloads without the field (back-compat).
  # Summary is control-char-sanitized: payloads hold parsed JSON strings, so a
  # multi-line bash command would otherwise split one TSV row into several —
  # the tail fragments mis-parse as rank/key/timestamp and pollute fusion.
  echo "$results" | jq -r '.result | to_entries[] |
    "semantic\t" +
    (.key + 1 | tostring) + "\t" +
    (.value.payload.event_id // "sem-" + (.key | tostring)) + "\t" +
    (.value.payload.timestamp // "?") + "\t" +
    (.value.payload.project // "?") + "\t" +
    ((.value.payload.summary // .value.payload.url // .value.payload.type // "?") | gsub("[\u0000-\u001f]+"; " ")) + "\t" +
    (if .value.payload.url then "url:" + .value.payload.url + "|" else "" end) +
    (if .value.payload.deeplink and .value.payload.deeplink != "" then "deeplink:" + .value.payload.deeplink + "|" else "" end) +
    (if .value.payload.transcript_path and .value.payload.transcript_path != "" then "transcript:" + .value.payload.transcript_path + "|" else "" end) +
    (if .value.payload.cwd and .value.payload.cwd != "" then "cwd:" + .value.payload.cwd + "|" else "" end) +
    (if .value.payload.session then "session:" + .value.payload.session + "|" else "" end) +
    (if .value.payload.provider and .value.payload.provider != "" then "provider:" + .value.payload.provider + "|" else "" end) +
    (if .value.payload.prompt_intent and .value.payload.prompt_intent != "" then "intent:" + .value.payload.prompt_intent + "|" else "" end) +
    "\t" +
    (.value.payload.type // (if (.value.payload.event_id // "") | startswith("git-") then "git_commit" else "?" end)) +
    "\t" +
    ((.value.payload.salience // 0.5) | tostring)
  ' 2>/dev/null
}

# ─── 2. Keyword search with rank fusion via awk ───
#
# Each JSONL source is grep-matched, then awk extracts fields and assigns
# a within-source rank. Results from all sources are piped into a fusion
# awk that computes RRF scores, deduplicates, and sorts.
#
# Intermediate format (TSV):
#   source \t rank \t key \t timestamp \t project \t summary \t extras

grep_jsonl_to_tsv() {
  local file="$1" source="$2"
  [ -f "$file" ] || return 0

  # Note: The file is passed twice for the 2-pass (NR==FNR) BM25 algorithm
  awk -f "$(dirname "$0")/bm25-search.awk" \
    -v query="$AWK_QUERY" -v src="$source" -v proj_filter="$PROJECT" \
    "$file" "$file" 2>/dev/null
}

grep_transcripts_to_tsv() {
  [ -d "$CLAUDE_TRANSCRIPTS" ] || [ -d "$CODEX_TRANSCRIPTS" ] || return 0

  # Per-line grep, no turn-grouping, no BM25. Turn-extraction is an
  # indexing-layer concern (Qdrant embeddings); the CLI keyword path is
  # a plain needle-finder of last resort. Opt-in via --transcript only.
  local matched_files=0

  while IFS= read -r transcript; do
    [ -z "$transcript" ] && continue

    local provider project_dir session_file session_id session_cwd
    session_file=$(basename "$transcript")
    case "$transcript" in
      "$CODEX_TRANSCRIPTS"/*)
        provider="codex"
        session_id=$(jq -r 'select(.type == "session_meta") | .payload.id // .payload.session_id // empty' "$transcript" 2>/dev/null | head -1)
        session_id="${session_id:-${session_file%.jsonl}}"
        session_cwd=$(jq -r 'select(.type == "session_meta") | .payload.cwd // empty' "$transcript" 2>/dev/null | head -1)
        project_dir=$(basename "${session_cwd:-$(dirname "$transcript")}")
        ;;
      *)
        provider="claude"
        project_dir=$(basename "$(dirname "$transcript")")
        session_id="${session_file%.jsonl}"
        ;;
    esac

    if [ -n "$PROJECT" ]; then
      echo "$project_dir" | grep -qi "$PROJECT" || continue
    fi

    matched_files=$((matched_files + 1))

    LC_ALL=C grep -niE "$GREP_QUERY" "$transcript" 2>/dev/null | head -20 | \
      awk -F: -v sid="$session_id" -v proj="$project_dir" -v provider="$provider" -v tpath="$transcript" '
        {
          lineno = $1
          content = $2
          for (i = 3; i <= NF; i++) content = content ":" $i
          gsub(/\t/, " ", content)
          gsub(/[[:cntrl:]]/, " ", content)
          if (length(content) > 300) content = substr(content, 1, 300) "..."
          printf "transcript\t%d\ttranscript-%s-%s-%d\t?\t%s\t%s\t%s\t%s\t%s\n", \
            NR, provider, sid, lineno, proj, content, \
            "provider:" provider "|session:" sid "|transcript:" tpath, "transcript", "0.5"
        }
      '

    if [ "$matched_files" -ge 20 ]; then
      echo "(showing top 20 matching transcripts)" >&2
      break
    fi
  done < <(
    if command -v rg >/dev/null 2>&1; then
      {
        [ -d "$CLAUDE_TRANSCRIPTS" ] && rg -l "$GREP_QUERY" "$CLAUDE_TRANSCRIPTS" --glob '*.jsonl' --max-depth 3 2>/dev/null
        [ -d "$CODEX_TRANSCRIPTS" ] && rg -l "$GREP_QUERY" "$CODEX_TRANSCRIPTS" --glob '*.jsonl' --max-depth 5 2>/dev/null
      } | head -20
    else
      {
        [ -d "$CLAUDE_TRANSCRIPTS" ] && find "$CLAUDE_TRANSCRIPTS" -mindepth 2 -maxdepth 2 -name "*.jsonl" -type f -exec grep -liE "$GREP_QUERY" {} + 2>/dev/null
        [ -d "$CODEX_TRANSCRIPTS" ] && find "$CODEX_TRANSCRIPTS" -name "*.jsonl" -type f -exec grep -liE "$GREP_QUERY" {} + 2>/dev/null
      } | head -20
    fi
  )
}

# ─── Rank fusion ───
rank_fuse_and_display() {
  # RRF with k=60 (standard constant)
  # Input: TSV lines from all sources
  # Output: faceted summary of top 500, then detailed top N results
  awk -F'\t' -v limit="$LIMIT" -v fusion_depth="$FUSION_DEPTH" -v decay_lambda="$DECAY_LAMBDA" -v now_epoch="$(date +%s)" \
      -v since_epoch="${SINCE_EPOCH:-0}" -v before_epoch="${BEFORE_EPOCH:-0}" \
      -v served_in="${SERVED_FILE:-}" -v served_out="${SERVED_OUT:-}" \
      -v access_ledger="$ACCESS_LEDGER" -v reuse_weight="$REUSE_WEIGHT" \
      -v served_log="$SERVED_LOG" -v serve_ts="$SERVE_TS" -v serve_query="$QUERY" -v serve_project="$PROJECT" \
      -v call_id="$CALL_ID" -v purpose="$PURPOSE" -v context_session="$CONTEXT_SESSION_ID" -v context_provider="$CONTEXT_PROVIDER" \
      -v output_format="$OUTPUT_FORMAT" '
  BEGIN {
    # Delta-serving: load already-served event_ids for this session
    if (served_in != "") {
      while ((getline served_line < served_in) > 0) {
        if (served_line != "") served[served_line] = 1
      }
      close(served_in)
    }
    suppressed_count = 0

    # Promote-on-reuse: load the access ledger (transcript reads recorded by
    # --touch). Per event we keep the access count, the most recent access
    # epoch, and an ACT-R-style frequency sum  Σ 1/sqrt(days_since_access) —
    # recent rehearsals count more, repeats compound with diminishing returns.
    # Missing ledger file → getline returns -1 → zero entries → untouched
    # events score exactly as before.
    if (access_ledger != "" && reuse_weight + 0 > 0) {
      while ((getline al_line < access_ledger) > 0) {
        if (match(al_line, /"event_id"[[:space:]]*:[[:space:]]*"/)) {
          al_id = substr(al_line, RSTART + RLENGTH)
          sub(/".*/, "", al_id)
          if (al_id == "") continue
          al_ep = 0
          if (match(al_line, /"timestamp"[[:space:]]*:[[:space:]]*"/)) {
            al_ts = substr(al_line, RSTART + RLENGTH)
            sub(/".*/, "", al_ts)
            al_ep = ts_to_epoch(al_ts)
          }
          if (al_ep <= 0) continue
          acc_n[al_id]++
          if (al_ep > acc_last[al_id] + 0) acc_last[al_id] = al_ep
          al_days = (now_epoch - al_ep) / 86400
          if (al_days < 0.02) al_days = 0.02  # floor ~30min; guards div-by-zero and clock skew
          acc_sum[al_id] += 1 / sqrt(al_days)
        }
      }
      close(access_ledger)
    }
  }
  # Parse an ISO 8601-ish timestamp (2026-03-29T14:30:00...) to epoch seconds.
  # Returns 0 if ts is empty, "?", or unparseable. Same arithmetic as the
  # time-decay block below — kept as a helper so the temporal filter and the
  # decay scorer stay in sync.
  function ts_to_epoch(ts,    y, mo, da, h, mi, days_from_year, mdays, days_from_month, total_days) {
    if (ts == "" || ts == "?") return 0
    y = substr(ts, 1, 4) + 0
    if (y < 1970 || y > 2100) return 0
    mo = substr(ts, 6, 2) + 0
    da = substr(ts, 9, 2) + 0
    h = substr(ts, 12, 2) + 0
    mi = substr(ts, 15, 2) + 0
    days_from_year = (y - 1970) * 365 + int((y - 1969) / 4)
    split("0,31,59,90,120,151,181,212,243,273,304,334", mdays, ",")
    days_from_month = mdays[mo] + 0
    if (mo > 2 && y % 4 == 0) days_from_month++
    total_days = days_from_year + days_from_month + da - 1
    return total_days * 86400 + h * 3600 + mi * 60
  }
  function json_escape(value) {
    gsub(/\\/, "\\\\", value)
    gsub(/\"/, "\\\"", value)
    gsub(/\r/, "\\r", value)
    gsub(/\n/, "\\n", value)
    gsub(/\t/, "\\t", value)
    return value
  }

  {
    src = $1; rank = $2; key = $3; ts = $4; proj = $5; summary = $6; extras = $7; etype = $8; sal = $9
    # Malformed-row guard: a row with no key or a non-numeric rank is a TSV
    # fragment (e.g. a multi-line summary split across lines), never a real
    # result. Without this, rank coerces to 0 → score 1/(60+0) — above every
    # legitimate rank-1 result — and fragments merge under key "" at the top.
    if (key == "" || rank !~ /^[0-9]+$/) next
    # Salience: hook-emitted strategic-weight multiplier in [0..1]. Old events
    # (pre-write-time-salience) lack the field — default to 0.5 (neutral).
    if (sal == "" || sal + 0 == 0) sal = 0.5
    if (sal + 0 > 1.0) sal = 1.0
    if (sal + 0 < 0.05) sal = 0.05  # floor; avoid zeroing-out anomalies

    # ─── Temporal filter: --since / --before ───
    # When either is set, drop rows outside the window. Records with no
    # parseable timestamp (transcripts emit "?") are dropped when a temporal
    # filter is active — we cant honour the filter for them, and including
    # them would silently leak unbounded results.
    if (since_epoch + 0 > 0 || before_epoch + 0 > 0) {
      ts_epoch = ts_to_epoch(ts)
      if (ts_epoch == 0) next
      if (since_epoch + 0 > 0 && ts_epoch < since_epoch + 0) next
      if (before_epoch + 0 > 0 && ts_epoch > before_epoch + 0) next
    }

    # ─── Delta-serving suppression ───
    # Drop already-served event_ids so iterative /remember calls in the
    # same session surface fresh material rather than re-returning the
    # same top-K from the prior call. --all bypasses by leaving served
    # empty. The suppression is at row-ingestion (before RRF) so the
    # final ranking reflects only fresh events.
    if (key in served) {
      suppressed_count++
      next
    }

    # RRF score: 1/(k + rank), then weighted by per-event salience. Salience is
    # multiplicative — a routine bash command (0.2) ranks 2.5× lower than a
    # neutral event (0.5) and 4.5× lower than a /wrapup milestone (0.9).
    score = (1.0 / (60 + rank)) * (sal + 0)

    # Accumulate scores per unique key (handles same event in multiple sources)
    if (key in rrf_score) {
      rrf_score[key] += score
      sources[key] = sources[key] "+" src
      # Track max salience seen so deduped keys retain the strongest signal
      if (sal + 0 > salience_map[key] + 0) salience_map[key] = sal
    } else {
      rrf_score[key] = score
      sources[key] = src
      timestamp[key] = ts
      project[key] = proj
      summaries[key] = summary
      extra[key] = extras
      etype_map[key] = etype
      salience_map[key] = sal
      order[++n] = key
    }
  }
  END {
    # Sort by RRF score (insertion sort — fine for small N)
    for (i = 2; i <= n; i++) {
      k = order[i]
      s = rrf_score[k]
      j = i - 1
      while (j >= 1 && rrf_score[order[j]] < s) {
        order[j+1] = order[j]
        j--
      }
      order[j+1] = k
    }

    # ─── Activation: Ebbinghaus time-decay + promote-on-reuse ───
    # score *= exp(-lambda * hours_since_last_use) * reuse_boost
    #
    # "Last use" is the event timestamp OR the most recent recorded access,
    # whichever is newer — reading the transcript behind a result refreshes
    # its recency (ACT-R: retrieval re-strengthens the trace). On top of that,
    # reuse_boost = 1 + reuse_weight * Σ 1/sqrt(days_since_access), capped at
    # 2.0 so reuse breaks ties and lifts proven-useful events without ever
    # overpowering relevance. Events with no recorded access score exactly
    # as before (decay from event time, boost 1.0).
    resort_needed = 0
    for (i = 1; i <= n; i++) {
      k = order[i]
      factor = 1.0
      if (k in acc_sum) {
        boost = 1 + reuse_weight * acc_sum[k]
        if (boost > 2.0) boost = 2.0
        factor *= boost
        resort_needed = 1
      }
      if (decay_lambda + 0 > 0 && now_epoch + 0 > 0) {
        event_epoch = ts_to_epoch(timestamp[k])
        if (event_epoch > 0) {
          if (acc_last[k] + 0 > event_epoch) event_epoch = acc_last[k] + 0
          hours = (now_epoch - event_epoch) / 3600
          if (hours < 0) hours = 0
          factor *= exp(-decay_lambda * hours)
          resort_needed = 1
        }
      }
      if (factor != 1.0) rrf_score[k] = rrf_score[k] * factor
    }

    # Re-sort after activation adjustment
    if (resort_needed) {
      for (i = 2; i <= n; i++) {
        k = order[i]
        s = rrf_score[k]
        j = i - 1
        while (j >= 1 && rrf_score[order[j]] < s) {
          order[j+1] = order[j]
          j--
        }
        order[j+1] = k
      }
    }

    # ─── Faceting: summarize top fusion_depth results ───
    facet_n = (n < fusion_depth) ? n : fusion_depth
    if (output_format == "text" && facet_n > 0) {
      # Count by project, source, type, time
      delete proj_count
      delete src_count
      delete type_count
      delete intent_count
      delete time_bucket
      delete day_bucket
      oldest = ""; newest = ""

      for (i = 1; i <= facet_n; i++) {
        k = order[i]
        p = project[k]
        if (p != "" && p != "?") proj_count[p]++

        # Source facet (normalize compound sources to components)
        ns = split(sources[k], src_parts, "+")
        for (si = 1; si <= ns; si++) {
          s = src_parts[si]
          if (s != "") src_count[s]++
        }

        # Event type facet
        et = etype_map[k]
        if (et != "" && et != "?") type_count[et]++

        # Prompt-intent facet — pull intent:<key> out of the extras bag.
        # Only transcript turns (post-backfill) carry one; other rows skip.
        if (match(extra[k], /intent:[a-z][a-z-]*/)) {
          iv = substr(extra[k], RSTART + 7, RLENGTH - 7)
          if (iv != "") intent_count[iv]++
        }

        # Time buckets: YYYY-MM (monthly) and YYYY-MM-DD (daily for recent)
        t = timestamp[k]
        if (t != "" && t != "?") {
          ym = substr(t, 1, 7)
          if (ym ~ /^[0-9]{4}-[0-9]{2}$/) {
            time_bucket[ym]++
            if (oldest == "" || t < oldest) oldest = t
            if (newest == "" || t > newest) newest = t
          }
          ymd = substr(t, 1, 10)
          if (ymd ~ /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/) {
            day_bucket[ymd]++
          }
        }
      }

      printf "--- Facets (%d results) ---\n", facet_n

      # Project distribution (sorted by count, descending)
      np = 0
      for (p in proj_count) { np++; pnames[np] = p; pcounts[np] = proj_count[p] }
      for (i = 2; i <= np; i++) {
        tk = pnames[i]; tv = pcounts[i]; j = i - 1
        while (j >= 1 && pcounts[j] < tv) {
          pnames[j+1] = pnames[j]; pcounts[j+1] = pcounts[j]; j--
        }
        pnames[j+1] = tk; pcounts[j+1] = tv
      }
      printf "  projects: "
      for (i = 1; i <= np && i <= 8; i++) {
        if (i > 1) printf ", "
        printf "%s(%d)", pnames[i], pcounts[i]
      }
      if (np > 8) printf ", +%d more", np - 8
      printf "\n"

      # Event type distribution (sorted by count, descending)
      nt = 0
      for (et in type_count) { nt++; tnames[nt] = et; tcounts[nt] = type_count[et] }
      for (i = 2; i <= nt; i++) {
        tk = tnames[i]; tv = tcounts[i]; j = i - 1
        while (j >= 1 && tcounts[j] < tv) {
          tnames[j+1] = tnames[j]; tcounts[j+1] = tcounts[j]; j--
        }
        tnames[j+1] = tk; tcounts[j+1] = tv
      }
      printf "  types:    "
      for (i = 1; i <= nt && i <= 8; i++) {
        if (i > 1) printf ", "
        printf "%s(%d)", tnames[i], tcounts[i]
      }
      if (nt > 8) printf ", +%d more", nt - 8
      printf "\n"

      # Prompt-intent distribution (transcript turns only; sorted descending)
      nin = 0
      for (iv in intent_count) { nin++; innames[nin] = iv; incounts[nin] = intent_count[iv] }
      for (i = 2; i <= nin; i++) {
        tk = innames[i]; tv = incounts[i]; j = i - 1
        while (j >= 1 && incounts[j] < tv) {
          innames[j+1] = innames[j]; incounts[j+1] = incounts[j]; j--
        }
        innames[j+1] = tk; incounts[j+1] = tv
      }
      if (nin > 0) {
        printf "  intents:  "
        for (i = 1; i <= nin && i <= 8; i++) {
          if (i > 1) printf ", "
          printf "%s(%d)", innames[i], incounts[i]
        }
        if (nin > 8) printf ", +%d more", nin - 8
        printf "\n"
      }

      # Source distribution
      printf "  sources:  "
      first = 1
      for (s in src_count) {
        if (!first) printf ", "
        printf "%s(%d)", s, src_count[s]
        first = 0
      }
      printf "\n"

      # Time span + monthly + daily distribution
      if (oldest != "" && newest != "") {
        printf "  span:     %s to %s\n", substr(oldest, 1, 10), substr(newest, 1, 10)

        # Monthly buckets (sorted descending, show up to 6)
        nbk = 0
        for (ym in time_bucket) { nbk++; bnames[nbk] = ym; bcounts[nbk] = time_bucket[ym] }
        for (i = 2; i <= nbk; i++) {
          tk = bnames[i]; tv = bcounts[i]; j = i - 1
          while (j >= 1 && bnames[j] < tk) {
            bnames[j+1] = bnames[j]; bcounts[j+1] = bcounts[j]; j--
          }
          bnames[j+1] = tk; bcounts[j+1] = tv
        }
        printf "  months:   "
        for (i = 1; i <= nbk && i <= 6; i++) {
          if (i > 1) printf ", "
          printf "%s(%d)", bnames[i], bcounts[i]
        }
        if (nbk > 6) printf ", +%d older", nbk - 6
        printf "\n"

        # Daily buckets (sorted descending, show last 7 active days)
        ndk = 0
        for (ymd in day_bucket) { ndk++; dnames[ndk] = ymd; dcounts[ndk] = day_bucket[ymd] }
        for (i = 2; i <= ndk; i++) {
          tk = dnames[i]; tv = dcounts[i]; j = i - 1
          while (j >= 1 && dnames[j] < tk) {
            dnames[j+1] = dnames[j]; dcounts[j+1] = dcounts[j]; j--
          }
          dnames[j+1] = tk; dcounts[j+1] = tv
        }
        if (ndk > 0) {
          printf "  days:     "
          for (i = 1; i <= ndk && i <= 7; i++) {
            if (i > 1) printf ", "
            printf "%s(%d)", dnames[i], dcounts[i]
          }
          if (ndk > 7) printf ", +%d older", ndk - 7
          printf "\n"
        }
      }

      printf "---\n\n"
    }

    # ─── Display top results ───
    shown = 0
    for (i = 1; i <= n && shown < limit; i++) {
      k = order[i]
      # Reuse marker: events with recorded accesses show a visible (used xN)
      # tag — the glass-box cue for why a result may rank above fresher ones.
      reuse_tag = (acc_n[k] + 0 > 0) ? sprintf(" (used x%d)", acc_n[k]) : ""
      if (output_format == "jsonl") {
        printf "{\"timestamp\":\"%s\",\"source\":\"%s\",\"event_id\":\"%s\",\"summary\":\"%s\",\"project\":\"%s\",\"event_type\":\"%s\",\"salience\":%.3f,\"rank\":%d,\"extras\":\"%s\"}\n", \
          json_escape(timestamp[k]), json_escape(sources[k]), json_escape(k), \
          json_escape(summaries[k]), json_escape(project[k]), json_escape(etype_map[k]), \
          salience_map[k] + 0, shown + 1, json_escape(extra[k])
      } else {
        printf "[%s] [%s] %s%s\n", timestamp[k], sources[k], k, reuse_tag

        # Truncate summary to 200 chars
        s = summaries[k]
        if (length(s) > 200) s = substr(s, 1, 200) "..."
        printf "  %s\n", s
        printf "  project: %s\n", project[k]

        # Parse extras (pipe-separated key:value pairs)
        split(extra[k], pairs, "|")
        for (p in pairs) {
          if (pairs[p] == "") continue
          nkv = split(pairs[p], kv, ":")
          # Rejoin value in case it contained colons (URLs)
          val = ""
          for (v = 2; v <= nkv; v++) {
            if (v > 2) val = val ":"
            val = val kv[v]
          }
          if (val != "") printf "  %s: %s\n", kv[1], val
        }
        printf "\n"
      }
      shown++

      # Delta-serving: record this displayed key so subsequent calls in
      # the same session suppress it. Written to a file the shell wrapper
      # appends into the per-session served-list with last-200 cap.
      if (served_out != "") print k > served_out

      # Served log: durable record of what was shown, for hit-rate-report.js
      # to join against the access ledger later. Rank is fused-order position
      # i, not display-order shown — they match here since nothing between
      # fusion and display is skipped.
      if (served_log != "") {
        esc_q = serve_query
        gsub(/\\/, "\\\\", esc_q); gsub(/"/, "\\\"", esc_q)
        esc_src = sources[k]
        gsub(/\\/, "\\\\", esc_src); gsub(/"/, "\\\"", esc_src)
        esc_proj = (project[k] != "" ? project[k] : serve_project)
        gsub(/\\/, "\\\\", esc_proj); gsub(/"/, "\\\"", esc_proj)
        printf "{\"timestamp\":\"%s\",\"call_id\":\"%s\",\"purpose\":\"%s\",\"session_id\":\"%s\",\"provider\":\"%s\",\"query\":\"%s\",\"event_id\":\"%s\",\"rank\":%d,\"source\":\"%s\",\"project\":\"%s\"}\n", \
          serve_ts, call_id, purpose, context_session, context_provider, esc_q, k, i, esc_src, esc_proj >> served_log
      }
    }

    # Surface a hint when delta-serving suppressed material so the user
    # knows to use --all if they want to re-see it.
    if (output_format == "text" && suppressed_count > 0) {
      printf "(delta serving: %d already-shown result%s suppressed; --all to see)\n", \
        suppressed_count, (suppressed_count == 1 ? "" : "s")
    }

    if (shown == 0) exit 1
  }
  '
}

# ─── --thread: traverse the parent_event_id work-arc ───
# Hooks emit parent_event_id linking events within the same session that are
# logged within 60s of each other (see hooks/common.sh). This walks both
# directions from the supplied event: ancestors (recurse via parent_event_id)
# and descendants (events whose parent_event_id == an ancestor in the chain).
# Output is the full arc sorted by timestamp — a coherent thread of work
# rather than disconnected snapshots. Targets LongMemEval multi-session
# reasoning (docs/INDEXING_BACKLOG.md item #1).
thread_traversal() {
  local start_id="$1"
  local changelog="$DEV/changelog.jsonl"
  if [ ! -f "$changelog" ]; then
    echo "thread: $changelog not found" >&2
    return 1
  fi

  echo "=== Thread for: $start_id ==="
  echo ""

  awk -v start="$start_id" '
    function extract_str(json, field,    pat, val) {
      pat = "\"" field "\"[[:space:]]*:[[:space:]]*\""
      if (match(json, pat)) {
        val = substr(json, RSTART + RLENGTH)
        sub(/".*/, "", val)
        return val
      }
      return ""
    }

    {
      eid = extract_str($0, "event_id")
      if (eid == "") next
      ts  = extract_str($0, "timestamp")
      pid = extract_str($0, "parent_event_id")
      sid = extract_str($0, "session_id"); if (sid == "") sid = extract_str($0, "session")
      proj = extract_str($0, "project")
      summ = extract_str($0, "summary"); if (summ == "") summ = extract_str($0, "description")
      etype = extract_str($0, "type"); if (etype == "") etype = extract_str($0, "milestone")

      ts_of[eid] = ts
      parent_of[eid] = pid
      session_of[eid] = sid
      project_of[eid] = proj
      summary_of[eid] = summ
      type_of[eid] = etype
      seen[eid] = 1
      if (pid != "") children[pid] = children[pid] " " eid
    }

    END {
      if (!(start in seen)) {
        printf "(no event with id %s in changelog)\n", start
        exit 1
      }

      # Walk ancestors
      cur = start
      while (cur != "" && (cur in seen) && !(cur in visited)) {
        visited[cur] = 1
        cur = parent_of[cur]
      }

      # BFS descendants
      qh = 1; qt = 1; queue[1] = start
      while (qh <= qt) {
        cur = queue[qh++]
        n = split(children[cur], kids, " ")
        for (i = 1; i <= n; i++) {
          kid = kids[i]
          if (kid != "" && !(kid in visited)) {
            visited[kid] = 1
            queue[++qt] = kid
          }
        }
      }

      # Collect into array, sort by timestamp ascending (oldest first)
      ni = 0
      for (k in visited) order[++ni] = k
      for (i = 2; i <= ni; i++) {
        kk = order[i]; tt = ts_of[kk]; j = i - 1
        while (j >= 1 && ts_of[order[j]] > tt) {
          order[j+1] = order[j]
          j--
        }
        order[j+1] = kk
      }

      for (i = 1; i <= ni; i++) {
        k = order[i]
        marker = (k == start) ? "★" : " "
        printf "%s [%s] [%s] %s\n", marker, ts_of[k], type_of[k], k
        s = summary_of[k]
        if (length(s) > 240) s = substr(s, 1, 240) "..."
        printf "    %s\n", s
        if (project_of[k] != "" && project_of[k] != "?") printf "    project: %s\n", project_of[k]
        if (parent_of[k] != "") printf "    parent: %s\n", parent_of[k]
        printf "\n"
      }

      printf "(arc length: %d events)\n", ni
    }
  ' "$changelog"
}

if [ -n "$THREAD_ID" ]; then
  thread_traversal "$THREAD_ID"
  exit $?
fi

# ─── Run searches ───
if [ "$OUTPUT_FORMAT" = "text" ]; then
  echo "=== Searching for: \"$QUERY\" ==="
  [ -n "$PROJECT" ] && echo "=== Project filter: $PROJECT ==="
  echo ""
fi

# Collect keyword results from all JSONL sources + (optionally) transcripts
keyword_search() {
  # --intent is a transcript-turn facet that only exists on Qdrant points.
  # The JSONL event logs carry no intent, so honouring --intent means going
  # semantic-only — emit nothing here rather than leaking unfiltered rows.
  [ -n "$INTENT" ] && return 0
  grep_jsonl_to_tsv "$DEV/changelog.jsonl" "changelog"
  grep_jsonl_to_tsv "$DEV/research-log.jsonl" "research"
  grep_jsonl_to_tsv "$DEV/session-milestones.jsonl" "milestones"
  grep_jsonl_to_tsv "$DEV/tool-use-log.jsonl" "tool-use"
  [ "$INCLUDE_TRANSCRIPTS" = "1" ] && grep_transcripts_to_tsv
}

# Phase 1 & 2: Run keyword and semantic searches in parallel
keyword_search > "$TMPDIR/keyword_results.tsv" &
PID_KW=$!

semantic_search_to_tsv > "$TMPDIR/semantic_results.tsv" 2>/dev/null &
PID_SEM=$!

wait $PID_KW
wait $PID_SEM

# Phase 3: fuse everything through RRF
SEMANTIC_COUNT=$(wc -l < "$TMPDIR/semantic_results.tsv" | tr -d ' ')
if [ "$OUTPUT_FORMAT" = "text" ] && [ "$SEMANTIC_COUNT" -gt 0 ]; then
  echo "(hybrid: keyword + semantic)"
  echo ""
fi

cat "$TMPDIR/keyword_results.tsv" "$TMPDIR/semantic_results.tsv" | rank_fuse_and_display
[ $? -eq 0 ] && FOUND=1

# ─── Delta-serving: append this calls served keys to the per-session list ───
# Capped at the most recent 200 unique entries so old served IDs eventually
# fall off and re-surface in fresh queries.
if [ -n "$SERVED_FILE" ] && [ -f "$SERVED_OUT" ]; then
  cat "$SERVED_OUT" >> "$SERVED_FILE"
  # Atomically rewrite with last-200 unique entries
  if [ -s "$SERVED_FILE" ]; then
    tail -200 "$SERVED_FILE" | awk '!seen[$0]++' > "$SERVED_FILE.tmp" 2>/dev/null \
      && mv "$SERVED_FILE.tmp" "$SERVED_FILE"
  fi
fi

# ─── Cold start guidance ───
if [ "$FOUND" -eq 0 ] && [ "$OUTPUT_FORMAT" = "text" ]; then
  echo "No results found."
  echo ""

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
    echo "  grep -r -i \"$QUERY\" $CLAUDE_TRANSCRIPTS/ $CODEX_TRANSCRIPTS/ --include='*.jsonl' -l"
  else
    # ─── Phantom detection (LongMemEval abstention) ───
    # Empty result + entity-shaped tokens in the query is a different failure
    # mode than "no results, query was vague". Distinguish them: scan for
    # event_ids and file paths in the query; check the index for each; log
    # the unknowns as knowledge_gap events for future capture.
    UNKNOWN=""

    # Event ID candidates: evt-XXXXXXXXXXXX or git-XXXXXXX
    for eid in $(echo "$QUERY" | grep -oE '(evt-|git-)[a-z0-9]+' 2>/dev/null); do
      if ! LC_ALL=C grep -q "$eid" \
          "$DEV/changelog.jsonl" "$DEV/research-log.jsonl" \
          "$DEV/session-milestones.jsonl" "$DEV/tool-use-log.jsonl" \
          2>/dev/null; then
        UNKNOWN="${UNKNOWN:+$UNKNOWN,}$eid"
      fi
    done

    # File path candidates: tokens with a dot extension
    for path in $(echo "$QUERY" | grep -oE '[/A-Za-z0-9_.-]+\.[a-zA-Z0-9]{1,8}' 2>/dev/null); do
      # Skip pure version numbers and common non-paths
      case "$path" in
        [0-9]*.[0-9]*|*.md|*.) continue ;;
      esac
      if ! LC_ALL=C grep -q -- "$path" \
          "$DEV/changelog.jsonl" "$DEV/research-log.jsonl" \
          "$DEV/session-milestones.jsonl" "$DEV/tool-use-log.jsonl" \
          2>/dev/null; then
        UNKNOWN="${UNKNOWN:+$UNKNOWN,}$path"
      fi
    done

    if [ -n "$UNKNOWN" ]; then
      LOGGER="$(dirname "$0")/../hooks/log-knowledge-gap.sh"
      [ -x "$LOGGER" ] || LOGGER="$(dirname "$0")/../plugins/session-cartographer/hooks/log-knowledge-gap.sh"
      if [ -x "$LOGGER" ]; then
        "$LOGGER" --query "$QUERY" --entities "$UNKNOWN" --project "$PROJECT" 2>/dev/null
      fi
      gap_count=$(echo "$UNKNOWN" | tr ',' '\n' | wc -l | tr -d ' ')
      printf "(no results — flagged %d unknown entit%s for next-session capture: %s)\n" \
        "$gap_count" "$([ "$gap_count" -eq 1 ] && echo y || echo ies)" "$UNKNOWN"
      echo ""
    fi
    echo "Try broader keywords, --project filter, or --transcript to search raw session text."
  fi
fi

if [ "$OUTPUT_FORMAT" = "text" ]; then
  echo ""
  echo "=== Done ==="
fi

# ─── Context-window fill report (concise) ───
# Restore real stdout so the tee child can flush, then read the captured
# byte count and print one-line token estimate. /remember and /focus both
# pipe this into Claude's context; users want to see what it costs.
exec 1>&3
exec 3>&-
wait "$TEE_PID"
if [ "$OUTPUT_FORMAT" = "text" ] && [ -s "$OUTPUT_CAPTURE" ]; then
  chars=$(wc -c < "$OUTPUT_CAPTURE" | tr -d ' ')
  # Rough English heuristic: 1 token ≈ 4 chars. Good to ±20% for prose;
  # less accurate for dense JSON/code (more like 3 chars/token), but the
  # purpose is order-of-magnitude awareness, not budget enforcement.
  tokens=$((chars / 4))
  if [ "$tokens" -ge 1000 ]; then
    tokens_h=$(awk -v t="$tokens" 'BEGIN { printf "%.1fK", t/1000 }')
  else
    tokens_h="${tokens}"
  fi
  pct200k=$(awk -v t="$tokens" 'BEGIN { printf "%.1f", t*100/200000 }')
  printf "(~%s tokens · ~%s%%/200K)\n" "$tokens_h" "$pct200k"
fi
