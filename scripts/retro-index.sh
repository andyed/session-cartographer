#!/usr/bin/env bash
# retro-index.sh — Batch ingestion of Claude Code and Codex transcripts
#
# Walks both provider transcript stores and pipes normalized turns into Qdrant
# via index-event.sh. The index is intentionally shared: either agent can
# recall work produced by the other.
#
# Resumable: each session is checkpointed — by id + transcript mtime — to
# $CARTOGRAPHER_DEV_DIR/.carto/retro-index-progress once it finishes. A run
# killed partway through (common on a multi-hour full-history backfill) skips
# the completed sessions when restarted; only the interrupted session onward
# is reprocessed. Pass --fresh to clear the checkpoint and reindex everything.
#
# Usage: ./retro-index.sh [--provider all|claude|codex] [--limit-days N]
#                         [--project NAME] [--transcript PATH] [--fresh]

set -o pipefail

LIMIT_DAYS=""
PROJECT_FILTER=""
FRESH=0
PROVIDER_FILTER="all"
TRANSCRIPT_FILTER=""

while [ $# -gt 0 ]; do
  case "$1" in
    --limit-days) LIMIT_DAYS="$2"; shift 2 ;;
    --project)    PROJECT_FILTER="$2"; shift 2 ;;
    --provider)   PROVIDER_FILTER="$2"; shift 2 ;;
    --transcript) TRANSCRIPT_FILTER="$2"; shift 2 ;;
    --fresh)      FRESH=1; shift ;;
    *) shift ;;
  esac
done

case "$PROVIDER_FILTER" in
  all|claude|codex) ;;
  *) echo "Error: --provider must be all, claude, or codex"; exit 2 ;;
esac

# CARTOGRAPHER_TRANSCRIPTS_DIR remains the backwards-compatible Claude
# override. New code should prefer the provider-specific variables.
CLAUDE_TRANSCRIPTS="${CARTOGRAPHER_CLAUDE_TRANSCRIPTS_DIR:-${CARTOGRAPHER_TRANSCRIPTS_DIR:-$HOME/.claude/projects}}"
CODEX_TRANSCRIPTS="${CARTOGRAPHER_CODEX_TRANSCRIPTS_DIR:-$HOME/.codex/sessions}"
SCRIPT_DIR="$(dirname "$0")"
INDEXER="$SCRIPT_DIR/index-event.sh"
CLAUDE_TURN_GROUPER="$SCRIPT_DIR/transcript-to-turns.awk"
CODEX_TURN_GROUPER="$SCRIPT_DIR/codex-transcript-to-turns.awk"
CODEX_PROJECT_INFERER="$SCRIPT_DIR/infer-codex-project.js"

# Resume checkpoint — lives alongside the carto event logs.
DEV="${CARTOGRAPHER_DEV_DIR:-$HOME/Documents/dev}"
STATE_DIR="$DEV/.carto"
PROGRESS_FILE="$STATE_DIR/retro-index-progress"

if [ ! -x "$INDEXER" ]; then
    echo "Error: Cannot find executable index-event.sh at $INDEXER"
    exit 1
fi

for turn_grouper in "$CLAUDE_TURN_GROUPER" "$CODEX_TURN_GROUPER"; do
    if [ ! -f "$turn_grouper" ]; then
        echo "Error: Cannot find $turn_grouper"
        exit 1
    fi
done

if [ ! -f "$CODEX_PROJECT_INFERER" ]; then
    echo "Error: Cannot find $CODEX_PROJECT_INFERER"
    exit 1
fi

if [ -n "$TRANSCRIPT_FILTER" ] && [ ! -f "$TRANSCRIPT_FILTER" ]; then
    echo "Error: --transcript path does not exist: $TRANSCRIPT_FILTER"
    exit 2
fi
if [ -n "$TRANSCRIPT_FILTER" ] && [ "$PROVIDER_FILTER" = "all" ]; then
    echo "Error: --transcript requires --provider claude or --provider codex"
    exit 2
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
[ "$PROVIDER_FILTER" != "all" ] && echo "Provider filter: $PROVIDER_FILTER"
[ -n "$LIMIT_DAYS" ] && echo "Limiting to transcripts modified in the last $LIMIT_DAYS days."

FIND_ARGS=()
[ -n "$LIMIT_DAYS" ] && FIND_ARGS+=("-mtime" "-$LIMIT_DAYS")

COUNTER_FILE=$(mktemp)
SKIPPED_FILE=$(mktemp)
FAILED_FILE=$(mktemp)
SESSION_FAILED_FILE=$(mktemp)
trap 'rm -f "$COUNTER_FILE" "$SKIPPED_FILE" "$FAILED_FILE" "$SESSION_FAILED_FILE"' EXIT
total_indexed=0

