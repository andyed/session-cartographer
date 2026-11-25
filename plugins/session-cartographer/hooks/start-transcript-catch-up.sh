#!/usr/bin/env bash
# SessionStart hook: launch checkpointed transcript catch-up in the background.

[ "${CARTOGRAPHER_AUTO_CATCHUP:-1}" = "1" ] || exit 0

cat >/dev/null
. "$(dirname "$0")/common.sh"
CATCHUP=$(cartographer_script catch-up-transcripts.sh)
[ -x "$CATCHUP" ] || exit 0

# The worker owns cooldown and locking. Detaching keeps SessionStart fast.
CATCHUP_PROVIDER="codex"
case "${CARTOGRAPHER_PROVIDER:-}" in
  antigravity|all|claude|codex) CATCHUP_PROVIDER="$CARTOGRAPHER_PROVIDER" ;;
esac
nohup "$CATCHUP" --provider "$CATCHUP_PROVIDER" >/dev/null 2>&1 </dev/null &
exit 0
