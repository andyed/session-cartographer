#!/bin/bash
# PostToolUse hook: logs file modifications and bash commands.
# Captures the code generation events that research/milestones hooks miss.
#
# Logs:
#   Edit/Write → file path modified
#   Bash       → command run (truncated to 200 chars), OR a file edit when the
#                command writes files (`sed -i`, `>`/`>>`, `tee`, python open-w) —
#                auto mode edits through Bash, so those are real work, not noise.
#
# Gated by CARTOGRAPHER_LOG_TOOL_USE=true (opt-in to avoid noise).
# Output: tool-use-log.jsonl + changelog.jsonl
# Environment: CARTOGRAPHER_DEV_DIR overrides ~/Documents/dev

# Opt-in gate — set CARTOGRAPHER_LOG_TOOL_USE=true to enable
[ "${CARTOGRAPHER_LOG_TOOL_USE:-false}" = "true" ] || exit 0

DEV="${CARTOGRAPHER_DEV_DIR:-$HOME/Documents/dev}"
LOG_FILE="$DEV/tool-use-log.jsonl"
CHANGELOG="$DEV/changelog.jsonl"
INPUT=$(cat)
EVENT_ID="evt-$(LC_ALL=C tr -dc 'a-z0-9' < /dev/urandom | head -c 12)"

TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty')
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty')
TRANSCRIPT=$(echo "$INPUT" | jq -r '.transcript_path // empty')
CWD=$(echo "$INPUT" | jq -r '.cwd // empty')
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

GIT_REPO=$(cd "$CWD" 2>/dev/null && git rev-parse --show-toplevel 2>/dev/null)
if [ -n "$GIT_REPO" ]; then
    PROJECT=$(basename "$GIT_REPO")
else
    PROJECT=$(basename "$CWD")
fi

# Cross-event linkage: thread events into work-arcs.
. "$(dirname "$0")/common.sh"
PROVIDER=$(detect_provider "$INPUT")
PARENT_ID=$(find_parent_event_id "$CHANGELOG" "$SESSION_ID" "$TIMESTAMP")

SALIENCE="0.5"  # default; per-branch overrides below

# ── Bash-as-editor detection ──────────────────────────────────────────────────
# Under auto mode the harness prefers Bash over Edit/Write, so most real edits
# arrive as `cd <repo> && python3 - <<PY …` or `sed -i` or `cat > f <<EOF`.
# Before 2026-08-28 none of that was recorded: the noise filter matched the FIRST
# TOKEN of a compound command, so every `cd …` hop was dropped outright, and what
# survived logged as generic `tool_bash` (salience 0.2). Measured on session
# 7c9b94b3 — ~1,050 lines changed across 11 files, of which the log captured 4
# file edits, all of them Write-tool calls. session-digest's `files` panel was
# reporting a fraction of the work and reading as if that were the whole session.

