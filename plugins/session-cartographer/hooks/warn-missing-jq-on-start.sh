#!/bin/bash
# SessionStart hook: say so, once, when jq is missing.
#
# Every capture hook in this directory reads its payload with jq and exits 0
# without it, by design: a missing dependency must never block a tool call.
# The cost of that design is that an install without jq looks healthy. The
# plugin reports installed, /remember runs, and the corpus stays empty with
# nothing to say why (observed 2026-10-10 on a fresh Windows box). This hook
# is the one place that speaks up. It runs on startup, resume and clear, not
# on compact, so a session hears it once.
#
# With jq present it prints nothing and exits before reading stdin, like the
# other start hooks. Without it, the line goes out as systemMessage so the
# user sees it, and as additionalContext so the agent can repeat the install
# command when asked why recall finds nothing. The JSON is written with
# printf, for the obvious reason; the text holds no quote or backslash.

command -v jq >/dev/null 2>&1 && exit 0

MSG='session-cartographer: jq not found. Hooks will not capture anything until it is installed: winget install jqlang.jq (Windows), brew install jq (macOS), apt install jq (Debian/Ubuntu).'

printf '{"systemMessage":"%s","hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"%s"}}\n' "$MSG" "$MSG"
exit 0
