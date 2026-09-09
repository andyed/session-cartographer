#!/usr/bin/env bash
set -euo pipefail

# Build a two-part activity pulse: a deterministic census ABOVE a relevance
# sample.
#
# Why two parts. `cartographer-feed.sh` asks the ranking engine one relevance
# question with a fixed generic phrase ("recent activity decisions discoveries
# fixes research commits unfinished work") and reports what comes back. That is
# the right instrument for "what here is worth reading" and the wrong one for
# "what happened", because a census question has no relevance gradient: every
# event in the window is equally "about" yesterday, so the ranker returns *an*
# answer with no way for the caller to know it is not *the* answer. Measured on
# 2026-09-08: the feed returned 1 result (a Lemon Squeezy refund-policy fetch)
# from a 24h window that deterministically held 736 events, 22 sessions, 12
# projects, and 20 git commits/pushes across four repos.
#
# So this script counts first and ranks second. The counted half comes from the
# facts endpoint, is exhaustive within its window and scope, and cites event_ids
# so every number can be checked with `cartographer-search.sh --get`. The
# relevance half is the existing feed, unchanged, invoked as a subprocess. It
# finds meaning; the census establishes ground truth. Both belong, and labelling
# which is which is the whole point — an unlabelled sample reads as a census.
#
# This script never writes. It calls the read-only facts endpoint, and the feed
# it shells out to already routes served/access telemetry to /dev/null.
# `scripts/cartographer-search.sh` stays the single writer of retrieval
# telemetry; a second writer here would double-count every scheduled run.

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
FEED="$ROOT/scripts/cartographer-feed.sh"
# Preferred transport. The bare-curl path below is only for a runtime shipped
# without the client; when this file is present it wins, because it is the one
# place that speaks the spool envelope and validates the response contract.
FACTS_CLIENT="$ROOT/scripts/cartographer-facts.js"
# shellcheck source=./project-registry.sh
. "$ROOT/scripts/project-registry.sh"

PROJECTS=""
SINCE="24h"
BEFORE=""
QUERY="recent activity decisions discoveries fixes research commits unfinished work"
LIMIT_PER_PROJECT=5
MAX_RESULTS=24
MIN_SALIENCE=0.4
DENY_REGEX='a^'
EXCLUDE_EVENT_TYPES_REGEX='^tool_(bash|file_edit)$'
# Tempo needs completed days to build a baseline from, and it never scores the
# partial current day. A window as short as the census window would leave every
# project at z_status=insufficient_history, which is a true answer and a useless
# one, so the tempo window is widened independently of --since.
TEMPO_SINCE="21d"
TOP=50
SAMPLE=3
FACTS_URL="${CARTOGRAPHER_TURBO_URL:-http://127.0.0.1:2526}"
FACTS_TIMEOUT_MS=5000

usage() {
  printf 'Usage: %s --projects NAME[,NAME...] [options]\n' "$0"
  printf '  --since WHEN              census/search window, default: 24h\n'
  printf '  --before WHEN             optional upper time bound\n'
  printf '  --query TEXT              custom recall query (passed to the feed)\n'
  printf '  --limit-per-project N     default: 5\n'
  printf '  --max-results N           default: 24\n'
  printf '  --min-salience N          default: 0.4\n'
  printf '  --deny-regex REGEX        project/summary exclusion (default: none)\n'
  printf '  --exclude-event-types REGEX  default: routine bash/file edits\n'
  printf '  --tempo-since WHEN        baseline window for tempo, default: 21d\n'
  printf '  --top N                   census/tempo buckets per dimension, default: 50\n'
  printf '  --sample N                audit event_ids per bucket, default: 3\n'
  printf '  --facts-url URL           loopback facts service, default: %s\n' "$FACTS_URL"
  printf '  --facts-timeout-ms N      per-call budget, default: 5000\n'
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
    --tempo-since)       TEMPO_SINCE="$2"; shift 2 ;;
    --top)               TOP="$2"; shift 2 ;;
    --sample)            SAMPLE="$2"; shift 2 ;;
    --facts-url)         FACTS_URL="$2"; shift 2 ;;
    --facts-timeout-ms)  FACTS_TIMEOUT_MS="$2"; shift 2 ;;
    -h|--help)           usage; exit 0 ;;
    *)
      printf 'cartographer-pulse: unknown argument: %s\n' "$1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

