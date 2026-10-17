# common.sh — shared helpers for cartographer hooks.
# Source from individual log-*.sh hooks via:
#   . "$(dirname "$0")/common.sh"
#
# All helpers are silent on missing dependencies (jq, date) so hooks
# degrade gracefully — never block a tool call because of indexing.

# detect_provider <hook-input-json>
#
# Provider selection belongs at the ingestion boundary. Do not use a mutable
# global "mode" file: Claude Code and Codex sessions may run concurrently.
# An explicit CARTOGRAPHER_PROVIDER override is useful for fixtures and custom
# integrations; normal hooks are detected from provider-specific payload/path
# signals and fall back to "unknown" rather than guessing.
detect_provider() {
  local input="$1"

  case "${CARTOGRAPHER_PROVIDER:-}" in
    claude|codex) printf '%s\n' "$CARTOGRAPHER_PROVIDER"; return 0 ;;
  esac

  command -v jq >/dev/null 2>&1 || { printf '%s\n' "unknown"; return 0; }

  local transcript turn_id model
  transcript=$(printf '%s' "$input" | jq -r '.transcript_path // empty' 2>/dev/null)
  turn_id=$(printf '%s' "$input" | jq -r '.turn_id // empty' 2>/dev/null)
  model=$(printf '%s' "$input" | jq -r '.model // empty' 2>/dev/null)
  detect_provider_from "$transcript" "$turn_id" "$model"
}

