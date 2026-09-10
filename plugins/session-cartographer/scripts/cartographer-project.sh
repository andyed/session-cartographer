#!/usr/bin/env bash
# cartographer-project.sh — print the REAL project name for a directory.
#
# The command-line face of `cartographer_project()` in hooks/common.sh, which is
# and stays the single definition. Hooks source that function directly (they run
# on every tool call and cannot afford a fork); skills are markdown and cannot
# source a shell library portably, so they shell out to this instead. Two
# consumers, one implementation — the alternative is a second copy of the
# --git-common-dir logic in three SKILL.md files, and this repo has already paid
# for what happens when a derivation lives in more than one place.
#
# Usage: cartographer-project.sh [dir]     (default: $PWD)
# Exits non-zero with empty stdout if common.sh cannot be found, so a caller can
# tell "no answer" from an answer. Never guesses.

set -u

dir="${1:-$PWD}"
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)

# scripts/ exists under both layouts: the repo root (hooks live under
# plugins/session-cartographer/) and the assembled plugin root (hooks are a
# sibling). copy-plugin-runtime.sh is what creates the second one.
for candidate in \
  "$here/../hooks/common.sh" \
  "$here/../plugins/session-cartographer/hooks/common.sh"
do
  if [ -f "$candidate" ]; then
    # shellcheck source=/dev/null
    . "$candidate"
    cartographer_project "$dir"
    exit 0
  fi
done

echo "cartographer-project: common.sh not found relative to $here" >&2
exit 1
