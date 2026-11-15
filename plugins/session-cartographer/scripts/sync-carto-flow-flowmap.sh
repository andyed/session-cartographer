#!/usr/bin/env bash
# Copies the drawing the Explorer's session map uses into the sidebar pane that ships in the plugin.
#
# A mod loads only its own files, so the pane cannot import explorer/shared/flowmap. It carries
# byte-identical copies instead, and tests/unit/carto-flow-flowmap-sync.test.js fails when one drifts.
# Run this after changing any file listed here, then run the mod's tests.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
from="$root/explorer/shared/flowmap"
to="$root/plugins/session-cartographer/hooks/carto-flow/flowmap"
mkdir -p "$to"
for name in hub.js kinds.js ribbon.js tint.js board.js palette.js setup.js text.js; do
  cp "$from/$name" "$to/$name"
done
echo "carto-flow: copied 8 files into plugins/session-cartographer/hooks/carto-flow/flowmap"
