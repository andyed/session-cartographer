#!/usr/bin/env bash
# cartographer-search.sh — Unified search across all Claude Code session history.
#
# Usage: cartographer-search.sh <query> [--project NAME] [--limit N]
#
# Searches (in order):
#   1. Qdrant semantic search (if available)
#   2. JSONL event logs + transcripts via grep+awk rank fusion
#
# Results are ranked via Reciprocal Rank Fusion (RRF) across sources,
# then deduplicated and sorted by combined score.
#
# Environment:
#   CARTOGRAPHER_DEV_DIR         — default: ~/Documents/dev
#   CARTOGRAPHER_TRANSCRIPTS_DIR — default: ~/.claude/projects
#   CARTOGRAPHER_QDRANT_URL      — default: http://localhost:6333
#   CARTOGRAPHER_EMBED_URL       — default: http://localhost:8890/v1/embeddings
#   CARTOGRAPHER_EMBED_MODEL     — default: mxbai-embed-large
#   CARTOGRAPHER_COLLECTION      — default: session-cartographer

set -o pipefail

QUERY="${1:?Usage: cartographer-search.sh \"<query>\" [--project NAME] [--limit N]}"
shift

LIMIT=15
PROJECT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --project)  PROJECT="$2"; shift 2 ;;
    --limit)    LIMIT="$2"; shift 2 ;;
    *) shift ;;
  esac
done

DEV="${CARTOGRAPHER_DEV_DIR:-$HOME/Documents/dev}"
TRANSCRIPTS="${CARTOGRAPHER_TRANSCRIPTS_DIR:-$HOME/.claude/projects}"
QDRANT="${CARTOGRAPHER_QDRANT_URL:-http://localhost:6333}"
EMBED_URL="${CARTOGRAPHER_EMBED_URL:-http://localhost:8890/v1/embeddings}"
EMBED_MODEL="${CARTOGRAPHER_EMBED_MODEL:-mxbai-embed-large}"
COLLECTION="${CARTOGRAPHER_COLLECTION:-session-cartographer}"

FOUND=0
TMPDIR=$(mktemp -d)
trap "rm -rf $TMPDIR" EXIT

# ─── Check for jq (needed for semantic search and transcript parsing) ───
HAS_JQ=false
command -v jq &>/dev/null && HAS_JQ=true

