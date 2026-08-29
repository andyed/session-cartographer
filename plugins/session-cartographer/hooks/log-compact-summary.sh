#!/usr/bin/env bash
# PostCompact hook: preserve Claude's generated continuation summary as a
# derived search aid, then refresh the canonical turn index asynchronously.
#
# The compact summary is intentionally not treated as canonical history. Raw
# transcript turns remain the source of truth; this event only provides a
# compact navigation surface while transcript catch-up runs.

set -u

DEV="${CARTOGRAPHER_DEV_DIR:-$HOME/Documents/dev}"
CHANGELOG="$DEV/changelog.jsonl"
SUMMARY_MAX="${CARTOGRAPHER_COMPACT_SUMMARY_MAX:-8000}"
INPUT=$(cat)

command -v jq >/dev/null 2>&1 || exit 0

EVENT=$(printf '%s' "$INPUT" | jq -r '.hook_event_name // empty' 2>/dev/null)
[ "$EVENT" = "PostCompact" ] || exit 0

SESSION_ID=$(printf '%s' "$INPUT" | jq -r '.session_id // empty' 2>/dev/null)
TRANSCRIPT=$(printf '%s' "$INPUT" | jq -r '.transcript_path // empty' 2>/dev/null)
CWD=$(printf '%s' "$INPUT" | jq -r '.cwd // empty' 2>/dev/null)
TRIGGER=$(printf '%s' "$INPUT" | jq -r '.trigger // "unknown"' 2>/dev/null)
RAW_SUMMARY=$(printf '%s' "$INPUT" | jq -r '.compact_summary // empty' 2>/dev/null)
[ -n "$RAW_SUMMARY" ] || exit 0

. "$(dirname "$0")/common.sh"
PROVIDER=$(detect_provider "$INPUT")

GIT_REPO=$(cd "$CWD" 2>/dev/null && git rev-parse --show-toplevel 2>/dev/null)
# A worktree's basename is a throwaway name; resolve to the parent repo.
. "$(dirname "$0")/common.sh"
PROJECT=$(cartographer_project "$CWD")

# Event summaries must remain single-line. Redact common credential shapes
# before either the plaintext changelog or Qdrant can retain them. This is a
# backstop, not a guarantee; users should still avoid putting secrets in chat.
NORMALIZED=$(printf '%s' "$RAW_SUMMARY" | tr '\n\t\r' '   ' | tr -s ' ')
REDACTED=$(printf '%s' "$NORMALIZED" | jq -Rr '
  gsub("gh[pousr]_[A-Za-z0-9_]{20,}"; "[REDACTED_GITHUB_TOKEN]")
  | gsub("sk-(ant-|proj-)?[A-Za-z0-9_-]{16,}"; "[REDACTED_API_KEY]")
  | gsub("xox[baprs]-[A-Za-z0-9-]{10,}"; "[REDACTED_SLACK_TOKEN]")
  | gsub("AKIA[0-9A-Z]{16}"; "[REDACTED_AWS_KEY]")
  | gsub("(?i)bearer[[:space:]]+[A-Za-z0-9._~+/-]{16,}"; "Bearer [REDACTED_TOKEN]")
  | gsub("(?i)(api[_ -]?key|access[_ -]?token|auth[_ -]?token|password|secret)[[:space:]]*[:=][[:space:]]*[^[:space:],;]+"; "[REDACTED_CREDENTIAL]")
' 2>/dev/null)
[ -n "$REDACTED" ] || REDACTED="[compact summary unavailable after sanitization]"

case "$SUMMARY_MAX" in ''|*[!0-9]*) SUMMARY_MAX=8000 ;; esac
[ "$SUMMARY_MAX" -lt 256 ] && SUMMARY_MAX=256
SUMMARY=$(printf '%s' "$REDACTED" | awk -v max="$SUMMARY_MAX" '{ print substr($0, 1, max) }')
if [ "${#REDACTED}" -gt "${#SUMMARY}" ]; then
  SUMMARY_TRUNCATED=true
else
  SUMMARY_TRUNCATED=false
fi

HASH_INPUT=$(printf '%s\n%s\n%s' "$SESSION_ID" "$TRIGGER" "$REDACTED")
if command -v shasum >/dev/null 2>&1; then
  SUMMARY_HASH=$(printf '%s' "$HASH_INPUT" | shasum -a 256 | awk '{print $1}')
elif command -v sha256sum >/dev/null 2>&1; then
  SUMMARY_HASH=$(printf '%s' "$HASH_INPUT" | sha256sum | awk '{print $1}')
else
  SUMMARY_HASH=$(printf '%s' "$HASH_INPUT" | cksum | awk '{print $1}')
fi
EVENT_ID="evt-compact-summary-$(printf '%.16s' "$SUMMARY_HASH")"

mkdir -p "$DEV" 2>/dev/null || exit 0
if [ -f "$CHANGELOG" ] && LC_ALL=C grep -Fq "\"event_id\":\"$EVENT_ID\"" "$CHANGELOG" 2>/dev/null; then
  exit 0
fi

TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
PARENT_ID=$(find_parent_event_id "$CHANGELOG" "$SESSION_ID" "$TIMESTAMP")
ENCODED_PATH=$(printf '%s' "$TRANSCRIPT" | jq -sRr @uri 2>/dev/null)
DEEPLINK=""
[ "$PROVIDER" = "claude" ] && DEEPLINK="claude-history://session/${ENCODED_PATH}"

EVENT_JSON=$(jq -n -c \
  --arg eid "$EVENT_ID" \
  --arg ts "$TIMESTAMP" \
  --arg session "$SESSION_ID" \
  --arg provider "$PROVIDER" \
  --arg project "$PROJECT" \
  --arg cwd "$CWD" \
  --arg transcript "$TRANSCRIPT" \
  --arg deeplink "$DEEPLINK" \
  --arg summary "$SUMMARY" \
  --arg hash "$SUMMARY_HASH" \
  --arg trigger "$TRIGGER" \
  --arg parent_id "$PARENT_ID" \
  --argjson truncated "$SUMMARY_TRUNCATED" \
  '{event_id:$eid, timestamp:$ts, type:"derived_compaction_summary", provider:$provider, session_id:$session, project:$project, cwd:$cwd, transcript_path:$transcript, deeplink:$deeplink, summary:$summary, summary_hash:$hash, summary_truncated:$truncated, compaction_trigger:$trigger, canonical:false, noise_class:"compaction_echo", derived_from:{kind:"claude_postcompact", session_id:$session, transcript_path:$transcript}, related_ids:[], salience:0.35}
   + if $parent_id != "" then {parent_event_id:$parent_id} else {} end') || exit 0

printf '%s\n' "$EVENT_JSON" >> "$CHANGELOG"

# Both follow-ups are detached and optional. Compaction continuity must never
# depend on local embedding services or a historical backfill completing.
if [ "${CARTOGRAPHER_POSTCOMPACT_INDEX:-1}" = "1" ]; then
  INDEXER=$(cartographer_script index-event.sh)
  if [ -x "$INDEXER" ]; then
    printf '%s\n' "$EVENT_JSON" | nohup "$INDEXER" >/dev/null 2>&1 &
  fi
fi

if [ "${CARTOGRAPHER_POSTCOMPACT_CATCHUP:-1}" = "1" ]; then
  CATCHUP=$(cartographer_script catch-up-transcripts.sh)
  if [ -x "$CATCHUP" ]; then
    nohup "$CATCHUP" --provider claude --force >/dev/null 2>&1 </dev/null &
  fi
fi

exit 0