[ -x "$FEED" ] || {
  printf 'cartographer-pulse: feed runtime is unavailable: %s\n' "$FEED" >&2
  exit 1
}

# Same fail-closed discipline as the feed. An unscoped census would be a
# complete, correct, and completely inappropriate answer: it would count the
# employer systems and deprecated-alias history that the caller's allowlist
# exists to exclude, and it would look authoritative doing it.
[ -n "$PROJECTS" ] || {
  printf 'cartographer-pulse: --projects is required; refusing an unscoped corpus census\n' >&2
  exit 2
}

if ! [[ "$LIMIT_PER_PROJECT" =~ ^[1-9][0-9]*$ ]] || \
   ! [[ "$MAX_RESULTS" =~ ^[1-9][0-9]*$ ]] || \
   ! [[ "$TOP" =~ ^[1-9][0-9]*$ ]] || \
   ! [[ "$SAMPLE" =~ ^[0-9]+$ ]] || \
   ! [[ "$FACTS_TIMEOUT_MS" =~ ^[1-9][0-9]*$ ]] || \
   ! [[ "$MIN_SALIENCE" =~ ^[0-9]+([.][0-9]+)?$ ]] || \
   ! awk -v value="$MIN_SALIENCE" 'BEGIN { exit !(value >= 0 && value <= 1) }'; then
  printf 'cartographer-pulse: limits must be positive integers and salience must be in [0,1]\n' >&2
  exit 2
fi

WORK=$(mktemp -d "${TMPDIR:-/tmp}/cartographer-pulse.XXXXXX")
trap 'rm -rf "$WORK"' EXIT
EXPANDED_PROJECT_FILE="$WORK/projects.txt"
: > "$EXPANDED_PROJECT_FILE"

# The census and the search have to describe the same corpus. If the two halves
# resolved `psychodeli` to different alias sets, the counted section would be
# measuring a scope the search section never looked at, and the reader has no way
# to tell. That used to be guaranteed by copying the feed's jq verbatim; it is
# now guaranteed by both calling the same resolver.
IFS=',' read -r -a project_list <<< "$PROJECTS"
for raw_project in "${project_list[@]}"; do
  project=$(printf '%s' "$raw_project" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
  [ -n "$project" ] || continue
  cartographer_expand_alias "$project" >> "$EXPANDED_PROJECT_FILE"
done

expanded_projects=$(sort -u "$EXPANDED_PROJECT_FILE" | paste -sd '|' -)
[ -n "$expanded_projects" ] || {
  printf 'cartographer-pulse: project allowlist expanded to zero projects\n' >&2
  exit 2
}
project_count=$(printf '%s' "$expanded_projects" | tr '|' '\n' | awk 'NF { n++ } END { print n + 0 }')

# ---------------------------------------------------------------------------
# Facts transport
# ---------------------------------------------------------------------------

FACTS_STATUS="ok"
FACTS_TRANSPORT=""
FACTS_ERROR=""

facts_call() {
  # $1 verb, $2 project spec, $3 since, $4 before, $5 output file
  local call_id="pulse-$1-$$-$(date +%s)"

  if [ -f "$FACTS_CLIENT" ]; then
    # Preferred path. The client owns transport selection (HTTP, then the spool
    # a Codex sandbox needs when loopback connect is denied) and validates the
    # response before printing it, so a truncated or wrong-corpus answer fails
    # here instead of being rendered as a smaller census.
    if node "$FACTS_CLIENT" --verb "$1" --project "$2" --since "$3" --before "$4" \
         --top "$TOP" --sample "$SAMPLE" --purpose pulse --call-id "$call_id" \
         --format json --url "$FACTS_URL" --timeout "$FACTS_TIMEOUT_MS" \
         > "$5" 2>"$WORK/facts-err.log"; then
      FACTS_TRANSPORT="client"
      return 0
    fi
    FACTS_ERROR=$(LC_ALL=C tr -d '\r' < "$WORK/facts-err.log" | tail -1)
    [ -n "$FACTS_ERROR" ] || FACTS_ERROR="$FACTS_CLIENT exited nonzero for verb '$1'"
    return 1
  fi

  # Fallback for a runtime shipped without the client. HTTP only: the spool
  # transport lives in the client, and reimplementing it here would give the
  # project two spool encoders to keep in step, which is exactly how the `kind`
  # discriminator gets forgotten and a census is answered by the ranker.
  local code request_file="$WORK/req-$1-$$.json"
  jq -nc \
    --arg verb "$1" --arg call_id "$call_id" --arg project "$2" \
    --arg since "$3" --arg before "$4" \
    --argjson top "$TOP" --argjson sample "$SAMPLE" \
    '{contract_version: 1, verb: $verb, call_id: $call_id, project: $project,
      since: $since, before: $before, top: $top, sample: $sample, purpose: "pulse"}' \
    > "$request_file"
  code=$(curl -s --max-time "$(awk -v ms="$FACTS_TIMEOUT_MS" 'BEGIN { printf "%.3f", ms / 1000 }')" \
    -o "$5" -w '%{http_code}' \
    -X POST "$FACTS_URL/api/facts" \
    -H 'Content-Type: application/json' \
    --data-binary @"$request_file" 2>/dev/null) || code="000"
  if [ "$code" = "200" ] && jq -e '.facts != null' "$5" >/dev/null 2>&1; then
    FACTS_TRANSPORT="http"
    return 0
  fi
  FACTS_ERROR="POST $FACTS_URL/api/facts returned HTTP $code and no client at $FACTS_CLIENT"
  return 1
}

