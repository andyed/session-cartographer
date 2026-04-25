#!/bin/bash
# PostToolUse hook: logs WebFetch and WebSearch to research-log.jsonl.
# Receives JSON on stdin with tool_input + tool_response (PostToolUse schema).
#
# Logs:
#   WebFetch  → one "fetch" entry with URL, prompt, auto-categorized
#   WebSearch → one "search" entry (query) + one "search_result" per result URL
#
# Categories (auto-detected from URL domain):
#   research  — arxiv, pubmed, pmc, jov, biorxiv, semanticscholar, springer, elifesciences
#   docs      — github.com (repos/docs), MDN, official docs sites
#   blog      — medium, dev.to, substack, *.blog, wordpress
#   news      — news sites, sciencedaily, arstechnica, hackernews
#   reference — wikipedia, stackexchange, stackoverflow
#   other     — everything else
#
# Environment: CARTOGRAPHER_DEV_DIR overrides ~/Documents/dev

DEV="${CARTOGRAPHER_DEV_DIR:-$HOME/Documents/dev}"
LOG_FILE="$DEV/research-log.jsonl"
CHANGELOG="$DEV/changelog.jsonl"
INPUT=$(cat)
EVENT_ID="evt-$(LC_ALL=C tr -dc 'a-z0-9' < /dev/urandom | head -c 12)"

# Cross-event linkage: thread events into work-arcs. Parent computed against
# the unified changelog so chains can span event types in the same session.
. "$(dirname "$0")/common.sh"

TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty')
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty')
TRANSCRIPT=$(echo "$INPUT" | jq -r '.transcript_path // empty')
CWD=$(echo "$INPUT" | jq -r '.cwd // empty')
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

GIT_REPO=$(cd "$CWD" 2>/dev/null && git rev-parse --show-toplevel 2>/dev/null)
if [ -n "$GIT_REPO" ]; then
    PROJECT=$(basename "$GIT_REPO")
else
    PROJECT=$(basename "$CWD")
fi

# Auto-categorize URL by domain
categorize_url() {
    local url="$1"
    local lower=$(echo "$url" | tr '[:upper:]' '[:lower:]')
    case "$lower" in
        *arxiv.org*|*pubmed*|*pmc.ncbi*|*jov.arvojournals*|*biorxiv.org*|*semanticscholar*|*springer.com/article*|*elifesciences.org*|*researchgate.net/publication*|*dspace.mit.edu*|*cvrl.org*|*ncbi.nlm.nih.gov/books*|*sciencedirect.com*)
            echo "research" ;;
        *github.com*|*docs.*|*developer.*|*mdn.*|*readthedocs*|*deepwiki.com*)
            echo "docs" ;;
        *medium.com*|*dev.to*|*substack.com*|*.blog*|*wordpress*|*humanlayer.dev/blog*|*gend.co/blog*|*promptlayer.com*|*eesel.ai/blog*|*smartscope.blog*|*boxesandarrows.com*)
            echo "blog" ;;
        *news.*|*sciencedaily*|*arstechnica*|*theverge*|*wired.com*|*techcrunch*|*hackernews*|*news.ycombinator*)
            echo "news" ;;
        *wikipedia.org*|*stackoverflow.com*|*stackexchange.com*)
            echo "reference" ;;
        *)
            echo "other" ;;
    esac
}

PARENT_ID=$(find_parent_event_id "$CHANGELOG" "$SESSION_ID" "$TIMESTAMP")

if [ "$TOOL_NAME" = "WebFetch" ]; then
    URL=$(echo "$INPUT" | jq -r '.tool_input.url // empty')
    PROMPT=$(echo "$INPUT" | jq -r '.tool_input.prompt // empty')
    CATEGORY=$(categorize_url "$URL")

    jq -n -c \
        --arg eid "$EVENT_ID" \
        --arg ts "$TIMESTAMP" \
        --arg type "fetch" \
        --arg url "$URL" \
        --arg prompt "$PROMPT" \
        --arg category "$CATEGORY" \
        --arg project "$PROJECT" \
        --arg cwd "$CWD" \
        --arg session "$SESSION_ID" \
        --arg transcript "$TRANSCRIPT" \
        --arg parent_id "$PARENT_ID" \
        '{event_id: $eid, timestamp: $ts, type: $type, url: $url, prompt: $prompt, category: $category, project: $project, cwd: $cwd, session: $session, transcript_path: $transcript}
         + if $parent_id != "" then {parent_event_id: $parent_id} else {} end' \
        >> "$LOG_FILE"

    # Changelog envelope
    jq -n -c \
        --arg eid "$EVENT_ID" \
        --arg ts "$TIMESTAMP" \
        --arg session "$SESSION_ID" \
        --arg project "$PROJECT" \
        --arg cwd "$CWD" \
        --arg summary "Fetched: $URL" \
        --arg transcript "$TRANSCRIPT" \
        --arg parent_id "$PARENT_ID" \
        '{event_id: $eid, timestamp: $ts, type: "research_fetch", session_id: $session, project: $project, cwd: $cwd, summary: $summary, transcript_path: $transcript, related_ids: []}
         + if $parent_id != "" then {parent_event_id: $parent_id} else {} end' \
        >> "$CHANGELOG"

