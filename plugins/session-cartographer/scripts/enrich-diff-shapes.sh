#!/usr/bin/env bash
# enrich-diff-shapes.sh — Backfill diff_shape onto existing git_commit events.
#
# Reads changelog.jsonl, finds git_commit events without diff_shape,
# computes it from the commit hash, and rewrites the file in place.
#
# Usage:
#   bash scripts/enrich-diff-shapes.sh              # enrich in place
#   bash scripts/enrich-diff-shapes.sh --dry-run     # preview counts only
#
# Requires: jq, git repos accessible under DEV_DIR

set -euo pipefail

DEV="${CARTOGRAPHER_DEV_DIR:-$HOME/Documents/dev}"
CHANGELOG="$DEV/changelog.jsonl"
DIFF_SHAPE="$(dirname "$0")/diff-shape.sh"
DRY_RUN=false

[ "${1:-}" = "--dry-run" ] && DRY_RUN=true

if [ ! -f "$CHANGELOG" ]; then
  echo "No changelog.jsonl found at $CHANGELOG"
  exit 1
fi

TOTAL=$(grep -c '"git_commit"' "$CHANGELOG" || true)
FULLY_ENRICHED=$(grep '"diff_shape"' "$CHANGELOG" 2>/dev/null | grep -c '"commit_type"' || true)
NEED=$((TOTAL - FULLY_ENRICHED))

echo "Git commits: $TOTAL total, $FULLY_ENRICHED fully enriched, $NEED to process."

if [ "$NEED" -eq 0 ]; then
  echo "Nothing to do."
  exit 0
fi

if $DRY_RUN; then
  echo "(dry run — no changes)"
  exit 0
fi

echo "Enriching..."
TMPFILE=$(mktemp)
enriched=0
failed=0

while IFS= read -r line; do
  # Pass through non-git-commit events unchanged
  if ! echo "$line" | jq -e '.type == "git_commit"' >/dev/null 2>&1; then
    echo "$line" >> "$TMPFILE"
    continue
  fi

  # Already has diff_shape with commit_type? Pass through
  if echo "$line" | jq -e '.diff_shape != null and .diff_shape.commit_type != null' >/dev/null 2>&1; then
    echo "$line" >> "$TMPFILE"
    continue
  fi

  # Extract commit hash and project to find repo
  HASH=$(echo "$line" | jq -r '.commit_hash // empty')
  PROJECT=$(echo "$line" | jq -r '.project // empty')

  # Try to find the repo
  REPO=""
  if [ -n "$HASH" ] && [ -n "$PROJECT" ]; then
    # Check common locations
    for candidate in "$DEV/$PROJECT" "$DEV"/*/"$PROJECT"; do
      if [ -d "$candidate/.git" ] && git -C "$candidate" cat-file -e "$HASH" 2>/dev/null; then
        REPO="$candidate"
        break
      fi
    done
  fi

  if [ -n "$REPO" ] && [ -n "$HASH" ]; then
    SHAPE=$(bash "$DIFF_SHAPE" "$HASH" "$REPO" 2>/dev/null || echo "")
    if [ -n "$SHAPE" ]; then
      echo "$line" | jq -c --argjson ds "$SHAPE" '. + {diff_shape: $ds}' >> "$TMPFILE"
      enriched=$((enriched + 1))
    else
      echo "$line" >> "$TMPFILE"
      failed=$((failed + 1))
    fi
  else
    echo "$line" >> "$TMPFILE"
    failed=$((failed + 1))
  fi

  # Progress every 100
  if [ $(( (enriched + failed) % 100 )) -eq 0 ] && [ $((enriched + failed)) -gt 0 ]; then
    echo "  processed $((enriched + failed)) of $NEED..."
  fi
done < "$CHANGELOG"

# Atomic replace
mv "$TMPFILE" "$CHANGELOG"

echo ""
echo "Done. Enriched $enriched commits, $failed could not be resolved."