# Paths a command WRITES to; empty when it only reads. Order matters at the call
# site: a write must outrank the noise filter, because `cat > src/f.js <<EOF` is
# both a real edit and a `cat `.
bash_written_paths() {
  local cmd="$1" raw=""
  # `> path` / `>> path` — plain redirects and heredoc writes. Refusing a leading
  # `&` keeps fd dups (`2>&1`) out.
  raw="$raw
$(printf '%s' "$cmd" | grep -oE '>>?[[:space:]]*[^ &|;<>()]+' | sed -E 's/^>>?[[:space:]]*//')"
  # `sed -i … target` — the target is the last token of the sed clause.
  raw="$raw
$(printf '%s' "$cmd" | grep -oE 'sed -i[^|;&]*' | awk '{print $NF}')"
  # `tee [-a] path`
  raw="$raw
$(printf '%s' "$cmd" | grep -oE 'tee[[:space:]]+(-a[[:space:]]+)?[^ &|;]+' | awk '{print $NF}')"
  # python write-mode open(). Two shapes, because the idiomatic one binds the
  # path to a variable first (`p='f.js'` … `open(p,'w')`) and a literal-only
  # regex misses exactly the form that is most common in practice:
  #   A) open('path', 'w')            → the literal
  #   B) open(var, 'w') + var='path'  → harvest path-like quoted strings
  if printf '%s' "$cmd" | grep -qE "open\([^)]*,[[:space:]]*[\"'][wa]"; then
    raw="$raw
$(printf '%s' "$cmd" | grep -oE "open\([\"'][^\"']+[\"'][[:space:]]*,[[:space:]]*[\"'][wa]" \
      | sed -E "s/^open\([\"']//; s/[\"'].*$//")"
    # Shape B (variable-bound path) is a LAST RESORT: harvest quoted path-like
    # strings only when nothing explicit was found. Otherwise a heredoc that
    # writes a file whose CONTENT mentions other paths reports them all —
    # `cat > t.test.js <<EOF … open('src/app.js','w') … EOF` named both.
    if [ -z "$(printf '%s\n' "$raw" | awk 'NF' | head -1)" ]; then
      raw="$raw
$(printf '%s' "$cmd" | grep -oE "[\"'][^\"' ]*(/[^\"' ]+|[^\"' /]+\.[A-Za-z0-9]{1,6})[\"']" \
        | tr -d "\"'")"
    fi
  fi

  printf '%s\n' "$raw" | awk 'NF' | while read -r p; do
    case "$p" in
      /dev/*|/tmp/*|/private/tmp/*|\&*|-*) continue ;;                 # devices, scratch, fd dups, flags
      */node_modules/*|*/.git/*|*.lock|*lock.json) continue ;;
      # Shell/JSON metacharacters mean this came out of quoted SOURCE TEXT, not a
      # real target. Writing this detector logged `Modified: {",{,src/app.js`
      # because the harvester read the test file it was creating.
      *[\{\}\"\(\)\$\*\;]*|\'*) continue ;;
      *) printf '%s\n' "$p" ;;
    esac
  done | grep -E '(/|\.[A-Za-z0-9]{1,6}$)' \
    | awk '!seen[$0]++' | head -5 | paste -sd ',' -
}

# True when a command is only noise. Strips leading `cd … &&` hops first so the
# verdict is about what actually RUNS — `cd repo && ls` is noise, but
# `cd repo && python3 …` is the session's actual work.
bash_is_noise() {
  local probe="$1" next=""
  while :; do
    case "$probe" in
      cd\ *"&&"*)
        next=$(printf '%s' "$probe" | sed 's/^cd [^&]*&&[[:space:]]*//')
        [ "$next" = "$probe" ] && break
        probe="$next" ;;
      *) break ;;
    esac
  done
  case "$probe" in
    # `ls*` used to swallow lsof/lsblk/lsattr too — anchored now.
    ls|ls\ *|cat\ *|echo\ *|pwd|cd\ *|which\ *|wc\ *|head\ *|tail\ *) return 0 ;;
  esac
  return 1
}

