#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
PLUGIN=${1:?Usage: copy-plugin-runtime.sh <plugin-directory>}

case "$PLUGIN" in
  /|'') echo "Refusing unsafe plugin destination: $PLUGIN" >&2; exit 2 ;;
esac

mkdir -p \
  "$PLUGIN/scripts" \
  "$PLUGIN/explorer/public/js" \
  "$PLUGIN/explorer/server" \
  "$PLUGIN/explorer/src"

# Keep the checkout marketplace and release archive on one runtime assembly
# path. Skills and hooks live canonically under plugins/session-cartographer;
# the shared CLI, registry, and Explorer live at the repository root.
find "$ROOT/scripts" -maxdepth 1 -type f -exec cp {} "$PLUGIN/scripts/" \;
cp "$ROOT/package.json" "$PLUGIN/package.json"
cp "$ROOT/project-registry.json" "$PLUGIN/project-registry.json"
cp "$ROOT/LICENSE" "$PLUGIN/LICENSE"

cp "$ROOT/explorer/package.json" "$ROOT/explorer/package-lock.json" "$PLUGIN/explorer/"
cp "$ROOT/explorer/index.html" "$ROOT/explorer/postcss.config.js" "$PLUGIN/explorer/"
cp "$ROOT/explorer/tailwind.config.js" "$ROOT/explorer/vite.config.js" "$PLUGIN/explorer/"
cp "$ROOT/explorer/public/favicon.ico" "$PLUGIN/explorer/public/favicon.ico"
cp "$ROOT/explorer/public/js/"*.js "$PLUGIN/explorer/public/js/"
cp -R "$ROOT/explorer/server/." "$PLUGIN/explorer/server/"
cp -R "$ROOT/explorer/src/." "$PLUGIN/explorer/src/"