# Emit provider + path pairs. Provider is metadata on every normalized turn,
# never a separate index or collection.
discover_transcripts() {
    if [ -n "$TRANSCRIPT_FILTER" ]; then
        printf '%s\t%s\n' "$PROVIDER_FILTER" "$TRANSCRIPT_FILTER"
        return
    fi
    if [ "$PROVIDER_FILTER" = "all" ] || [ "$PROVIDER_FILTER" = "claude" ]; then
        find "$CLAUDE_TRANSCRIPTS" -mindepth 2 -maxdepth 2 -name "*.jsonl" -type f "${FIND_ARGS[@]}" -print 2>/dev/null | \
        while IFS= read -r path; do printf 'claude\t%s\n' "$path"; done
    fi
    if [ "$PROVIDER_FILTER" = "all" ] || [ "$PROVIDER_FILTER" = "codex" ]; then
        find "$CODEX_TRANSCRIPTS" -name "*.jsonl" -type f "${FIND_ARGS[@]}" -print 2>/dev/null | \
        while IFS= read -r path; do printf 'codex\t%s\n' "$path"; done
    fi
}

while IFS=$'\t' read -r provider transcript; do
    [ -z "$transcript" ] && continue

    session_file=$(basename "$transcript")
    if [ "$provider" = "codex" ]; then
        session_id=$(jq -r 'select(.type == "session_meta") | .payload.id // .payload.session_id // empty' "$transcript" 2>/dev/null | head -1)
        session_id="${session_id:-${session_file%.jsonl}}"
        session_cwd=$(jq -r 'select(.type == "session_meta") | .payload.cwd // empty' "$transcript" 2>/dev/null | head -1)
        project_dir=$(node "$CODEX_PROJECT_INFERER" "$transcript" "$DEV" 2>/dev/null)
        project_dir="${project_dir:-$(basename "${session_cwd:-$(dirname "$transcript")}")}"
        turn_grouper="$CODEX_TURN_GROUPER"
    else
        project_dir=$(basename "$(dirname "$transcript")")
        session_id="${session_file%.jsonl}"
        turn_grouper="$CLAUDE_TURN_GROUPER"
    fi

    if [ -n "$PROJECT_FILTER" ]; then
        echo "$project_dir" | grep -qi "$PROJECT_FILTER" || continue
    fi

    # Resume check — skip a session already indexed at this transcript mtime.
    # A transcript that has grown since (new mtime) is reprocessed; the overlap
    # dedupes in Qdrant via the deterministic turn-<sid>-<idx> point IDs.
    transcript_mtime=$(file_mtime "$transcript")
    # Project is part of the Codex checkpoint identity. This deliberately
    # invalidates pre-attribution Codex checkpoints once, allowing generic
    # `project=dev` points to be replaced by deterministic-ID upserts under
    # their inferred repository. Claude keeps accepting its legacy keys.
    progress_key="$provider $session_id $transcript_mtime $project_dir"
    provider_legacy_progress_key="$provider $session_id $transcript_mtime"
    legacy_progress_key="$session_id $transcript_mtime"
    if grep -qxF "$progress_key" "$PROGRESS_FILE" 2>/dev/null || \
       { [ "$provider" = "claude" ] && { grep -qxF "$provider_legacy_progress_key" "$PROGRESS_FILE" 2>/dev/null || grep -qxF "$legacy_progress_key" "$PROGRESS_FILE" 2>/dev/null; }; }; then
        echo "Skipping (already indexed): $session_id ($provider/$project_dir)"
        echo 1 >> "$SKIPPED_FILE"
        continue
    fi

    echo "Indexing session: $session_id ($provider/$project_dir)"
    : > "$SESSION_FAILED_FILE"

    # Turn-group the transcript, then ship one event per turn to Qdrant.
    # Turn event_ids are deterministic (turn-<sid>-<idx>), so reruns and
    # parallel reconstruct-history.js runs dedupe cleanly via the point-id hash.
    # Piping through a while loop would put the counter in a subshell where
    # increments don't propagate; write to a counter file and sum at the end.
    awk -f "$turn_grouper" \
        -v sid="$session_id" -v proj="$project_dir" -v tpath="$transcript" \
        "$transcript" 2>/dev/null | \
    while IFS= read -r payload; do
        [ -z "$payload" ] && continue
        if echo "$payload" | PE_GATE_REJECT="${PE_GATE_REJECT:-2.0}" "$INDEXER"; then
            echo 1 >> "$COUNTER_FILE"
        else
            echo "$provider $session_id" >> "$SESSION_FAILED_FILE"
            echo "$provider $session_id" >> "$FAILED_FILE"
        fi
    done

    if [ -s "$SESSION_FAILED_FILE" ]; then
        echo "Warning: indexing failed for one or more turns; session left uncheckpointed: $session_id" >&2
        continue
    fi

    # Checkpoint only after the whole session is walked. A mid-session kill
    # never reaches this line, so the session is reprocessed — not lost — on
    # the next run, while every session before it stays skipped.
    echo "$progress_key" >> "$PROGRESS_FILE"

done < <(discover_transcripts)

total_indexed=$(wc -l < "$COUNTER_FILE" | tr -d ' ')
total_skipped=$(wc -l < "$SKIPPED_FILE" | tr -d ' ')
total_failed=$(wc -l < "$FAILED_FILE" | tr -d ' ')
rm -f "$COUNTER_FILE" "$SKIPPED_FILE" "$FAILED_FILE" "$SESSION_FAILED_FILE"
echo "Retro-indexing complete! Backfilled $total_indexed turns; skipped $total_skipped already-indexed session(s); $total_failed turn failure(s)."
[ "$total_failed" -eq 0 ]
