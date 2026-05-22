#!/usr/bin/env bash
# retro-index.sh — Batch ingestion of historical Claude Code transcripts
#
# Walks existing ~/.claude/projects transcripts and pipes turns into Qdrant
# via index-event.sh. Provides immediate semantic search capability on Day 1.
#
# Resumable: each session is checkpointed — by id + transcript mtime — to
# $CARTOGRAPHER_DEV_DIR/.carto/retro-index-progress once it finishes. A run
# killed partway through (common on a multi-hour full-history backfill) skips
# the completed sessions when restarted; only the interrupted session onward
# is reprocessed. Pass --fresh to clear the checkpoint and reindex everything.
#
# Usage: ./retro-index.sh [--limit-days N] [--project NAME] [--fresh]

set -o pipefail

LIMIT_DAYS=""
PROJECT_FILTER=""
FRESH=0

while [ $# -gt 0 ]; do
  case "$1" in
    --limit-days) LIMIT_DAYS="$2"; shift 2 ;;
    --project)    PROJECT_FILTER="$2"; shift 2 ;;
    --fresh)      FRESH=1; shift ;;
    *) shift ;;
  esac
done

TRANSCRIPTS="${CARTOGRAPHER_TRANSCRIPTS_DIR:-$HOME/.claude/projects}"
SCRIPT_DIR="$(dirname "$0")"
INDEXER="$SCRIPT_DIR/index-event.sh"
TURN_GROUPER="$SCRIPT_DIR/transcript-to-turns.awk"

# Resume checkpoint — lives alongside the carto event logs.
DEV="${CARTOGRAPHER_DEV_DIR:-$HOME/Documents/dev}"
STATE_DIR="$DEV/.carto"
PROGRESS_FILE="$STATE_DIR/retro-index-progress"

if [ ! -x "$INDEXER" ]; then
    echo "Error: Cannot find executable index-event.sh at $INDEXER"
    exit 1
fi

if [ ! -f "$TURN_GROUPER" ]; then
    echo "Error: Cannot find $TURN_GROUPER"
    exit 1
fi

# Portable file mtime in epoch seconds — BSD stat (macOS), then GNU stat.
file_mtime() {
    stat -f %m "$1" 2>/dev/null || stat -c %Y "$1" 2>/dev/null || echo 0
}

mkdir -p "$STATE_DIR"
if [ "$FRESH" = "1" ]; then
    : > "$PROGRESS_FILE"
    echo "Fresh run — resume checkpoint cleared."
elif [ -s "$PROGRESS_FILE" ]; then
    already=$(wc -l < "$PROGRESS_FILE" | tr -d ' ')
    echo "Resuming — $already already-indexed session(s) will be skipped (--fresh to reindex all)."
fi

echo "Starting historical backfill..."
[ -n "$LIMIT_DAYS" ] && echo "Limiting to transcripts modified in the last $LIMIT_DAYS days."

FIND_ARGS=()
[ -n "$LIMIT_DAYS" ] && FIND_ARGS+=("-mtime" "-$LIMIT_DAYS")

COUNTER_FILE=$(mktemp)
SKIPPED_FILE=$(mktemp)
trap 'rm -f "$COUNTER_FILE" "$SKIPPED_FILE"' EXIT
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

    # Resume check — skip a session already indexed at this transcript mtime.
    # A transcript that has grown since (new mtime) is reprocessed; the overlap
    # dedupes in Qdrant via the deterministic turn-<sid>-<idx> point IDs.
    progress_key="$session_id $(file_mtime "$transcript")"
    if grep -qxF "$progress_key" "$PROGRESS_FILE" 2>/dev/null; then
        echo "Skipping (already indexed): $session_id ($project_dir)"
        echo 1 >> "$SKIPPED_FILE"
        continue
    fi

    echo "Indexing session: $session_id ($project_dir)"

    # Turn-group the transcript, then ship one event per turn to Qdrant.
    # Turn event_ids are deterministic (turn-<sid>-<idx>), so reruns and
    # parallel reconstruct-history.js runs dedupe cleanly via the point-id hash.
    # Piping through a while loop would put the counter in a subshell where
    # increments don't propagate; write to a counter file and sum at the end.
    awk -f "$TURN_GROUPER" \
        -v sid="$session_id" -v proj="$project_dir" -v tpath="$transcript" \
        "$transcript" 2>/dev/null | \
    while IFS= read -r payload; do
        [ -z "$payload" ] && continue
        echo "$payload" | "$INDEXER"
        echo 1 >> "$COUNTER_FILE"
    done

    # Checkpoint only after the whole session is walked. A mid-session kill
    # never reaches this line, so the session is reprocessed — not lost — on
    # the next run, while every session before it stays skipped.
    echo "$progress_key" >> "$PROGRESS_FILE"

done < <(find "$TRANSCRIPTS" -mindepth 2 -maxdepth 2 -name "*.jsonl" -type f "${FIND_ARGS[@]}" 2>/dev/null || true)

total_indexed=$(wc -l < "$COUNTER_FILE" | tr -d ' ')
total_skipped=$(wc -l < "$SKIPPED_FILE" | tr -d ' ')
rm -f "$COUNTER_FILE" "$SKIPPED_FILE"
echo "Retro-indexing complete! Backfilled $total_indexed turns; skipped $total_skipped already-indexed session(s)."