# ─── 1. Semantic search (best results, needs services) ───
semantic_search() {
  $HAS_JQ || return 1
  curl -sf "$QDRANT/collections/$COLLECTION" >/dev/null 2>&1 || return 1
  curl -sf "${EMBED_URL%/v1/embeddings}/health" >/dev/null 2>&1 || return 1

  local embed_response
  embed_response=$(curl -sf "$EMBED_URL" \
    -H "Content-Type: application/json" \
    -d "$(jq -n --arg m "$EMBED_MODEL" --arg q "Represent this sentence for retrieval: $QUERY" \
      '{model: $m, input: $q}')" 2>/dev/null) || return 1

  local vector
  vector=$(echo "$embed_response" | jq -c '.data[0].embedding // empty' 2>/dev/null)
  [ -z "$vector" ] && return 1

  local search_body
  if [ -n "$PROJECT" ]; then
    search_body=$(jq -n --argjson v "$vector" --argjson l "$LIMIT" --arg p "$PROJECT" \
      '{vector: $v, limit: $l, with_payload: true, filter: {must: [{key: "project", match: {value: $p}}]}}')
  else
    search_body=$(jq -n --argjson v "$vector" --argjson l "$LIMIT" \
      '{vector: $v, limit: $l, with_payload: true}')
  fi

  local results
  results=$(curl -sf "$QDRANT/collections/$COLLECTION/points/search" \
    -H "Content-Type: application/json" \
    -d "$search_body" 2>/dev/null) || return 1

  local count
  count=$(echo "$results" | jq '.result | length' 2>/dev/null)
  [ "$count" = "0" ] || [ -z "$count" ] && return 1

  echo "=== Semantic search: $count results ==="
  echo ""
  echo "$results" | jq -r '.result[] |
    "[\(.payload.timestamp // "?")] [\(.payload.source // "?")] \(.payload.event_id // "no-id")  (score: \(.score | tostring | .[:5]))" +
    "\n  " + (.payload.summary // .payload.url // .payload.type // "?") +
    "\n  project: " + (.payload.project // "?") +
    (if .payload.url then "\n  url: " + .payload.url else "" end) +
    (if .payload.deeplink and .payload.deeplink != "" then "\n  deeplink: " + .payload.deeplink else "" end) +
    (if .payload.transcript_path and .payload.transcript_path != "" then "\n  transcript: " + .payload.transcript_path else "" end) +
    "\n"
  ' 2>/dev/null
  FOUND=1
  return 0
}

# ─── 2. Keyword search with rank fusion via awk ───
#
# Each JSONL source is grep-matched, then awk extracts fields and assigns
# a within-source rank. Results from all sources are piped into a fusion
# awk that computes RRF scores, deduplicates, and sorts.
#
# Intermediate format (TSV):
#   source \t rank \t key \t timestamp \t project \t summary \t extras

grep_jsonl_to_tsv() {
  local file="$1" source="$2"
  [ -f "$file" ] || return 0

  LC_ALL=C grep -in "$QUERY" "$file" 2>/dev/null | \
  LC_ALL=C awk -F'\t' -v src="$source" -v proj_filter="$PROJECT" '
  BEGIN { rank = 0 }
  {
    line = $0
    # Strip the line-number prefix from grep -n
    sub(/^[0-9]+:/, "", line)

    # Poor-mans JSON field extraction — fast, no jq
    key = extract(line, "event_id")
    if (key == "") key = extract(line, "milestone")
    if (key == "") key = src "-" NR

    ts = extract(line, "timestamp")
    proj = extract(line, "project")
    summary = extract(line, "summary")
    if (summary == "") summary = extract(line, "description")
    if (summary == "") summary = extract(line, "prompt")
    if (summary == "") summary = extract(line, "url")
    if (summary == "") summary = extract(line, "query")

    url = extract(line, "url")
    deeplink = extract(line, "deeplink")
    transcript = extract(line, "transcript_path")

    # Project filter (case-insensitive)
    if (proj_filter != "" && tolower(proj) !~ tolower(proj_filter)) next

    rank++

    # Extras: url, deeplink, transcript (pipe-separated)
    extras = ""
    if (url != "") extras = extras "url:" url "|"
    if (deeplink != "" && deeplink != "none") extras = extras "deeplink:" deeplink "|"
    if (transcript != "") extras = extras "transcript:" transcript "|"

    printf "%s\t%d\t%s\t%s\t%s\t%s\t%s\n", src, rank, key, ts, proj, summary, extras
  }

  function extract(json, field,    pat, val) {
    pat = "\"" field "\"[[:space:]]*:[[:space:]]*\""
    if (match(json, pat)) {
      val = substr(json, RSTART + RLENGTH)
      sub(/".*/, "", val)
      return val
    }
    return ""
  }
  '
}

grep_transcripts_to_tsv() {
  [ -d "$TRANSCRIPTS" ] || return 0

  local matched_files=0
  for transcript in "$TRANSCRIPTS"/*/*.jsonl; do
    [ -f "$transcript" ] || continue
    grep -qi "$QUERY" "$transcript" 2>/dev/null || continue

    local project_dir session_file session_id
    project_dir=$(basename "$(dirname "$transcript")")
    session_file=$(basename "$transcript")
    session_id="${session_file%.jsonl}"

    # Project filter
    if [ -n "$PROJECT" ]; then
      echo "$project_dir" | grep -qi "$PROJECT" || continue
    fi

    matched_files=$((matched_files + 1))

    # Use awk to extract matching messages — much faster than jq for large files
    LC_ALL=C grep -in "$QUERY" "$transcript" 2>/dev/null | \
    LC_ALL=C awk -F'\t' -v sid="$session_id" -v pdir="$project_dir" -v tpath="$transcript" '
    BEGIN { rank = 0 }
    {
      line = $0
      sub(/^[0-9]+:/, "", line)

      type = extract(line, "type")
      if (type != "user" && type != "assistant") next

      # Check message.content exists and contains a string
      # Look for "content":" pattern
      if (line !~ /"content"[[:space:]]*:[[:space:]]*"/) next

      ts = extract(line, "timestamp")
      uuid = extract(line, "uuid")
      if (uuid == "") uuid = "transcript-" sid "-" NR

      # Extract content snippet (first 150 chars after "content":")
      content = ""
      if (match(line, /"content"[[:space:]]*:[[:space:]]*"/)) {
        content = substr(line, RSTART + RLENGTH, 150)
        gsub(/".*/, "", content)
        gsub(/\\n/, " ", content)
        gsub(/\\t/, " ", content)
      }

      rank++
      extras = "transcript:" tpath "|session:" sid "|"

      printf "transcript:%s\t%d\t%s\t%s\t%s\t%s\t%s\n", type, rank, uuid, ts, pdir, content, extras
    }

    function extract(json, field,    pat, val) {
      pat = "\"" field "\"[[:space:]]*:[[:space:]]*\""
      if (match(json, pat)) {
        val = substr(json, RSTART + RLENGTH)
        sub(/".*/, "", val)
        return val
      }
      return ""
    }
    ' | head -$((LIMIT * 2))

    [ "$matched_files" -ge 5 ] && break
  done
}

# ─── Rank fusion ───
rank_fuse_and_display() {
  # RRF with k=60 (standard constant)
  # Input: TSV lines from all sources
  # Output: deduplicated, scored, sorted, formatted results
  awk -F'\t' -v limit="$LIMIT" '
  {
    src = $1; rank = $2; key = $3; ts = $4; proj = $5; summary = $6; extras = $7

    # RRF score: 1/(k + rank)
    score = 1.0 / (60 + rank)

    # Accumulate scores per unique key (handles same event in multiple sources)
    if (key in rrf_score) {
      rrf_score[key] += score
      sources[key] = sources[key] "+" src
    } else {
      rrf_score[key] = score
      sources[key] = src
      timestamp[key] = ts
      project[key] = proj
      summaries[key] = summary
      extra[key] = extras
      order[++n] = key
    }
  }
  END {
    # Sort by RRF score (insertion sort — fine for small N)
    for (i = 2; i <= n; i++) {
      k = order[i]
      s = rrf_score[k]
      j = i - 1
      while (j >= 1 && rrf_score[order[j]] < s) {
        order[j+1] = order[j]
        j--
      }
      order[j+1] = k
    }

    # Display top results
    shown = 0
    for (i = 1; i <= n && shown < limit; i++) {
      k = order[i]
      printf "[%s] [%s] %s\n", timestamp[k], sources[k], k

      # Truncate summary to 200 chars
      s = summaries[k]
      if (length(s) > 200) s = substr(s, 1, 200) "..."
      printf "  %s\n", s
      printf "  project: %s\n", project[k]

      # Parse extras (pipe-separated key:value pairs)
      split(extra[k], pairs, "|")
      for (p in pairs) {
        if (pairs[p] == "") continue
        split(pairs[p], kv, ":")
        # Rejoin value in case it contained colons (URLs)
        val = ""
        for (v = 2; v <= length(kv); v++) {
          if (v > 2) val = val ":"
          val = val kv[v]
        }
        if (val != "") printf "  %s: %s\n", kv[1], val
      }
      printf "\n"
      shown++
    }

    if (shown == 0) exit 1
  }
  '
}

# ─── Run searches ───
echo "=== Searching for: \"$QUERY\" ==="
[ -n "$PROJECT" ] && echo "=== Project filter: $PROJECT ==="
echo ""

# Try semantic first (silent fail)
semantic_search 2>/dev/null

# Keyword search with rank fusion
if [ "$FOUND" -eq 0 ]; then
  # Collect all sources into one TSV stream, pipe through fusion
  {
    grep_jsonl_to_tsv "$DEV/changelog.jsonl" "changelog"
    grep_jsonl_to_tsv "$DEV/research-log.jsonl" "research"
    grep_jsonl_to_tsv "$DEV/session-milestones.jsonl" "milestones"
    grep_transcripts_to_tsv
  } | rank_fuse_and_display

  if [ $? -eq 0 ]; then
    FOUND=1
  fi
fi

# ─── Cold start guidance ───
if [ "$FOUND" -eq 0 ]; then
  echo "No results found."
  echo ""

  local_logs=0
  [ -f "$DEV/changelog.jsonl" ] && local_logs=1
  [ -f "$DEV/research-log.jsonl" ] && local_logs=1
  [ -f "$DEV/session-milestones.jsonl" ] && local_logs=1

  if [ "$local_logs" -eq 0 ]; then
    echo "No event logs found in $DEV/"
    echo "Logs are created automatically by the session-cartographer hooks."
    echo "They'll start accumulating after your first WebFetch, WebSearch,"
    echo "compaction, or session end."
    echo ""
    echo "To search raw session transcripts now:"
    echo "  grep -r -i \"$QUERY\" $TRANSCRIPTS/ --include='*.jsonl' -l"
  else
    echo "Try broader keywords or check transcripts with --project filter."
  fi
fi

echo ""
echo "=== Done ==="
