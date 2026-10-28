#!/usr/bin/env bash
# qdrant-curl.sh — curl, carrying the Qdrant API key when one applies.
#
# The command-line face of qdrant_curl in scripts/qdrant-auth.sh, for skills:
# they are markdown, run in whatever shell the agent has, and cannot source a
# library portably. Pass curl arguments as usual; the first http(s) argument
# decides which key applies (see qdrant-auth.js for the rules). The key goes
# in as a header read from a descriptor, never as an argument or in the URL.
#
# Usage: qdrant-curl.sh -sf "$QDRANT_URL/collections/$COLLECTION/points/$ID"

set -u

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
# shellcheck source=./qdrant-auth.sh
. "$here/qdrant-auth.sh"

url=""
for arg in "$@"; do
  case "$arg" in
    http://*|https://*) url="$arg"; break ;;
  esac
done
cartographer_qdrant_auth "$url"
qdrant_curl "$@"
