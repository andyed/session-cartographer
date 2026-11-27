#!/bin/bash
# UserPromptSubmit hook (Claude Code, Codex) and PreInvocation (Antigravity,
# through antigravity-hook-bridge.cjs): hand this session any note another
# agent session left for it with the cartographer `tell` tool.
#
# The mailbox and its rules live in scripts/mailbox.js. This hook is the
# delivery side only.
#
# Cost when nothing waits, which is almost every prompt: one bash glob over
# .carto/mailbox/*/pending/, no jq and no node. Only when some session has a
# note pending does it parse the payload (one jq) and start node to claim the
# notes addressed to this one.
#
# Silent-fail by design: every error path exits 0 with no output, so a fault
# never blocks the prompt. Stdout becomes model context on this event, so only
# the final JSON reaches it.

exec 2>/dev/null

DEV="${CARTOGRAPHER_DEV_DIR:-$HOME/Documents/dev}"
MAILBOX="$DEV/.carto/mailbox"

# Fast path: is any note pending for anyone?
[ -d "$MAILBOX" ] || exit 0
shopt -s nullglob
PENDING=("$MAILBOX"/*/pending/*.json)
shopt -u nullglob
[ "${#PENDING[@]}" -gt 0 ] || exit 0

command -v jq >/dev/null 2>&1 || exit 0
command -v node >/dev/null 2>&1 || exit 0

case "$0" in */*) HOOK_DIR="${0%/*}" ;; *) HOOK_DIR=. ;; esac
. "$HOOK_DIR/common.sh" || exit 0

IFS= read -r -d '' INPUT || true

FIELDS=$(printf '%s' "$INPUT" | jq -r '
  if type == "object" then . else {} end
  | [((.session_id // "") | tostring), (.transcript_path // ""), (.turn_id // ""), (.model // ""),
     (.hook_event_name // "UserPromptSubmit")]
  | @sh') || exit 0
[ -n "$FIELDS" ] || exit 0
eval "set -- $FIELDS"
PAYLOAD_SID=$1 TRANSCRIPT=$2 TURN_ID=$3 MODEL=$4 EVENT=$5

# Both ids, when they differ: standup addresses a session by the id its events
# carry, which comes from the env chain where one is set and the payload where not.
ARGS=()
cartographer_resolved "$PAYLOAD_SID" && ARGS+=(--session "$PAYLOAD_SID")
if cartographer_session_id && [ "$CARTO_SESSION_ID" != "$PAYLOAD_SID" ]; then
  ARGS+=(--session "$CARTO_SESSION_ID")
fi
[ "${#ARGS[@]}" -gt 0 ] || exit 0

# Is one of the pending notes ours? Checked here so a note for someone else
# costs no node start.
OURS=0
for ((i = 1; i < ${#ARGS[@]}; i += 2)); do
  for f in "${PENDING[@]}"; do
    case "$f" in "$MAILBOX/${ARGS[$i]}/pending/"*) OURS=1; break 2 ;; esac
  done
done
[ "$OURS" = 1 ] || exit 0

SCRIPT=$(cartographer_script mailbox.js) || exit 0
PROVIDER=$(detect_provider_from "$TRANSCRIPT" "$TURN_ID" "$MODEL")

node "$SCRIPT" deliver "${ARGS[@]}" --provider "$PROVIDER" --event "$EVENT"
exit 0
