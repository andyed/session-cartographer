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

# ─── Query rewriting: wildcard expansion ───
# "hallucinat*" → find all tokens starting with "hallucinat" in the logs,
# then pass them as the query to BM25 (which does exact token matching).
GREP_QUERY="$QUERY"
AWK_QUERY="$QUERY"
if echo "$QUERY" | grep -q '\*'; then
  # Build grep pattern for file matching
  GREP_QUERY=$(echo "$QUERY" | sed 's/\*/[a-z0-9]*/g')

  # Expand wildcard terms against actual tokens in the event logs
  EXPANDED=""
  for word in $QUERY; do
    if echo "$word" | grep -q '\*'; then
      prefix=$(echo "$word" | sed 's/\*//' | tr '[:upper:]' '[:lower:]')
      # Extract matching tokens from all JSONL files
      matches=$(LC_ALL=C grep -ohiE "${prefix}[a-z0-9]*" \
        "$DEV/changelog.jsonl" "$DEV/research-log.jsonl" \
        "$DEV/session-milestones.jsonl" "$DEV/tool-use-log.jsonl" \
        2>/dev/null | tr '[:upper:]' '[:lower:]' | sort -u | head -20)
      if [ -n "$matches" ]; then
        EXPANDED="$EXPANDED $matches"
      else
        EXPANDED="$EXPANDED $prefix"
      fi
    else
      EXPANDED="$EXPANDED $word"
    fi
  done
  AWK_QUERY=$(echo "$EXPANDED" | xargs)
  [ -n "$AWK_QUERY" ] && echo "(expanded: $AWK_QUERY)"
fi



# ─── Check for jq (needed for semantic search and transcript parsing) ───
HAS_JQ=false
command -v jq &>/dev/null && HAS_JQ=true

# ─── 1. Semantic search → TSV (for fusion with keyword results) ───
semantic_search_to_tsv() {
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

  # Emit TSV in the same format as keyword sources — RRF fuses them together
  echo "$results" | jq -r '.result | to_entries[] |
    "semantic\t" +
    (.key + 1 | tostring) + "\t" +
    (.value.payload.event_id // "sem-" + (.key | tostring)) + "\t" +
    (.value.payload.timestamp // "?") + "\t" +
    (.value.payload.project // "?") + "\t" +
    (.value.payload.summary // .value.payload.url // .value.payload.type // "?") + "\t" +
    (if .value.payload.url then "url:" + .value.payload.url + "|" else "" end) +
    (if .value.payload.deeplink and .value.payload.deeplink != "" then "deeplink:" + .value.payload.deeplink + "|" else "" end) +
    (if .value.payload.transcript_path and .value.payload.transcript_path != "" then "transcript:" + .value.payload.transcript_path + "|" else "" end) +
    (if .value.payload.cwd and .value.payload.cwd != "" then "cwd:" + .value.payload.cwd + "|" else "" end) +
    (if .value.payload.session then "session:" + .value.payload.session + "|" else "" end)
  ' 2>/dev/null
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

  # Note: The file is passed twice for the 2-pass (NR==FNR) BM25 algorithm
  awk -f "$(dirname "$0")/bm25-search.awk" \
    -v query="$AWK_QUERY" -v src="$source" -v proj_filter="$PROJECT" \
    "$file" "$file" 2>/dev/null
}

grep_transcripts_to_tsv() {
  [ -d "$TRANSCRIPTS" ] || return 0

  local matched_files=0
  
  # Bulk grep all transcripts in one shot to eliminate thousands of slow bash/grep subprocesses (drops latency from 24s to <1s)
  while IFS= read -r transcript; do
    [ -z "$transcript" ] && continue

    local project_dir session_file session_id
    project_dir=$(basename "$(dirname "$transcript")")
    session_file=$(basename "$transcript")
    session_id="${session_file%.jsonl}"

    # Project filter
    if [ -n "$PROJECT" ]; then
      echo "$project_dir" | grep -qi "$PROJECT" || continue
    fi

    matched_files=$((matched_files + 1))

    # Use bm25 algorithm — much faster than jq for large files, and ranks properly via TF-IDF
    awk -f "$(dirname "$0")/bm25-search.awk" \
      -v query="$QUERY" -v src="transcript" -v sid="$session_id" -v pdir="$project_dir" -v tpath="$transcript" \
      "$transcript" "$transcript" 2>/dev/null | head -$((LIMIT * 2))

    [ "$matched_files" -ge 5 ] && break
  done < <(find "$TRANSCRIPTS" -mindepth 2 -maxdepth 2 -name "*.jsonl" -type f -exec LC_ALL=C grep -liE "$GREP_QUERY" {} + 2>/dev/null)
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
        nkv = split(pairs[p], kv, ":")
        # Rejoin value in case it contained colons (URLs)
        val = ""
        for (v = 2; v <= nkv; v++) {
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

# Collect keyword results from all JSONL sources + transcripts
keyword_search() {
  grep_jsonl_to_tsv "$DEV/changelog.jsonl" "changelog"
  grep_jsonl_to_tsv "$DEV/research-log.jsonl" "research"
  grep_jsonl_to_tsv "$DEV/session-milestones.jsonl" "milestones"
  grep_jsonl_to_tsv "$DEV/tool-use-log.jsonl" "tool-use"
  grep_transcripts_to_tsv
}

# Phase 1 & 2: Run keyword and semantic searches in parallel
keyword_search > "$TMPDIR/keyword_results.tsv" &
PID_KW=$!

semantic_search_to_tsv > "$TMPDIR/semantic_results.tsv" 2>/dev/null &
PID_SEM=$!

wait $PID_KW
wait $PID_SEM

# Phase 3: fuse everything through RRF
SEMANTIC_COUNT=$(wc -l < "$TMPDIR/semantic_results.tsv" | tr -d ' ')
if [ "$SEMANTIC_COUNT" -gt 0 ]; then
  echo "(hybrid: keyword + semantic)"
  echo ""
fi

cat "$TMPDIR/keyword_results.tsv" "$TMPDIR/semantic_results.tsv" | rank_fuse_and_display
[ $? -eq 0 ] && FOUND=1

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