# detect_provider_from <transcript_path> <turn_id> <model>
#
# The decision behind detect_provider(), for a hook that has already pulled the
# three fields out of its payload. The hot hooks extract every field they need
# with one jq call and come here, so provider detection costs them no process.
detect_provider_from() {
  local transcript="$1" turn_id="$2" model="$3"

  case "${CARTOGRAPHER_PROVIDER:-}" in
    claude|codex) printf '%s\n' "$CARTOGRAPHER_PROVIDER"; return 0 ;;
  esac

  case "$transcript" in
    */.codex/sessions/*|*/.codex/archived_sessions/*) printf '%s\n' "codex"; return 0 ;;
    */.claude/projects/*) printf '%s\n' "claude"; return 0 ;;
  esac

  # turn_id and model are Codex hook extensions. Keep this below path checks
  # so fixtures with explicit Claude transcript paths remain deterministic.
  if [ -n "$turn_id" ] || [ -n "$model" ]; then
    printf '%s\n' "codex"
  else
    printf '%s\n' "unknown"
  fi
}

# cartographer_resolved <value>
#
# True when <value> is a real identifier: isResolved() in scripts/sentinels.js,
# for hooks that cannot import it. Absence is spelled "" or "unknown", trimmed
# and in any case. "unknown" is truthy and equal to itself, so a hook that keys
# on it with `[ -n ]` merges every unattributed session into one phantom.
# Parameter expansion and a case pattern only: no process.
cartographer_resolved() {
  local v="$1"
  v="${v#"${v%%[![:space:]]*}"}"
  v="${v%"${v##*[![:space:]]}"}"
  case "$v" in
    ''|[Uu][Nn][Kk][Nn][Oo][Ww][Nn]) return 1 ;;
  esac
  return 0
}

# cartographer_session_id
#
# Sets CARTO_SESSION_ID and CARTO_SESSION_SOURCE from the chain
# cartographer-search.sh reads — CARTOGRAPHER_SESSION_ID, CLAUDE_SESSION_ID,
# CLAUDE_CODE_SESSION_ID, CODEX_SESSION_ID — taking the first resolved value,
# not the first non-empty one: a ${a:-$b} chain lets "unknown" shadow a real id.
# A hook that calls a search must name the session the search will name, or its
# own rows cannot be joined to the served rows; this is that one reading.
cartographer_session_id() {
  local var
  CARTO_SESSION_ID=""; CARTO_SESSION_SOURCE=""
  for var in CARTOGRAPHER_SESSION_ID CLAUDE_SESSION_ID CLAUDE_CODE_SESSION_ID CODEX_SESSION_ID; do
    if cartographer_resolved "${!var:-}"; then
      CARTO_SESSION_ID="${!var}"; CARTO_SESSION_SOURCE="$var"
      return 0
    fi
  done
  return 1
}

# cartographer_script <filename>
#
# Resolve a Cartographer script from a self-contained release plugin, a source
# checkout plugin, or an explicit install root. Keep the release-plugin check
# first: GitHub release assets carry scripts inside the plugin so an install
# never depends on the developer's checkout.
cartographer_script() {
  local name="$1" root plugin_root source_root here
  here=$(cartographer_dirname "${BASH_SOURCE[0]}")
  plugin_root=$(cd "$here/.." 2>/dev/null && pwd)
  source_root=$(cd "$here/../../.." 2>/dev/null && pwd)
  for root in \
    "${CARTOGRAPHER_ROOT:-}" \
    "$plugin_root" \
    "$source_root" \
    "$HOME/Documents/dev/session-cartographer"; do
    [ -n "$root" ] || continue
    if [ -f "$root/scripts/$name" ]; then
      printf '%s\n' "$root/scripts/$name"
      return 0
    fi
  done
  return 1
}

# find_parent_event_id <log_file> <session_id> <now_ts_iso>
#
# Returns the event_id of the most recent prior event in <log_file> that
# (a) shares the same session_id and (b) was logged within 60s of <now_ts_iso>.
# Echoes an empty string when no parent qualifies.
#
# Used to thread events into work-arcs ("tried X" → "X failed" → "switched to Y")
# so /remember can traverse a chain rather than returning disconnected snapshots.
# 60s is the heuristic working window — anything older is likely a different
# thread of work even within the same session.
find_parent_event_id() {
  local log="$1" sid="$2" now="$3"
  [ -z "$sid" ] && return 0
  [ -z "$now" ] && return 0
  [ ! -f "$log" ] && return 0
  command -v jq >/dev/null 2>&1 || return 0

  local last fields
  last=$(tail -1 "$log" 2>/dev/null)
  [ -z "$last" ] && return 0

  # One jq for the three fields; a row that is not an object yields none.
  fields=$(printf '%s' "$last" | jq -r 'if type == "object" then . else {} end
    | [(.session_id // .session // ""), (.timestamp // ""), (.event_id // "")] | @sh' 2>/dev/null)
  [ -z "$fields" ] && return 0
  eval "set -- $fields"
  cartographer_parent_pick "$sid" "$now" "$1" "$2" "$3"
}

# cartographer_parent_pick <sid> <now_ts_iso> <parent_session> <parent_ts> <parent_id>
#
# The window test behind find_parent_event_id(), for a hook that has already
# read the last changelog row's fields (the hot hooks parse it inside their one
# jq call). Echoes <parent_id> when it belongs to <sid> and was logged within
# 60s before <now_ts_iso>; otherwise nothing.
cartographer_parent_pick() {
  local sid="$1" now="$2" parent_session="$3" parent_ts="$4" parent_id="$5"
  [ -z "$sid" ] && return 0
  [ -z "$now" ] && return 0
  [ "$parent_session" != "$sid" ] && return 0
  [ -z "$parent_ts" ] && return 0
  [ -z "$parent_id" ] && return 0

  local parent_epoch now_epoch diff
  parent_epoch=$(cartographer_iso_epoch "$parent_ts")
  now_epoch=$(cartographer_iso_epoch "$now")
  [ -z "$parent_epoch" ] && return 0
  [ -z "$now_epoch" ] && return 0

  diff=$((now_epoch - parent_epoch))
  if [ "$diff" -ge 0 ] && [ "$diff" -le 60 ]; then
    echo "$parent_id"
  fi
}

# cartographer_iso_epoch <timestamp>
#
# Seconds since the epoch for an ISO 8601 UTC stamp, or nothing when it does
# not parse. The canonical form the hooks write (%Y-%m-%dT%H:%M:%SZ) is
# converted in bash arithmetic, no process. Anything else goes to date(1)
# exactly as before: BSD date (macOS) with -j -f, GNU date (Linux) with -d,
# which accept different inputs and always did.
cartographer_iso_epoch() {
  local ts="$1" y m d H M S era yoe doy doe days
  case "$ts" in
    [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]Z)
      y=$((10#${ts:0:4})); m=$((10#${ts:5:2})); d=$((10#${ts:8:2}))
      H=$((10#${ts:11:2})); M=$((10#${ts:14:2})); S=$((10#${ts:17:2}))
      if [ "$m" -ge 1 ] && [ "$m" -le 12 ] && [ "$d" -ge 1 ] && [ "$d" -le 31 ] \
         && [ "$H" -le 23 ] && [ "$M" -le 59 ] && [ "$S" -le 60 ]; then
        # Days from civil (Howard Hinnant), proleptic Gregorian, UTC.
        [ "$m" -le 2 ] && y=$((y - 1))
        era=$(( (y >= 0 ? y : y - 399) / 400 ))
        yoe=$(( y - era * 400 ))
        doy=$(( (153 * (m > 2 ? m - 3 : m + 9) + 2) / 5 + d - 1 ))
        doe=$(( yoe * 365 + yoe / 4 - yoe / 100 + doy ))
        days=$(( era * 146097 + doe - 719468 ))
        printf '%s\n' $(( days * 86400 + H * 3600 + M * 60 + S ))
        return 0
      fi
      ;;
  esac
  date -j -u -f '%Y-%m-%dT%H:%M:%SZ' "$ts" +%s 2>/dev/null || \
    date -d "$ts" +%s 2>/dev/null
}

# cartographer_bytes <string> <n>
#
# The first <n> BYTES of a string, as `head -c n` cuts them. Bash counts
# characters under a UTF-8 locale, so the slice runs under LC_ALL=C and the
# locale is put back after. A cut inside a multibyte character leaves its
# leading bytes, exactly as head does; jq later writes those as U+FFFD.
cartographer_bytes() {
  local _s="$1" _set="${LC_ALL+set}" _lc="${LC_ALL-}"
  LC_ALL=C
  _s=${_s:0:$2}
  if [ -n "$_set" ]; then LC_ALL="$_lc"; else unset LC_ALL; fi
  printf '%s' "$_s"
}

# cartographer_head_c <string> <n>
#
# What `$(jq -r … | head -c n)` left in a variable: the first n bytes of the
# string plus the newline jq printed after it, trailing newlines then dropped
# as command substitution drops them.
cartographer_head_c() {
  local _s
  _s=$(cartographer_bytes "$1
" "$2")
  printf '%s' "$_s"
}

# cartographer_append <file> <row>
#
# Append <row> and a newline to <file> in ONE write(2), so rows from
# concurrent sessions cannot interleave. A plain `printf '%s\n' "$row" >> f`
# does not promise that: bash line-buffers its stdout through a 1024-byte
# buffer on macOS (BUFSIZ; glibc's is 8192), so a longer row leaves in several
# writes and another session's row lands between them. Measured 2026-10-16 with
# 8 writers × 400 rows on macOS, bash 3.2 and 5.3 alike: a row of exactly 1024
# bytes with its newline arrived whole every time, 1025 tore ~60% of rows, and
# session-milestones.jsonl held 6 rows spliced at byte 1025. Linux CI never
# saw it, because 8 KB covers every row there.
#
# So a row that fits the buffer keeps the builtin (no process), and only a
# longer one pays a cat, reading a here-string that bash has fully written
# (a temp file under 3.2, a pipe under 5.x) and writing it back in one call:
# clean to 70 KB in the same test. Measured on the live logs, 99.5% of
# tool-use rows and 99.3% of changelog rows fit the builtin, and 42% of
# milestone rows do not. <row> may hold several newline-joined rows; they
# go out together. Under LC_ALL=C, ${#} counts bytes, not characters.
#
# A rewriter replacing <file> (scripts/jsonl-lock.js) says so in
# "<file>.rewrite": "held <pid> <gen> ..." while it works and
# "released - <gen> ..." after, where <gen> counts rewrites. While a live pid
# holds it the row goes to "<file>.spool", which the rewriter appends once it
# has finished, since a row written into the copy it is replacing would vanish
# with it. The state is read again after the write. If the next rewrite (gen
# one past the first read) holds the log, it has not yet made its last look at
# the old file and the row is in hand. Any other change means a rewrite may
# have finished reading wherever the row went, so it is written again to
# wherever a row goes now. Delivery is at least once: readers fold a repeated
# event_id, and nothing restores a lost row. A grace period alone did not
# hold: tests/unit/jsonl-lock.test.js lost rows at load average 160 to a cat
# that opened the old file before the rename and wrote after the last look,
# and again at 434 when the second read skipped without the generation, a
# whole rewrite having finished inside one write. Builtins only (read, kill
# -0, test): this costs a hook no process. A held state whose pid is gone is
# ignored, so a crashed rewriter cannot divert every later row.
cartographer_append() {
  local _f="$1" _row="$2" _t _n _k1 _p1 _g1 _r1 _k2 _p2 _g2 _r2 _try=0
  local _set="${LC_ALL+set}" _lc="${LC_ALL-}"
  LC_ALL=C
  _n=${#_row}
  if [ -n "$_set" ]; then LC_ALL="$_lc"; else unset LC_ALL; fi
  while :; do
    _k1=; _p1=; _g1=; _r1=
    read -r _k1 _p1 _g1 _r1 2>/dev/null < "$_f.rewrite"
    _t="$_f"
    [ "$_k1" = held ] && kill -0 "$_p1" 2>/dev/null && _t="$_f.spool"
    if [ "$_n" -lt 1024 ]; then
      printf '%s\n' "$_row" >> "$_t" || return
    else
      # Errors from the cat attempt are dropped and the builtin retried, so a
      # failure is reported once, by the same write the hooks always made: an
      # unwritable log, or a here-string bash 3.2 could not put in TMPDIR.
      cat 2>/dev/null >> "$_t" <<< "$_row" || printf '%s\n' "$_row" >> "$_t" || return
    fi
    _k2=; _p2=; _g2=; _r2=
    read -r _k2 _p2 _g2 _r2 2>/dev/null < "$_f.rewrite"
    [ "$_k1 $_p1 $_g1 $_r1" = "$_k2 $_p2 $_g2 $_r2" ] && return 0
    if [ "$_t" = "$_f" ] && [ "$_k2" = held ] && kill -0 "$_p2" 2>/dev/null; then
      case "$_g1" in '') _g1=0 ;; *[!0-9]*) _g1=x ;; esac
      case "$_g2" in ''|*[!0-9]*) _g2=x ;; esac
      [ "$_g1" != x ] && [ "$_g2" != x ] && [ "$_g2" -eq $((_g1 + 1)) ] && return 0
    fi
    # At most 8 writes, the same cap as appendJsonl (scripts/jsonl-lock.js).
    _try=$((_try + 1))
    [ "$_try" -lt 8 ] || return 0
  done
}

# cartographer_event_id
#
# A fresh `evt-` id: 12 characters of [a-z0-9] drawn from /dev/urandom through
# one process (od). Bytes of 252 and above are rejected so every character is
# equally likely; 32 bytes leave 12 survivors with room to spare. Falls back
# to the tr|head pipeline this replaced if od is missing or comes up short.
cartographer_event_id() {
  local alpha='abcdefghijklmnopqrstuvwxyz0123456789' id='' b
  for b in $(od -An -v -tu1 -N32 /dev/urandom 2>/dev/null); do
    [ "$b" -lt 252 ] || continue
    id="$id${alpha:$((b % 36)):1}"
    [ ${#id} -ge 12 ] && break
  done
  [ ${#id} -ge 12 ] || id=$(LC_ALL=C tr -dc 'a-z0-9' < /dev/urandom | head -c 12)
  printf 'evt-%s' "$id"
}

# cartographer_dirname / cartographer_basename <path>
#
# dirname(1) and basename(1) in parameter expansion, so a hook that resolves a
# handful of paths does not pay a process for each. Same answers as the
# utilities: trailing slashes are dropped, a bare name has dirname `.`, the
# root's dirname and basename are both `/`.
cartographer_dirname() {
  local p="$1"
  case "$p" in
    '') printf '.\n'; return 0 ;;
    *[!/]*) ;;
    *) printf '/\n'; return 0 ;;          # all slashes
  esac
  p="${p%"${p##*[!/]}"}"                   # drop trailing slashes
  case "$p" in
    */*) p="${p%/*}"; p="${p%"${p##*[!/]}"}"; printf '%s\n' "${p:-/}" ;;
    *)   printf '.\n' ;;
  esac
}
cartographer_basename() {
  local p="$1"
  case "$p" in
    '') printf '\n'; return 0 ;;
    *[!/]*) ;;
    *) printf '/\n'; return 0 ;;
  esac
  p="${p%"${p##*[!/]}"}"
  printf '%s\n' "${p##*/}"
}

