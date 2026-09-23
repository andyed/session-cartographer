#!/usr/bin/env bash
# Record one /investigate event: an opened hypothesis, or the outcome that
# closes one. Reads a small JSON request on stdin and prints a JSON receipt.
#
#   {"kind":"open",  "symptom":"...", "hypothesis":"...", "layer":"boundary",
#    "files":["js/app.js"]}                                  # layer, files optional
#   {"kind":"close", "resolves":"evt-abc123def456", "outcome":"confirmed",
#    "evidence":"..."}                                       # confirmed|refuted|abandoned
#
# The skill used to carry this as an inline jq block. Agents paraphrased it,
# which produced four record shapes and 64 diagnoses written to a path nothing
# searched (see backfill-investigations.js). One script, one shape.
#
# Both kinds land in changelog.jsonl, the log /remember searches, and are then
# indexed. An outcome carries the original event id in its summary so a keyword
# search for that id finds both halves. The JSONL write and the semantic index
# are separate states: an indexing failure never erases the durable record.

DEV="${CARTOGRAPHER_DEV_DIR:-$HOME/Documents/dev}"
LOG_FILE="${CARTOGRAPHER_CHANGELOG:-$DEV/changelog.jsonl}"
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
INDEXER="${CARTOGRAPHER_INDEXER:-$SCRIPT_DIR/index-event.sh}"

fail() {
  jq -n -c --arg stage "$1" --arg eid "${EVENT_ID:-}" --arg log "${2:-not_written}" \
    '{event_id:(if $eid == "" then null else $eid end),log_outcome:$log,
      index:{outcome:"not_attempted",stage:$stage}}' 2>/dev/null \
    || printf '{"event_id":null,"log_outcome":"not_written","index":{"outcome":"not_attempted","stage":"%s"}}\n' "$1"
  exit "${3:-65}"
}

command -v jq >/dev/null 2>&1 || fail jq_missing not_written 69
INPUT=$(cat)
printf '%s' "$INPUT" | jq -e 'type == "object"' >/dev/null 2>&1 || fail invalid_json

field() { printf '%s' "$INPUT" | jq -r --arg k "$1" '.[$k] // empty'; }
KIND=$(field kind)
flat() { printf '%s' "$1" | tr '\n\t' '  '; }

# ── Who and where ──────────────────────────────────────────────────────────
CLAUDE_SID="${CLAUDE_SESSION_ID:-${CLAUDE_CODE_SESSION_ID:-}}"
SESSION_ID="${CARTOGRAPHER_SESSION_ID:-${CLAUDE_SID:-${CODEX_SESSION_ID:-unknown}}}"
PROVIDER="${CARTOGRAPHER_PROVIDER:-unknown}"
[ "$PROVIDER" = "unknown" ] && [ -n "$CLAUDE_SID" ] && PROVIDER="claude"
[ "$PROVIDER" = "unknown" ] && [ -n "${CODEX_SESSION_ID:-}" ] && PROVIDER="codex"
# A worktree resolves to its parent repo; cartographer-project.sh is the one
# definition shared with the hooks.
PROJECT=$(bash "$SCRIPT_DIR/cartographer-project.sh" 2>/dev/null) || PROJECT=""
[ -n "$PROJECT" ] || PROJECT=$(basename "$(git rev-parse --show-toplevel 2>/dev/null || pwd)")
TRANSCRIPT=""
if [ "$SESSION_ID" != "unknown" ]; then
  TRANSCRIPT=$(find "$HOME/.claude/projects" -name "${SESSION_ID}.jsonl" 2>/dev/null | head -1)
  if [ -z "$TRANSCRIPT" ]; then
    TRANSCRIPT=$(find "$HOME/.codex/sessions" "$HOME/.codex/archived_sessions" -name "*${SESSION_ID}*.jsonl" 2>/dev/null | head -1)
    [ -n "$TRANSCRIPT" ] && PROVIDER="codex"
  fi
