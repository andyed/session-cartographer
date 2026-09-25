#!/bin/bash
# PreToolUse hook: before an edit, note whether another session recently edited
# or committed the same file. Silent when there is no collision; never blocks.
# The logic lives in scripts/cartographer-collision.js (shared contention rules
# with /standup). Disable with CARTOGRAPHER_COLLISION_CHECK=0.
command -v node >/dev/null 2>&1 || exit 0
[ "${CARTOGRAPHER_COLLISION_CHECK:-1}" = "0" ] && exit 0
. "$(dirname "$0")/common.sh"
SCRIPT=$(cartographer_script cartographer-collision.js) || exit 0
node "$SCRIPT" 2>/dev/null
exit 0
