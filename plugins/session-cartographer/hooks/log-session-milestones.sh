#!/bin/bash
# Lifecycle hook: logs session milestones with deep link info.
# Creates a timeline of "session bookmarks" for claude-code-history-viewer.
#
# Milestones logged:
#   - PreCompact (auto/manual) — context is full, about to lose detail
#   - SessionEnd — natural session close
#   - SubagentStop — research/explore agents completing work
#   - Stop — a Codex turn boundary (Claude Code's Stop is a no-op here)
#
# Output: session-milestones.jsonl + changelog.jsonl
# Environment: CARTOGRAPHER_DEV_DIR overrides ~/Documents/dev

DEV="${CARTOGRAPHER_DEV_DIR:-$HOME/Documents/dev}"
LOG_FILE="$DEV/session-milestones.jsonl"
CHANGELOG="$DEV/changelog.jsonl"
INPUT=$(cat)
case "$0" in */*) HOOK_DIR="${0%/*}" ;; *) HOOK_DIR=. ;; esac
. "$HOOK_DIR/common.sh"

# Every field the hook reads, in ONE jq call — see log-tool-use.sh for why.
# This hook runs on every Claude Code turn (Stop) and used to pay for ten jq
# starts, two git calls and a python3 interpreter before discovering it had
# nothing to log. The transcript path is URL-encoded here too: jq's @uri
# percent-encodes every byte outside [A-Za-z0-9_.~-], the same set Python's
# urllib.parse.quote(path, safe='') kept, so the deeplink is unchanged and
# python3 is no longer a dependency of a hook.
# The timestamp is jq's clock, in UTC to the second: the same text
# `date -u +%Y-%m-%dT%H:%M:%SZ` printed, without the process.
FIELDS=$(printf '%s' "$INPUT" | jq -r '
  def s: (. // "") | tostring;
  [ (.hook_event_name | s), (.session_id | s), (.transcript_path | s), (.cwd | s),
    (.turn_id | s), (.model | s),
    ((.trigger // "unknown") | tostring), ((.reason // "unknown") | tostring),
    ((.agent_type // "unknown") | tostring),
    ((.transcript_path | s) | @uri),
    (now | floor | todate) ]
  | @sh' 2>/dev/null)
eval "set -- $FIELDS"
EVENT=$1 SESSION_ID=$2 TRANSCRIPT=$3 CWD=$4 TURN_ID=$5 MODEL=$6
TRIGGER=$7 REASON=$8 AGENT_TYPE=$9 ENCODED_PATH=${10} TIMESTAMP=${11}
set --

PROVIDER=$(detect_provider_from "$TRANSCRIPT" "$TURN_ID" "$MODEL")

# Which events log, decided before anything is spent on the rest: a Claude
# Code Stop fires every turn and leaves here having run one process.
case "$EVENT" in
    PreCompact)
        MILESTONE="compaction_${TRIGGER}"
        DESCRIPTION="Context compaction (${TRIGGER}) — session at peak density"
        ;;
    SessionEnd)
        MILESTONE="session_end_${REASON}"
        DESCRIPTION="Session ended (${REASON})"
        ;;
    Stop)
        # Claude Code has a dedicated SessionEnd event. Its Stop event is a
        # turn boundary and would duplicate every response. Codex currently
        # exposes Stop but not SessionEnd, so preserve it as a provider-labeled
        # turn milestone rather than pretending the whole session ended.
        [ "$PROVIDER" = "codex" ] || exit 0
        MILESTONE="turn_stop"
        DESCRIPTION="Codex turn completed"
        ;;
    SubagentStop)
        case "$AGENT_TYPE" in
            Explore|Plan|general-purpose)
                MILESTONE="agent_${AGENT_TYPE}"
                DESCRIPTION="${AGENT_TYPE} agent completed"
                ;;
            *)
                exit 0  # Skip noisy agent types
                ;;
        esac
        ;;
    *)
        exit 0
        ;;
esac

# The host hands us the path it INTENDS for this session; it does not promise
# the file was ever written. Sessions that end abnormally (SessionEnd reason
# "other") frequently leave no transcript at all — 78% of those rows pointed at
# a nonexistent file, which is 97% of every broken link in the log. Record what
# we were told, but say plainly whether it resolves, so consumers can tell a
# reachable transcript from a remembered intention.
TRANSCRIPT_VERIFIED=false
[ -n "$TRANSCRIPT" ] && [ -f "$TRANSCRIPT" ] && TRANSCRIPT_VERIFIED=true

# Cross-event linkage: thread events into work-arcs. Looked up only for an
# event that logs — the per-turn Stop above never pays for it.
PARENT_ID=$(find_parent_event_id "$CHANGELOG" "$SESSION_ID" "$TIMESTAMP")

# The repo the session sits in and its real project name from one git call.
# A worktree's basename is a throwaway name; cartographer_repo resolves to the
# parent repo.
cartographer_repo "$CWD"
GIT_REPO=$CARTO_TOPLEVEL
PROJECT=$CARTO_PROJECT

DEEPLINK=""
# Only mint a deeplink we know resolves. An unopenable claude-history:// URL is
# indistinguishable from a working one until a human clicks it and gets nothing.
[ "$PROVIDER" = "claude" ] && [ "$TRANSCRIPT_VERIFIED" = true ] \
    && DEEPLINK="claude-history://session/${ENCODED_PATH}"

# Salience by milestone type — wrapups are deliberate strategic synthesis,
# compactions are mechanical noise. Tuning: docs/INDEXING_BACKLOG.md item #2.
case "$MILESTONE" in
  session_wrapup)   SALIENCE="0.9" ;;
  session_end_*)    SALIENCE="0.5" ;;
  compaction_*)     SALIENCE="0.4" ;;
  agent_*)          SALIENCE="0.4" ;;
  *)                SALIENCE="0.5" ;;
esac

# Git context for session-end and compaction events. The dirty count is the
# porcelain's line count and the recent list its lines joined with `|`, as
# `wc -l` and `paste -sd '|'` produced them, counted and joined in bash.
GIT_BRANCH=""
GIT_DIRTY=0
GIT_RECENT=""
if [ -n "$GIT_REPO" ]; then
    GIT_BRANCH=$(git -C "$GIT_REPO" branch --show-current 2>/dev/null || echo "detached")
    GIT_STATUS=$(git -C "$GIT_REPO" status --porcelain 2>/dev/null)
    if [ -n "$GIT_STATUS" ]; then
        while IFS= read -r _; do GIT_DIRTY=$((GIT_DIRTY + 1)); done <<EOF
$GIT_STATUS
EOF
    fi
    GIT_RECENT=$(git -C "$GIT_REPO" log --oneline -5 2>/dev/null)
    GIT_RECENT=${GIT_RECENT//
/|}
fi

# Count session events from changelog. grep -c prints "0" AND exits 1 on
# zero matches, so `|| echo 0` would yield "0\n0" — guard non-numeric so
# --argjson below never sees a multi-line value.
SESSION_EVENT_COUNT=0
if [ -f "$CHANGELOG" ] && [ -n "$SESSION_ID" ]; then
    SESSION_EVENT_COUNT=$(LC_ALL=C grep -c "$SESSION_ID" "$CHANGELOG" 2>/dev/null)
    case "$SESSION_EVENT_COUNT" in ''|*[!0-9]*) SESSION_EVENT_COUNT=0 ;; esac
fi

# A session-end row with no reachable transcript AND no logged activity records
# nothing that can ever be recalled: no conversation to open, no events to join
# to, no content indexed. Measured on a 15,000-row log, 7,646 such rows existed —
# 51% of the whole log — all from `session_end_other`, the abnormal-exit reason.
#
# The activity check is what makes this safe to drop rather than merely noisy.
# 79 rows had a dead transcript but real logged work behind them; those are a
# lost transcript over a genuine session and are kept. Only the intersection —
# nothing reachable and nothing done — is discarded.
#
# Scoped to session_end_* deliberately. That is where the evidence is; a
# subagent or compaction row with a zero count has not been shown to be noise.
case "$MILESTONE" in
    session_end_*)
        if [ "$TRANSCRIPT_VERIFIED" != true ] && [ "$SESSION_EVENT_COUNT" -eq 0 ]; then
            exit 0
        fi
        ;;
esac

EVENT_ID=$(cartographer_event_id)

# Build richer summary for changelog
if [ -n "$GIT_BRANCH" ]; then
    RICH_SUMMARY="${DESCRIPTION} [${GIT_BRANCH}, ${GIT_DIRTY} dirty, ${SESSION_EVENT_COUNT} events]"
else
    RICH_SUMMARY="${DESCRIPTION} [${SESSION_EVENT_COUNT} events]"
fi

# Both rows from one jq: the milestone row first, the changelog row second.
NL='
'
ROWS=$(jq -n -c \
    --arg eid "$EVENT_ID" \
    --arg ts "$TIMESTAMP" \
    --arg milestone "$MILESTONE" \
    --arg description "$DESCRIPTION" \
    --arg session "$SESSION_ID" \
    --arg provider "$PROVIDER" \
    --arg transcript "$TRANSCRIPT" \
    --argjson transcript_verified "$TRANSCRIPT_VERIFIED" \
    --arg deeplink "$DEEPLINK" \
    --arg project "$PROJECT" \
    --arg cwd "$CWD" \
    --arg event "$EVENT" \
    --arg branch "$GIT_BRANCH" \
    --argjson dirty "$GIT_DIRTY" \
    --arg recent_commits "$GIT_RECENT" \
    --argjson event_count "$SESSION_EVENT_COUNT" \
    --arg parent_id "$PARENT_ID" \
    --argjson salience "$SALIENCE" \
    --arg type "milestone_${MILESTONE}" \
    --arg summary "$RICH_SUMMARY" \
    '({event_id: $eid, timestamp: $ts, milestone: $milestone, provider: $provider, description: $description, session_id: $session, transcript_path: $transcript, transcript_verified: $transcript_verified, deeplink: $deeplink, project: $project, cwd: $cwd, event: $event, git_branch: $branch, git_dirty_files: $dirty, recent_commits: $recent_commits, session_event_count: $event_count, salience: $salience}
      + if $parent_id != "" then {parent_event_id: $parent_id} else {} end),
     ({event_id: $eid, timestamp: $ts, type: $type, provider: $provider, session_id: $session, project: $project, cwd: $cwd, deeplink: $deeplink, summary: $summary, transcript_path: $transcript, transcript_verified: $transcript_verified, related_ids: [], salience: $salience}
      + if $parent_id != "" then {parent_event_id: $parent_id} else {} end)')
case "$ROWS" in *"$NL"*) ;; *) exit 0 ;; esac
MILESTONE_ROW=${ROWS%%"$NL"*}
CHANGELOG_EVENT=${ROWS#*"$NL"}

printf '%s\n' "$MILESTONE_ROW" >> "$LOG_FILE"
printf '%s\n' "$CHANGELOG_EVENT" >> "$CHANGELOG"

# Real-time indexing (silent fail if services aren't running)
INDEXER=$(cartographer_script index-event.sh)
if [ -x "$INDEXER" ]; then
  printf '%s\n' "$CHANGELOG_EVENT" | "$INDEXER" &
fi

exit 0
