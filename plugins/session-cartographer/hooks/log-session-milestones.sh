#!/bin/bash
# Lifecycle hook: logs session milestones with deep link info.
# Creates a timeline of "session bookmarks" for claude-code-history-viewer.
#
# Milestones logged:
#   - PreCompact (auto/manual) — context is full, about to lose detail
#   - SessionEnd — natural session close
#   - SubagentStop — research/explore agents completing work
#
# Output: session-milestones.jsonl + changelog.jsonl
# Environment: CARTOGRAPHER_DEV_DIR overrides ~/Documents/dev

DEV="${CARTOGRAPHER_DEV_DIR:-$HOME/Documents/dev}"
LOG_FILE="$DEV/session-milestones.jsonl"
CHANGELOG="$DEV/changelog.jsonl"
INPUT=$(cat)
EVENT_ID="evt-$(LC_ALL=C tr -dc 'a-z0-9' < /dev/urandom | head -c 12)"

EVENT=$(echo "$INPUT" | jq -r '.hook_event_name // empty')
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty')
TRANSCRIPT=$(echo "$INPUT" | jq -r '.transcript_path // empty')
CWD=$(echo "$INPUT" | jq -r '.cwd // empty')
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# Cross-event linkage: thread events into work-arcs.
. "$(dirname "$0")/common.sh"
PARENT_ID=$(find_parent_event_id "$CHANGELOG" "$SESSION_ID" "$TIMESTAMP")

GIT_REPO=$(cd "$CWD" 2>/dev/null && git rev-parse --show-toplevel 2>/dev/null)
if [ -n "$GIT_REPO" ]; then
    PROJECT=$(basename "$GIT_REPO")
else
    PROJECT=$(basename "$CWD")
fi

# Encode the transcript path for URL safety
ENCODED_PATH=$(echo "$TRANSCRIPT" | python3 -c "import sys, urllib.parse; print(urllib.parse.quote(sys.stdin.read().strip(), safe=''))" 2>/dev/null || echo "$TRANSCRIPT")

case "$EVENT" in
    PreCompact)
        TRIGGER=$(echo "$INPUT" | jq -r '.trigger // "unknown"')
        MILESTONE="compaction_${TRIGGER}"
        DESCRIPTION="Context compaction (${TRIGGER}) — session at peak density"
        ;;
    SessionEnd)
        REASON=$(echo "$INPUT" | jq -r '.reason // "unknown"')
        MILESTONE="session_end_${REASON}"
        DESCRIPTION="Session ended (${REASON})"
        ;;
    SubagentStop)
        AGENT_TYPE=$(echo "$INPUT" | jq -r '.agent_type // "unknown"')
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

DEEPLINK="claude-history://session/${ENCODED_PATH}"

# Salience by milestone type — wrapups are deliberate strategic synthesis,
# compactions are mechanical noise. Tuning: docs/INDEXING_BACKLOG.md item #2.
case "$MILESTONE" in
  session_wrapup)   SALIENCE="0.9" ;;
  session_end_*)    SALIENCE="0.5" ;;
  compaction_*)     SALIENCE="0.4" ;;
  agent_*)          SALIENCE="0.4" ;;
  *)                SALIENCE="0.5" ;;
esac

# Git context for session-end and compaction events
GIT_BRANCH=""
GIT_DIRTY=0
GIT_RECENT=""
if [ -n "$GIT_REPO" ]; then
    GIT_BRANCH=$(git -C "$GIT_REPO" branch --show-current 2>/dev/null || echo "detached")
    GIT_DIRTY=$(git -C "$GIT_REPO" status --porcelain 2>/dev/null | wc -l | tr -d ' ')
    GIT_RECENT=$(git -C "$GIT_REPO" log --oneline -5 2>/dev/null | paste -sd '|' - || true)
fi

# Count session events from changelog
SESSION_EVENT_COUNT=0
if [ -f "$CHANGELOG" ] && [ -n "$SESSION_ID" ]; then
    SESSION_EVENT_COUNT=$(LC_ALL=C grep -c "$SESSION_ID" "$CHANGELOG" 2>/dev/null || echo 0)
fi

# Write to milestones log
jq -n -c \
    --arg eid "$EVENT_ID" \
    --arg ts "$TIMESTAMP" \
    --arg milestone "$MILESTONE" \
    --arg description "$DESCRIPTION" \
    --arg session "$SESSION_ID" \
    --arg transcript "$TRANSCRIPT" \
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
    '{event_id: $eid, timestamp: $ts, milestone: $milestone, description: $description, session_id: $session, transcript_path: $transcript, deeplink: $deeplink, project: $project, cwd: $cwd, event: $event, git_branch: $branch, git_dirty_files: $dirty, recent_commits: $recent_commits, session_event_count: $event_count, salience: $salience}
     + if $parent_id != "" then {parent_event_id: $parent_id} else {} end' \
    >> "$LOG_FILE"

# Build richer summary for changelog
if [ -n "$GIT_BRANCH" ]; then
    RICH_SUMMARY="${DESCRIPTION} [${GIT_BRANCH}, ${GIT_DIRTY} dirty, ${SESSION_EVENT_COUNT} events]"
else
    RICH_SUMMARY="${DESCRIPTION} [${SESSION_EVENT_COUNT} events]"
fi

# Write to unified changelog
jq -n -c \
    --arg eid "$EVENT_ID" \
    --arg ts "$TIMESTAMP" \
    --arg type "milestone_${MILESTONE}" \
    --arg session "$SESSION_ID" \
    --arg project "$PROJECT" \
    --arg cwd "$CWD" \
    --arg deeplink "$DEEPLINK" \
    --arg summary "$RICH_SUMMARY" \
    --arg transcript "$TRANSCRIPT" \
    --arg parent_id "$PARENT_ID" \
    --argjson salience "$SALIENCE" \
    '{event_id: $eid, timestamp: $ts, type: $type, session_id: $session, project: $project, cwd: $cwd, deeplink: $deeplink, summary: $summary, transcript_path: $transcript, related_ids: [], salience: $salience}
     + if $parent_id != "" then {parent_event_id: $parent_id} else {} end' \
    >> "$CHANGELOG"

# Real-time indexing (silent fail if services aren't running)
INDEXER="$(dirname "$0")/../../../scripts/index-event.sh"
if [ -x "$INDEXER" ]; then
  tail -1 "$CHANGELOG" | "$INDEXER" &
fi

exit 0
