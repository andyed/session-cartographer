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

# A worktree's basename is a throwaway name; resolve to the parent repo.
. "$(dirname "$0")/common.sh"
PROJECT=$(cartographer_project "$CWD")

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

# Keep only the harvested strings that can be real write targets. Reads stdin,
# one candidate per line; emits the survivors, deduped, at most five, one per
# line. Factored out of bash_written_paths() so the variable-bound fallback
# below can be gated on what SURVIVES filtering rather than on the raw harvest.
bash_filter_paths() {
  awk 'NF' | while read -r p; do
    case "$p" in
      /dev/*|/tmp/*|/private/tmp/*|\&*|-*) continue ;;                 # devices, scratch, fd dups, flags
      */node_modules/*|*/.git/*|*.lock|*lock.json) continue ;;
      *://*) continue ;;                                                # a URL in the content is never a target
      # Shell/JSON metacharacters mean this came out of quoted SOURCE TEXT, not a
      # real target. Writing this detector logged `Modified: {",{,src/app.js`
      # because the harvester read the test file it was creating.
      *[\{\}\"\(\)\$\*\;]*|\'*) continue ;;
      *) printf '%s\n' "$p" ;;
    esac
  done | grep -E '(/|\.[A-Za-z0-9]{1,6}$)' \
    | awk '!seen[$0]++' | head -5
}

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
    # strings only when nothing explicit SURVIVES FILTERING. Otherwise a heredoc
    # that writes a file whose CONTENT mentions other paths reports them all —
    # `cat > t.test.js <<EOF … open('src/app.js','w') … EOF` named both.
    #
    # Gated on the filtered set, not the raw harvest. The raw check was empty in
    # the tests but not in practice: a `<project>` placeholder inside the quoted
    # content harvests as a `>` redirect to a bare backtick, and a `2>/dev/null`
    # anywhere in the compound command harvests `/dev/null`. Either made the raw
    # list non-empty, the fallback was skipped, the filter then discarded the
    # junk, and a real `p='/Users/andyed/CLAUDE.md' … open(p,'w')` logged as
    # `Ran:` (session 24b90edb, 2026-09-13, twice) while the same shape without
    # the incidental `>` was caught.
    if [ -z "$(printf '%s\n' "$raw" | bash_filter_paths | head -1)" ]; then
      raw="$raw
$(printf '%s' "$cmd" | grep -oE "[\"'][^\"' ]*(/[^\"' ]+|[^\"' /]+\.[A-Za-z0-9]{1,6})[\"']" \
        | tr -d "\"'")"
    fi
  fi

  printf '%s\n' "$raw" | bash_filter_paths | paste -sd ',' -
}

# The command as the shell runs it: heredoc bodies removed, lines intact. Reads
# stdin. Git and noise detection read this, never the raw text, because a body
# is data — a memory file, release notes, a commit message — and it names
# `git push` or `git commit` without running either. Over 30 days of transcripts
# (83,302 Bash commands, 2026-09-26) a commit or push appeared only inside a
# body 40 times and none of them ran there; read raw, each is a phantom push, or
# turns a real `cat > notes.md <<EOF` edit into `Ran:` via the commit branch.
#
# A delimiter must start with a letter or `_`, so arithmetic `1<<2` is not a
# heredoc, and `<<<` is a here-string. A body with no terminator line is kept:
# a misread `<<` then hides nothing.
bash_strip_heredocs() {
  awk -v Q="'" '
    { L[++n] = $0 }
    END {
      i = 1
      while (i <= n) {
        line = L[i++]; print line
        nq = 0; rest = line
        while (match(rest, /<<-?[ \t]*[^ \t;&|<>()]+/)) {
          before = (RSTART > 1) ? substr(rest, RSTART - 1, 1) : ""
          tok = substr(rest, RSTART, RLENGTH)
          rest = substr(rest, RSTART + RLENGTH)
          if (before == "<") continue
          d = tok; sub(/^<<-?[ \t]*/, "", d); gsub(/["\\]/, "", d); gsub(Q, "", d)
          if (d !~ /^[A-Za-z_][A-Za-z0-9_.-]*$/) continue
          q[++nq] = d; dash[nq] = (substr(tok, 3, 1) == "-")
        }
        # Bodies follow in the order their delimiters appeared on the line.
        for (k = 1; k <= nq; k++) {
          for (j = i; j <= n; j++) {
            t = L[j]; sub(/\r$/, "", t)
            if (dash[k]) sub(/^\t+/, "", t)
            if (t == q[k]) break
          }
          if (j > n) break
          i = j + 1
        }
      }
    }'
}

