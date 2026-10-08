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
case "$0" in */*) HOOK_DIR="${0%/*}" ;; *) HOOK_DIR=. ;; esac
. "$HOOK_DIR/common.sh"

# Every field the hook reads, in ONE jq call. A jq start costs ~13 ms on a
# laptop and this hook paid for 17–19 of them per call (64 processes and
# ~230 ms for a plain `npm test`, measured 2026-10-07); the work inside was
# never the cost. @sh quotes each value for eval, so a command holding quotes,
# newlines or `$(…)` comes back byte for byte. The last changelog row rides in
# as --arg so the parent lookup (find_parent_event_id in common.sh) needs no
# second parse; a row that is not an object yields no parent, as before.
#
# duration_ms is kept only when numeric. PostToolUseFailure carries a failed
# call: no tool_response, and a command that failed after committing still
# committed. apply_patch names its files inside the patch text: one line per
# `*** Add|Update|Delete File:`, the first twenty, comma-joined.
LAST_ROW=""
[ -f "$CHANGELOG" ] && LAST_ROW=$(tail -1 "$CHANGELOG" 2>/dev/null)
FIELDS=$(printf '%s' "$INPUT" | jq -r --arg last "$LAST_ROW" '
  def s: (. // "") | tostring;
  ((try ($last | fromjson) catch null) | if type == "object" then . else {} end) as $p
  | (now | floor) as $t
  | [ (.tool_name | s), (.session_id | s), (.transcript_path | s), (.cwd | s),
      (.hook_event_name | s), (.tool_use_id | s),
      ((.duration_ms | s) | if test("^[0-9]+(\\.[0-9]+)?$") then . else "" end),
      (.turn_id | s), (.model | s),
      (.tool_input.command | s),
      (.tool_input.file_path | s),
      ([ ((.tool_input.patch // .tool_input.input) | s) | split("\n")[]
         | capture("^\\*\\*\\* (Add|Update|Delete) File: (?<f>.*)$").f ] | .[:20] | join(",")),
      ((.tool_response // "") | if type == "object" then (.stdout // "") else . end | tostring),
      (($p.session_id // $p.session) | s), ($p.timestamp | s), ($p.event_id | s),
      ($t | todate), $t ]
  | @sh' 2>/dev/null)
eval "set -- $FIELDS"
TOOL_NAME=$1 SESSION_ID=$2 TRANSCRIPT=$3 CWD=$4 HOOK_EVENT=$5 TOOL_USE_ID=$6 DURATION_MS=$7
TURN_ID=$8 MODEL=$9 COMMAND_IN=${10} FILE_PATH_IN=${11} PATCH_FILES=${12} RESPONSE_IN=${13}
LAST_SESSION=${14} LAST_TS=${15} LAST_ID=${16}
# The row's timestamp and the epoch second the call_commits() window and HEAD
# freshness check measure from: jq's clock, in UTC to the second, the same
# text `date -u +%Y-%m-%dT%H:%M:%SZ` printed.
TIMESTAMP=${17} NOW_EPOCH=${18}
set --
# Minted when a row is written: a call that logs nothing pays for no id.
EVENT_ID=""

# Cross-event linkage: thread events into work-arcs.
PROVIDER=$(detect_provider_from "$TRANSCRIPT" "$TURN_ID" "$MODEL")
PARENT_ID=$(cartographer_parent_pick "$SESSION_ID" "$TIMESTAMP" "$LAST_SESSION" "$LAST_TS" "$LAST_ID")
# PROJECT is resolved where a branch knows which directory to ask — the cwd,
# the edited file's repo, the committed repo — so a call that exits early
# never asks git. A worktree's basename is a throwaway name; cartographer_repo
# in common.sh resolves to the parent repo.
PROJECT=""

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

# Everything the Bash branch reads from the command's text comes out of ONE
# awk pass, AWK_COMMAND_FACTS below. The functions it absorbed each ran as a
# pipeline of processes per call — bash_strip_heredocs (awk, head),
# git_invocation ×3 (awk each), bash_is_noise (awk ×2), bash_written_paths
# and bash_filter_paths (grep ×5, sed, awk ×3, head, paste) — 12 awk, 7 head,
# 5 tr, 5 grep per plain command, each start 5–13 ms. The rules are theirs,
# applied in their order, and the notes that justified each rule stay with it.
#
# bash_filter_paths — keep only the harvested strings that can be real write
# targets: not devices, scratch, fd dups (`2>&1` harvests `&1`), flags,
# node_modules, .git, lock files, or a URL (never a target). Shell/JSON
# metacharacters mean this came out of quoted SOURCE TEXT, not a real target.
# Writing this detector logged `Modified: {",{,src/app.js` because the
# harvester read the test file it was creating. A survivor must contain a `/`
# or end in a 1–6 character extension; deduped, at most five.
#
# bash_written_paths — paths a command WRITES to; empty when it only reads.
# Order matters at the call site: a write must outrank the noise filter,
# because `cat > src/f.js <<EOF` is both a real edit and a `cat `.
#   `> path` / `>> path`   plain redirects and heredoc writes; refusing a
#                          leading `&` keeps fd dups out.
#   `sed -i … target`      the target is the last token of the sed clause.
#   `tee [-a] path`
#   python write-mode open(). Two shapes, because the idiomatic one binds the
#   path to a variable first (`p='f.js'` … `open(p,'w')`) and a literal-only
#   regex misses exactly the form that is most common in practice:
#     A) open('path', 'w')            → the literal
#     B) open(var, 'w') + var='path'  → harvest path-like quoted strings
#   Shape B is a LAST RESORT: harvest quoted path-like strings only when
#   nothing explicit SURVIVES FILTERING. Otherwise a heredoc that writes a
#   file whose CONTENT mentions other paths reports them all —
#   `cat > t.test.js <<EOF … open('src/app.js','w') … EOF` named both.
#   Gated on the filtered set, not the raw harvest. The raw check was empty in
#   the tests but not in practice: a `<project>` placeholder inside the quoted
#   content harvests as a `>` redirect to a bare backtick, and a `2>/dev/null`
#   anywhere in the compound command harvests `/dev/null`. Either made the raw
#   list non-empty, the fallback was skipped, the filter then discarded the
#   junk, and a real `p='/Users/andyed/CLAUDE.md' … open(p,'w')` logged as
#   `Ran:` (session 24b90edb, 2026-09-13, twice) while the same shape without
#   the incidental `>` was caught.
#
# bash_strip_heredocs — the command as the shell runs it: heredoc bodies
# removed, lines intact. Git and noise detection read this, never the raw
# text, because a body is data — a memory file, release notes, a commit
# message — and it names `git push` or `git commit` without running either.
# Over 30 days of transcripts (83,302 Bash commands, 2026-09-26) a commit or
# push appeared only inside a body 40 times and none of them ran there; read
# raw, each is a phantom push, or turns a real `cat > notes.md <<EOF` edit
# into `Ran:` via the commit branch. A delimiter must start with a letter or
# `_`, so arithmetic `1<<2` is not a heredoc, and `<<<` is a here-string. A
# body with no terminator line is kept: a misread `<<` then hides nothing.
#
# bash_is_noise — true when every command in a command line is noise: `cd
# repo && ls` is, `cd repo && python3 …` is not. Reads the heredoc-stripped
# command with its newlines, so each `&&`, `;` or newline segment is judged on
# its own. This used to judge the first command after any leading `cd` hops
# and ignore the rest, so a leading `cat`/`echo`/`ls` took everything after it
# down. Commit c29a684 (session 979b81b0, 2026-09-26) was lost that way: `cat
# > <scratchpad>/commit-msg.txt <<EOF … EOF` then `git add … && git commit -F
# …`, where the scratchpad path is filtered out of the writes that would have
# overridden the verdict. Replayed over the same 30 days, the old rule dropped
# ~4,400 commands of real work this way (node/python/npx runs, curl, 552 git
# writes) and ~9,900 inspection runs (`echo "==="; grep …`) that are logged
# whenever they lack the leading echo. Judging every segment logs both: a
# logged command costs a row, a dropped one can cost a commit. `ls*` used to
# swallow lsof/lsblk/lsattr too — anchored now.
#
# git_invocation — the first `git [global options] <subcommand>` the command
# runs, or nothing. Only the options between `git` and the subcommand come
# back, so the `-C` of an earlier `git -C a add` never lends its path to a
# later `git -C b commit`. Matched against code_only() and cut from the
# original, so a quoted `-C` path comes back intact. Reads the heredoc-
# stripped command with its newlines, since a comment ends at one.
#
# The summary forms are cut here too, in bytes as `head -c` cut them: the
# 500-byte flattened COMMAND (newlines and tabs to spaces, runs of spaces
# squeezed — downstream TSV/embedding paths are line-based, and the trailing
# newline jq printed became its trailing space), the 20000-byte flattened
# form the write harvest reads, and the heredoc-stripped 20000-byte form the
# git and noise detection read. Detection reads the FULL command; only the
# SUMMARY is truncated. A long heredoc puts its `open(p,'w')` well past 500
# chars, so detecting against the truncated copy missed precisely the largest
# edits — a real CHANGELOG.md rewrite logged as `tool_bash` while a short one
# was caught. Git and noise detection read the truncated copy until
# 2026-09-26, so a commit past char 500 was invisible: a `cat >> TODO.md
# <<EOF … EOF` or a long `printf` ahead of it is enough. Replayed over 30
# days, 584 commands put a real `git commit` past that cut. 20000 is capped
# well above any real command so a pathological paste can't stall the hook.
#
# Prints, one per line: the commit, push and commit-verb invocations, the
# noise verdict (1 = all noise), the written paths (comma-joined), the
# 500-byte COMMAND, then the heredoc-stripped form on as many lines as it
# has, closed by a line holding a single `.` so an empty form is still
# delimited once `$(…)` strips trailing newlines. Needs AWK_CODE_ONLY ahead
# of it, and re_commit/re_push/re_verbs from -v.
AWK_COMMAND_FACTS='
function flat(x) { gsub(/[\n\t\r]/, " ", x); gsub(/  +/, " ", x); return x }
function trim(x) { sub(/^[[:space:]]+/, "", x); sub(/[[:space:]]+$/, "", x); return x }
function last_field(x,   a, k) { k = split(x, a, " "); return (k ? a[k] : "") }
# All matches of re in s, one per line, as `grep -oE` lists them. re is a
# string: a regex literal in argument position is `$0 ~ /re/`, a number.
function harvest(s, re,   out) {
  out = ""
  while (match(s, re)) { out = out substr(s, RSTART, RLENGTH) "\n"; s = substr(s, RSTART + RLENGTH) }
  return out
}
function strip_heredocs(   o, i, line, nq, rest, before, tok, d, q, dash, k, j, t) {
  o = ""; i = 1
  while (i <= n) {
    line = L[i++]; o = o line "\n"
    nq = 0; rest = line
    while (match(rest, /<<-?[ \t]*[^ \t;&|<>()]+/)) {
      before = (RSTART > 1) ? substr(rest, RSTART - 1, 1) : ""
      tok = substr(rest, RSTART, RLENGTH)
      rest = substr(rest, RSTART + RLENGTH)
      if (before == "<") continue
      d = tok; sub(/^<<-?[ \t]*/, "", d); gsub(/["\\]/, "", d); gsub(/\047/, "", d)
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
  return o
}
function is_noise(sh,   m, lines, i, line, buf, out, segs, j, seg) {
  m = split(sh, lines, "\n"); out = ""; buf = ""
  for (i = 1; i <= m; i++) {
    line = lines[i]
    if (sub(/\\$/, "", line)) { buf = buf line " "; continue }
    out = out buf line "\n"; buf = ""
  }
  if (buf != "") out = out buf "\n"
  gsub(/&&|;/, "\n", out)
  m = split(out, segs, "\n")
  for (j = 1; j <= m; j++) {
    seg = trim(segs[j])
    if (seg == "" || seg ~ /^#/ || seg == "ls" || seg ~ /^ls / || seg ~ /^cat / || seg ~ /^echo / \
        || seg == "pwd" || seg == "cd" || seg ~ /^cd / || seg ~ /^which / || seg ~ /^wc / \
        || seg ~ /^head / || seg ~ /^tail /) continue
    return 0
  }
  return 1
}
function keep_path(p) {
  if (p ~ /^\/dev\// || p ~ /^\/tmp\// || p ~ /^\/private\/tmp\// || p ~ /^&/ || p ~ /^-/) return 0
  if (p ~ /\/node_modules\// || p ~ /\/\.git\// || p ~ /\.lock$/ || p ~ /lock\.json$/) return 0
  if (index(p, "://")) return 0
  if (p ~ /[{}"()$*;]/ || p ~ /^\047/) return 0
  return (index(p, "/") || p ~ EXT_END)
}
# bash_filter_paths over a newline-separated list: blank lines dropped, each
# candidate trimmed as `read` trims, filtered, deduped, at most five.
function filter_paths(raw, want,   m, c, i, p, seen, out, k) {
  m = split(raw, c, "\n"); out = ""; k = 0
  for (i = 1; i <= m; i++) {
    p = trim(c[i])
    if (p == "" || !keep_path(p) || (p in seen)) continue
    seen[p] = 1
    out = out (k ? "," : "") p
    if (++k >= want) break
  }
  return out
}
function written_paths(full,   raw, lst, m, a, i, tok, re) {
  raw = "\n"
  lst = harvest(full, ">>?[[:space:]]*[^ &|;<>()]+")
  m = split(lst, a, "\n"); for (i = 1; i < m; i++) { tok = a[i]; sub(/^>>?[[:space:]]*/, "", tok); raw = raw tok "\n" }
  raw = raw "\n"
  lst = harvest(full, "sed -i[^|;&]*")
  m = split(lst, a, "\n"); for (i = 1; i < m; i++) raw = raw last_field(a[i]) "\n"
  raw = raw "\n"
  lst = harvest(full, "tee[[:space:]]+(-a[[:space:]]+)?[^ &|;]+")
  m = split(lst, a, "\n"); for (i = 1; i < m; i++) raw = raw last_field(a[i]) "\n"
  if (full ~ OPEN_W) {
    raw = raw "\n"
    lst = harvest(full, OPEN_LIT)
    m = split(lst, a, "\n"); for (i = 1; i < m; i++) { tok = a[i]; sub(/^open\(["\047]/, "", tok); sub(/["\047].*$/, "", tok); raw = raw tok "\n" }
    if (filter_paths(raw, 1) == "") {
      raw = raw "\n"
      lst = harvest(full, QUOTED_PATH)
      m = split(lst, a, "\n"); for (i = 1; i < m; i++) { tok = a[i]; gsub(/["\047]/, "", tok); raw = raw tok "\n" }
    }
  }
  return filter_paths(raw, 5)
}
BEGIN {
  A = "[A-Za-z0-9]"; ext = "\\." A A "?" A "?" A "?" A "?" A "?"   # {1,6}, spelled out for every awk
  EXT_END = ext "$"
  OPEN_W = "open\\([^)]*,[[:space:]]*[\"\047][wa]"
  OPEN_LIT = "open\\([\"\047][^\"\047]+[\"\047][[:space:]]*,[[:space:]]*[\"\047][wa]"
  QUOTED_PATH = "[\"\047][^\"\047 ]*(/[^\"\047 ]+|[^\"\047 /]+" ext ")[\"\047]"
}
{ L[++n] = $0 }
END {
  raw = ""; for (i = 1; i <= n; i++) raw = raw L[i] "\n"
  sh = substr(strip_heredocs(), 1, 20000); sub(/\n+$/, "", sh)
  s = sh "\n"; m = code_only(s)
  gsub(/[\t\r\n]/, " ", s); gsub(/[\t\r\n]/, " ", m)
  print (match(m, re_commit) ? substr(s, RSTART, RLENGTH) : "")
  print (match(m, re_push) ? substr(s, RSTART, RLENGTH) : "")
  print (match(m, re_verbs) ? substr(s, RSTART, RLENGTH) : "")
  print is_noise(sh)
  print written_paths(flat(substr(raw, 1, 20000)))
  print flat(substr(raw, 1, 500))
  printf "%s\n.", sh
}'

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

# awk: code_only(s) is s with every byte the shell would not run as a command
# blanked to `_`: quoted strings and comments. Same length, newlines kept, so a
# match found in it can be cut from s at the same offsets. A `$( … )` or
# backtick substitution inside double quotes is code and stays.
#
# A quoted string is data, the way a heredoc body is (see bash_strip_heredocs):
# a grep pattern, a jq filter, a list a probe loops over. Matching `git commit`
# inside one logged evt-q8ybf3m6r3jq (session fd2c1dac, 2026-09-27), from
# `for s in 'cd /a && git commit -q' …` whose stdout printed a sample
# `[main (root-commit) 1a2b3c4] x y`. Over 30 days of transcripts to 2026-09-27
# (59,183 Claude and Codex commands), 27 named `git commit` only inside quotes,
# every one of them data; none was a commit run through `bash -c '…'`.
AWK_CODE_ONLY='
function code_only(s,   o, i, n, c, t, k, st, pd) {
  o = ""; k = 1; st[1] = ""; n = length(s)
  for (i = 1; i <= n; i++) {
    c = substr(s, i, 1); t = st[k]
    if (t == "#") { if (c == "\n") { k--; o = o c } else o = o "_"; continue }
    if (t == "\047") { if (c == "\047") { k--; o = o c } else o = o (c == "\n" ? c : "_"); continue }
    if (t == "\"" || t == "$\047") {
      if (c == "\\" && i < n) { i++; o = o "_" (substr(s, i, 1) == "\n" ? "\n" : "_"); continue }
      if (t == "$\047" && c == "\047") { k--; o = o c; continue }
      if (t == "\"" && c == "\"") { k--; o = o c; continue }
      if (t == "\"" && c == "$" && substr(s, i + 1, 1) == "(") { st[++k] = "("; pd[k] = 1; o = o "$("; i++; continue }
      if (t == "\"" && c == "`") { st[++k] = "`"; o = o c; continue }
      o = o (c == "\n" ? c : "_"); continue
    }
    # Code: the top level, or a substitution inside double quotes.
    if (c == "\\") { o = o c; if (i < n) o = o substr(s, ++i, 1); continue }
    if (c == "\047") { st[++k] = (i > 1 && substr(s, i - 1, 1) == "$") ? "$\047" : "\047"; o = o c; continue }
    if (c == "\"") { st[++k] = "\""; o = o c; continue }
    if (c == "#" && (i == 1 || substr(s, i - 1, 1) ~ /[ \t\n;&|()]/)) { st[++k] = "#"; o = o "_"; continue }
    if (t == "(") { if (c == "(") pd[k]++; else if (c == ")" && --pd[k] == 0) k-- }
    else if (t == "`" && c == "`") k--
    o = o c
  }
  return o
}'

# The regex a `git [global options] <verb>` is found by, for the awk passes
# that read the command (AWK_COMMAND_FACTS, bash_cd_base, git_invocations).
git_re() { printf '(^|[^[:alnum:]_.-])git%s[[:space:]]+%s([^[:alnum:]_-]|$)' "$GIT_OPTS" "$1"; }

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

# awk: the `cd` hop walker, shared by bash_cd_base() and git_invocations().
# walk(s, from, to) moves `cur` through the hops in s[from..to): `cd`, `pushd`
# and `popd`, each read from text, scoped by subshells. Its state lives in
# globals so a caller can walk a command in pieces: set `cur`, `seen` (a hop was
# read), `d` (subshell depth), `q` (open quote) and `seg` (the simple command so
# far) before the first call, and hop(seg) once the walk reaches an invocation,
# since the separator ahead of `git` leaves the last hop in the buffer.
AWK_CD_HOP='
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
function walk(s, from, to,   i, c) {
  for (i = from; i < to; i++) {
    c = substr(s, i, 1)
    if (q != "") {
      seg = seg c
      if (c == "\\" && q == "\"") seg = seg substr(s, ++i, 1)
      else if (c == q) q = ""
      continue
    }
    if (c == "\\") { seg = seg c substr(s, ++i, 1); continue }
    # A comment runs to the newline, as in code_only(): the apostrophe in
    # `# don'"'"'t` opens no quote that would hide the hops after it.
    if (c == "#" && (i == 1 || substr(s, i - 1, 1) ~ /[ \t\n;&|()]/)) {
      while (i < to - 1 && substr(s, i + 1, 1) != "\n") i++
      continue
    }
    if (c == "\"" || c == "\047") { q = c; seg = seg c; continue }
    if (c == "(") { hop(seg); seg = ""; stack[++d] = cur; continue }
    if (c == ")") { hop(seg); seg = ""; if (d > 0) cur = stack[d--]; continue }
    if (c == ";" || c == "&" || c == "|" || c == "\n") { hop(seg); seg = ""; continue }
    seg = seg c
  }
}'

# Where the command's own `cd` hops leave it when it reaches its first `git …
# <$2>` (found as git_invocation() finds it, outside quotes and comments),
# walking from $3. Prints nothing when no hop precedes the invocation,
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
    -v re="$(git_re "$2")" \
    -v start="$3" -v home="$HOME" "$AWK_CODE_ONLY$AWK_CD_HOP"'
    { if (sub(/\\$/, "")) { s = s $0 " " } else { s = s $0 "\n" } }
    END {
      if (!match(code_only(s), re)) exit
      cur = start; seen = 0; d = 0; seg = ""; q = ""
      walk(s, 1, RSTART)
      # The separator before `git` belongs to the match, so the last hop is
      # still in the buffer.
      hop(seg)
      if (seen) print cur
    }'
}

# Every `git [global options] <verb>` the command runs, for each verb matching
# $2, one line apiece: "<dir>\t<invocation>\t<args>". <dir> is where the
# command's own `cd` hops stand when it reaches that invocation, walking from
# $3, or `?` where bash_cd_base() would print `?`. <invocation> runs from `git`
# through the verb, so it carries the global options git_invocation_repo()
# applies and no subcommand option: `git commit -C HEAD` reuses a message, it
# does not change directory. <args> is the rest of that simple command.
git_invocations() {
  printf '%s\n' "$1" | LC_ALL=C awk \
    -v re="$(git_re "$2")" \
    -v start="$3" -v home="$HOME" "$AWK_CODE_ONLY$AWK_CD_HOP"'
    { if (sub(/\\$/, "")) { s = s $0 " " } else { s = s $0 "\n" } }
    END {
      m = code_only(s); k = 0; off = 0
      while (match(substr(m, off + 1), re)) {
        a = off + RSTART; e = a + RLENGTH - 1
        if (substr(m, a, 3) != "git") a++
        if (substr(m, e, 1) ~ /[^[:alnum:]_-]/) e--
        gs[++k] = a; ge[k] = e; off = e
      }
      cur = start; seen = 0; d = 0; seg = ""; q = ""; from = 1
      for (j = 1; j <= k; j++) {
        walk(s, from, gs[j]); hop(seg); seg = ""; from = gs[j]
        inv = substr(s, gs[j], ge[j] - gs[j] + 1)
        rest = substr(m, ge[j] + 1)
        args = substr(s, ge[j] + 1, match(rest, /[;&|\n)]/) ? RSTART - 1 : length(rest))
        gsub(/[\t\r\n]/, " ", inv); gsub(/[\t\r\n]/, " ", args)
        printf "%s\t%s\t%s\n", cur, inv, args
      }
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

# ── Every commit a call made, from the reflog ─────────────────────────────────
# One Bash call often makes several commits: a fix and the doc that records it,
# or a `cd` into a second repo to commit there too. Reading HEAD found only the
# last. Replayed on 2026-09-27, 21 of the 46 commits missing from 2026-09-26/27
# were this, 1 more was a `git merge` and 1 a `git cherry-pick`, and 251 calls
# in 30 days ran `git commit` twice or more. Every one is in a reflog, stamped
# with the time HEAD moved and the action that moved it.
#
# The verbs that can make a commit. Their invocations name the repos to read.
COMMIT_VERBS='(commit|merge|cherry-pick|revert|am|pull)'

# The toplevel a directory sits in, worktree and all; empty outside a repo.
repo_of() {
  [ -n "$1" ] && [ -d "$1" ] && (cd "$1" 2>/dev/null && git rev-parse --show-toplevel 2>/dev/null)
}

# Commits this call made: "<toplevel>\t<sha>\t<action>" lines, oldest first,
# after one "reflog\t<toplevel>" line per repo whose reflog could be read.
# $1 is the call's start in epoch seconds.
#
# A reflog entry counts when HEAD moved inside the call AND the commit it names
# was committed inside the call: an amend that backdates, or a HEAD moved onto
# someone else's commit, fails the second test. The repos come from the
# command's own invocations, as git_base_dir() reads them, walked from where the
# command started rather than where Claude's shell ended up. Two guards keep a
# concurrent session's commit in the same repo out:
#  - its subject must appear in the command (`-m`, a heredoc body), or
#  - failing that, a repo gives up no more plain commits, or merges, than the
#    command ran `git commit`, or `git merge`/`git pull`, against it, newest
#    first. Cherry-picks, reverts and `am` apply a list, so they are not capped.
# An invocation whose repo cannot be read from text (`git -C "$W"`, `cd -`)
# adds the cwd's repos and every worktree of the repos that did resolve, and
# an entry there counts only on a subject match (for a cherry-pick, the subject
# of a sha the command names): the text is still never evaluated, and a match
# in a reflog written during the call is not a guess.
call_commits() {
  local since="$1" now line base inv verb dir repo unresolved="" wt r
  local want="" fallback="" repos="" logged picks="" named="" tok args sub
  now=$NOW_EPOCH
  while IFS=$'\t' read -r base inv args; do
    [ -n "$inv" ] || continue
    verb=${inv##*[[:space:]]}
    [ "$verb" = "cherry-pick" ] && picks="$picks $args"
    case "$base" in
      '?') dir="" ;;
      *) if [ -d "$base" ]; then dir="$base"; else dir="$CWD"; fi ;;
    esac
    repo=""
    [ -n "$dir" ] && repo=$(git_invocation_repo "$inv" "$dir")
    if [ -z "$repo" ]; then unresolved=1; continue; fi
    case "$verb" in
      commit)     want="$want$repo"$'\t'"commit"$'\n' ;;
      merge|pull) want="$want$repo"$'\t'"merge"$'\n' ;;
      *)          want="$want$repo"$'\t'"pick"$'\n' ;;
    esac
    repos="$repos$repo"$'\n'
  done <<EOF
$(git_invocations "$COMMAND_SHELL" "$COMMIT_VERBS" "$PRE_CWD")
EOF
  if [ -n "$unresolved" ]; then
    for r in "$(repo_of "$CWD")" "$(repo_of "$PRE_CWD")"; do
      [ -n "$r" ] && fallback="$fallback$r"$'\n'
    done
    while IFS= read -r r; do
      [ -n "$r" ] || continue
      fallback="$fallback$(git -C "$r" worktree list --porcelain 2>/dev/null | sed -n 's/^worktree //p')"$'\n'
    done <<EOF
$(printf '%s' "$repos$fallback" | awk 'NF && !seen[$0]++')
EOF
  fi
  [ -n "$repos$fallback" ] || return 0
  # A cherry-pick names a commit, not a subject: the subject of each sha it
  # names, wherever that sha resolves, stands in for the message in the text.
  for tok in $(printf '%s' "$picks" | LC_ALL=C grep -oE '[0-9a-f]{7,40}' | sort -u); do
    while IFS= read -r r; do
      [ -n "$r" ] || continue
      sub=$(git -C "$r" log -1 --format=%s "$tok" -- 2>/dev/null)
      [ -n "$sub" ] && { named="$named$sub"$'\n'; break; }
    done <<EOF
$(printf '%s' "$repos$fallback" | awk 'NF && !seen[$0]++')
EOF
  done
  logged=""
  [ -f "$CHANGELOG" ] && logged=$(tail -n 3000 "$CHANGELOG" 2>/dev/null \
    | LC_ALL=C grep -oE 'Commit [0-9a-f]{7,40}' | cut -c8- | sort -u)
  # One reflog read per repo, the ones the command names first: a sha seen
  # twice keeps its first reading, and only a named repo carries caps.
  printf '%s' "$repos$fallback" | awk 'NF && !seen[$0]++' | while IFS= read -r r; do
    [ -d "$r" ] || continue
    printf 'reflog\t%s\n' "$r"
    git -C "$r" log -g -n 60 --date=unix --format='%H%x09%gd%x09%ct%x09%gs%x09%s' HEAD 2>/dev/null \
      | awk -v r="$r" '{ print "entry\t" r "\t" $0 }'
  done | CARTO_CMD="$COMMAND_RAW" CARTO_NAMED="$named" CARTO_WANT="$want" CARTO_LOGGED="$logged" \
      LC_ALL=C awk -F'\t' \
      -v since="$since" -v now="$now" '
    BEGIN {
      n = split(ENVIRON["CARTO_WANT"], wl, "\n")
      for (i = 1; i <= n; i++) if (split(wl[i], f, "\t") == 2) cap[f[1] "\t" f[2]]++
      n = split(ENVIRON["CARTO_LOGGED"], ll, "\n")
      for (i = 1; i <= n; i++) if (ll[i] != "") logged[ll[i]] = 1
      cmd = ENVIRON["CARTO_CMD"]
      n = split(ENVIRON["CARTO_NAMED"], nl, "\n")
      for (i = 1; i <= n; i++) if (nl[i] != "") named[nl[i]] = 1
    }
    function later(x, y) {
      if (E_rt[x] != E_rt[y]) return E_rt[x] > E_rt[y]
      if (grp[E_repo[x]] != grp[E_repo[y]]) return grp[E_repo[x]] > grp[E_repo[y]]
      return x < y
    }
    $1 == "reflog" { print; next }
    $1 != "entry" { next }
    {
      repo = $2; sha = $3; ct = $5; gs = $6; subj = $7
      rt = $4; sub(/^[^{]*\{/, "", rt); sub(/\}.*$/, "", rt)
      if (rt + 0 < since || rt + 0 > now + 5 || ct + 0 < since || ct + 0 > now + 5) next
      action = gs; sub(/: .*$/, "", action); msg = gs; sub(/^[^:]*: /, "", msg)
      if (action ~ /^commit/) class = "commit"
      else if (action ~ /rebase/ || msg ~ /^Fast[- ]forward/) next
      else if (action ~ /^(merge|pull)/) class = "merge"
      else if (action ~ /^(cherry-pick|revert|am)$/) class = "pick"
      else next
      if (sha in done) next
      for (l in logged) if (index(sha, l) == 1) next
      done[sha] = 1
      if (action == "commit (amend)") name = "amend"
      else if (action == "commit (merge)" || class == "merge") name = "merge"
      else if (class == "commit") name = "commit"
      else name = action
      if (!(repo in grp)) grp[repo] = ++ngrp
      k++; E_repo[k] = repo; E_sha[k] = sha; E_class[k] = class; E_name[k] = name
      E_rt[k] = rt + 0
      E_match[k] = (length(subj) >= 3 && index(cmd, subj) > 0) || (class == "pick" && (subj in named))
    }
    END {
      # Each repo lists newest first: subject matches, then the rest up to what
      # the command asked of that repo. A repo reached only because an
      # invocation could not be read asked for nothing, so it gives up matches
      # alone; so does a class the command never ran against a repo.
      for (i = 1; i <= k; i++) if (E_match[i]) { ok[i] = 1; took[E_repo[i] "\t" E_class[i]]++ }
      for (i = 1; i <= k; i++) {
        if (ok[i]) continue
        key = E_repo[i] "\t" E_class[i]
        if (!(cap[key] + 0)) continue
        if (E_class[i] != "pick" && took[key] + 0 >= cap[key] + 0) continue
        ok[i] = 1; took[key]++
      }
      # Oldest first. Within a second: the repo the command reached first,
      # then the order within each reflog reversed, since a reflog lists newest
      # first.
      n = 0
      for (i = 1; i <= k; i++) if (ok[i]) out[++n] = i
      for (a = 2; a <= n; a++) {
        v = out[a]
        for (b = a - 1; b >= 1 && later(out[b], v); b--) out[b + 1] = out[b]
        out[b + 1] = v
      }
      for (a = 1; a <= n; a++) { i = out[a]; printf "commit\t%s\t%s\t%s\n", E_repo[i], E_sha[i], E_name[i] }
    }'
}

# Where the call started, which Claude Code's payload does not say: its cwd is
# where the shell ended up. The transcript line that issued the tool call
# carries the cwd from before it. Empty when that line cannot be found.
call_start_cwd() {
  # An id is letters, digits, `_` and `-`; anything else never reaches the pattern.
  case "$TOOL_USE_ID" in ''|*[!A-Za-z0-9_-]*) return 0 ;; esac
  [ -f "$TRANSCRIPT" ] || return 0
  tail -c 4000000 "$TRANSCRIPT" 2>/dev/null \
    | LC_ALL=C grep -E "\"id\": ?\"$TOOL_USE_ID\"" | tail -1 | jq -r '.cwd // empty' 2>/dev/null
}

# One row, from the globals the branches set, to both logs and the index.
# COMMIT_ACTION is set only for rows read from the reflog: commit, amend,
# merge, cherry-pick, revert or am.
emit_row() {
  [ -n "$EVENT_ID" ] || EVENT_ID=$(cartographer_event_id)
  # Both rows from one jq: the tool-use row first, the changelog row second.
  # The changelog row carries related_ids and names the session session_id;
  # the tool-use row names the tool and carries commit_url.
  local rows nl='
' tool_row changelog_event
  rows=$(jq -n -c \
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
      --arg commit_action "${COMMIT_ACTION:-}" \
      --argjson diff_shape "${DIFF_SHAPE:-null}" \
      --arg parent_id "$PARENT_ID" \
      --argjson salience "${SALIENCE:-0.5}" \
      '({event_id: $eid, timestamp: $ts, type: $type, provider: $provider, tool: $tool, summary: $summary, project: $project, cwd: $cwd, session: $session, transcript_path: $transcript, diff_shape: $diff_shape, salience: $salience}
        + if $commit_type != "" then {commit_type: $commit_type} else {} end
        + if $commit_url != "" then {commit_url: $commit_url} else {} end
        + if $commit_action != "" then {commit_action: $commit_action} else {} end
        + if $parent_id != "" then {parent_event_id: $parent_id} else {} end),
       ({event_id: $eid, timestamp: $ts, type: $type, provider: $provider, session_id: $session, project: $project, cwd: $cwd, summary: $summary, transcript_path: $transcript, diff_shape: $diff_shape, related_ids: [], salience: $salience}
        + if $commit_type != "" then {commit_type: $commit_type} else {} end
        + if $commit_action != "" then {commit_action: $commit_action} else {} end
        + if $parent_id != "" then {parent_event_id: $parent_id} else {} end)')
  case "$rows" in *"$nl"*) ;; *) return 0 ;; esac
  tool_row=${rows%%"$nl"*}
  changelog_event=${rows#*"$nl"}

  printf '%s\n' "$tool_row" >> "$LOG_FILE"
  printf '%s\n' "$changelog_event" >> "$CHANGELOG"

  # Real-time indexing (silent fail if services aren't running)
  INDEXER=$(cartographer_script index-event.sh)
  if [ -x "$INDEXER" ]; then
    printf '%s\n' "$changelog_event" | "$INDEXER" &
  fi
}

# Files, diff shape, type, salience, summary and URL for COMMIT_HASH, with
# COMMIT_MSG its subject and GIT_REPO the repo holding it (empty when only
# stdout named the commit). One definition for the reflog's rows and HEAD's.
commit_fields() {
  # Get changed files from the commit if we can
  # The first twenty paths, comma-joined; the same list `head -20 | tr | sed`
  # built, counted the same way below (a comma inside a path counts twice,
  # as it always did).
  CHANGED_FILES=""
  if [ -n "$COMMIT_HASH" ] && [ -n "$GIT_REPO" ]; then
    n=0
    while IFS= read -r f && [ "$n" -lt 20 ]; do
      [ -n "$f" ] || continue
      CHANGED_FILES="${CHANGED_FILES:+$CHANGED_FILES,}$f"
      n=$((n + 1))
    done <<EOF
$(cd "$GIT_REPO" && git diff-tree --root --no-commit-id --name-only -r "$COMMIT_HASH" 2>/dev/null)
EOF
  fi

  # Extract diff shape metadata (Tier 3)
  DIFF_SHAPE=""
  if [ -n "$COMMIT_HASH" ] && [ -n "$GIT_REPO" ]; then
    DIFF_SHAPE_SCRIPT=$(cartographer_script diff-shape.sh)
    [ -n "$DIFF_SHAPE_SCRIPT" ] && DIFF_SHAPE=$(bash "$DIFF_SHAPE_SCRIPT" "$COMMIT_HASH" "$GIT_REPO" 2>/dev/null || echo "")
  fi

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
    FILE_COUNT=${CHANGED_FILES//[!,]/}
    FILE_COUNT=$(( ${#FILE_COUNT} + 1 ))
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
    GITHUB_BASE=$(cd "$GIT_REPO" && git remote get-url origin 2>/dev/null)
    GITHUB_BASE=${GITHUB_BASE%.git}
    gh='https://github.com/'
    GITHUB_BASE=${GITHUB_BASE/git@github.com:/$gh}
    [ -n "$GITHUB_BASE" ] && COMMIT_URL="${GITHUB_BASE}/commit/${COMMIT_HASH}"
  fi
}

case "$TOOL_NAME" in
  Edit|Write|apply_patch)
    if [ "$TOOL_NAME" = "apply_patch" ]; then FILE_PATH=$PATCH_FILES; else FILE_PATH=$FILE_PATH_IN; fi
    [ -z "$FILE_PATH" ] && exit 0
    PRIMARY_FILE=${FILE_PATH%%,*}

    # Skip noisy paths (node_modules, .git, lock files)
    case "$PRIMARY_FILE" in
      */node_modules/*|*/.git/*|*/package-lock.json|*/yarn.lock|*/pnpm-lock.yaml) exit 0 ;;
    esac
    # Refine project via file path's git repo; the cwd's otherwise.
    cartographer_repo "$(cartographer_dirname "$PRIMARY_FILE")"
    if [ -n "$CARTO_TOPLEVEL" ]; then PROJECT=$CARTO_PROJECT; else PROJECT=$(cartographer_project "$CWD"); fi
    SUMMARY="Modified: $FILE_PATH"
    TYPE="tool_file_edit"
    SALIENCE="0.4"
    ;;
  Bash)
    [ -z "$COMMAND_IN" ] && exit 0
    # One awk pass for every form of the command and everything read from it;
    # see AWK_COMMAND_FACTS. Fields come back one per line, the heredoc-
    # stripped form last, closed by a `.` line.
    FACTS=$(printf '%s\n' "$COMMAND_IN" | LC_ALL=C awk \
      -v re_commit="$(git_re commit)" -v re_push="$(git_re push)" -v re_verbs="$(git_re "$COMMIT_VERBS")" \
      "$AWK_CODE_ONLY$AWK_COMMAND_FACTS")
    NL='
'
    COMMIT_CALL=${FACTS%%"$NL"*};      FACTS=${FACTS#*"$NL"}
    PUSH_CALL=${FACTS%%"$NL"*};        FACTS=${FACTS#*"$NL"}
    COMMIT_VERB_CALL=${FACTS%%"$NL"*}; FACTS=${FACTS#*"$NL"}
    BASH_NOISE=${FACTS%%"$NL"*};       FACTS=${FACTS#*"$NL"}
    BASH_WRITES=${FACTS%%"$NL"*};      FACTS=${FACTS#*"$NL"}
    COMMAND=${FACTS%%"$NL"*};          FACTS=${FACTS#*"$NL"}
    COMMAND_SHELL=${FACTS%"$NL".}
    [ -z "$COMMAND" ] && exit 0

    # Every commit the call made, when the payload says how long the call ran
    # (Claude Code's duration_ms): the reflog is then read for exactly this
    # call. Without it — Codex, an older client — the window would be a guess,
    # and a guess picks up a concurrent session's commits, so HEAD stays the
    # source below. A second of slack covers the clock's resolution.
    CALL_OUT=""
    if [ -n "$COMMIT_VERB_CALL" ] && [ -n "$DURATION_MS" ]; then
      PRE_CWD=$(call_start_cwd)
      [ -n "$PRE_CWD" ] && [ -d "$PRE_CWD" ] || PRE_CWD="$CWD"
      # floor(now - ms/1000 - 2): whole seconds, rounding the duration up.
      MS_INT=${DURATION_MS%%.*}; MS_FRAC=${DURATION_MS#"$MS_INT"}
      case "$MS_FRAC" in *[1-9]*) MS_INT=$((10#$MS_INT + 1)) ;; *) MS_INT=$((10#$MS_INT)) ;; esac
      CALL_START=$(( NOW_EPOCH - 2 - (MS_INT + 999) / 1000 ))
      # The command as written, heredoc bodies included, where a commit
      # message usually is: call_commits() matches reflog subjects against it.
      COMMAND_RAW=$(cartographer_head_c "$COMMAND_IN" 20000)
      CALL_OUT=$(call_commits "$CALL_START")
    fi
    CALL_COMMITS=""
    REFLOG_READ=""
    if [ -n "$CALL_OUT" ]; then
      CALL_COMMITS=$(printf '%s\n' "$CALL_OUT" | awk -F'\t' '$1 == "commit"')
      # Read at least one reflog: the reflog, not HEAD, then says what was made.
      REFLOG_READ=$(printf '%s\n' "$CALL_OUT" | awk -F'\t' '$1 == "reflog"' | head -1)
    fi

    if [ -n "$CALL_COMMITS" ]; then
      while IFS=$'\t' read -r _ GIT_REPO COMMIT_HASH COMMIT_ACTION <&3; do
        COMMIT_MSG=$(git -C "$GIT_REPO" log -1 --format=%s "$COMMIT_HASH" 2>/dev/null)
        PROJECT=$(cartographer_project "$GIT_REPO")
        commit_fields
        emit_row
        PARENT_ID="$EVENT_ID"
        EVENT_ID=$(cartographer_event_id)
      done 3<<EOF
$CALL_COMMITS
EOF
      exit 0
    fi
    # A failed call logs only what it committed; everything else it did is
    # left out, as before PostToolUseFailure was registered.
    [ "$HOOK_EVENT" = "PostToolUseFailure" ] && exit 0

    # A write outranks the noise filter — see bash_written_paths. So does a
    # commit or push, which a pipe can hide from the per-segment verdict
    # (`cat msg.txt | git commit -F -` is one segment, and it starts with cat).
    if [ -z "$BASH_WRITES" ] && [ -z "$COMMIT_CALL" ] && [ -z "$PUSH_CALL" ] \
       && [ "$BASH_NOISE" = 1 ]; then
      exit 0
    fi
    PROJECT=$(cartographer_project "$CWD")

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
      RESPONSE=$(cartographer_head_c "$RESPONSE_IN" 2000)
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
      #
      # When call_commits() read a reflog and found nothing, nothing was made:
      # HEAD's freshness cannot tell this call's commit from a concurrent
      # session's, and the reflog already could.
      if [ -n "$GIT_REPO" ] && [ -z "$REFLOG_READ" ]; then
        REPO_HASH=$(git -C "$GIT_REPO" rev-parse --verify -q HEAD 2>/dev/null)
        if [ -n "$REPO_HASH" ]; then
          REPO_COMMIT_TS=$(git -C "$GIT_REPO" log -1 --format=%ct "$REPO_HASH" 2>/dev/null)
          REPO_AGE=$(( NOW_EPOCH - ${REPO_COMMIT_TS:-0} ))
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

      if [ -n "$COMMIT_HASH" ]; then
        commit_fields
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
      cartographer_repo "$(cartographer_dirname "$PRIMARY_FILE")"
      [ -n "$CARTO_TOPLEVEL" ] && PROJECT=$CARTO_PROJECT
      SUMMARY="Modified: $BASH_WRITES (via bash)"
      TYPE="tool_file_edit"
      SALIENCE="0.4"
    else
      SUMMARY="Ran: $(cartographer_head_c "$COMMAND" 200)"
      TYPE="tool_bash"
      SALIENCE="0.2"
    fi
    ;;
  *)
    exit 0
    ;;
esac

emit_row

exit 0
