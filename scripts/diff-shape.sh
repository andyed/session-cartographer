#!/usr/bin/env bash
# diff-shape.sh — Extract diff geometry from a git commit.
#
# Outputs a single-line JSON object with file counts, line counts, and quadrant.
# Called by log-tool-use.sh (real-time) and backfill-git-history.sh (historical).
#
# Usage: diff-shape.sh <commit_hash> [repo_path]
# Output: {"files_new":2,"files_modified":3,"files_deleted":0,"lines_added":145,"lines_removed":23,"quadrant":"architecture"}
#
# Quadrant classification (from COGNITIVE_ARCHITECTURE.md):
#              small (<100 lines)    big (>=100 lines)
# new files  | bootstrap           | architecture
# old files  | surgical            | dangerous

set -euo pipefail

HASH="${1:?Usage: diff-shape.sh <commit_hash> [repo_path]}"
REPO="${2:-.}"

cd "$REPO" 2>/dev/null || exit 1

# Use --name-status for reliable file classification (handles merges too)
# For merge commits, diff against first parent
NAME_STATUS=$(git diff-tree --no-commit-id --name-status -r --first-parent "$HASH" 2>/dev/null)

FILES_NEW=$(echo "$NAME_STATUS" | grep -c '^A' || true)
FILES_MOD=$(echo "$NAME_STATUS" | grep -c '^M' || true)
FILES_DEL=$(echo "$NAME_STATUS" | grep -c '^D' || true)

# Line counts: --first-parent ensures merge commits diff against parent 1
STAT_LINE=$(git diff --stat "${HASH}^..${HASH}" 2>/dev/null | tail -1)
# Handle root commit (no parent)
if [ -z "$STAT_LINE" ]; then
  STAT_LINE=$(git diff --stat "$(git hash-object -t tree /dev/null)..${HASH}" 2>/dev/null | tail -1)
fi

LINES_ADD=$(echo "$STAT_LINE" | grep -oE '[0-9]+ insertion' | grep -oE '[0-9]+' || echo 0)
LINES_DEL=$(echo "$STAT_LINE" | grep -oE '[0-9]+ deletion' | grep -oE '[0-9]+' || echo 0)
[ -z "$LINES_ADD" ] && LINES_ADD=0
[ -z "$LINES_DEL" ] && LINES_DEL=0

# Quadrant classification
TOTAL_CHURN=$((LINES_ADD + LINES_DEL))
if [ "$FILES_NEW" -gt 0 ]; then
  if [ "$LINES_ADD" -lt 100 ]; then
    QUADRANT="bootstrap"
  else
    QUADRANT="construct"
  fi
else
  if [ "$TOTAL_CHURN" -lt 50 ]; then
    QUADRANT="surgical"
  else
    QUADRANT="rework"
  fi
fi

# Commit type extraction — conventional commits: feat, fix, refactor, docs, test, chore, ci, revert
# Parse from the commit subject line
SUBJECT=$(git log --format='%s' -1 "$HASH" 2>/dev/null)
COMMIT_TYPE=""
if echo "$SUBJECT" | grep -qE '^(feat|fix|refactor|docs|test|chore|ci|revert|style|perf|build)(\(.*\))?[!]?:'; then
  COMMIT_TYPE=$(echo "$SUBJECT" | sed -E 's/^(feat|fix|refactor|docs|test|chore|ci|revert|style|perf|build)(\(.*\))?[!]?:.*/\1/')
fi

jq -n -c \
  --argjson fn "$FILES_NEW" \
  --argjson fm "$FILES_MOD" \
  --argjson fd "$FILES_DEL" \
  --argjson la "$LINES_ADD" \
  --argjson lr "$LINES_DEL" \
  --arg q "$QUADRANT" \
  --arg ct "$COMMIT_TYPE" \
  '{files_new:$fn, files_modified:$fm, files_deleted:$fd, lines_added:$la, lines_removed:$lr, quadrant:$q, commit_type: (if $ct == "" then null else $ct end)}'
