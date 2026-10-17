# shellcheck shell=bash
# qdrant-auth.sh — the shell face of scripts/qdrant-auth.js: which API key, if
# any, a request to Qdrant carries, and a curl that sends it. Sourced by
# index-event.sh and cartographer-search.sh; qdrant-curl.sh is the command-line
# face for skills, which cannot source a library portably.
#
# The rules, and why each holds, live in qdrant-auth.js. In short:
# CARTOGRAPHER_QDRANT_API_KEY goes wherever the URL points; otherwise the key
# file start-services.sh writes (CARTOGRAPHER_QDRANT_API_KEY_FILE, else
# ${CARTOGRAPHER_QDRANT_STORAGE:-~/Documents/dev/qdrant-storage}/api-key) goes
# to a loopback URL only; otherwise no header at all. tests/unit/qdrant-auth.test.js
# runs this file and the JS module over the same cases.
#
# Usage:
#   . scripts/qdrant-auth.sh
#   cartographer_qdrant_auth "$QDRANT_URL"   # once, after the URL is known
#   qdrant_curl -sf "$QDRANT_URL/collections/$COLLECTION"
#
# Builtins only on the lookup path (no fork per event): index-event.sh runs
# once for every logged event.

CARTOGRAPHER_QDRANT_KEY=""

# Sets CARTOGRAPHER_QDRANT_KEY (deliberately not exported) for qdrant_curl.
cartographer_qdrant_auth() {
  local url="${1:-}" key="" file authority
  CARTOGRAPHER_QDRANT_KEY=""
  key="${CARTOGRAPHER_QDRANT_API_KEY:-}"
  if [ -z "${key//[[:space:]]/}" ]; then
    key=""
    # Loopback only: the host as written (localhost, 127.0.0.1 or [::1]) plus
    # an optional port, the same literal rule as isLoopbackUrl() in the JS.
    # Whole-authority matching keeps 127.0.0.1.example.com out, and any
    # userinfo disqualifies: in http://localhost:6333@evil.example/ the host
    # is evil.example.
    case "$url" in
      http://*|https://*) ;;
      *) return 0 ;;
    esac
    authority="${url#*://}"
    authority="${authority%%[/?#]*}"
    case "$authority" in
      *@*) return 0 ;;
      localhost|localhost:*|127.0.0.1|127.0.0.1:*|'[::1]'|'[::1]':*) ;;
      *) return 0 ;;
    esac
    file="${CARTOGRAPHER_QDRANT_API_KEY_FILE:-${CARTOGRAPHER_QDRANT_STORAGE:-$HOME/Documents/dev/qdrant-storage}/api-key}"
    [ -f "$file" ] && [ -r "$file" ] || return 0
    # read fails on a file with no trailing newline yet still fills the
    # variable, so its status is not the test; the emptiness check below is.
    IFS= read -r key < "$file" 2>/dev/null || true
  fi
  # Trim surrounding whitespace, including a CRLF file's carriage return,
  # which would otherwise end up inside the header value.
  key="${key#"${key%%[![:space:]]*}"}"
  key="${key%"${key##*[![:space:]]}"}"
  CARTOGRAPHER_QDRANT_KEY="$key"
}

# curl with the api-key header when a key applies, plain curl otherwise. The
# header goes in through a descriptor (-H @file, curl 7.55+) rather than as an
# argument, so the key never appears in `ps` output. printf is a builtin, so
# the process substitution's subshell execs nothing that would show it either.
qdrant_curl() {
  if [ -n "$CARTOGRAPHER_QDRANT_KEY" ]; then
    curl -H @<(printf 'api-key: %s\n' "$CARTOGRAPHER_QDRANT_KEY") "$@"
  else
    curl "$@"
  fi
}