# True when every command in a command line is noise: `cd repo && ls` is,
# `cd repo && python3 …` is not. Reads the heredoc-stripped command with its
# newlines, so each `&&`, `;` or newline segment is judged on its own.
#
# This used to judge the first command after any leading `cd` hops and ignore
# the rest, so a leading `cat`/`echo`/`ls` took everything after it down. Commit
# c29a684 (session 979b81b0, 2026-09-26) was lost that way: `cat > <scratchpad>
# /commit-msg.txt <<EOF … EOF` then `git add … && git commit -F …`, where the
# scratchpad path is filtered out of the writes that would have overridden the
# verdict. Replayed over the same 30 days, the old rule dropped ~4,400 commands
# of real work this way (node/python/npx runs, curl, 552 git writes) and ~9,900
# inspection runs (`echo "==="; grep …`) that are logged whenever they lack the
# leading echo.
# Judging every segment logs both: a logged command costs a row, a dropped one
# can cost a commit.
bash_is_noise() {
  local seg
  while IFS= read -r seg; do
    seg="${seg#"${seg%%[![:space:]]*}"}"
    seg="${seg%"${seg##*[![:space:]]}"}"
    case "$seg" in
      # `ls*` used to swallow lsof/lsblk/lsattr too — anchored now.
      ''|\#*|ls|ls\ *|cat\ *|echo\ *|pwd|cd|cd\ *|which\ *|wc\ *|head\ *|tail\ *) ;;
      *) return 1 ;;
    esac
  done <<EOF
$(printf '%s\n' "$1" | awk '
    { if (sub(/\\$/, "")) { buf = buf $0 " "; next } print buf $0; buf = "" }
    END { if (buf != "") print buf }' | awk '{ gsub(/&&|;/, "\n"); print }')
EOF
  return 0
}

# ── git subcommand detection ──────────────────────────────────────────────────
# `git -C <repo> commit` is how an agent avoids a leading `cd`, and it contains
# no literal "git commit". The substring match that stood here logged 9e3d014
# (session 49614682, 2026-09-26) as tool_bash, and /wrapup's digest printed no
# commits block. So: `git`, then any run of global options, then the subcommand
# in first position — `git -C r log --grep commit` is not a commit.
#
# A shell word is unquoted characters and quoted strings, concatenated
# (`user.name="A B"` is one word). The options that take a separate argument
# are listed; any other `--long[=value]` is a flag, and `-p`/`-P` are the only
# bare short flags git takes before a subcommand.
GIT_WORD='([^[:space:]"'"'"';&|<>()]|"[^"]*"|'"'"'[^'"'"']*'"'"')+'
GIT_OPTS="([[:space:]]+(-[Cc][[:space:]]+${GIT_WORD}|--(git-dir|work-tree|namespace)[[:space:]]+${GIT_WORD}|--[a-z][a-z-]*(=${GIT_WORD})?|-[pP]))*"

# The first `git [global options] <subcommand>` in a command, or nothing. Only
# the options between `git` and the subcommand come back, so the `-C` of an
# earlier `git -C a add` never lends its path to a later `git -C b commit`.
git_invocation() {
  printf '%s' "$1" | LC_ALL=C grep -oE "(^|[^[:alnum:]_.-])git${GIT_OPTS}[[:space:]]+$2([^[:alnum:]_-]|\$)" | head -1
}

# A path as written in a command, made absolute against a base directory. The
# shell never saw this text, so `~` and `$HOME` are expanded by hand; nothing
# in the command is ever evaluated.
git_path() {
  local p="$1"
  case "$p" in
    '~'|'$HOME'|'${HOME}') p="$HOME" ;;
    '~/'*)       p="$HOME/${p:2}" ;;
    '$HOME/'*)   p="$HOME/${p:6}" ;;
    '${HOME}/'*) p="$HOME/${p:8}" ;;
  esac
  case "$p" in /*) ;; *) p="$2/$p" ;; esac
  printf '%s' "$p"
}

# Toplevel of the repo a git_invocation() ran in; empty when there is none.
# Starts at $2 (see git_base_dir()) and applies each `-C` in order, a relative one
# resolving against the last, as git does. --work-tree and --git-dir resolve
# after every -C, and a --git-dir only names a toplevel when it ends in `.git`.
git_invocation_repo() {
  local dir="$2" want="" tok wt="" gd=""
  while IFS= read -r tok; do
    tok=$(printf '%s' "$tok" | sed -E "s/\"([^\"]*)\"/\1/g; s/'([^']*)'/\1/g")
    case "$want" in
      C)    dir=$(git_path "$tok" "$dir"); want=""; continue ;;
      wt)   wt="$tok"; want=""; continue ;;
      gd)   gd="$tok"; want=""; continue ;;
      skip) want=""; continue ;;
    esac
    case "$tok" in
      -C)            want=C ;;
      -c|--namespace) want=skip ;;
      --work-tree)   want=wt ;;
      --work-tree=*) wt="${tok#--work-tree=}" ;;
      --git-dir)     want=gd ;;
      --git-dir=*)   gd="${tok#--git-dir=}" ;;
    esac
  done <<EOF
$(printf '%s' "$1" | LC_ALL=C grep -oE "$GIT_WORD")
EOF
  if [ -n "$wt" ]; then
    dir=$(git_path "$wt" "$dir")
  elif [ -n "$gd" ]; then
    dir=$(git_path "${gd%/}" "$dir")
    dir="${dir%/.git}"
  fi
  (cd "$dir" 2>/dev/null && git rev-parse --show-toplevel 2>/dev/null)
}

# Where the command's own `cd` hops leave it when it reaches its first `git …
# <$2>`, walking from $3. Prints nothing when no hop precedes the invocation,
# and `?` when one cannot be read from text: `cd "$W"`, `cd -`, `popd`, a glob.
# Nothing is evaluated — a guessed directory files a commit under the wrong
# repo, which is worse than filing it under none.
#
# Reads the heredoc-stripped command with its newlines, which separate commands
# as `;` does. A subshell scopes its hops, so `(cd a && make); git commit` and
# `R=$(cd a && pwd); git commit` both commit where they started. Paths expand
# `~` and `$HOME` as git_path() does.
bash_cd_base() {
  printf '%s\n' "$1" | LC_ALL=C awk \
    -v re="(^|[^[:alnum:]_.-])git${GIT_OPTS}[[:space:]]+$2([^[:alnum:]_-]|\$)" \
    -v start="$3" -v home="$HOME" '
    function resolve(p) {
      if (p == "~" || p == "$HOME" || p == "${HOME}") return home
      if (substr(p, 1, 2) == "~/") return home "/" substr(p, 3)
      if (substr(p, 1, 6) == "$HOME/") return home "/" substr(p, 7)
      if (substr(p, 1, 8) == "${HOME}/") return home "/" substr(p, 9)
      if (p == "-" || p ~ /[$`*?[]/) return "?"
      if (substr(p, 1, 1) == "/") return p
      return (cur == "?") ? "?" : cur "/" p
    }
    # One simple command: words split on unquoted blanks, quotes removed.
    function hop(seg,   n, w, i, c, q, word, inword, verb) {
      n = 0; word = ""; inword = 0; q = ""
      for (i = 1; i <= length(seg); i++) {
        c = substr(seg, i, 1)
        if (q != "") {
          if (c == "\\" && q == "\"") { word = word substr(seg, ++i, 1); continue }
          if (c == q) q = ""; else word = word c
          continue
        }
        if (c == "\\") { word = word substr(seg, ++i, 1); inword = 1; continue }
        if (c == "\"" || c == "\047") { q = c; inword = 1; continue }
        if (c == " " || c == "\t") { if (inword) { w[++n] = word; word = ""; inword = 0 }; continue }
        word = word c; inword = 1
      }
      if (inword) w[++n] = word
      i = 1
      while (i <= n && w[i] ~ /^(if|then|else|elif|do|while|until|!|\{)$/) i++
      if (i > n) return
      verb = w[i]
      if (verb == "popd") { cur = "?"; seen = 1; return }
      if (verb != "cd" && verb != "pushd") return
      seen = 1
      for (i++; i <= n && w[i] ~ /^-[LPe@]$/; i++) ;
      if (i <= n && w[i] == "--") i++
      # A bare pushd swaps with the stack, which text does not show.
      if (i > n) { cur = (verb == "pushd") ? "?" : home; return }
      # zsh reads `cd old new` as a substitution in the current path.
      cur = (i < n) ? "?" : resolve(w[i])
    }
    { if (sub(/\\$/, "")) { s = s $0 " " } else { s = s $0 "\n" } }
    END {
      if (!match(s, re)) exit
      pre = substr(s, 1, RSTART - 1)
      cur = start; seen = 0; d = 0; seg = ""; q = ""
      for (i = 1; i <= length(pre); i++) {
        c = substr(pre, i, 1)
        if (q != "") {
          seg = seg c
          if (c == "\\" && q == "\"") seg = seg substr(pre, ++i, 1)
          else if (c == q) q = ""
          continue
        }
        if (c == "\\") { seg = seg c substr(pre, ++i, 1); continue }
        if (c == "\"" || c == "\047") { q = c; seg = seg c; continue }
        if (c == "(") { hop(seg); seg = ""; stack[++d] = cur; continue }
        if (c == ")") { hop(seg); seg = ""; if (d > 0) cur = stack[d--]; continue }
        if (c == ";" || c == "&" || c == "|" || c == "\n") { hop(seg); seg = ""; continue }
        seg = seg c
      }
      # The separator before `git` belongs to the match, so the last hop is
      # still in the buffer.
      hop(seg)
      if (seen) print cur
    }'
}

# The directory a `git … <$1>` in the command started from, before its own -C:
# the last literal `cd` hop ahead of it (bash_cd_base), else the hook's cwd.
#
# Claude Code reports the cwd its shell keeps AFTER the command, so a hop into
# the project is already there; one that leaves the project is reset, and the
# payload names where the session started. Codex reports the session's cwd
# whatever the command did. A hop's directory that does not exist falls back to
# the cwd, since `cd sub` read against a cwd that is already `sub` names
# `sub/sub`. An unreadable hop falls back to it too: Claude's cwd is then
# right when the harness kept the hop, and the caller must not trust a repo
# that cannot confirm the commit.
git_base_dir() {
  local base
  base=$(bash_cd_base "$COMMAND_SHELL" "$1" "$CWD")
  case "$base" in
    ''|'?') printf '%s' "$CWD" ;;
    *) if [ -d "$base" ]; then printf '%s' "$base"; else printf '%s' "$CWD"; fi ;;
  esac
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
    [ -n "$FILE_REPO" ] && PROJECT=$(cartographer_project "$FILE_REPO")

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
    # Git and noise detection read the full command minus heredoc bodies — see
    # bash_strip_heredocs(). They read the truncated copy until 2026-09-26, so a
    # commit past char 500 was invisible: a `cat >> TODO.md <<EOF … EOF` or a
    # long `printf` ahead of it is enough. Replayed over 30 days, 584 commands put
    # a real `git commit` past that cut.
    COMMAND_SHELL=$(echo "$INPUT" | jq -r '.tool_input.command // empty' | bash_strip_heredocs | head -c 20000)
    COMMAND_SHELL_FLAT=$(printf '%s' "$COMMAND_SHELL" | tr '\n\t\r' '   ' | tr -s ' ')
    COMMIT_CALL=$(git_invocation "$COMMAND_SHELL_FLAT" commit)
    PUSH_CALL=$(git_invocation "$COMMAND_SHELL_FLAT" push)

    # A write outranks the noise filter — see bash_written_paths(). So does a
    # commit or push, which a pipe can hide from the per-segment verdict
    # (`cat msg.txt | git commit -F -` is one segment, and it starts with cat).
    BASH_WRITES=$(bash_written_paths "$COMMAND_FULL")
    if [ -z "$BASH_WRITES" ] && [ -z "$COMMIT_CALL" ] && [ -z "$PUSH_CALL" ] \
       && bash_is_noise "$COMMAND_SHELL"; then
      exit 0
    fi

    # Detect git commit — extract commit hash, message, and changed files
    if [ -n "$COMMIT_CALL" ]; then
      # The repo the commit ran in, which a `cd` hop or `-C` makes different
      # from the hook's cwd: every repo read below (freshness, diff-tree,
      # remote) must hit it, or a commit made from ~/Documents/dev reads no
      # HEAD, or the wrong one.
      GIT_REPO=$(git_invocation_repo "$COMMIT_CALL" "$(git_base_dir commit)")
      # Parse the commit output from tool_response. Use .stdout when it's an
      # object: jq -r of the whole object prints raw JSON whose \n escape
      # sequences then leak into COMMIT_MSG as literal backslash-n text.
      RESPONSE=$(echo "$INPUT" | jq -r '(.tool_response // empty) | if type == "object" then (.stdout // "") else . end' | head -c 2000)
      # Only git's own summary line names a commit: `[main 1a2b3c4] subject`,
      # with ` (root-commit)` on a first commit and `detached HEAD` in place of
      # a branch. The first 7+ hex run anywhere in stdout stood here, and
      # six phantom commits came of it by 2026-09-26: `feedbac` out of
      # "feedback", a session-id prefix, a worktree name, a sha256, and two
      # shas out of the JSON rows a hook replay printed.
      COMMIT_LINE=$(printf '%s\n' "$RESPONSE" \
        | LC_ALL=C grep -oE '\[(detached HEAD|[^][[:space:]]+)( \(root-commit\))? [0-9a-f]{7,40}\] .*' | head -1)
      COMMIT_HASH=$(printf '%s' "$COMMIT_LINE" | sed -E 's/^\[[^]]* ([0-9a-f]{7,40})\] .*$/\1/')
      COMMIT_MSG=$(printf '%s' "$COMMIT_LINE" | sed -E 's/^\[[^]]*\] //')

      # A repo that does not hold the sha git printed is not where the commit
      # ran, and a fresh HEAD there belongs to some other commit, so neither
      # the HEAD nor files, diff shape or URL are read from it. Codex sends no
      # per-command workdir to the hook, and its session cwd stands in: five
      # session-cartographer commits from a session rooted in histospire
      # carried URLs into histospire's remote. The project stays cwd-derived,
      # which is all that is known.
      if [ -n "$GIT_REPO" ] && [ -n "$COMMIT_HASH" ] \
         && ! git -C "$GIT_REPO" cat-file -e "${COMMIT_HASH}^{commit}" 2>/dev/null; then
        GIT_REPO=""
      fi
      [ -n "$GIT_REPO" ] && PROJECT=$(cartographer_project "$GIT_REPO")

      # Ask the repo, not the output. This hook is PostToolUse, so HEAD already
      # carries the commit, and `-q` / `--quiet` / `>/dev/null` — which suppress
      # the `[branch abc1234] subject` line the scrape above depends on — take
      # nothing away from git. Before this, a quiet commit lost its subject to
      # the `other` classifier and, with no hash anywhere in stdout, produced no
      # git_commit row at all.
      #
      # Freshness is the guard. `git commit` also appears in a command that
      # FAILED (nothing staged, a rejecting hook) or never intended to commit
      # (--dry-run), and reading HEAD blindly would file the previous commit as
      # freshly made. A commit this hook was triggered by is seconds old; one
      # left over from earlier is not.
      if [ -n "$GIT_REPO" ]; then
        REPO_HASH=$(git -C "$GIT_REPO" rev-parse --verify -q HEAD 2>/dev/null)
        if [ -n "$REPO_HASH" ]; then
          REPO_COMMIT_TS=$(git -C "$GIT_REPO" log -1 --format=%ct "$REPO_HASH" 2>/dev/null)
          REPO_AGE=$(( $(date +%s) - ${REPO_COMMIT_TS:-0} ))
          # Already recorded means this invocation did not create it — the
          # freshness window alone cannot tell a real commit from a `git commit`
          # that failed seconds after one, and both leave HEAD looking new.
          # An amend gets a different sha and is correctly logged again.
          REPO_SEEN=""
          [ -f "$CHANGELOG" ] && REPO_SEEN=$(tail -n 2000 "$CHANGELOG" 2>/dev/null | grep -c "Commit ${REPO_HASH}" 2>/dev/null)
          if [ -n "$REPO_COMMIT_TS" ] && [ "$REPO_AGE" -ge 0 ] && [ "$REPO_AGE" -le 120 ] \
             && [ "${REPO_SEEN:-0}" -eq 0 ]; then
            COMMIT_HASH="$REPO_HASH"
            COMMIT_MSG=$(git -C "$GIT_REPO" log -1 --format=%s "$REPO_HASH" 2>/dev/null)
          elif [ -z "$RESPONSE" ] || [ "${REPO_SEEN:-0}" -ne 0 ]; then
            # HEAD is stale, or already logged: no commit was made here.
            COMMIT_HASH=""
            COMMIT_MSG=""
          fi
        fi
      fi

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
    elif [ -n "$PUSH_CALL" ]; then
      PUSH_REPO=$(git_invocation_repo "$PUSH_CALL" "$(git_base_dir push)")
      [ -n "$PUSH_REPO" ] && PROJECT=$(cartographer_project "$PUSH_REPO")
      SUMMARY="Pushed: $COMMAND"
      TYPE="git_push"
      SALIENCE="0.6"
    elif [ -n "$BASH_WRITES" ]; then
      # Same type/salience as an Edit/Write call — the tool used to change the
      # file is an implementation detail, and downstream (session-digest's `files`
      # panel, the profile's work-shape) only asks what changed.
      PRIMARY_FILE=${BASH_WRITES%%,*}
      FILE_REPO=$(cd "$(dirname "$PRIMARY_FILE")" 2>/dev/null && git rev-parse --show-toplevel 2>/dev/null)
      [ -n "$FILE_REPO" ] && PROJECT=$(cartographer_project "$FILE_REPO")
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
CHANGELOG_EVENT=$(jq -n -c \
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
     + if $parent_id != "" then {parent_event_id: $parent_id} else {} end')
if [ -n "$CHANGELOG_EVENT" ]; then printf '%s\n' "$CHANGELOG_EVENT" >> "$CHANGELOG"; fi

# Real-time indexing (silent fail if services aren't running)
INDEXER=$(cartographer_script index-event.sh)
if [ -x "$INDEXER" ]; then
  [ -n "$CHANGELOG_EVENT" ] && printf '%s\n' "$CHANGELOG_EVENT" | "$INDEXER" &
fi

exit 0
