#!/usr/bin/env bash
# retro-index.sh — Batch ingestion of historical Claude Code transcripts
#
# Walks existing ~/.claude/projects transcripts and pipes messages into Qdrant
# via index-event.sh. Provides immediate semantic search capability on Day 1.
#
# Usage: ./retro-index.sh [--limit-days N] [--project NAME]

set -o pipefail

LIMIT_DAYS=""
PROJECT_FILTER=""

while [ $# -gt 0 ]; do
  case "$1" in
    --limit-days) LIMIT_DAYS="$2"; shift 2 ;;
    --project)    PROJECT_FILTER="$2"; shift 2 ;;
    *) shift ;;
  esac
done

TRANSCRIPTS="${CARTOGRAPHER_TRANSCRIPTS_DIR:-$HOME/.claude/projects}"
SCRIPT_DIR="$(dirname "$0")"
INDEXER="$SCRIPT_DIR/index-event.sh"
TURN_GROUPER="$SCRIPT_DIR/transcript-to-turns.awk"

if [ ! -x "$INDEXER" ]; then
    echo "Error: Cannot find executable index-event.sh at $INDEXER"
    exit 1
fi

if [ ! -f "$TURN_GROUPER" ]; then
    echo "Error: Cannot find $TURN_GROUPER"
    exit 1
fi

echo "Starting historical backfill..."
[ -n "$LIMIT_DAYS" ] && echo "Limiting to transcripts modified in the last $LIMIT_DAYS days."

FIND_ARGS=()
[ -n "$LIMIT_DAYS" ] && FIND_ARGS+=("-mtime" "-$LIMIT_DAYS")

total_indexed=0

# Walk the transcripts directory
while IFS= read -r transcript; do
    [ -z "$transcript" ] && continue
    
    project_dir=$(basename "$(dirname "$transcript")")
    session_file=$(basename "$transcript")
    session_id="${session_file%.jsonl}"

    if [ -n "$PROJECT_FILTER" ]; then
        echo "$project_dir" | grep -qi "$PROJECT_FILTER" || continue
    fi

    echo "Indexing session: $session_id ($project_dir)"

    # Turn-group the transcript, then ship one event per turn to Qdrant.
    # Turn event_ids are deterministic (turn-<sid>-<idx>), so reruns and
    # parallel reconstruct-history.js runs dedupe cleanly via the point-id hash.
    awk -f "$TURN_GROUPER" \
        -v sid="$session_id" -v proj="$project_dir" -v tpath="$transcript" \
        "$transcript" 2>/dev/null | \
    while IFS= read -r payload; do
        [ -z "$payload" ] && continue
        echo "$payload" | "$INDEXER"
        total_indexed=$((total_indexed + 1))
    done

done < <(find "$TRANSCRIPTS" -mindepth 2 -maxdepth 2 -name "*.jsonl" -type f "${FIND_ARGS[@]}" 2>/dev/null || true)

echo "Retro-indexing complete! Backfilled $total_indexed historical turns."
