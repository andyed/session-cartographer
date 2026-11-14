#!/usr/bin/env bash
# Copies the drawing the Explorer's session map uses into the carto-map mod.
#
# A mod loads only its own files, so the pane cannot import explorer/shared/workmap. It carries
# byte-identical copies instead, and tests/unit/carto-map-workmap-sync.test.js fails when one drifts.
# Run this after changing any file listed here, then run the mod's tests.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
from="$root/explorer/shared/workmap"
to="$root/mods/carto-map/hooks/workmap"
mkdir -p "$to"
for name in hub.js kinds.js ribbon.js tint.js board.js palette.js setup.js text.js; do
  cp "$from/$name" "$to/$name"
done
echo "carto-map: copied 8 files into mods/carto-map/hooks/workmap"
