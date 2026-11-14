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
# Codex also COMPRESSES a rollout in place about a week after its session:
# rollout-<ts>-<uuid>.jsonl becomes rollout-<ts>-<uuid>.jsonl.zst, mtime kept.
# Measured 2026-11-13: 3,646 of 3,916 rollouts on disk were .zst, and 139 of the
# 1,132 Codex sessions with events in the last 30 days had a transcript that
# existed only in that spelling (docs/COMPRESSED_ROLLOUTS.md). Every step below
# therefore tries the plain name and then its .zst sibling; the plain file wins
# when both exist.
#
# A caller that gets a path ending in .jsonl.zst must decompress it:
# scripts/transcript-file.js in Node, `zstd -dc <path>` in a shell.
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

# The recorded name without a compression suffix, so a needle in either
# spelling finds the file in the other.
PLAIN="${NEEDLE%.zst}"
BASE=$(basename "$PLAIN")

case "$BASE" in
  *.jsonl)
    # 1b. Compressed (or decompressed) where it was recorded.
    for candidate in "$PLAIN" "$PLAIN.zst"; do
      [ -f "$candidate" ] && { printf '%s\n' "$candidate"; exit 0; }
    done
    # 2. Same basename under the archive (Codex archive is flat, so this is
    #    cheap and exact — no directory walk).
    for candidate in "$CODEX_ARCHIVED/$BASE" "$CODEX_ARCHIVED/$BASE.zst"; do
      [ -f "$candidate" ] && { printf '%s\n' "$candidate"; exit 0; }
    done
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

# One find over both stores and both spellings, archive first as before. The
# awk prints the first plain match from either store, or the first compressed
# one when no store holds a plain file.
CODEX_DIRS=()
for dir in "$CODEX_ARCHIVED" "$CODEX_TRANSCRIPTS"; do
  [ -d "$dir" ] && CODEX_DIRS+=("$dir")
done
if [ "${#CODEX_DIRS[@]}" -gt 0 ]; then
  HIT=$(find "${CODEX_DIRS[@]}" \( -name "*${ID}*.jsonl" -o -name "*${ID}*.jsonl.zst" \) -type f 2>/dev/null \
    | LC_ALL=C awk '!/\.zst$/ { plain = $0; exit } zst == "" { zst = $0 } END { print (plain != "" ? plain : zst) }')
  [ -n "$HIT" ] && { printf '%s\n' "$HIT"; exit 0; }
fi

if [ -d "$CLAUDE_TRANSCRIPTS" ]; then
  HIT=$(find "$CLAUDE_TRANSCRIPTS" -name "${ID}.jsonl" -type f 2>/dev/null | head -1)
  [ -n "$HIT" ] && { printf '%s\n' "$HIT"; exit 0; }
fi

exit 1
