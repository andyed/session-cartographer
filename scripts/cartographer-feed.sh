#!/usr/bin/env bash
set -euo pipefail

# Build a bounded, read-only activity pulse from the canonical Session
# Cartographer index. The caller owns the project allowlist; this script fails
# closed rather than searching the entire cross-agent corpus by default.

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
SEARCH="$ROOT/scripts/cartographer-search.sh"

PROJECTS=""
SINCE="24h"
BEFORE=""
QUERY="recent activity decisions discoveries fixes research commits unfinished work"
LIMIT_PER_PROJECT=5
MAX_RESULTS=24
MIN_SALIENCE=0.4
DENY_REGEX='a^'
EXCLUDE_EVENT_TYPES_REGEX='^tool_(bash|file_edit)$'

usage() {
  printf 'Usage: %s --projects NAME[,NAME...] [options]\n' "$0"
  printf '  --since WHEN              default: 24h\n'
  printf '  --before WHEN             optional upper time bound\n'
  printf '  --query TEXT              custom recall query\n'
  printf '  --limit-per-project N     default: 5\n'
  printf '  --max-results N           default: 24\n'
  printf '  --min-salience N          default: 0.4\n'
  printf '  --deny-regex REGEX        project/summary exclusion (default: none)\n'
  printf '  --exclude-event-types REGEX  default: routine bash/file edits\n'
}

while [ $# -gt 0 ]; do
  case "$1" in
    --projects)          PROJECTS="$2"; shift 2 ;;
    --since)             SINCE="$2"; shift 2 ;;
    --before)            BEFORE="$2"; shift 2 ;;
    --query)             QUERY="$2"; shift 2 ;;
    --limit-per-project) LIMIT_PER_PROJECT="$2"; shift 2 ;;
    --max-results)       MAX_RESULTS="$2"; shift 2 ;;
    --min-salience)      MIN_SALIENCE="$2"; shift 2 ;;
    --deny-regex)        DENY_REGEX="$2"; shift 2 ;;
    --exclude-event-types) EXCLUDE_EVENT_TYPES_REGEX="$2"; shift 2 ;;
    -h|--help)           usage; exit 0 ;;
    *)
      printf 'cartographer-feed: unknown argument: %s\n' "$1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

[ -x "$SEARCH" ] || {
  printf 'cartographer-feed: search runtime is unavailable: %s\n' "$SEARCH" >&2
  exit 1
}

[ -n "$PROJECTS" ] || {
  printf 'cartographer-feed: --projects is required; refusing an unscoped corpus search\n' >&2
  exit 2
}

if ! [[ "$LIMIT_PER_PROJECT" =~ ^[1-9][0-9]*$ ]] || \
   ! [[ "$MAX_RESULTS" =~ ^[1-9][0-9]*$ ]] || \
   ! [[ "$MIN_SALIENCE" =~ ^[0-9]+([.][0-9]+)?$ ]] || \
   ! awk -v value="$MIN_SALIENCE" 'BEGIN { exit !(value >= 0 && value <= 1) }'; then
  printf 'cartographer-feed: limits must be positive integers and salience must be in [0,1]\n' >&2
  exit 2
fi

WORK=$(mktemp -d "${TMPDIR:-/tmp}/cartographer-feed.XXXXXX")
trap 'rm -rf "$WORK"' EXIT
RAW="$WORK/results.jsonl"
FILTERED="$WORK/results.json"
ERRORS="$WORK/errors.log"
EXPANDED_PROJECT_FILE="$WORK/projects.txt"
: > "$RAW"
: > "$ERRORS"
: > "$EXPANDED_PROJECT_FILE"

