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
PROJECT=$(basename "$CWD")
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

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
    --arg event "$EVENT" \
    '{event_id: $eid, timestamp: $ts, milestone: $milestone, description: $description, session_id: $session, transcript_path: $transcript, deeplink: $deeplink, project: $project, event: $event}' \
    >> "$LOG_FILE"

# Write to unified changelog
jq -n -c \
    --arg eid "$EVENT_ID" \
    --arg ts "$TIMESTAMP" \
    --arg type "milestone_${MILESTONE}" \
    --arg session "$SESSION_ID" \
    --arg project "$PROJECT" \
    --arg deeplink "$DEEPLINK" \
    --arg summary "$DESCRIPTION" \
    '{event_id: $eid, timestamp: $ts, type: $type, session_id: $session, project: $project, deeplink: $deeplink, summary: $summary, related_ids: []}' \
    >> "$CHANGELOG"

# Real-time indexing (silent fail if services aren't running)
INDEXER="$(dirname "$0")/../../../scripts/index-event.sh"
if [ -x "$INDEXER" ]; then
  tail -1 "$CHANGELOG" | "$INDEXER" &
fi

exit 0
