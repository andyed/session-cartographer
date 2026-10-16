#!/bin/bash
# SessionStart hook (opt-in): a start note an agent can act on at turn one.
#
# 78% of recall happens on a session's first turn (measured 2026-10-15), because
# this note is what the agent reads there. So it carries what an agent needs
# before its first move in the project it is starting in:
#   - the latest /wrapup's open threads (its unresolved[]), with the event id to
#     --get the record: 78 of 368 wrapups had ever been read back (2026-10-15);
#   - the checkout's branch, uncommitted path count and unpushed commit count;
#   - other sessions active in this project in the last 2 h, from the standup
#     roster (cartographer-standup.js --roster) and the files they last touched.
# It replaced co-active projects and maneuver names. Of the 41 notes shown in the
# 30 days to 2026-10-15, no later search named a maneuver, and the 4 that named a
# related project were an all-projects scope or the session's own task. Both
# lenses still run in /remember --project, which the note points to. They also
# cost ~1.8 s a start: each call rebuilt the co-occurrence graph from the logs.
#
# Shown when there is something new: a wrapup newer than the last one shown for
# this project, or a live peer. Silent on a repeat with neither. Every evaluation,
# shown or not, appends one row to $DEV/focus-on-start-trial.jsonl.
#
# DORMANT BY DEFAULT. Enable: export CARTOGRAPHER_FOCUS_ON_START=1
# Silent-fail: missing jq ends it; missing git, node or logs leave their part out.
# Env: CARTOGRAPHER_FOCUS_ON_START (gate), CARTOGRAPHER_DEV_DIR (default ~/Documents/dev),
#      CARTOGRAPHER_MILESTONES (wrapup log), CARTOGRAPHER_START_NOTE_WINDOW (peers, default 2h),
#      CARTOGRAPHER_START_NOTE_BUDGET (note cap in characters, default 800).
#
# Cost (2026-10-15, macOS, bash 3.2, load average ~25): ~130 ms and 9 processes
# (one jq for the payload, one for the note, git twice, or three times without an
# upstream, node once for the roster, rg|tail twice), against ~1.8 s and 22 for
# the graph-lens note. ~100 ms of it is node starting the roster, which runs in
# the background while git and the log lookups run. Gate off: ~7 ms.

# Gate first, before touching stdin: the dormant path costs a bash start and nothing else.
[ "${CARTOGRAPHER_FOCUS_ON_START:-0}" = "1" ] || exit 0
command -v jq >/dev/null 2>&1 || exit 0