# Resolve a working directory to its REAL project name.
#
# `basename $(git rev-parse --show-toplevel)` returns the WORKTREE directory
# name inside a worktree, so a session run in
# repo/.claude/worktrees/brave-thompson-40e495 gets filed under the project
# "brave-thompson-40e495". When that worktree is pruned, every event pointing at
# it orphans -- measured at ~5,700 events across changelog/tool-use/milestones.
# --git-common-dir always resolves to the MAIN repo's .git, in a worktree and in
# the main tree alike, so its parent is the real project root.
#
# cartographer_repo <dir> is the same resolution as a function that sets two
# globals from ONE git call — CARTO_PROJECT (what cartographer_project would
# print) and CARTO_TOPLEVEL (what `git rev-parse --show-toplevel` would print,
# empty outside a work tree). The hot hooks need both for the same directory,
# and asked git twice, then paid dirname and basename processes on the answer.
cartographer_repo() {
    local cwd common toplevel out d
    cwd="${1:-$PWD}"
    [ -d "$cwd" ] || cwd=$(cartographer_dirname "$cwd")
    CARTO_TOPLEVEL=""; CARTO_PROJECT=""

    # --git-common-dir first: rev-parse prints each answer as it goes, so the
    # common dir still arrives when --show-toplevel then dies in a bare repo.
    local nl='
'
    out=$(git -C "$cwd" rev-parse --path-format=absolute --git-common-dir --show-toplevel 2>/dev/null)
    common="${out%%"$nl"*}"
    case "$out" in
        *"$nl"*) toplevel="${out#*"$nl"}" ;;
        *)       toplevel="" ;;
    esac
    if [ -z "$common" ]; then
        # git < 2.31 has no --path-format; --git-common-dir may come back relative.
        common=$(git -C "$cwd" rev-parse --git-common-dir 2>/dev/null) || common=""
        case "$common" in
            "" | /*) : ;;
            *) common="$cwd/$common" ;;
        esac
        toplevel=$(git -C "$cwd" rev-parse --show-toplevel 2>/dev/null) || toplevel=""
    fi
    CARTO_TOPLEVEL="$toplevel"

    # Only trust it when it really is a .git directory. A bare repo (repo.git)
    # would otherwise yield the name of its PARENT directory.
    case "$common" in
        */.git)
            d=$(cartographer_dirname "$common")
            d=$(cd "$d" 2>/dev/null && pwd -P) || d=$(cartographer_dirname "$common")
            CARTO_PROJECT=$(cartographer_basename "$d")
            return 0
            ;;
    esac

    if [ -n "$toplevel" ]; then CARTO_PROJECT=$(cartographer_basename "$toplevel")
    else CARTO_PROJECT=$(cartographer_basename "$cwd"); fi
}

cartographer_project() {
    cartographer_repo "${1:-$PWD}"
    printf '%s\n' "$CARTO_PROJECT"
}
