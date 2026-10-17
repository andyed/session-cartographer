#!/bin/bash
# UserPromptSubmit hook (TRIAL, opt-in): when the user's prompt points at shared
# history, run recall and hand the agent the top hits before it answers.
#
# Agents do not reach for recall mid-session. Measured 2026-10-15 over 30 days of
# Claude transcripts: 72 prompts carried a memory cue ("thought we fixed this?",
# "did we implement that?", "not sure where we tried that (which agent)") and the
# agent recalled after 4. Codex recalled in 1 of 59 sessions that saw the
# SessionStart nudge. Recall is fast now; the missing step is the call. This hook
# makes it where the cue happens instead of relying on the agent to remember a
# skill exists.
#
# DORMANT BY DEFAULT. Trial it:  export CARTOGRAPHER_RECALL_ON_PROMPT=1  (then launch)
#   Stop:      unset CARTOGRAPHER_RECALL_ON_PROMPT
#   Bake out:  remove this file + its UserPromptSubmit block in both hook files
#
# What counts as a cue: recallCue() in scripts/classify-prompt-intent.js, a list
# of named, rule-based patterns. Never the first prompt of a session (SessionStart
# orients turn one), a slash command, tooling text that starts with "<", or a
# compaction continuation. A cue whose prompt has no topic left once the cue is
# removed ("didn't we fix this?") abstains rather than search for "fix".
#
# Cost: a non-cue prompt pays a jq to read, a node to classify and a jq to log
# (~75 ms measured). A cue runs cartographer-search.sh under a hard budget
# (default 1500 ms); past it the search and its children are killed and the hook
# abstains. A cue answered by warm Turbo took 630-670 ms end to end.
#
# What it injects: at most three single-line hits that clear the score floor,
# plus the call_id for --get/--touch. The floor is applied inside the search
# (--min-score), so the served rows and the delta-serving list hold exactly what
# the agent was shown.
#
# The floor, 0.010, came from 19 real cue prompts replayed against recall on
# 2026-10-15, each windowed to the 30 days before it and its scores re-based to
# the prompt's own time (decay runs from now, so an old window scores low for
# its age alone). Relevant top hits scored 0.0112-0.0219. The three prompts with
# nothing behind them in the corpus topped out at 0.0059-0.0077. Between those,
# judged-irrelevant top hits (0.0115-0.0168) overlap relevant ones, so no floor
# separates them: this one removes the empty queries and leaves the rest to the
# agent, which is told to verify before relying on a hit.
#
# That replay predates the lookup exemption (2026-10-16) and lift (2026-10-17):
# a prompt whose words all appear in at most 10 records now scores those records
# undecayed and x3, so they clear this floor far more often (24 -> 73 of 139
# replayed real lookups, docs/SCORING.md "Lifting named records"). Re-run the
# replay before baking the hook in.
#
# Measurable: one row per evaluated prompt in $DEV/recall-on-prompt-trial.jsonl —
# fired or why not, latency, counts, call_id. The search writes its own served
# and search-call rows (purpose "prompt-cue"), including the pre-floor top_score
# an abstention never sees; join on call_id. This hook writes neither.
#
# Silent-fail by design: every error path exits 0 with no output. It never exits
# 2, which would block the prompt.
#
# Env: CARTOGRAPHER_RECALL_ON_PROMPT (gate), CARTOGRAPHER_RECALL_ON_PROMPT_BUDGET_MS
#      (1500), CARTOGRAPHER_RECALL_ON_PROMPT_MIN_SCORE (0.010), CARTOGRAPHER_DEV_DIR
#      (~/Documents/dev), CARTOGRAPHER_RECALL_ON_PROMPT_LOG (the trial log path),
#      TMPDIR_BASE (/tmp; per-session first-prompt markers).

# Gate first, before touching stdin: the dormant path costs a bash start and nothing else.
[ "${CARTOGRAPHER_RECALL_ON_PROMPT:-0}" = "1" ] || exit 0

# Stdout becomes model context on this event, so nothing but the final JSON may
# reach it, and stderr carries nothing anyone reads.
exec 2>/dev/null

command -v jq >/dev/null 2>&1 || exit 0
command -v node >/dev/null 2>&1 || exit 0

