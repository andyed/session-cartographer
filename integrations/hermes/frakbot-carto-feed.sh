#!/usr/bin/env bash
set -euo pipefail

# Personal FrakBot policy wrapper. Keep the generic feed builder in
# Session Cartographer; keep the independent-project allowlist here.

CARTO_ROOT="${CARTOGRAPHER_ROOT:-/Users/andyed/Documents/dev/session-cartographer}"
FEED="$CARTO_ROOT/scripts/cartographer-feed.sh"

PROJECTS="${FRAKBOT_CARTO_PROJECTS:-scrutinizer,psychodeli,tvapps,interests,sciprogfi,iblipper,devtools,wyrdforge,muriel,approach-retreat,pot-luck,camerastein,20granitecreek,suffuse,science-agent,psychodeli-audio-lab,mbp-dash,pointbreak,tunupa,movies-mindbendingpixels}"

[ -x "$FEED" ] || {
  printf 'frakbot-carto-feed: canonical feed runtime is unavailable: %s\n' "$FEED" >&2
  exit 1
}

bash "$FEED" \
  --projects "$PROJECTS" \
  --since 24h \
  --limit-per-project 5 \
  --max-results 24 \
  --min-salience 0.4

printf '\nConsumer instruction: inspect this pulse alongside Hermes session_search. '
printf 'Treat it as cross-agent session evidence, not live-world evidence. '
printf 'Exact-fetch or read a cited transcript only when the result materially affects the molt.\n'

