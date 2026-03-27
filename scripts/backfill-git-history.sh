#!/usr/bin/env bash
# backfill-git-history.sh — Import git commit history into cartographer event logs.
#
# Walks project directories, extracts commits, writes to changelog.jsonl.
# Optionally indexes into Qdrant via index-event.sh.
#
# Usage:
#   bash scripts/backfill-git-history.sh                    # All repos in DEV_DIR
#   bash scripts/backfill-git-history.sh --project foo      # Single project
#   bash scripts/backfill-git-history.sh --since 2026-01-01 # Date filter
#   bash scripts/backfill-git-history.sh --limit 50         # Max commits per repo
#   bash scripts/backfill-git-history.sh --dry-run          # Preview without writing

set -o pipefail

DEV="${CARTOGRAPHER_DEV_DIR:-$HOME/Documents/dev}"
CHANGELOG="$DEV/changelog.jsonl"
INDEXER="$(dirname "$0")/index-event.sh"

PROJECT_FILTER=""
SINCE=""
LIMIT=500
DRY_RUN=false
INCLUDE_FILES=true

while [ $# -gt 0 ]; do
  case "$1" in
    --project)    PROJECT_FILTER="$2"; shift 2 ;;
    --since)      SINCE="$2"; shift 2 ;;
    --limit)      LIMIT="$2"; shift 2 ;;
    --dry-run)    DRY_RUN=true; shift ;;
    --no-files)   INCLUDE_FILES=false; shift ;;
    *) shift ;;
  esac
done

# Collect existing commit event IDs to avoid duplicates
EXISTING_IDS=""
if [ -f "$CHANGELOG" ]; then
  EXISTING_IDS=$(grep '"git_commit"' "$CHANGELOG" 2>/dev/null | grep -oE '"event_id":"[^"]*"' | sort -u)
fi

total=0
skipped=0

process_repo() {
  local repo_path="$1"
  local project=$(basename "$repo_path")

  # Check if it's actually a git repo
  cd "$repo_path" 2>/dev/null || return
  git rev-parse --git-dir >/dev/null 2>&1 || return

  # Build git log format: hash|timestamp|subject|author
  local git_args=("log" "--format=%H|%aI|%s|%an" "--max-count=$LIMIT")
  [ -n "$SINCE" ] && git_args+=("--since=$SINCE")

  local count=0
  while IFS='|' read -r hash timestamp subject author; do
    [ -z "$hash" ] && continue

    local short_hash="${hash:0:7}"
    local event_id="git-${short_hash}"

    # Skip if already in changelog
    if echo "$EXISTING_IDS" | grep -q "$event_id"; then
      skipped=$((skipped + 1))
      continue
    fi

    # Get changed files
    local files=""
    if $INCLUDE_FILES; then
      files=$(git diff-tree --no-commit-id --name-only -r "$hash" 2>/dev/null | head -20 | tr '\n' ', ' | sed 's/,$//')
    fi

    local summary="Commit ${short_hash}: ${subject}"
    [ -n "$files" ] && summary="${summary} | files: ${files}"

    if $DRY_RUN; then
      echo "  [${timestamp}] ${project}: ${summary}" | head -c 120
      echo ""
    else
      jq -n -c \
        --arg eid "$event_id" \
        --arg ts "$timestamp" \
        --arg type "git_commit" \
        --arg project "$project" \
        --arg summary "$summary" \
        --arg hash "$hash" \
        --arg author "$author" \
        '{event_id: $eid, timestamp: $ts, type: $type, project: $project, summary: $summary, commit_hash: $hash, author: $author, related_ids: []}' \
        >> "$CHANGELOG"

      # Real-time indexing
      if [ -x "$INDEXER" ]; then
        tail -1 "$CHANGELOG" | "$INDEXER" 2>/dev/null &
      fi
    fi

    count=$((count + 1))
    total=$((total + 1))
  done < <(git "${git_args[@]}" 2>/dev/null)

  [ "$count" -gt 0 ] && echo "  $project: $count commits"
}

echo "Backfilling git history..."
[ -n "$SINCE" ] && echo "  Since: $SINCE"
[ -n "$PROJECT_FILTER" ] && echo "  Project: $PROJECT_FILTER"
$DRY_RUN && echo "  (dry run — no writes)"
echo ""

if [ -n "$PROJECT_FILTER" ]; then
  # Single project
  repo_path="$DEV/$PROJECT_FILTER"
  if [ -d "$repo_path" ]; then
    process_repo "$repo_path"
  else
    echo "Project not found: $repo_path"
    exit 1
  fi
else
  # Walk all directories in DEV_DIR
  for dir in "$DEV"/*/; do
    [ -d "$dir/.git" ] || continue
    process_repo "$dir"
  done
fi

echo ""
echo "Done. $total commits backfilled, $skipped already existed."
