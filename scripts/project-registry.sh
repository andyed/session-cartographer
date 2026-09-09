#!/usr/bin/env bash
# project-registry.sh — the one resolver for project-registry.json.
#
# WHY THIS EXISTS
#
# The registry that ships in this repo is the MAINTAINER's: ten aliases naming
# his repositories. Every adopter of the public plugin installs it. An alias the
# resolver does not know falls through as a literal project name rather than
# erroring, so an adopter who runs `--project devtools` gets zero results for a
# scope they believe they set — a silent wrong answer, not a failure. Worse,
# the shipped `frakbot` alias expands to `openclaw`, which this project treats
# as deprecated archive material that is never a valid source.
#
# So: a user-level registry that REPLACES the shipped one, resolved in exactly
# one place. Four consumers (cartographer-search.sh, cartographer-feed.sh,
# cartographer-pulse.sh, build-profile.js) each had their own copy of the path
# handling and jq expansion; per CLAUDE.md's sentinel rule a re-derived
# definition is a defect here, and these had already diverged (search joins
# with "|", the feed emits one name per line, build-profile probed two
# directories the shell consumers never looked at).
#
# RESOLUTION ORDER (highest first, first hit wins)
#
#   1. $CARTOGRAPHER_PROJECT_REGISTRY   explicit path, for tests and one-offs
#   2. <config dir>/project-registry.json
#      config dir = dirname($CARTOGRAPHER_CONFIG) when set, else
#      ${XDG_CONFIG_HOME:-$HOME/.config}/session-cartographer — the same
#      convention turboConfigPath() in scripts/turbo-common.js already resolves.
#      Reused deliberately: a second config location would mean an adopter who
#      configured Turbo still has to discover where the registry lives.
#   3. <dir of this script>/../project-registry.json   the shipped default
#
# LAYERS DO NOT MERGE. A user registry replaces the shipped one wholesale.
# Merging would leave `frakbot -> openclaw` reachable in an adopter's install
# forever, and an alias the user deliberately deleted would keep working.
#
# ERRORS ARE LOUD. A registry that is present but unparseable returns nonzero
# instead of falling back to the shipped file — a silent fallback would answer
# an adopter's query with the maintainer's aliases, which is the exact failure
# this file was written to remove.
#
# Usage:
#   . "$(dirname "$0")/project-registry.sh"
#   REGISTRY=$(cartographer_registry_path) || exit 3
#   cartographer_expand_alias psychodeli        # one member per line
#
#   bash scripts/project-registry.sh --path     # print the resolved path
#   bash scripts/project-registry.sh --aliases  # list alias keys
#   bash scripts/project-registry.sh --expand X # expand one name

# Directory holding user-level Session Cartographer configuration.
cartographer_registry_config_dir() {
  if [ -n "${CARTOGRAPHER_CONFIG:-}" ]; then
    dirname "$CARTOGRAPHER_CONFIG"
    return 0
  fi
  printf '%s/session-cartographer\n' "${XDG_CONFIG_HOME:-$HOME/.config}"
}

# The user-level registry path, whether or not it exists. This is where
# bootstrap-project-registry.js writes.
cartographer_user_registry_path() {
  if [ -n "${CARTOGRAPHER_PROJECT_REGISTRY:-}" ]; then
    printf '%s\n' "$CARTOGRAPHER_PROJECT_REGISTRY"
    return 0
  fi
  printf '%s/project-registry.json\n' "$(cartographer_registry_config_dir)"
}

# Validate one candidate file. Returns 0 when it is a usable registry, 1 when
# it is present but malformed. jq is the only parser these shell consumers
# have; without it we cannot tell malformed from valid, so validation is
# skipped with a warning rather than guessed at.
cartographer_registry_valid() {
  _carto_reg_file="$1"
  if ! command -v jq >/dev/null 2>&1; then
    printf 'project-registry: jq not found — cannot validate %s\n' "$_carto_reg_file" >&2
    return 0
  fi
  if jq -e '(.aliases | type) == "object"' "$_carto_reg_file" >/dev/null 2>&1; then
    return 0
  fi
  printf 'project-registry: %s is not a valid registry (expected a JSON object with an "aliases" object)\n' \
    "$_carto_reg_file" >&2
  return 1
}

# Print the resolved registry path. Nonzero (and nothing on stdout) when the
# selected registry is unusable.
cartographer_registry_path() {
  _carto_reg_self="${BASH_SOURCE[0]:-$0}"
  _carto_reg_shipped="$(cd "$(dirname "$_carto_reg_self")/.." && pwd)/project-registry.json"

  # 1. Explicit path. Set-but-missing is an error, not a fallback: the caller
  #    named a file, and quietly answering from a different one is how the
  #    original bug worked.
  if [ -n "${CARTOGRAPHER_PROJECT_REGISTRY:-}" ]; then
    if [ ! -f "$CARTOGRAPHER_PROJECT_REGISTRY" ]; then
      printf 'project-registry: CARTOGRAPHER_PROJECT_REGISTRY=%s does not exist\n' \
        "$CARTOGRAPHER_PROJECT_REGISTRY" >&2
      return 3
    fi
    cartographer_registry_valid "$CARTOGRAPHER_PROJECT_REGISTRY" || return 3
    printf '%s\n' "$CARTOGRAPHER_PROJECT_REGISTRY"
    return 0
  fi

  # 2. User-level registry. Absent is normal (fall through); present and
  #    broken is an error.
  _carto_reg_user="$(cartographer_registry_config_dir)/project-registry.json"
  if [ -f "$_carto_reg_user" ]; then
    cartographer_registry_valid "$_carto_reg_user" || return 3
    printf '%s\n' "$_carto_reg_user"
    return 0
  fi

  # 3. Shipped default.
  if [ -f "$_carto_reg_shipped" ]; then
    printf '%s\n' "$_carto_reg_shipped"
    return 0
  fi
  return 1
}

# Expand one project name through the resolved registry. Prints the alias
# members one per line, or the name itself when it is not an alias. Callers
# that want search's "a|b|c" form pipe through `paste -sd '|' -`.
cartographer_expand_alias() {
  _carto_alias_name="$1"
  [ -n "$_carto_alias_name" ] || return 0
  _carto_alias_registry="$(cartographer_registry_path)" || return 3
  if [ -n "$_carto_alias_registry" ] && command -v jq >/dev/null 2>&1 && \
     jq -e --arg a "$_carto_alias_name" '.aliases[$a] | type == "array"' \
       "$_carto_alias_registry" >/dev/null 2>&1; then
    jq -r --arg a "$_carto_alias_name" '.aliases[$a][]' "$_carto_alias_registry"
    return 0
  fi
  printf '%s\n' "$_carto_alias_name"
}

# Direct invocation (not sourced).
if [ "${BASH_SOURCE[0]:-$0}" = "$0" ]; then
  case "${1:---path}" in
    --path) cartographer_registry_path ;;
    --user-path) cartographer_user_registry_path ;;
    --aliases)
      _carto_reg="$(cartographer_registry_path)" || exit 3
      jq -r '.aliases | keys[]' "$_carto_reg"
      ;;
    --expand) cartographer_expand_alias "${2:?--expand needs a name}" ;;
    *) printf 'Usage: project-registry.sh [--path|--user-path|--aliases|--expand NAME]\n' >&2; exit 2 ;;
  esac
fi