case "$TOOL_NAME" in
  Edit|Write|apply_patch)
    if [ "$TOOL_NAME" = "apply_patch" ]; then
      FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.patch // .tool_input.input // empty' | sed -nE 's/^\*\*\* (Add|Update|Delete) File: (.*)$/\2/p' | head -20 | paste -sd ',' -)
    else
      FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')
    fi
    [ -z "$FILE_PATH" ] && exit 0
    PRIMARY_FILE=${FILE_PATH%%,*}
    # Refine project via file path's git repo
    FILE_REPO=$(cd "$(dirname "$PRIMARY_FILE")" 2>/dev/null && git rev-parse --show-toplevel 2>/dev/null)
    [ -n "$FILE_REPO" ] && PROJECT=$(basename "$FILE_REPO")

    # Skip noisy paths (node_modules, .git, lock files)
    case "$PRIMARY_FILE" in
      */node_modules/*|*/.git/*|*/package-lock.json|*/yarn.lock|*/pnpm-lock.yaml) exit 0 ;;
    esac
    FILENAME=$(basename "$PRIMARY_FILE")
    SUMMARY="Modified: $FILE_PATH"
    TYPE="tool_file_edit"
    SALIENCE="0.4"
    ;;
  Bash)
    # Flatten newlines/tabs: multi-line commands (heredocs, python -c) must
    # become one-line summaries — downstream TSV/embedding paths are line-based.
    COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty' | head -c 500 | tr '\n\t\r' '   ' | tr -s ' ')
    [ -z "$COMMAND" ] && exit 0
    # Detection reads the FULL command; only the SUMMARY is truncated. A long
    # heredoc puts its `open(p,'w')` well past 500 chars, so detecting against the
    # truncated copy missed precisely the largest edits — a real CHANGELOG.md
    # rewrite logged as `tool_bash` while a short one was caught. Capped well
    # above any real command so a pathological paste can't stall the hook.
    COMMAND_FULL=$(echo "$INPUT" | jq -r '.tool_input.command // empty' | head -c 20000 | tr '\n\t\r' '   ' | tr -s ' ')
    # A write outranks the noise filter — see bash_written_paths().
    BASH_WRITES=$(bash_written_paths "$COMMAND_FULL")
    if [ -z "$BASH_WRITES" ] && bash_is_noise "$COMMAND"; then
      exit 0
    fi

    # Detect git commit — extract commit hash, message, and changed files
    if echo "$COMMAND" | grep -q "git commit"; then
      # Parse the commit output from tool_response. Use .stdout when it's an
      # object: jq -r of the whole object prints raw JSON whose \n escape
      # sequences then leak into COMMIT_MSG as literal backslash-n text.
      RESPONSE=$(echo "$INPUT" | jq -r '(.tool_response // empty) | if type == "object" then (.stdout // "") else . end' | head -c 2000)
      COMMIT_HASH=$(echo "$RESPONSE" | grep -oE '[a-f0-9]{7,}' | head -1)
      COMMIT_MSG=$(echo "$RESPONSE" | grep -oE '\] .+' | head -1 | sed 's/^\] //')

      # Get changed files from the commit if we can
      CHANGED_FILES=""
      if [ -n "$COMMIT_HASH" ] && [ -n "$GIT_REPO" ]; then
        CHANGED_FILES=$(cd "$GIT_REPO" && git diff-tree --no-commit-id --name-only -r "$COMMIT_HASH" 2>/dev/null | head -20 | tr '\n' ', ' | sed 's/,$//')
      fi

      # Extract diff shape metadata (Tier 3)
      DIFF_SHAPE=""
      if [ -n "$COMMIT_HASH" ] && [ -n "$GIT_REPO" ]; then
        DIFF_SHAPE_SCRIPT=$(cartographer_script diff-shape.sh)
        [ -n "$DIFF_SHAPE_SCRIPT" ] && DIFF_SHAPE=$(bash "$DIFF_SHAPE_SCRIPT" "$COMMIT_HASH" "$GIT_REPO" 2>/dev/null || echo "")
      fi

      if [ -n "$COMMIT_HASH" ]; then
        # Classify commit from conventional-commit prefix or keywords
        COMMIT_TYPE="other"
        case "$COMMIT_MSG" in
          feat:*|feat\(*) COMMIT_TYPE="feature" ;;
          fix:*|fix\(*|bugfix:*) COMMIT_TYPE="fix" ;;
          refactor:*|refactor\(*) COMMIT_TYPE="refactor" ;;
          docs:*|docs\(*) COMMIT_TYPE="docs" ;;
          test:*|test\(*|tests:*) COMMIT_TYPE="test" ;;
          chore:*|chore\(*) COMMIT_TYPE="chore" ;;
          ci:*|ci\(*) COMMIT_TYPE="ci" ;;
          style:*|style\(*) COMMIT_TYPE="style" ;;
          perf:*|perf\(*) COMMIT_TYPE="perf" ;;
          build:*|build\(*) COMMIT_TYPE="build" ;;
          revert:*|revert\(*) COMMIT_TYPE="revert" ;;
          *[Aa]dd*|*[Ii]mplement*|*[Cc]reate*) COMMIT_TYPE="feature" ;;
          *[Ff]ix*|*[Rr]esolve*|*[Pp]atch*) COMMIT_TYPE="fix" ;;
          *[Rr]efactor*|*[Cc]lean*|*[Ss]implif*) COMMIT_TYPE="refactor" ;;
          *[Uu]pdate*|*[Ee]nhance*|*[Ii]mprov*) COMMIT_TYPE="enhancement" ;;
        esac

        SUMMARY="[${COMMIT_TYPE}] Commit ${COMMIT_HASH}: ${COMMIT_MSG}"
        [ -n "$CHANGED_FILES" ] && SUMMARY="${SUMMARY} | files: ${CHANGED_FILES}"
        TYPE="git_commit"

        # Salience by commit type — feature/fix carry more strategic weight
        # than chore/style. +0.1 for wide-ranging or release commits. Cap 1.0.
        case "$COMMIT_TYPE" in
          feature|fix)         SALIENCE_RAW="0.7" ;;
          refactor|revert|perf) SALIENCE_RAW="0.6" ;;
          enhancement|other)   SALIENCE_RAW="0.5" ;;
          docs|test|chore|ci|build) SALIENCE_RAW="0.4" ;;
          style)               SALIENCE_RAW="0.3" ;;
          *)                   SALIENCE_RAW="0.5" ;;
        esac
        # Bonus: wide blast radius
        FILE_COUNT=0
        if [ -n "$CHANGED_FILES" ]; then
          FILE_COUNT=$(echo "$CHANGED_FILES" | tr ',' '\n' | wc -l | tr -d ' ')
        fi
        if [ "$FILE_COUNT" -gt 5 ]; then
          SALIENCE_RAW=$(awk -v s="$SALIENCE_RAW" 'BEGIN { v = s + 0.1; if (v > 1.0) v = 1.0; printf "%.2f", v }')
        fi
        # Bonus: release commits ("Release vX.Y.Z" or contains version tag pattern)
        case "$COMMIT_MSG" in
          [Rr]elease\ *|*v[0-9]*.[0-9]*)
            SALIENCE_RAW=$(awk -v s="$SALIENCE_RAW" 'BEGIN { v = s + 0.1; if (v > 1.0) v = 1.0; printf "%.2f", v }')
            ;;
        esac
        SALIENCE="$SALIENCE_RAW"

        # Build GitHub commit URL from remote
        COMMIT_URL=""
        if [ -n "$GIT_REPO" ]; then
          GITHUB_BASE=$(cd "$GIT_REPO" && git remote get-url origin 2>/dev/null | sed 's/\.git$//' | sed 's|git@github.com:|https://github.com/|')
          [ -n "$GITHUB_BASE" ] && COMMIT_URL="${GITHUB_BASE}/commit/${COMMIT_HASH}"
        fi
      else
        SUMMARY="Ran: $COMMAND"
        TYPE="tool_bash"
        SALIENCE="0.2"
      fi
    # Detect git push
    elif echo "$COMMAND" | grep -q "git push"; then
      SUMMARY="Pushed: $COMMAND"
      TYPE="git_push"
      SALIENCE="0.6"
    elif [ -n "$BASH_WRITES" ]; then
      # Same type/salience as an Edit/Write call — the tool used to change the
      # file is an implementation detail, and downstream (session-digest's `files`
      # panel, the profile's work-shape) only asks what changed.
      PRIMARY_FILE=${BASH_WRITES%%,*}
      FILE_REPO=$(cd "$(dirname "$PRIMARY_FILE")" 2>/dev/null && git rev-parse --show-toplevel 2>/dev/null)
      [ -n "$FILE_REPO" ] && PROJECT=$(basename "$FILE_REPO")
      SUMMARY="Modified: $BASH_WRITES (via bash)"
      TYPE="tool_file_edit"
      SALIENCE="0.4"
    else
      SUMMARY="Ran: $(echo "$COMMAND" | head -c 200)"
      TYPE="tool_bash"
      SALIENCE="0.2"
    fi
    ;;
  *)
    exit 0
    ;;
