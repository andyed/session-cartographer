#!/bin/bash
# Lifecycle hook: generates a structured handoff briefing on session end
# and a compaction snapshot on PreCompact.
#
# Inspired by session-wizard's "last-session.md" concept — but compiled from
# cartographer's own JSONL event logs rather than a parallel system.
#
# Triggers:
#   SessionEnd  → writes last-session.md (full session summary + git state)
#   PreCompact  → appends a compaction snapshot to last-session.md (preserves
#                 what's about to be lost from context)
#
# Output: $DEV/<project>/last-session.md (overwritten per session)
# Environment: CARTOGRAPHER_DEV_DIR overrides ~/Documents/dev

set -euo pipefail

DEV="${CARTOGRAPHER_DEV_DIR:-$HOME/Documents/dev}"
CHANGELOG="$DEV/changelog.jsonl"
RESEARCH_LOG="$DEV/research-log.jsonl"
TOOL_LOG="$DEV/tool-use-log.jsonl"
INPUT=$(cat)

EVENT=$(echo "$INPUT" | jq -r '.hook_event_name // empty')
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty')
CWD=$(echo "$INPUT" | jq -r '.cwd // empty')
TRANSCRIPT=$(echo "$INPUT" | jq -r '.transcript_path // empty')
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

[ -z "$EVENT" ] && exit 0
[ -z "$SESSION_ID" ] && exit 0

GIT_REPO=$(cd "$CWD" 2>/dev/null && git rev-parse --show-toplevel 2>/dev/null) || true
if [ -n "$GIT_REPO" ]; then
    PROJECT=$(basename "$GIT_REPO")
else
    PROJECT=$(basename "$CWD")
fi

BRIEFING_DIR="$DEV/$PROJECT"
mkdir -p "$BRIEFING_DIR"
BRIEFING_FILE="$BRIEFING_DIR/last-session.md"

# --- Helper: extract session events from a JSONL file ---
session_events() {
    local file="$1"
    [ -f "$file" ] || return 0
    LC_ALL=C grep -F "$SESSION_ID" "$file" 2>/dev/null || true
}

# --- Helper: format changelog entries as bullet points ---
format_changelog() {
    local events="$1"
    [ -z "$events" ] && return 0
    echo "$events" | jq -r '
        select(.session_id == "'"$SESSION_ID"'") |
        "- **" + .type + "**: " + (.summary // .description // "(no summary)")
    ' 2>/dev/null || true
}

# --- Helper: format research entries ---
format_research() {
    local events="$1"
    [ -z "$events" ] && return 0
    echo "$events" | jq -r '
        select(.session == "'"$SESSION_ID"'") |
        if .type == "fetch" then
            "- [" + (.category // "other") + "] Fetched: " + (.url // "(unknown)")
        elif .type == "search" then
            "- Searched: \"" + (.query // "(unknown)") + "\""
        else empty end
    ' 2>/dev/null || true
}

# --- Helper: format tool-use entries ---
format_tools() {
    local events="$1"
    [ -z "$events" ] && return 0
    echo "$events" | jq -r '
        select(.session == "'"$SESSION_ID"'") |
        if .type == "git_commit" then
            "- **commit** " + (.summary // "(no message)")
        elif .type == "git_push" then
            "- **push** " + (.summary // "")
        else
            "- " + (.type // "tool") + ": " + (.summary // "(no summary)")
        end
    ' 2>/dev/null | head -30 || true
}

# --- Git state snapshot ---
git_state() {
    [ -z "$GIT_REPO" ] && return 0
    local branch dirty_count

    branch=$(git -C "$GIT_REPO" branch --show-current 2>/dev/null || echo "detached")
    dirty_count=$(git -C "$GIT_REPO" status --porcelain 2>/dev/null | wc -l | tr -d ' ')

    echo "**Branch:** \`$branch\`"

    if [ "$dirty_count" -gt 0 ]; then
        echo "**Dirty files:** $dirty_count"
        echo '```'
        git -C "$GIT_REPO" status --porcelain 2>/dev/null | head -15
        [ "$dirty_count" -gt 15 ] && echo "... and $((dirty_count - 15)) more"
        echo '```'
    else
        echo "**Working tree:** clean"
    fi

    echo ""
    echo "**Recent commits (this session):**"
    echo '```'
    git -C "$GIT_REPO" log --oneline -8 2>/dev/null || echo "(no commits)"
    echo '```'
}

# --- Gather session data ---
CHANGELOG_EVENTS=$(session_events "$CHANGELOG")
RESEARCH_EVENTS=$(session_events "$RESEARCH_LOG")
TOOL_EVENTS=$(session_events "$TOOL_LOG")

ACTIVITY=$(format_changelog "$CHANGELOG_EVENTS")
RESEARCH=$(format_research "$RESEARCH_EVENTS")
TOOLS=$(format_tools "$TOOL_EVENTS")

case "$EVENT" in
    SessionEnd)
        REASON=$(echo "$INPUT" | jq -r '.reason // "unknown"')

        cat > "$BRIEFING_FILE" <<BRIEFING_EOF
# Last Session — $PROJECT
_Session ended: $TIMESTAMP ($REASON)_
_Session ID: \`${SESSION_ID:0:12}…\`_

## Git State
$(git_state)

## Session Activity
${ACTIVITY:-_No changelog events recorded._}

BRIEFING_EOF

        # Research section (only if non-empty)
        if [ -n "$RESEARCH" ]; then
            cat >> "$BRIEFING_FILE" <<BRIEFING_EOF
## Research
$RESEARCH

BRIEFING_EOF
        fi

        # Tool use section (only if non-empty)
        if [ -n "$TOOLS" ]; then
            cat >> "$BRIEFING_FILE" <<BRIEFING_EOF
## Key Changes
$TOOLS

BRIEFING_EOF
        fi

        # Transcript pointer
        if [ -n "$TRANSCRIPT" ]; then
            cat >> "$BRIEFING_FILE" <<BRIEFING_EOF
## Transcript
\`$TRANSCRIPT\`
BRIEFING_EOF
        fi
        ;;

    PreCompact)
        TRIGGER=$(echo "$INPUT" | jq -r '.trigger // "unknown"')

        # If briefing already exists, append a compaction snapshot
        # If not, start a new one — this captures state before context is lost
        if [ -f "$BRIEFING_FILE" ]; then
            cat >> "$BRIEFING_FILE" <<BRIEFING_EOF

---

## Compaction Snapshot ($TRIGGER) — $TIMESTAMP
_Context compaction triggered. State captured before detail is lost._

### Activity Since Last Snapshot
${ACTIVITY:-_No new changelog events._}

### Git State at Compaction
$(git_state)
BRIEFING_EOF
        else
            cat > "$BRIEFING_FILE" <<BRIEFING_EOF
# Session Briefing — $PROJECT
_Started: session \`${SESSION_ID:0:12}…\`_

## Compaction Snapshot ($TRIGGER) — $TIMESTAMP
_Context compaction triggered. State captured before detail is lost._

### Git State
$(git_state)

### Session Activity So Far
${ACTIVITY:-_No changelog events recorded yet._}

BRIEFING_EOF

            if [ -n "$RESEARCH" ]; then
                cat >> "$BRIEFING_FILE" <<BRIEFING_EOF
### Research So Far
$RESEARCH

BRIEFING_EOF
            fi
        fi
        ;;

    *)
        exit 0
        ;;
esac

exit 0