elif [ "$TOOL_NAME" = "WebSearch" ]; then
    QUERY=$(echo "$INPUT" | jq -r '.tool_input.query // empty')

    # Log the search query itself
    SEARCH_EVENT_ID="evt-$(LC_ALL=C tr -dc 'a-z0-9' < /dev/urandom | head -c 12)"
    jq -n -c \
        --arg eid "$SEARCH_EVENT_ID" \
        --arg ts "$TIMESTAMP" \
        --arg type "search" \
        --arg query "$QUERY" \
        --arg project "$PROJECT" \
        --arg cwd "$CWD" \
        --arg session "$SESSION_ID" \
        --arg transcript "$TRANSCRIPT" \
        --arg parent_id "$PARENT_ID" \
        '{event_id: $eid, timestamp: $ts, type: $type, query: $query, project: $project, cwd: $cwd, session: $session, transcript_path: $transcript}
         + if $parent_id != "" then {parent_event_id: $parent_id} else {} end' \
        >> "$LOG_FILE"

    # Changelog envelope
    jq -n -c \
        --arg eid "$SEARCH_EVENT_ID" \
        --arg ts "$TIMESTAMP" \
        --arg session "$SESSION_ID" \
        --arg project "$PROJECT" \
        --arg cwd "$CWD" \
        --arg summary "Search: $QUERY" \
        --arg transcript "$TRANSCRIPT" \
        --arg parent_id "$PARENT_ID" \
        '{event_id: $eid, timestamp: $ts, type: "research_search", session_id: $session, project: $project, cwd: $cwd, summary: $summary, transcript_path: $transcript, related_ids: []}
         + if $parent_id != "" then {parent_event_id: $parent_id} else {} end' \
        >> "$CHANGELOG"

    # Extract result URLs from tool_response and log each as search_result
    echo "$INPUT" | jq -r '
        .tool_response // empty |
        if type == "string" then
            (try fromjson catch null)
        else
            .
        end |
        if type == "array" then .[]
        elif type == "object" then .links // .results // [] | .[]
        else empty
        end |
        .url // empty
    ' 2>/dev/null | while IFS= read -r RESULT_URL; do
        [ -z "$RESULT_URL" ] && continue
        CATEGORY=$(categorize_url "$RESULT_URL")
        TITLE=$(echo "$INPUT" | jq -r --arg url "$RESULT_URL" '
            .tool_response // "" |
            if type == "string" then (try fromjson catch null) else . end |
            if type == "array" then .[] elif type == "object" then .links // .results // [] | .[] else empty end |
            select(.url == $url) | .title // ""
        ' 2>/dev/null | head -1)

        RESULT_EVENT_ID="evt-$(LC_ALL=C tr -dc 'a-z0-9' < /dev/urandom | head -c 12)"
        # Search results parent to the search event itself (intra-fanout linkage),
        # which already lives in related_ids. parent_event_id keeps the cross-
        # event chain coherent — set to the search event for the same reason.
        jq -n -c \
            --arg eid "$RESULT_EVENT_ID" \
            --arg ts "$TIMESTAMP" \
            --arg type "search_result" \
            --arg url "$RESULT_URL" \
            --arg title "$TITLE" \
            --arg query "$QUERY" \
            --arg category "$CATEGORY" \
            --arg project "$PROJECT" \
            --arg cwd "$CWD" \
            --arg session "$SESSION_ID" \
            --arg transcript "$TRANSCRIPT" \
            --arg parent "$SEARCH_EVENT_ID" \
            '{event_id: $eid, timestamp: $ts, type: $type, url: $url, title: $title, query: $query, category: $category, project: $project, cwd: $cwd, session: $session, transcript_path: $transcript, related_ids: [$parent], parent_event_id: $parent}' \
            >> "$LOG_FILE"
    done
fi

# Real-time indexing (silent fail if services aren't running)
INDEXER="$(dirname "$0")/../../../scripts/index-event.sh"
if [ -x "$INDEXER" ]; then
  tail -1 "$CHANGELOG" | "$INDEXER" &
fi

# Always exit 0 — this is a passive logger, never blocks
exit 0