IFS=',' read -r -a project_list <<< "$PROJECTS"
for raw_project in "${project_list[@]}"; do
  project=$(printf '%s' "$raw_project" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
  [ -n "$project" ] || continue
  if [ -f "$ROOT/project-registry.json" ] && \
     jq -e --arg project "$project" '.aliases[$project] | type == "array"' \
       "$ROOT/project-registry.json" >/dev/null 2>&1; then
    jq -r --arg project "$project" '.aliases[$project][]' \
      "$ROOT/project-registry.json" >> "$EXPANDED_PROJECT_FILE"
  else
    printf '%s\n' "$project" >> "$EXPANDED_PROJECT_FILE"
  fi
done

expanded_projects=$(sort -u "$EXPANDED_PROJECT_FILE" | paste -sd '|' -)
[ -n "$expanded_projects" ] || {
  printf 'cartographer-feed: project allowlist expanded to zero projects\n' >&2
  exit 2
}

project_count=$(printf '%s' "$expanded_projects" | tr '|' '\n' | awk 'NF { n++ } END { print n + 0 }')
search_limit=$((project_count * LIMIT_PER_PROJECT))
minimum_search_limit=$((MAX_RESULTS * 3))
[ "$search_limit" -ge "$minimum_search_limit" ] || search_limit="$minimum_search_limit"
[ "$search_limit" -le 200 ] || search_limit=200

args=("$QUERY" --project "$expanded_projects" --since "$SINCE" --limit "$search_limit" --format jsonl --all)
if [ -n "$BEFORE" ]; then
  args+=(--before "$BEFORE")
fi

CARTOGRAPHER_PURPOSE=feed \
CARTOGRAPHER_PROVIDER="${CARTOGRAPHER_PROVIDER:-feed}" \
CARTOGRAPHER_SERVED_LOG=/dev/null \
CARTOGRAPHER_ACCESS_LEDGER=/dev/null \
CARTOGRAPHER_REUSE_WEIGHT=0 \
  bash "$SEARCH" "${args[@]}" >> "$RAW" 2>> "$ERRORS" || true

if [ -s "$RAW" ]; then
  jq -s \
    --arg deny "$DENY_REGEX" \
    --arg exclude_types "$EXCLUDE_EVENT_TYPES_REGEX" \
    --argjson min_salience "$MIN_SALIENCE" \
    --argjson max_results "$MAX_RESULTS" '
      map(select(
        (.event_id // "") != "" and
        (.project // "") != "" and
        (((.project // "") | test($deny; "i")) | not) and
        (((.summary // "") | test($deny; "i")) | not) and
        (((.event_type // "") | test($exclude_types; "i")) | not) and
        ((.salience // 0.5) >= $min_salience)
      ))
      | unique_by(.event_id)
      | sort_by(.timestamp)
      | reverse
      | .[:$max_results]
    ' "$RAW" > "$FILTERED"
else
  printf '[]\n' > "$FILTERED"
fi

generated_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
result_count=$(jq 'length' "$FILTERED")

printf '# Session Cartographer Pulse\n\n'
printf -- '- Generated: %s\n' "$generated_at"
if [ -n "$BEFORE" ]; then
  printf -- '- Window: since `%s`, before `%s`\n' "$SINCE" "$BEFORE"
else
  printf -- '- Window: since `%s`\n' "$SINCE"
fi
printf -- '- Scope: %d explicitly allowlisted project names\n' "$project_count"
printf -- '- Results: %d after deduplication, salience, and deny filtering\n' "$result_count"
printf -- '- Provenance: Claude Code/Codex Cartographer records; session evidence, not live-world evidence\n'
printf -- '- Privacy: summaries only; no raw transcript content is included\n\n'

if [ "$result_count" -eq 0 ]; then
  printf 'No eligible cross-agent activity was found in this window.\n'
else
  printf '## Recent cross-agent work\n\n'
  jq -r '
    def extra_value($key):
      ((.extras // "") | split("|")
        | map(select(startswith($key + ":")))
        | first // ""
        | ltrimstr($key + ":"));
    .[] |
    "- **\(.timestamp) · \(.project) · \((.event_type // "record") | if . == "" then "record" else . end)** `\(.event_id)`\n" +
    "  \((.summary // "") | if length > 500 then .[:500] + "..." else . end)\n" +
    (extra_value("transcript") as $transcript |
      if $transcript == "" then
        "  Source: \(.source). Use the event ID for exact fetch if this affects the molt."
      else
        "  Source: \(.source). Transcript pointer: `\($transcript)`"
      end) + "\n"
  ' "$FILTERED"
fi

if [ -s "$ERRORS" ]; then
  error_count=$(wc -l < "$ERRORS" | tr -d ' ')
  printf '\nSearch diagnostics: %s stderr line(s) were suppressed from the feed; inspect the job output if expected projects are absent.\n' "$error_count"
fi