CENSUS="$WORK/census.json"
CENSUS_ALL="$WORK/census-all.json"
TEMPO="$WORK/tempo.json"

if ! facts_call census "$expanded_projects" "$SINCE" "$BEFORE" "$CENSUS"; then
  FACTS_STATUS="unavailable"
fi
if [ "$FACTS_STATUS" = "ok" ]; then
  # The same window with no project scope. The difference is the blind spot:
  # events that happened and that this allowlist structurally cannot see.
  # Reporting it makes the policy boundary visible instead of invisible — the
  # operator decides whether to widen it, but not by accident.
  facts_call census "" "$SINCE" "$BEFORE" "$CENSUS_ALL" || : > "$CENSUS_ALL"
  facts_call tempo "$expanded_projects" "$TEMPO_SINCE" "$BEFORE" "$TEMPO" || : > "$TEMPO"
fi

# ---------------------------------------------------------------------------
# Header
# ---------------------------------------------------------------------------

generated_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)

printf '# Session Cartographer Pulse\n\n'
printf -- '- Generated: %s\n' "$generated_at"
if [ -n "$BEFORE" ]; then
  printf -- '- Window: since `%s`, before `%s`\n' "$SINCE" "$BEFORE"
else
  printf -- '- Window: since `%s`\n' "$SINCE"
fi
printf -- '- Scope: %d explicitly allowlisted project names\n' "$project_count"
if [ "$FACTS_STATUS" = "ok" ]; then
  printf -- '- Composition: a counted section (exhaustive within window and scope) above a search section (a relevance sample, not exhaustive)\n'
  printf -- '- Ground truth: facts service reachable via %s\n' "$FACTS_TRANSPORT"
else
  printf -- '- Composition: search section only; the counted section is UNAVAILABLE this run\n'
fi
printf -- '- Provenance: Claude Code/Codex Cartographer records; session evidence, not live-world evidence\n'
printf -- '- Privacy: summaries only; no raw transcript content is included\n\n'

# ---------------------------------------------------------------------------
# Counted
# ---------------------------------------------------------------------------

if [ "$FACTS_STATUS" != "ok" ]; then
  # Degrade loudly. Printing a zeroed census here would be the worst available
  # outcome: "0 events" is indistinguishable from "nothing happened", and the
  # consumer would act on a silence that is an outage.
  printf '## What happened (counted)\n\n'
  printf '**UNAVAILABLE this run.** The deterministic census could not be obtained: %s\n\n' "$FACTS_ERROR"
  printf 'This is an outage, not a quiet day. Do not read the absence of this section as an absence of activity, and do not infer counts from the search section below.\n\n'
  printf '## Commits\n\n_Unavailable: commits are read from the census._\n\n'
  printf '## Tempo\n\n_Unavailable: tempo is read from the facts service._\n\n'