case "$0" in */*) HOOK_DIR="${0%/*}" ;; *) HOOK_DIR=. ;; esac
. "$HOOK_DIR/common.sh" || exit 0

IFS= read -r -d '' INPUT || true

# One jq for every field, the timestamp included.
FIELDS=$(printf '%s' "$INPUT" | jq -r '
  if type == "object" then . else {} end
  | [((.prompt // .user_prompt // "") | tostring), ((.session_id // "") | tostring),
     (.transcript_path // ""), (.cwd // ""), (.turn_id // ""), (.model // ""), (now | todate)]
  | @sh') || exit 0
[ -n "$FIELDS" ] || exit 0
eval "set -- $FIELDS"
PROMPT=$1 PAYLOAD_SID=$2 TRANSCRIPT=$3 CWD=$4 TURN_ID=$5 MODEL=$6 TS=$7

DEV="${CARTOGRAPHER_DEV_DIR:-$HOME/Documents/dev}"
TRIAL="${CARTOGRAPHER_RECALL_ON_PROMPT_LOG:-$DEV/recall-on-prompt-trial.jsonl}"
STATE_DIR="${TMPDIR_BASE:-/tmp}/cartographer-recall-on-prompt"
PROVIDER=$(detect_provider_from "$TRANSCRIPT" "$TURN_ID" "$MODEL")

# The session the search will name. The chain comes first because the search
# child reads the same chain; the payload's id fills in when the chain is empty,
# and is then handed to the child explicitly so both rows still agree.
SID="" SID_SOURCE=""
if cartographer_session_id; then
  SID="$CARTO_SESSION_ID"; SID_SOURCE="$CARTO_SESSION_SOURCE"
elif cartographer_resolved "$PAYLOAD_SID"; then
  SID="$PAYLOAD_SID"; SID_SOURCE="payload"
fi

BUDGET_MS="${CARTOGRAPHER_RECALL_ON_PROMPT_BUDGET_MS:-1500}"
case "$BUDGET_MS" in ''|*[!0-9]*) BUDGET_MS=1500 ;; esac
MIN_SCORE="${CARTOGRAPHER_RECALL_ON_PROMPT_MIN_SCORE:-0.010}"
case "$MIN_SCORE" in ''|*[!0-9.]*|*.*.*|.) MIN_SCORE=0.010 ;; esac

STAMP="${TS//[-:]/}"
CALL_ID="call-${STAMP%Z}-$$"
CUE="" STRENGTH="" TOPIC="" QUERY="" PROJECT="" SCOPE="" LATENCY="" COUNT="" TOP="" IDS="" SEARCHED=""

# record <fired:true|false> <reason> — one trial row per evaluated prompt. The
# prompt text is kept only once a cue matched, so the log can be replayed against
# recall to retune the floor without holding every prompt the user typed.
record() {
  local excerpt="" row
  [ -n "$CUE" ] && excerpt=$(cartographer_bytes "$PROMPT" 300)
  row=$(jq -n -c \
    --arg ts "$TS" --arg session "$SID" --arg session_source "$SID_SOURCE" \
    --arg provider "$PROVIDER" --arg project "$PROJECT" --arg scope "$SCOPE" \
    --arg cue "$CUE" --arg strength "$STRENGTH" --arg topic "$TOPIC" \
    --arg reason "$2" --argjson fired "$1" --arg latency "$LATENCY" \
    --arg count "$COUNT" --arg top "$TOP" --arg call_id "$CALL_ID" --arg ids "$IDS" \
    --arg prompt "$excerpt" --arg query "$QUERY" --arg chars "${#PROMPT}" \
    --arg budget "$BUDGET_MS" --arg min_score "$MIN_SCORE" --arg searched "$SEARCHED" '
    def num: if . == "" then null else tonumber end;
    def str: if . == "" then null else . end;
    {timestamp: $ts, session_id: ($session | str), session_source: ($session_source | str),
     provider: $provider, project: ($project | str), scope: ($scope | str),
     fired: $fired, reason: $reason, cue: ($cue | str), cue_strength: ($strength | str),
     topic_words: ($topic | num), latency_ms: ($latency | num), result_count: ($count | num),
     top_score: ($top | num), event_ids: (if $ids == "" then [] else ($ids | split(",")) end),
     call_id: (if $searched == "" then null else $call_id end),
     budget_ms: ($budget | tonumber), min_score: ($min_score | tonumber),
     prompt_chars: ($chars | tonumber), prompt: ($prompt | str), query: ($query | str)}' 2>/dev/null)
  if [ -n "$row" ]; then cartographer_append "$TRIAL" "$row" 2>/dev/null; fi
}

# First prompt of the session: SessionStart already oriented this turn. Checked
# before the prompt's shape, because turn one is turn one whatever it says.
KEY="$SID"
[ -n "$KEY" ] || KEY="$TRANSCRIPT"
if [ -n "$KEY" ]; then
  MARK="$STATE_DIR/${KEY//[!A-Za-z0-9._-]/_}"
  if [ ! -e "$MARK" ]; then
    [ -d "$STATE_DIR" ] || mkdir -p "$STATE_DIR"
    : > "$MARK"
    record false first_prompt
    exit 0
  fi
fi

LEAD="${PROMPT#"${PROMPT%%[![:space:]]*}"}"
case "$LEAD" in
  '') record false empty; exit 0 ;;
  '<'*) record false tooling; exit 0 ;;
  '/'*) record false slash_command; exit 0 ;;
  'This session is being continued from a previous conversation'*) record false compaction; exit 0 ;;
esac

CLASSIFIER=$(cartographer_script classify-prompt-intent.js) || { record false no_classifier; exit 0; }
CUE_LINE=$(printf '%s' "$PROMPT" | node "$CLASSIFIER" --recall-cue) || { record false classifier_error; exit 0; }
[ -n "$CUE_LINE" ] || { record false no_cue; exit 0; }

# "<cue>\t<strong|weak>\t<topic words>\t<query>", split without a process.
TAB=$'\t'
CUE="${CUE_LINE%%"$TAB"*}";  REST="${CUE_LINE#*"$TAB"}"
STRENGTH="${REST%%"$TAB"*}"; REST="${REST#*"$TAB"}"
TOPIC="${REST%%"$TAB"*}";    QUERY="${REST#*"$TAB"}"
# A classifier that predates --recall-cue reads the flag as prompt text and
# prints an intent ("feedback-context\tFeedback/context"). Abstain, never fire on it.
case "$STRENGTH" in strong|weak) ;; *) CUE="" STRENGTH="" TOPIC="" QUERY=""; record false classifier_error; exit 0 ;; esac
case "$TOPIC" in ''|*[!0-9]*) TOPIC=0 ;; esac
[ "$TOPIC" -gt 0 ] || { record false no_topic; exit 0; }

# Scope to the project the session is in, unless that "project" is the
# workspace root or a home directory: --project is a substring filter, and
# `dev` would match unrelated repositories. Those sessions search everything.
if [ -n "$CWD" ]; then
  cartographer_repo "$CWD"
  PROJECT="$CARTO_PROJECT"
fi
SCOPE="$PROJECT"
NONPROJ=$(cartographer_script non-projects.js)
if [ -n "$PROJECT" ] && [ -n "$NONPROJ" ]; then
  CARTOGRAPHER_DEV_DIR="$DEV" node "$NONPROJ" --is-non-project "$PROJECT" >/dev/null
  [ $? -eq 0 ] && SCOPE=""
fi

SEARCH=$(cartographer_script cartographer-search.sh) || { record false no_search; exit 0; }
[ -d "$STATE_DIR" ] || mkdir -p "$STATE_DIR"
OUT="$STATE_DIR/out.$$"
LATE="$OUT.late"
rm -f "$OUT" "$LATE"

[ "$SID_SOURCE" = "payload" ] && export CARTOGRAPHER_SESSION_ID="$SID"
case "$PROVIDER" in
  claude|codex) [ -n "${CARTOGRAPHER_PROVIDER:-}" ] || export CARTOGRAPHER_PROVIDER="$PROVIDER" ;;
esac

set -- --since 30d --limit 3 --format jsonl --purpose prompt-cue \
  --call-id "$CALL_ID" --min-score "$MIN_SCORE"
[ -n "$SCOPE" ] && set -- "$@" --project "$SCOPE"

now_ms() { perl -MTime::HiRes=time -e 'printf "%d", time() * 1000' 2>/dev/null; }
STARTED=$(now_ms)
SEARCHED=1

# Hard budget. Job control puts the search and the watchdog each in a process
# group of its own, so one signal reaches the search's whole tree (the Turbo
# client, the awk ladders) and the watchdog's sleep is not left behind. Turbo's
# own server is spawned detached and is never in that group. The watchdog leaves
# a marker, so a timeout is told from a search that failed on its own.
BUDGET_S="$((BUDGET_MS / 1000)).$(printf '%03d' $((BUDGET_MS % 1000)))"
set -m
bash "$SEARCH" "$QUERY" "$@" < /dev/null > "$OUT" &
SEARCH_PID=$!
( sleep "$BUDGET_S"; : > "$LATE"; kill -TERM -- "-$SEARCH_PID" ) &
WATCH_PID=$!
set +m
wait "$SEARCH_PID"
STATUS=$?
kill -TERM -- "-$WATCH_PID"
wait "$WATCH_PID"

ENDED=$(now_ms)
[ -n "$STARTED" ] && [ -n "$ENDED" ] && LATENCY=$((ENDED - STARTED))

if [ -e "$LATE" ]; then
  rm -f "$OUT" "$LATE"
  record false timeout
  exit 0
fi
if [ "$STATUS" -ne 0 ]; then
  rm -f "$OUT"
  record false search_error
  exit 0
fi

# One jq renders the context and the hook JSON. Line 1 is "<count>\t<top>\t<ids>"
# for the trial row; line 2, present only when something cleared the floor, is
# the hook output. Every hit already cleared --min-score inside the search.
#
# Size: the context stays near 600 characters. Header and hint are fixed; the
# remainder is split across the hits and each summary is cut to fit its share.
# A hit's project is printed only when it differs from the scope the header
# names. "this session" marks a hit from the asking session, which the agent may
# no longer hold after a compaction. The portable path's "summary" is its BM25
# search text (summary, description, prompt, url, query, then the event id and
# cwd), so it is cut where the id begins; Turbo's is the summary itself.
RENDERED=$(jq -Rnr --arg sid "$SID" --arg cue "$CUE" --arg scope "$SCOPE" --arg cid "$CALL_ID" '
  def extra($k): ((.extras // "") | split("|") | map(select(startswith($k + ":"))) | first // "")
    | ltrimstr($k + ":");
  def provider: extra("provider") as $p
    | if $p != "" then $p
      else extra("transcript") | if test("/\\.codex/") then "codex" elif test("/\\.claude/") then "claude" else "" end
      end;
  def clip($n): if length > $n then .[0:($n - 1)] + "…" else . end;
  [inputs | fromjson? | select(type == "object" and ((.event_id // "") | length) > 0)] as $rows
  | ($rows | length) as $n
  | "\($n)\t\($rows[0].score // "")\t\($rows | map(.event_id) | join(","))",
    (if $n == 0 then empty else
      ("[carto recall · \($cue) cue] Prior work matching this prompt ("
        + (if $scope == "" then "all projects" else $scope end) + ", 30d):") as $head
      | ("Verify before relying on one: cartographer-search.sh _ --get <id> --call-id \($cid)"
        + " (then --touch <id>, same --call-id, if it helped).") as $hint
      | (((600 - ($head | length) - ($hint | length)) / $n) | floor) as $share
      | [ $rows[] |
          ((.timestamp // "")[0:10]) as $date
          | ((.project // "") | if . == $scope then "" else . end) as $proj
          | provider as $prov
          | ([$proj, $prov] | map(select(. != "")) | join("/")) as $where
          | ((if $sid != "" and extra("session") == $sid then " (this session)" else "" end)) as $own
          | ("- \($date)" + (if $where == "" then "" else " \($where)" end) + ": ") as $prefix
          | (" [\(.event_id)]\($own)") as $suffix
          | .event_id as $ev | (.event_type // "event") as $etype
          | ((.summary // "") | tostring | gsub("\\s+"; " ")
              | (index(" " + $ev)) as $cut | (if $cut then .[0:$cut] else . end)
              | gsub("^ +| +$"; "")
              | sub("(?<sha>\\b[0-9a-f]{7})[0-9a-f]{33}\\b"; "\(.sha)")
              | if . == "" then $etype else . end) as $summary
          | $prefix + ($summary | clip([($share - ($prefix | length) - ($suffix | length)), 24] | max)) + $suffix
        ] as $lines
      | ([$head] + $lines + [$hint] | join("\n")) as $ctx
      | {hookSpecificOutput: {hookEventName: "UserPromptSubmit", additionalContext: $ctx}} | tojson
    end)
' "$OUT")
rm -f "$OUT"

META="${RENDERED%%$'\n'*}"
COUNT="${META%%"$TAB"*}"; REST="${META#*"$TAB"}"
TOP="${REST%%"$TAB"*}";   IDS="${REST#*"$TAB"}"
case "$COUNT" in ''|*[!0-9]*) record false search_error; exit 0 ;; esac
[ "$COUNT" -gt 0 ] || { record false no_confident_hit; exit 0; }

record true injected
printf '%s\n' "${RENDERED#*$'\n'}"
exit 0