esac

# Write to tool-use log
jq -n -c \
    --arg eid "$EVENT_ID" \
    --arg ts "$TIMESTAMP" \
    --arg type "$TYPE" \
    --arg tool "$TOOL_NAME" \
    --arg summary "$SUMMARY" \
    --arg project "$PROJECT" \
    --arg cwd "$CWD" \
    --arg session "$SESSION_ID" \
    --arg provider "$PROVIDER" \
    --arg transcript "$TRANSCRIPT" \
    --arg commit_type "${COMMIT_TYPE:-}" \
    --arg commit_url "${COMMIT_URL:-}" \
    --argjson diff_shape "${DIFF_SHAPE:-null}" \
    --arg parent_id "$PARENT_ID" \
    --argjson salience "${SALIENCE:-0.5}" \
    '{event_id: $eid, timestamp: $ts, type: $type, provider: $provider, tool: $tool, summary: $summary, project: $project, cwd: $cwd, session: $session, transcript_path: $transcript, diff_shape: $diff_shape, salience: $salience}
     + if $commit_type != "" then {commit_type: $commit_type} else {} end
     + if $commit_url != "" then {commit_url: $commit_url} else {} end
     + if $parent_id != "" then {parent_event_id: $parent_id} else {} end' \
    >> "$LOG_FILE"

# Write to unified changelog
jq -n -c \
    --arg eid "$EVENT_ID" \
    --arg ts "$TIMESTAMP" \
    --arg type "$TYPE" \
    --arg session "$SESSION_ID" \
    --arg provider "$PROVIDER" \
    --arg project "$PROJECT" \
    --arg cwd "$CWD" \
    --arg summary "$SUMMARY" \
    --arg transcript "$TRANSCRIPT" \
    --arg commit_type "${COMMIT_TYPE:-}" \
    --argjson diff_shape "${DIFF_SHAPE:-null}" \
    --arg parent_id "$PARENT_ID" \
    --argjson salience "${SALIENCE:-0.5}" \
    '{event_id: $eid, timestamp: $ts, type: $type, provider: $provider, session_id: $session, project: $project, cwd: $cwd, summary: $summary, transcript_path: $transcript, diff_shape: $diff_shape, related_ids: [], salience: $salience}
     + if $commit_type != "" then {commit_type: $commit_type} else {} end
     + if $parent_id != "" then {parent_event_id: $parent_id} else {} end' \
    >> "$CHANGELOG"

# Real-time indexing (silent fail if services aren't running)
INDEXER=$(cartographer_script index-event.sh)
if [ -x "$INDEXER" ]; then
  tail -1 "$CHANGELOG" | "$INDEXER" &
fi

exit 0
