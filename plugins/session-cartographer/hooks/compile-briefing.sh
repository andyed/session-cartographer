#!/bin/bash
# compile-briefing.sh — Silent context compilation for Claude Code.
#
# Called by UserPromptSubmit hook. Reads the user's prompt from stdin,
# pattern-matches against project-families.json, and compiles a briefing
# file with git state + TODO + recent milestones for matched projects.
#
# Output: ~/.claude/briefings/<family-label>.md (overwritten each time)
# The briefing is cheap for Claude to read — one file instead of 5-6 tool calls.
#
# Environment: CARTOGRAPHER_DEV_DIR overrides ~/Documents/dev

set -euo pipefail

DEV="${CARTOGRAPHER_DEV_DIR:-$HOME/Documents/dev}"
BRIEFING_DIR="$HOME/.claude/briefings"
HOOKS_DIR="$(cd "$(dirname "$0")" && pwd)"
FAMILIES_FILE="$HOOKS_DIR/project-families.json"
MILESTONES="$DEV/session-milestones.jsonl"

mkdir -p "$BRIEFING_DIR"

# Read hook input from stdin
INPUT=$(cat)
PROMPT=$(echo "$INPUT" | jq -r '.prompt // empty' 2>/dev/null)

# Nothing to match against
[ -z "$PROMPT" ] && exit 0

# Lowercase the prompt for matching
PROMPT_LC=$(echo "$PROMPT" | tr '[:upper:]' '[:lower:]')

# Find matching families
MATCHED_FAMILIES=$(jq -r --arg prompt "$PROMPT_LC" '
  .families | to_entries[] |
  select(.key as $pat | $prompt | test($pat; "i")) |
  .key
' "$FAMILIES_FILE" 2>/dev/null) || true

[ -z "$MATCHED_FAMILIES" ] && exit 0

# For each matched family, compile a briefing
echo "$MATCHED_FAMILIES" | while IFS= read -r pattern; do
  LABEL=$(jq -r --arg p "$pattern" '.families | to_entries[] | select(.key == $p) | .value.label' "$FAMILIES_FILE")
  REPOS_JSON=$(jq -r --arg p "$pattern" '.families | to_entries[] | select(.key == $p) | .value.repos[]' "$FAMILIES_FILE")
  SAFE_LABEL=$(echo "$LABEL" | tr ' ' '-' | tr '[:upper:]' '[:lower:]')
  OUTFILE="$BRIEFING_DIR/${SAFE_LABEL}.md"

  {
    echo "# Context Briefing: $LABEL"
    echo "_Compiled: $(date -u +"%Y-%m-%dT%H:%M:%SZ")_"
    echo ""

    echo "$REPOS_JSON" | while IFS= read -r repo; do
      REPO_PATH="$DEV/$repo"
      [ ! -d "$REPO_PATH" ] && continue

      REPO_NAME=$(basename "$repo")
      echo "## $repo"
      echo ""

      # Git state: branch + dirty summary + recent commits
      if [ -d "$REPO_PATH/.git" ] || git -C "$REPO_PATH" rev-parse --git-dir >/dev/null 2>&1; then
        BRANCH=$(git -C "$REPO_PATH" branch --show-current 2>/dev/null || echo "detached")
        DIRTY=$(git -C "$REPO_PATH" status --porcelain 2>/dev/null | head -20)
        DIRTY_COUNT=$(git -C "$REPO_PATH" status --porcelain 2>/dev/null | wc -l | tr -d ' ')

        echo "**Branch:** \`$BRANCH\`"
        if [ "$DIRTY_COUNT" -gt 0 ]; then
          echo "**Dirty files:** $DIRTY_COUNT"
          if [ "$DIRTY_COUNT" -le 10 ]; then
            echo '```'
            echo "$DIRTY"
            echo '```'
          else
            echo '```'
            echo "$DIRTY" | head -10
            echo "... and $((DIRTY_COUNT - 10)) more"
            echo '```'
          fi
        else
          echo "**Working tree:** clean"
        fi
        echo ""

        echo "**Recent commits:**"
        echo '```'
        git -C "$REPO_PATH" log --oneline -5 2>/dev/null || echo "(no commits)"
        echo '```'
        echo ""
      fi

      # TODO.md — first 25 lines
      if [ -f "$REPO_PATH/TODO.md" ]; then
        echo "**TODO.md (excerpt):**"
        echo '```'
        head -25 "$REPO_PATH/TODO.md"
        echo '```'
        echo ""
      fi

      # briefing-notes.md — custom project context (conventions, gotchas, current state)
      if [ -f "$REPO_PATH/briefing-notes.md" ]; then
        echo "**Briefing Notes:**"
        echo ""
        cat "$REPO_PATH/briefing-notes.md"
        echo ""
      fi

      echo "---"
      echo ""
    done

    # Recent session milestones mentioning any repo in the family
    if [ -f "$MILESTONES" ]; then
      # Build grep pattern from repo names
      GREP_PAT=$(echo "$REPOS_JSON" | while IFS= read -r r; do basename "$r"; done | paste -sd '|' -)
      RECENT=$(tail -50 "$MILESTONES" | LC_ALL=C grep -iE "$GREP_PAT" 2>/dev/null | tail -5)
      if [ -n "$RECENT" ]; then
        echo "## Recent Session Milestones"
        echo '```json'
        echo "$RECENT"
        echo '```'
      fi
    fi

  } > "$OUTFILE"

done

exit 0