else
  printf '## What happened (counted)\n\n'
  jq -r --argjson top "$TOP" '
    def ids: (.event_ids // []) | map(select(. != null)) | if length == 0 then "" else ("`" + join("`, `") + "`") end;
    .facts as $f |
    "- Events: \($f.events) (every event in this window and scope, counted)",
    "- Distinct sessions: \($f.sessions.resolved) resolved" +
      (if $f.unattributed.session > 0 then ", plus \($f.unattributed.session) row(s) that carry no session id" else "" end),
    "- Projects with activity: \($f.by_project | length)" +
      (if ($f.by_project | length) >= $top then " (bucket list truncated at top=\($top))" else "" end),
    "- Span: \($f.span.oldest // "n/a") to \($f.span.newest // "n/a")",
    "- Cannot attribute: project \($f.unattributed.project), session \($f.unattributed.session), provider \($f.unattributed.provider), type \($f.unattributed.type), event_id \($f.unattributed.event_id)",
    "- Dropped as undated: \($f.undated_dropped) (no readable timestamp, so not placeable inside or outside the window)",
    "- Corpus scanned: \(.corpus_events) events; index generation `\(.index_generation // "unknown")`",
    "",
    "### By project",
    "",
    "| project | events | sample event_ids |",
    "| --- | ---: | --- |",
    ($f.by_project[] | "| \(.name) | \(.count) | \(ids) |"),
    "",
    "### By event type",
    "",
    "| type | events | sample event_ids |",
    "| --- | ---: | --- |",
    ($f.by_type[] | "| \(.name) | \(.count) | \(ids) |"),
    ""
  ' "$CENSUS"

  if [ -s "$CENSUS_ALL" ]; then
    scoped_events=$(jq -r '.facts.events' "$CENSUS")
    all_events=$(jq -r '.facts.events' "$CENSUS_ALL")
    outside=$((all_events - scoped_events))
    if [ "$outside" -gt 0 ]; then
      # The excluded set is derived with the same substring rule the server's
      # projectMatcher uses, so a family name (`psychodeli`) is not reported as
      # excluding its own repositories. Counting the excluded projects here
      # rather than reusing the unscoped project total matters: those are
      # different numbers, and printing the total next to the word "excluded"
      # would overstate the blind spot every run.
      excluded_json=$(jq -c --arg scope "$expanded_projects" '
        ($scope | ascii_downcase | split("|") | map(select(length > 0))) as $names |
        [.facts.by_project[]
          | select((.name | ascii_downcase) as $p | ($names | any(. as $n | $p | contains($n))) | not)]
      ' "$CENSUS_ALL")
      excluded_count=$(printf '%s' "$excluded_json" | jq 'length')
      printf '### Outside the requested scope\n\n'
      printf -- '- %d event(s) in the same window belong to %d project(s) this allowlist does not include.\n' \
        "$outside" "$excluded_count"
      printf -- '- Excluded projects by volume: %s\n' \
        "$(printf '%s' "$excluded_json" | jq -r '
             (.[:12] | map("\(.name) (\(.count))") | join(", ")) +
             (if length > 12 then ", and \(length - 12) more" else "" end)
             | if . == "" then "none" else . end')"
      printf -- '- This is the allowlist working as configured, not a defect. It is reported so the blind spot is visible; widening it is an operator policy decision.\n\n'
    fi
  fi

  printf '## Commits\n\n'
  jq -r '
    .facts.commits as $c |
    if ($c | length) == 0 then
      "_No git_commit or git_push events in this window and scope._"
    else
      ($c
        | group_by(.project // "«unattributed»")
        | sort_by(- (. | length))
        | map(
            "### \(.[0].project // "«unattributed»") (\(. | length))\n\n" +
            (map("- `\(.timestamp // "?")` \(.type) `\(.event_id // "«no event_id»")`  \n  \((.summary // "") | gsub("[\r\n\t]+"; " "))")
              | join("\n"))
          )
        | join("\n\n"))
      + (if ($c | length) >= 200 then "\n\n_Commit list capped at 200 by the facts endpoint; the counts above are complete._" else "" end)
    end
  ' "$CENSUS"
  printf '\n'

  printf '## Tempo\n\n'
  if [ -s "$TEMPO" ]; then
    printf 'Daily event volume per project over `%s`. The current UTC day is still being written, so it is shown and never scored — comparing a two-hour day against twenty-four-hour days reads as a collapse in activity every time.\n\n' "$TEMPO_SINCE"
    jq -r '
      .facts.projects as $p |
      if ($p | length) == 0 then
        "_No dated activity for these projects in the tempo window._"
      else
        (["| project | scored day | events | baseline mean | z | status | partial today |",
          "| --- | --- | ---: | ---: | ---: | --- | --- |"]
         + ($p | map("| \(.project) | \(.scored_day // "n/a") | \(.scored_count) | \(.baseline_mean // "n/a") | \(if .z == null then "n/a" else (.z | tostring) end) | \(.z_status) | \(if .partial_day == null then "—" else "\(.partial_day.day): \(.partial_day.count) (unscored)" end) |"))
        ) | join("\n")
      end
    ' "$TEMPO"
  else
    printf '_Unavailable: the tempo call did not return._\n'
  fi
  printf '\n'
fi

# ---------------------------------------------------------------------------
# Search
# ---------------------------------------------------------------------------

printf '## What the search surfaced\n\n'
printf 'The existing relevance feed, unchanged, over the same window and scope. It ranks by similarity to one generic query, so it is a **sample selected for meaning**, not a count. Its own header follows verbatim; only its heading levels are demoted so it nests here (a second top-level heading mid-document reads to a consumer as the start of a new report).\n\n'

FEED_OUT="$WORK/feed.md"
FEED_ERR="$WORK/feed.err"
feed_args=(--projects "$PROJECTS" --since "$SINCE" --query "$QUERY"
  --limit-per-project "$LIMIT_PER_PROJECT" --max-results "$MAX_RESULTS"
  --min-salience "$MIN_SALIENCE" --deny-regex "$DENY_REGEX"
  --exclude-event-types "$EXCLUDE_EVENT_TYPES_REGEX")
if [ -n "$BEFORE" ]; then
  feed_args+=(--before "$BEFORE")
fi

feed_status=0
bash "$FEED" "${feed_args[@]}" > "$FEED_OUT" 2> "$FEED_ERR" || feed_status=$?

if [ "$feed_status" -ne 0 ]; then
  printf '**UNAVAILABLE this run.** The relevance feed exited %d.\n\n' "$feed_status"
  if [ -s "$FEED_ERR" ]; then
    printf 'Feed diagnostics: %s\n\n' "$(LC_ALL=C tr '\n' ' ' < "$FEED_ERR" | LC_ALL=C sed 's/[[:space:]]\{1,\}/ /g')"
  fi
else
  LC_ALL=C awk '/^#+ / { sub(/^#+ /, "### ") } { print }' "$FEED_OUT"
  printf '\n'
fi

# ---------------------------------------------------------------------------
# Consumer instructions
# ---------------------------------------------------------------------------

printf '## How to read this pulse\n\n'
printf -- '- **The counted section is exhaustive.** Every event in the stated window and scope is in those totals. If a project is absent from "By project", it had zero events in scope — not "none that ranked".\n'
# The placeholder positional is not decoration: cartographer-search.sh requires
# a query argument and ignores it under --get. Printing the flag without one
# turns the verification step into a keyword search for the literal string
# "--get", which returns confident, unrelated results.
printf -- '- **Every number is checkable.** Each bucket cites up to %d event_ids. Verify any count by exact-fetching them: `%s/scripts/cartographer-search.sh verify --get EVENT_ID[,EVENT_ID...]` (the positional query is a required placeholder and is ignored under `--get`). A deterministic answer that is silently wrong is worse than a slow one, so check rather than trust when a number drives a decision.\n' \
  "$SAMPLE" "$ROOT"
printf -- '- **Commits are the highest-confidence facts here.** They are recorded, not inferred from prose. They are also what relevance ranking is worst at surfacing, since a commit summary shares no vocabulary with a question like "what happened yesterday".\n'
printf -- '- **The search section is NOT exhaustive.** It is a ranked sample of at most %d rows above a salience floor of %s. Absence from it means "did not rank", never "did not happen". Never quote it as a count.\n' \
  "$MAX_RESULTS" "$MIN_SALIENCE"
printf -- '- **Unattributed rows are reported, never folded in.** The "Cannot attribute" line counts rows whose project, session, or type could not be resolved. They are stated beside the totals, never merged into a bucket: `"unknown"` is truthy and equal to itself, so grouping on it manufactures one phantom entity that reads as a real and very busy project.\n'
printf -- '- **Scope is a policy choice.** Anything outside the allowlist is invisible to both sections. The "Outside the requested scope" count, when present, is the size of that blind spot.\n'
printf -- '- **This is session evidence, not live-world evidence.** Read a cited transcript only when a result materially affects the decision at hand.\n'
