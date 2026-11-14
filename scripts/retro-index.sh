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
# Codex rollouts are read in both spellings, from the live tree and from the
# archive. Codex moves a finished session to archived_sessions/ and, about a
# week after its last write, zstd-compresses the rollout in place
# (rollout-….jsonl becomes rollout-….jsonl.zst, mtime kept). A compressed one
# is streamed through `zstd -dc`. The checkpoint key holds no path and no
# spelling, so a rollout indexed while it was plain, or before it was archived,
# is skipped afterwards. Measured 2026-11-13 (docs/COMPRESSED_ROLLOUTS.md):
# 3,646 of 3,916 rollouts were compressed, and 241 of the 641 in the archive
# were not indexed at their last write, because this script walked the live
# tree only and they were archived before the next catch-up.
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
# Codex archives sessions rather than deleting them; index that root too.
CODEX_ARCHIVED="${CARTOGRAPHER_CODEX_ARCHIVED_DIR:-$HOME/.codex/archived_sessions}"
# The zstd binary that reads a compressed rollout. Overridable so a test can
# name one that is not there and see the skip counted.
ZSTD_BIN="${CARTOGRAPHER_ZSTD:-zstd}"
SCRIPT_DIR="$(dirname "$0")"
INDEXER="$SCRIPT_DIR/index-event.sh"
CLAUDE_TURN_GROUPER="$SCRIPT_DIR/transcript-to-turns.awk"
CODEX_TURN_GROUPER="$SCRIPT_DIR/codex-transcript-to-turns.awk"
# Overridable so a test can stand in a recorder for the inferer and prove the
# checkpoint pre-check below never reaches it.
CODEX_PROJECT_INFERER="${CARTOGRAPHER_CODEX_PROJECT_INFERER:-$SCRIPT_DIR/infer-codex-project.js}"

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
# Seconds since the epoch of a file's last modification, or 0. Each stat is
# tried and its answer kept only when it is a bare integer: GNU stat given the
# BSD flags (`-f %m`) exits non-zero but first prints a filesystem block to
# stdout, so `bsd || gnu` captured that block plus the real mtime, and every
# Linux checkpoint key carried the garbage. grep -qxF then read each of its
# lines as a separate pattern, which is how CI run 37727757122 skipped a
# session and printed the whole progress line as its project.
file_mtime() {
    local m
    for m in "$(stat -c %Y "$1" 2>/dev/null)" "$(stat -f %m "$1" 2>/dev/null)"; do
        case "$m" in ''|*[!0-9]*) continue ;; esac
        printf '%s\n' "$m"
        return 0
    done
    echo 0
}

# Codex's compressed spelling of a rollout, by name alone.
is_compressed() {
    case "$1" in *.jsonl.zst) return 0 ;; esac
    return 1
}

# A transcript's rows on stdout, in either spelling. Every reader below takes
# its rows from here, so none of them opens a compressed file as text.
transcript_rows() {
    if is_compressed "$1"; then
        "$ZSTD_BIN" -dc -- "$1" 2>/dev/null
    else
        cat -- "$1"
    fi
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
# Compressed rollouts that were found and not read, by reason. The main loop
# below is not a subshell, so plain counters hold.
compressed_no_zstd=0
compressed_undecodable=0

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
        # Both stores, both spellings. A root that does not exist costs one
        # suppressed error and the other is still walked.
        find "$CODEX_TRANSCRIPTS" "$CODEX_ARCHIVED" \( -name "*.jsonl" -o -name "*.jsonl.zst" \) -type f "${FIND_ARGS[@]}" -print 2>/dev/null | \
        while IFS= read -r path; do printf 'codex\t%s\n' "$path"; done
    fi
}

