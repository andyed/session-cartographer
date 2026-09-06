#!/usr/bin/env bash
# resolve-transcript.sh — turn a recorded transcript_path (or a bare session id)
# into a path that exists on disk.
#
# Why this exists: Codex does not delete finished sessions, it MOVES them from
# ~/.codex/sessions/<yyyy>/<mm>/<dd>/ to ~/.codex/archived_sessions/. Every
# transcript_path stamped by the hooks at event time therefore goes stale the
# moment a session is archived, while the data is still sitting on disk. A
# consumer that stats the recorded path and gives up reports "transcript
# missing" for a transcript that is fully recoverable — a silent recall failure,
# which is worse than an error.
#
# Usage:  resolve-transcript.sh <recorded-path-or-session-id>
# Prints the resolved path on stdout; exits 1 and prints nothing if not found.

set -u
NEEDLE="${1:-}"
[ -n "$NEEDLE" ] || { echo "usage: resolve-transcript.sh <path|session-id>" >&2; exit 2; }

CLAUDE_TRANSCRIPTS="${CARTOGRAPHER_CLAUDE_TRANSCRIPTS_DIR:-${CARTOGRAPHER_TRANSCRIPTS_DIR:-$HOME/.claude/projects}}"
CODEX_TRANSCRIPTS="${CARTOGRAPHER_CODEX_TRANSCRIPTS_DIR:-$HOME/.codex/sessions}"
CODEX_ARCHIVED="${CARTOGRAPHER_CODEX_ARCHIVED_DIR:-$HOME/.codex/archived_sessions}"

# 1. Recorded path still valid — the common case, costs one stat.
if [ -f "$NEEDLE" ]; then printf '%s\n' "$NEEDLE"; exit 0; fi

# 2. Same basename under the archive (Codex archive is flat, so this is cheap
#    and exact — no directory walk).
BASE=$(basename "$NEEDLE")
case "$BASE" in
  *.jsonl)
    [ -f "$CODEX_ARCHIVED/$BASE" ] && { printf '%s\n' "$CODEX_ARCHIVED/$BASE"; exit 0; }
    ;;
esac

# 3. Fall back to a session-id hunt across every store. Accepts either a bare id
#    or a path we could not match by basename.
ID="$BASE"
ID="${ID%.jsonl}"
ID="${ID##*-rollout-}"
# Codex rollout names are rollout-<timestamp>-<uuid>; keep the trailing uuid.
case "$ID" in
  rollout-*) ID="${ID##*-}" ;;
esac

for dir in "$CODEX_ARCHIVED" "$CODEX_TRANSCRIPTS"; do
  [ -d "$dir" ] || continue
  HIT=$(find "$dir" -name "*${ID}*.jsonl" -type f 2>/dev/null | head -1)
  [ -n "$HIT" ] && { printf '%s\n' "$HIT"; exit 0; }
done

if [ -d "$CLAUDE_TRANSCRIPTS" ]; then
  HIT=$(find "$CLAUDE_TRANSCRIPTS" -name "${ID}.jsonl" -type f 2>/dev/null | head -1)
  [ -n "$HIT" ] && { printf '%s\n' "$HIT"; exit 0; }
fi

exit 1
