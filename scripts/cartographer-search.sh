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
#   CARTOGRAPHER_DECAY_LAMBDA    — time-decay rate (default: 0.001, ~30-day half-life)

set -o pipefail

QUERY="${1:?Usage: cartographer-search.sh \"<query>\" [--project NAME] [--limit N]}"
shift

LIMIT=15
FUSION_DEPTH=500
PROJECT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --project)  PROJECT="$2"; shift 2 ;;
    --limit)    LIMIT="$2"; shift 2 ;;
    *) shift ;;
  esac
done

DECAY_LAMBDA="${CARTOGRAPHER_DECAY_LAMBDA:-0.001}"
DEV="${CARTOGRAPHER_DEV_DIR:-$HOME/Documents/dev}"
TRANSCRIPTS="${CARTOGRAPHER_TRANSCRIPTS_DIR:-$HOME/.claude/projects}"
QDRANT="${CARTOGRAPHER_QDRANT_URL:-http://localhost:6333}"

# Resolve project aliases from registry
REGISTRY="$(dirname "$0")/../project-registry.json"
if [ -n "$PROJECT" ] && [ -f "$REGISTRY" ]; then
  EXPANDED=$(jq -r --arg a "$PROJECT" '.aliases[$a] // empty | join("|")' "$REGISTRY" 2>/dev/null)
  [ -n "$EXPANDED" ] && PROJECT="$EXPANDED"
