#!/bin/bash
# PreToolUse hook: before an edit, note whether another session recently edited
# or committed the same file, and (opt-in) what the corpus knows about a file
# the first time this session edits it. Silent when there is nothing; never
# blocks. The logic lives in scripts/cartographer-collision.js (shared
# contention rules with /standup) and scripts/file-history.js.
# Disable the collision note with CARTOGRAPHER_COLLISION_CHECK=0; enable the
# history note with CARTOGRAPHER_FILE_HISTORY_ON_EDIT=1.
command -v node >/dev/null 2>&1 || exit 0
[ "${CARTOGRAPHER_COLLISION_CHECK:-1}" = "0" ] && [ "${CARTOGRAPHER_FILE_HISTORY_ON_EDIT:-0}" != "1" ] && exit 0
. "$(dirname "$0")/common.sh"
SCRIPT=$(cartographer_script cartographer-collision.js) || exit 0
node "$SCRIPT" 2>/dev/null
exit 0
