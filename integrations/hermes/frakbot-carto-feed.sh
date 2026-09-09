#!/usr/bin/env bash
set -euo pipefail

# Personal FrakBot policy wrapper. Keep the generic pulse builder in
# Session Cartographer; keep the independent-project allowlist here.
#
# As of the two-part pulse this calls `cartographer-pulse.sh`, which puts a
# deterministic census above the relevance feed rather than replacing it. The
# feed alone answered "what happened yesterday" with a single Lemon Squeezy
# refund-policy fetch out of a window that deterministically held hundreds of
# events and more than a dozen commits — a ranking engine asked a census
# question has no relevance gradient to work with, so it returns *an* answer
# with no way for this wrapper to know it is not *the* answer.

CARTO_ROOT="${CARTOGRAPHER_ROOT:-/Users/andyed/Documents/dev/session-cartographer}"
PULSE="$CARTO_ROOT/scripts/cartographer-pulse.sh"

# The allowlist is admission, not discovery: a project absent from it is
# invisible to both halves of the pulse. It was widened on 2026-09-08 after the
# census made the blind spot measurable — 232 events in a single 24h window
# belonged to active projects FrakBot could not see, including commits in
# repositories with real work landing that day. The additions below were chosen
# against a 30-day census diffed against the registry-expanded list, not by
# recall.
#
# What stays out, and why — this is the part to re-read before widening again:
#   * generic and cwd-derived names (`dev`, `andyed`, `repo`, `dist`, `spec`,
#     `Documents-dev`, `/`). `dev` alone carried 15,270 events in 30 days and is
#     the workspace root, not a project. This is the same trap documented for
#     build-profile.js: without the filter the home directory is the busiest
#     "project" you own.
#   * auto-named worktrees (`brave-thompson-40e495`, `zealous-mccarthy-9d6855`,
#     and siblings). They are checkouts of projects already listed here, so
#     admitting them would double-count the work under a name that means
#     nothing to a reader.
#   * `WarnerBros` — job-search material (interviewer dossiers, employer
#     research). Personal and sensitive; it does not belong in a scheduled
#     agent's daily prompt.
#   * `psychodeli-private` — the name is an explicit signal from the operator.
#     Admit it deliberately or not at all.
#   * the deprecated FrakBot alias mapping to OpenClaw history, per the
#     project-wide rule that OpenClaw is archive material and never a source.
#
# Matching is case-insensitive substring, so a family name admits its
# repositories: `antheia` covers `antheia-firetv`.
PROJECTS="${FRAKBOT_CARTO_PROJECTS:-scrutinizer,scrutinizer-repo,psychodeli,psychodeli-audio-lab,tvapps,interests,sciprogfi,iblipper,devtools,wyrdforge,muriel,approach-retreat,pot-luck,camerastein,20granitecreek,suffuse,science-agent,mbp-dash,pointbreak,tunupa,movies-mindbendingpixels,mindbendingpixels-www,attentional-foraging,crforager,clipwall,allserp-paper,cikm-leakycursor,pupil-lfhf,antheia,fisheye-menu,unhost,hardcopy,histospire,skill-doctor,ai-govee-lights}"

[ -x "$PULSE" ] || {
  printf 'frakbot-carto-feed: canonical pulse runtime is unavailable: %s\n' "$PULSE" >&2
  exit 1
}

bash "$PULSE" \
  --projects "$PROJECTS" \
  --since 24h \
  --limit-per-project 5 \
  --max-results 24 \
  --min-salience 0.4

printf '\nConsumer instruction: inspect this pulse alongside Hermes session_search. '
printf 'Treat it as cross-agent session evidence, not live-world evidence. '
printf 'Exact-fetch or read a cited transcript only when the result materially affects the molt. '
printf 'The counted section is exhaustive within its window and this allowlist; the search section is a relevance sample and must never be quoted as a count. '
printf 'Projects outside the allowlist are invisible to both — the "Outside the requested scope" line, when present, is the size of that blind spot.\n'