fi

EVENT_ID="evt-$(LC_ALL=C tr -dc 'a-z0-9' < /dev/urandom | head -c 12)"
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
BASE=$(jq -n -c --arg eid "$EVENT_ID" --arg ts "$TIMESTAMP" --arg session "$SESSION_ID" \
  --arg provider "$PROVIDER" --arg project "$PROJECT" --arg cwd "$(pwd)" --arg transcript "$TRANSCRIPT" \
  '{event_id:$eid, timestamp:$ts, provider:$provider, session_id:$session,
    project:$project, cwd:$cwd, transcript_path:$transcript}')

# ── The event ──────────────────────────────────────────────────────────────
case "$KIND" in
  open)
    SYMPTOM=$(field symptom); HYPOTHESIS=$(field hypothesis); LAYER=$(field layer)
    [ -n "$SYMPTOM" ] || fail missing_symptom
    [ -n "$HYPOTHESIS" ] || fail missing_hypothesis
    EVENT=$(printf '%s' "$INPUT" | jq -c --argjson base "$BASE" \
      --arg summary "$(flat "Investigated: $SYMPTOM — $HYPOTHESIS")" \
      --arg symptom "$SYMPTOM" --arg hypothesis "$HYPOTHESIS" --arg layer "$LAYER" \
      '$base + {type:"investigation", summary:$summary, symptom:$symptom,
        hypothesis:$hypothesis, salience:0.8}
       + (if $layer == "" then {} else {root_cause_layer:$layer} end)
       + (if (.files | type) == "array" then {files:.files} else {} end)')
    ;;
  close)
    RESOLVES=$(field resolves); OUTCOME=$(field outcome); EVIDENCE=$(field evidence)
    printf '%s' "$RESOLVES" | grep -Eq '^evt-[a-z0-9]+$' || fail missing_resolves
    case "$OUTCOME" in confirmed|refuted|abandoned) ;; *) fail invalid_outcome ;; esac
    [ -n "$EVIDENCE" ] || fail missing_evidence
    EVENT=$(jq -n -c --argjson base "$BASE" \
      --arg summary "$(flat "Investigation $OUTCOME: $RESOLVES — $EVIDENCE")" \
      --arg resolves "$RESOLVES" --arg outcome "$OUTCOME" --arg evidence "$EVIDENCE" \
      '$base + {type:"investigation_outcome", summary:$summary, resolves:$resolves,
        outcome:$outcome, evidence:$evidence, salience:0.8}')
    ;;
  *) fail invalid_kind ;;
esac
[ -n "$EVENT" ] || fail event_not_built

# ── Durable write, then index ──────────────────────────────────────────────
mkdir -p "$(dirname "$LOG_FILE")" 2>/dev/null || fail log_directory_unwritable not_written 73
printf '%s\n' "$EVENT" >> "$LOG_FILE" || fail log_write_failed not_written 73
LC_ALL=C grep -F "\"event_id\":\"$EVENT_ID\"" "$LOG_FILE" >/dev/null 2>&1 || fail log_verify_failed not_written 74

[ -f "$INDEXER" ] || fail indexer_missing written 69
INDEX_STATUS=0
# Pipe the event just built, never a re-read: concurrent sessions share the log.
INDEX_RECEIPT=$(printf '%s\n' "$EVENT" | CARTOGRAPHER_INDEX_RECEIPT=1 bash "$INDEXER") || INDEX_STATUS=$?
printf '%s' "$INDEX_RECEIPT" | jq -e . >/dev/null 2>&1 \
  || INDEX_RECEIPT='{"outcome":"unknown","stage":"invalid_index_receipt"}'

jq -n -c --arg eid "$EVENT_ID" --arg kind "$KIND" --argjson index "$INDEX_RECEIPT" \
  '{event_id:$eid, kind:$kind, log_outcome:"written", index:$index}'
exit "$INDEX_STATUS"