fi
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
  local depth=$FUSION_DEPTH
  if [ -n "$PROJECT" ]; then
    # Build Qdrant filter: single project uses match, multi-project alias uses should
    if echo "$PROJECT" | grep -q '|'; then
      local qdrant_filter
      qdrant_filter=$(echo "$PROJECT" | tr '|' '\n' | jq -R '{key: "project", match: {value: .}}' | jq -sc '{must: [{should: .}]}')
      search_body=$(jq -n --argjson v "$vector" --argjson l "$depth" --argjson f "$qdrant_filter" \
        '{vector: $v, limit: $l, with_payload: true, filter: $f}')
    else
      search_body=$(jq -n --argjson v "$vector" --argjson l "$depth" --arg p "$PROJECT" \
        '{vector: $v, limit: $l, with_payload: true, filter: {must: [{key: "project", match: {value: $p}}]}}')
    fi
  else
    search_body=$(jq -n --argjson v "$vector" --argjson l "$depth" \
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
  # Fields: src \t rank \t key \t ts \t proj \t summary \t extras \t etype
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
    (if .value.payload.session then "session:" + .value.payload.session + "|" else "" end) +
    "\t" +
    (.value.payload.type // (if (.value.payload.event_id // "") | startswith("git-") then "git_commit" else "?" end))
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

    if [ "$matched_files" -ge 20 ]; then
      echo "(showing top 20 matching transcripts)" >&2
      break
    fi
  done < <(find "$TRANSCRIPTS" -mindepth 2 -maxdepth 2 -name "*.jsonl" -type f -exec grep -liE "$GREP_QUERY" {} + 2>/dev/null)
}

# ─── Rank fusion ───
rank_fuse_and_display() {
  # RRF with k=60 (standard constant)
  # Input: TSV lines from all sources
  # Output: faceted summary of top 500, then detailed top N results
  awk -F'\t' -v limit="$LIMIT" -v fusion_depth="$FUSION_DEPTH" -v decay_lambda="$DECAY_LAMBDA" -v now_epoch="$(date +%s)" '
  {
    src = $1; rank = $2; key = $3; ts = $4; proj = $5; summary = $6; extras = $7; etype = $8

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
      etype_map[key] = etype
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

    # ─── Time-decay: Ebbinghaus-inspired recency weighting ───
    # score *= exp(-lambda * hours_since_event)
    # Applied after RRF fusion so it affects ranking but does not
    # eliminate old results entirely (they still appear if relevant enough).
    if (decay_lambda + 0 > 0 && now_epoch + 0 > 0) {
      for (i = 1; i <= n; i++) {
        k = order[i]
        ts = timestamp[k]
        if (ts == "" || ts == "?") continue

        # Parse ISO timestamp: 2026-03-29T14:30:00...
        y = substr(ts, 1, 4) + 0
        mo = substr(ts, 6, 2) + 0
        da = substr(ts, 9, 2) + 0
        h = substr(ts, 12, 2) + 0
        mi = substr(ts, 15, 2) + 0

        # Portable epoch approximation (no mktime needed)
        # Days from year + month + day, then add hours
        days_from_year = (y - 1970) * 365 + int((y - 1969) / 4)
        split("0,31,59,90,120,151,181,212,243,273,304,334", mdays, ",")
        days_from_month = mdays[mo] + 0
        if (mo > 2 && y % 4 == 0) days_from_month++
        total_days = days_from_year + days_from_month + da - 1
        event_epoch = total_days * 86400 + h * 3600 + mi * 60

        hours = (now_epoch - event_epoch) / 3600
        if (hours < 0) hours = 0
        rrf_score[k] = rrf_score[k] * exp(-decay_lambda * hours)
      }

      # Re-sort after decay adjustment
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
    }

    # ─── Faceting: summarize top fusion_depth results ───
    facet_n = (n < fusion_depth) ? n : fusion_depth
    if (facet_n > 0) {
      # Count by project, source, type, time
      delete proj_count
      delete src_count
      delete type_count
      delete time_bucket
      delete day_bucket
      oldest = ""; newest = ""

      for (i = 1; i <= facet_n; i++) {
        k = order[i]
        p = project[k]
        if (p != "" && p != "?") proj_count[p]++

        # Source facet (normalize compound sources to components)
        ns = split(sources[k], src_parts, "+")
        for (si = 1; si <= ns; si++) {
          s = src_parts[si]
          if (s != "") src_count[s]++
        }

        # Event type facet
        et = etype_map[k]
        if (et != "" && et != "?") type_count[et]++

        # Time buckets: YYYY-MM (monthly) and YYYY-MM-DD (daily for recent)
        t = timestamp[k]
        if (t != "" && t != "?") {
          ym = substr(t, 1, 7)
          if (ym ~ /^[0-9]{4}-[0-9]{2}$/) {
            time_bucket[ym]++
            if (oldest == "" || t < oldest) oldest = t
            if (newest == "" || t > newest) newest = t
          }
          ymd = substr(t, 1, 10)
          if (ymd ~ /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/) {
            day_bucket[ymd]++
          }
        }
      }

      printf "--- Facets (%d results) ---\n", facet_n

      # Project distribution (sorted by count, descending)
      np = 0
      for (p in proj_count) { np++; pnames[np] = p; pcounts[np] = proj_count[p] }
      for (i = 2; i <= np; i++) {
        tk = pnames[i]; tv = pcounts[i]; j = i - 1
        while (j >= 1 && pcounts[j] < tv) {
          pnames[j+1] = pnames[j]; pcounts[j+1] = pcounts[j]; j--
        }
        pnames[j+1] = tk; pcounts[j+1] = tv
      }
      printf "  projects: "
      for (i = 1; i <= np && i <= 8; i++) {
        if (i > 1) printf ", "
        printf "%s(%d)", pnames[i], pcounts[i]
      }
      if (np > 8) printf ", +%d more", np - 8
      printf "\n"

      # Event type distribution (sorted by count, descending)
      nt = 0
      for (et in type_count) { nt++; tnames[nt] = et; tcounts[nt] = type_count[et] }
      for (i = 2; i <= nt; i++) {
        tk = tnames[i]; tv = tcounts[i]; j = i - 1
        while (j >= 1 && tcounts[j] < tv) {
          tnames[j+1] = tnames[j]; tcounts[j+1] = tcounts[j]; j--
        }
        tnames[j+1] = tk; tcounts[j+1] = tv
      }
      printf "  types:    "
      for (i = 1; i <= nt && i <= 8; i++) {
        if (i > 1) printf ", "
        printf "%s(%d)", tnames[i], tcounts[i]
      }
      if (nt > 8) printf ", +%d more", nt - 8
      printf "\n"

      # Source distribution
      printf "  sources:  "
      first = 1
      for (s in src_count) {
        if (!first) printf ", "
        printf "%s(%d)", s, src_count[s]
        first = 0
      }
      printf "\n"

      # Time span + monthly + daily distribution
      if (oldest != "" && newest != "") {
        printf "  span:     %s to %s\n", substr(oldest, 1, 10), substr(newest, 1, 10)

        # Monthly buckets (sorted descending, show up to 6)
        nbk = 0
        for (ym in time_bucket) { nbk++; bnames[nbk] = ym; bcounts[nbk] = time_bucket[ym] }
        for (i = 2; i <= nbk; i++) {
          tk = bnames[i]; tv = bcounts[i]; j = i - 1
          while (j >= 1 && bnames[j] < tk) {
            bnames[j+1] = bnames[j]; bcounts[j+1] = bcounts[j]; j--
          }
          bnames[j+1] = tk; bcounts[j+1] = tv
        }
        printf "  months:   "
        for (i = 1; i <= nbk && i <= 6; i++) {
          if (i > 1) printf ", "
          printf "%s(%d)", bnames[i], bcounts[i]
        }
        if (nbk > 6) printf ", +%d older", nbk - 6
        printf "\n"

        # Daily buckets (sorted descending, show last 7 active days)
        ndk = 0
        for (ymd in day_bucket) { ndk++; dnames[ndk] = ymd; dcounts[ndk] = day_bucket[ymd] }
        for (i = 2; i <= ndk; i++) {
          tk = dnames[i]; tv = dcounts[i]; j = i - 1
          while (j >= 1 && dnames[j] < tk) {
            dnames[j+1] = dnames[j]; dcounts[j+1] = dcounts[j]; j--
          }
          dnames[j+1] = tk; dcounts[j+1] = tv
        }
        if (ndk > 0) {
          printf "  days:     "
          for (i = 1; i <= ndk && i <= 7; i++) {
            if (i > 1) printf ", "
            printf "%s(%d)", dnames[i], dcounts[i]
          }
          if (ndk > 7) printf ", +%d older", ndk - 7
          printf "\n"
        }
      }

      printf "---\n\n"
    }

    # ─── Display top results ───
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
