#!/usr/bin/env bash
# backfill-memories.sh — Index Claude Code memory files into cartographer event logs.
#
# Reads MEMORY.md index files and individual memory .md files from
# ~/.claude/projects/*/memory/, extracts frontmatter + content, and
# writes searchable events to changelog.jsonl.
#
# Usage:
#   bash scripts/backfill-memories.sh              # All memory files
#   bash scripts/backfill-memories.sh --dry-run     # Preview
#   bash scripts/backfill-memories.sh --project foo  # Filter by project context

set -o pipefail

DEV="${CARTOGRAPHER_DEV_DIR:-$HOME/Documents/dev}"
CHANGELOG="$DEV/changelog.jsonl"
PROJECTS_DIR="${CARTOGRAPHER_TRANSCRIPTS_DIR:-$HOME/.claude/projects}"
INDEXER="$(dirname "$0")/index-event.sh"

DRY_RUN=false
PROJECT_FILTER=""

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run)    DRY_RUN=true; shift ;;
    --project)    PROJECT_FILTER="$2"; shift 2 ;;
    *) shift ;;
  esac
done

# Collect existing memory event IDs to skip duplicates
EXISTING_IDS=""
if [ -f "$CHANGELOG" ]; then
  EXISTING_IDS=$(grep '"memory_' "$CHANGELOG" 2>/dev/null | grep -oE '"event_id":"[^"]*"' | sort -u)
fi

total=0
skipped=0

process_memory_file() {
  local filepath="$1"
  local project_dir="$2"

  local filename=$(basename "$filepath" .md)

  # Parse YAML frontmatter
  local name="" description="" mem_type=""
  local in_frontmatter=false
  local body=""
  local past_frontmatter=false

  while IFS= read -r line; do
    if [ "$line" = "---" ] && ! $past_frontmatter; then
      if $in_frontmatter; then
        past_frontmatter=true
      else
        in_frontmatter=true
      fi
      continue
    fi

    if $in_frontmatter && ! $past_frontmatter; then
      case "$line" in
        name:*)        name="${line#name: }" ;;
        description:*) description="${line#description: }" ;;
        type:*)        mem_type="${line#type: }" ;;
      esac
    elif $past_frontmatter; then
      body="${body}${line} "
    fi
  done < "$filepath"

  # Clean up
  name=$(echo "$name" | sed 's/^[[:space:]]*//' | sed 's/[[:space:]]*$//')
  description=$(echo "$description" | sed 's/^[[:space:]]*//' | sed 's/[[:space:]]*$//')
  mem_type=$(echo "$mem_type" | sed 's/^[[:space:]]*//' | sed 's/[[:space:]]*$//')
  body=$(echo "$body" | head -c 500)

  [ -z "$name" ] && name="$filename"
  [ -z "$mem_type" ] && mem_type="unknown"

  local event_id="memory-${project_dir}-${filename}"

  # Skip duplicates
  if echo "$EXISTING_IDS" | grep -q "$event_id"; then
    skipped=$((skipped + 1))
    return
  fi

  # Derive a readable project name from the directory
  local project_name
  project_name=$(echo "$project_dir" | sed 's/^-Users-[^-]*-Documents-dev-//' | sed 's/^-Users-[^-]*-//' | sed 's/^-//')
  [ -z "$project_name" ] && project_name="global"

  # Project filter
  if [ -n "$PROJECT_FILTER" ]; then
    echo "$project_name" | grep -qi "$PROJECT_FILTER" || return
  fi

  local summary="Memory [${mem_type}]: ${name} — ${description}"
  local timestamp
  timestamp=$(stat -f "%Sm" -t "%Y-%m-%dT%H:%M:%SZ" "$filepath" 2>/dev/null || date -r "$filepath" -u +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || date -u +"%Y-%m-%dT%H:%M:%SZ")

  if $DRY_RUN; then
    echo "  [${mem_type:0:8}] ${project_name}: ${name}"
    return
  fi

  jq -n -c \
    --arg eid "$event_id" \
    --arg ts "$timestamp" \
    --arg type "memory_${mem_type}" \
    --arg project "$project_name" \
    --arg summary "$summary" \
    --arg body "$body" \
    --arg mem_name "$name" \
    --arg mem_type "$mem_type" \
    --arg filepath "$filepath" \
    '{event_id: $eid, timestamp: $ts, type: $type, project: $project, summary: $summary, body: $body, memory_name: $mem_name, memory_type: $mem_type, memory_path: $filepath, related_ids: []}' \
    >> "$CHANGELOG"

  # Real-time indexing
  if [ -x "$INDEXER" ]; then
    tail -1 "$CHANGELOG" | "$INDEXER" 2>/dev/null &
  fi

  total=$((total + 1))
}

echo "Backfilling Claude Code memories..."
$DRY_RUN && echo "  (dry run)"
echo ""

for project_dir in "$PROJECTS_DIR"/*/; do
  [ -d "$project_dir/memory" ] || continue

  local_project=$(basename "$project_dir")

  for memfile in "$project_dir"/memory/*.md; do
    [ -f "$memfile" ] || continue
    # Skip MEMORY.md index files — we index the individual memories
    [ "$(basename "$memfile")" = "MEMORY.md" ] && continue

    process_memory_file "$memfile" "$local_project"
  done
done

echo ""
echo "Done. $total memories indexed, $skipped already existed."