while IFS=$'\t' read -r provider transcript; do
    [ -z "$transcript" ] && continue

    session_file=$(basename "$transcript")
    # The name without either suffix: rollout-<ts>-<id> in both spellings.
    session_stem="${session_file%.zst}"
    session_stem="${session_stem%.jsonl}"
    if [ "$provider" = "codex" ]; then
        # A plain file beside its compressed twin means Codex is partway
        # through compressing it, or left both. The plain one is in this walk
        # and is the one read, as in resolve-transcript.sh.
        if [ -z "$TRANSCRIPT_FILTER" ] && is_compressed "$transcript" && [ -f "${transcript%.zst}" ]; then
            echo "Skipping (plain copy beside it is read instead): $session_file"
            continue
        fi
        # Checkpoint pre-check, before the two jq passes and the node inferer
        # below. Those cost ~150 ms per transcript, and on a zero-work
        # catch-up (78 of 123 runs in the two weeks to 2026-10-07) they were
        # the whole run: 26 s median, 66 s p95, to decide to skip everything.
        # A Codex rollout file is named rollout-<date>T<time>-<session id>,
        # and the id in that name is the session_meta id (checked across the
        # live store: every rollout matched). So "codex <id> <mtime> " as a
        # line prefix of the progress file identifies a checkpointed session
        # at this mtime without opening the transcript. No prefix match falls
        # through to the full derivation and the full key check, so the
        # project-in-key invalidation is untouched. --project is excluded
        # because it needs the inferred project to decide inclusion at all.
        # Compression keeps the mtime and the name carries no spelling, so
        # this also skips a rollout that was indexed while plain.
        pre_sid="$session_stem"
        pre_sid="${pre_sid#rollout-[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]-[0-9][0-9]-[0-9][0-9]-}"
        case "$pre_sid" in
            "$session_stem"|*[!0-9a-fA-F-]*) pre_sid="" ;;
        esac
        if [ -n "$pre_sid" ] && [ -z "$PROJECT_FILTER" ]; then
            pre_mtime=$(file_mtime "$transcript")
            pre_prefix="codex $pre_sid $pre_mtime "
            pre_hit=$(grep -m1 -- "^$pre_prefix" "$PROGRESS_FILE" 2>/dev/null)
            if [ -n "$pre_hit" ]; then
                echo "Skipping (already indexed): $pre_sid (codex/${pre_hit#"$pre_prefix"})"
                echo 1 >> "$SKIPPED_FILE"
                continue
            fi
        fi
        if is_compressed "$transcript"; then
            # Not checkpointed, so it has to be read. Say why when it cannot
            # be: a compressed rollout that is passed over without a word is
            # the defect this branch exists for. Neither case checkpoints, so
            # the rollout is tried again on the next run.
            if ! command -v "$ZSTD_BIN" >/dev/null 2>&1; then
                echo "Skipping (compressed, and zstd is not installed): $session_stem"
                compressed_no_zstd=$((compressed_no_zstd + 1))
                continue
            fi
            # One test pass before any row is used. A frame that stops short
            # would otherwise index the turns before the break and checkpoint
            # the session as whole.
            if ! "$ZSTD_BIN" -tq -- "$transcript" 2>/dev/null; then
                echo "Skipping (compressed, and it does not decompress): $session_stem"
                compressed_undecodable=$((compressed_undecodable + 1))
                continue
            fi
        fi
        session_id=$(transcript_rows "$transcript" | jq -r 'select(.type == "session_meta") | .payload.id // .payload.session_id // empty' 2>/dev/null | head -1)
        session_id="${session_id:-$session_stem}"
        session_cwd=$(transcript_rows "$transcript" | jq -r 'select(.type == "session_meta") | .payload.cwd // empty' 2>/dev/null | head -1)
        if is_compressed "$transcript"; then
            # Rows on stdin: the inferer then needs nothing from Node's zlib,
            # which reads zstd only from 22.15.
            project_dir=$(transcript_rows "$transcript" | node "$CODEX_PROJECT_INFERER" - "$DEV" 2>/dev/null)
        else
            project_dir=$(node "$CODEX_PROJECT_INFERER" "$transcript" "$DEV" 2>/dev/null)
        fi
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
    # tpath is the path on disk, .zst included: resolve-transcript.sh takes a
    # recorded path in either spelling.
    transcript_rows "$transcript" | awk -f "$turn_grouper" \
        -v sid="$session_id" -v proj="$project_dir" -v tpath="$transcript" \
        2>/dev/null | \
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
# Unread compressed rollouts ride on the summary line, which is the one line
# catch-up-transcripts.sh keeps. They do not fail the run: a missing zstd
# would otherwise void the catch-up cooldown on every session start.
unread=""
[ "$compressed_no_zstd" -gt 0 ] && unread="$unread; $compressed_no_zstd compressed rollout(s) not read (zstd not installed)"
[ "$compressed_undecodable" -gt 0 ] && unread="$unread; $compressed_undecodable compressed rollout(s) not read (did not decompress)"
echo "Retro-indexing complete! Backfilled $total_indexed turns; skipped $total_skipped already-indexed session(s); $total_failed turn failure(s)$unread."
[ "$total_failed" -eq 0 ]