case "$0" in */*) HOOK_DIR=${0%/*} ;; *) HOOK_DIR=. ;; esac
. "$HOOK_DIR/common.sh" 2>/dev/null || exit 0
NOTE_JQ="$HOOK_DIR/start-note.jq"
[ -f "$NOTE_JQ" ] || exit 0

IFS= read -r -d '' INPUT
# One jq for every payload field.
FIELDS=$(printf '%s' "$INPUT" | jq -r '[.source, .cwd, .session_id, .transcript_path, .turn_id, .model]
  | map(if . == null then "" else tostring end) | @sh' 2>/dev/null)
[ -n "$FIELDS" ] || exit 0
eval "set -- $FIELDS"
SOURCE=$1 CWD=$2 SID=$3
PROVIDER=$(detect_provider_from "$4" "$5" "$6")

# Compaction re-injects its own summary. Skip-one rather than whitelist, so a new
# source value still gets a note.
case "$SOURCE" in compact) exit 0 ;; esac
[ -n "$CWD" ] || exit 0

# The real project, never the worktree directory: --git-common-dir, one git call.
cartographer_repo "$CWD"
PROJECT=$CARTO_PROJECT TOPLEVEL=$CARTO_TOPLEVEL
[ -n "$PROJECT" ] || exit 0

# Abstain on home-dir and workspace buckets: launching from ~ resolves to "andyed",
# which co-occurs with everything (75% of the first trial's fires).
case "$PROJECT" in
  andyed|home|dev|Documents|Documents-dev|Users|Users-andyed|Downloads|Desktop|Library|tmp|workspace) exit 0 ;;
esac

DEV="${CARTOGRAPHER_DEV_DIR:-$HOME/Documents/dev}"
MILESTONES="${CARTOGRAPHER_MILESTONES:-$DEV/session-milestones.jsonl}"
TRIAL="$DEV/focus-on-start-trial.jsonl"
WINDOW="${CARTOGRAPHER_START_NOTE_WINDOW:-2h}"
BUDGET="${CARTOGRAPHER_START_NOTE_BUDGET:-800}"

# Peers first: the roster is the slowest part (~100 ms, mostly node's start and
# the changelog tail), so it runs in the background on fd 3 while git and the
# log lookups below run, and jq reads it from there at the end.
STANDUP=""
command -v node >/dev/null 2>&1 && STANDUP=$(cartographer_script cartographer-standup.js)
if [ -n "$STANDUP" ]; then
  exec 3< <(CARTOGRAPHER_DEV_DIR="$DEV" node "$STANDUP" --roster --json \
    --project "$PROJECT" --since "$WINDOW" --me "${SID:-none}" 2>/dev/null)
else
  exec 3</dev/null
fi

# Repo state. GIT_OPTIONAL_LOCKS=0: status must not take index.lock in a checkout
# where other sessions are committing.
GIT_STATUS="" LOCAL_ONLY=""
if [ -n "$TOPLEVEL" ]; then
  GIT_STATUS=$(GIT_OPTIONAL_LOCKS=0 git -C "$CWD" status --porcelain=v2 --branch 2>/dev/null)
  case "$GIT_STATUS" in
    *"# branch.ab "*) ;;
    *"# branch.oid "[0-9a-f]*)
      LOCAL_ONLY=$(git -C "$CWD" rev-list --count HEAD --not --remotes 2>/dev/null) ;;
  esac
fi

# The last <n> lines of <file> matching ERE <pattern>. rg when present: BSD grep
# takes ~80 ms over the 12 MB milestone log, rg ~10 ms.
tail_match() {
  [ -f "$1" ] || return 0
  if command -v rg >/dev/null 2>&1; then
    rg --no-config -N --no-filename -e "$3" "$1" 2>/dev/null | tail -n "$2"
  else
    LC_ALL=C grep -E -e "$3" "$1" 2>/dev/null | tail -n "$2"
  fi
}

# Project names reach a regex here. Dots are escaped without a process; any other
# metacharacter (rare in a directory name) takes one sed.
case "$PROJECT" in
  *[!A-Za-z0-9._-]*) P_RE=$(printf '%s' "$PROJECT" | LC_ALL=C sed 's/[][\\.*^$+?(){}|/]/\\&/g') ;;
  *) P_RE=${PROJECT//./\\.} ;;
esac

# The newest wrapup candidates: either key order, either JSON spacing (45 wrapups
# were written by a non-compact writer). jq picks the newest by timestamp.
WRAPS=$(tail_match "$MILESTONES" 5 "\"session_wrapup\".*\"project\": ?\"$P_RE\"|\"project\": ?\"$P_RE\".*\"session_wrapup\"")
# The last row shown for this project; its wrapup_id is what "new" is measured against.
PRIOR=$(tail_match "$TRIAL" 1 "\"project\":\"$P_RE\",.*\"shown\":true")

RESULT=$(jq -n -R -r -f "$NOTE_JQ" \
  --arg project "$PROJECT" --arg sid "$SID" --arg source "$SOURCE" --arg provider "$PROVIDER" \
  --arg wraps "$WRAPS" --arg prior "$PRIOR" --arg status "$GIT_STATUS" --arg localonly "$LOCAL_ONLY" \
  --arg window "$WINDOW" --arg budget "$BUDGET" <&3 2>/dev/null)
exec 3<&-

# Line 1 is the trial row, line 2 the hook output. A silent note prints an empty
# line 2, which command substitution strips along with the newline before it.
NL='
'
ROW=${RESULT%%"$NL"*}
case "$RESULT" in *"$NL"*) OUT=${RESULT#*"$NL"} ;; *) OUT="" ;; esac
case "$ROW" in "{"*) ;; *) exit 0 ;; esac
printf '%s\n' "$ROW" >> "$TRIAL" 2>/dev/null
[ -n "$OUT" ] && printf '%s\n' "$OUT"
exit 0
