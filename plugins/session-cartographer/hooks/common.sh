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
