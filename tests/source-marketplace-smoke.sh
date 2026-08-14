#!/usr/bin/env bash
set -euo pipefail

# Delta serving suppresses event_ids already returned this session. A harness
# that inherits a live session id silently loses repeat results and fails on
# runs that are actually fine. Tests must be hermetic.
unset CARTOGRAPHER_SESSION_ID CLAUDE_SESSION_ID CLAUDE_CODE_SESSION_ID CODEX_SESSION_ID

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
PLUGIN="$ROOT/plugins/session-cartographer"
VERSION=$(node -p "require('$ROOT/package.json').version")

for required in \
  "$PLUGIN/.codex-plugin/plugin.json" \
  "$PLUGIN/.claude-plugin/plugin.json" \
  "$PLUGIN/hooks/hooks.json" \
  "$PLUGIN/scripts/cartographer-search.sh" \
  "$PLUGIN/scripts/catch-up-transcripts.sh" \
  "$PLUGIN/scripts/codex-transcript-to-turns.awk" \
  "$PLUGIN/scripts/infer-codex-project.js" \
  "$PLUGIN/scripts/cooccurrence-graph.js" \
  "$PLUGIN/explorer/server/index.js" \
  "$PLUGIN/project-registry.json"; do
  [ -f "$required" ] || {
    echo "Source marketplace is missing: $required" >&2
    echo "Run: bash scripts/copy-plugin-runtime.sh plugins/session-cartographer" >&2
    exit 1
  }
done

# The checked-in marketplace snapshot must match the canonical runtime.
for source in "$ROOT"/scripts/*; do
  [ -f "$source" ] || continue
  target="$PLUGIN/scripts/$(basename "$source")"
  cmp -s "$source" "$target" || {
    echo "Source marketplace runtime is stale: $target" >&2
    exit 1
  }
done
cmp -s "$ROOT/package.json" "$PLUGIN/package.json"
cmp -s "$ROOT/project-registry.json" "$PLUGIN/project-registry.json"
cmp -s "$ROOT/LICENSE" "$PLUGIN/LICENSE"

for source in \
  "$ROOT/explorer/package.json" \
  "$ROOT/explorer/package-lock.json" \
  "$ROOT/explorer/index.html" \
  "$ROOT/explorer/postcss.config.js" \
  "$ROOT/explorer/tailwind.config.js" \
  "$ROOT/explorer/vite.config.js" \
  "$ROOT/explorer/public/favicon.ico" \
  "$ROOT"/explorer/public/js/*.js; do
  relative=${source#"$ROOT/"}
  target="$PLUGIN/$relative"
  cmp -s "$source" "$target" || {
    echo "Source marketplace Explorer runtime is stale: $target" >&2
    exit 1
  }
done

for directory in explorer/server explorer/src; do
  while IFS= read -r source; do
    relative=${source#"$ROOT/"}
    target="$PLUGIN/$relative"
    cmp -s "$source" "$target" || {
      echo "Source marketplace Explorer runtime is stale: $target" >&2
      exit 1
    }
  done < <(find "$ROOT/$directory" -type f -print | sort)
done

WORK=$(mktemp -d "${TMPDIR:-/tmp}/session-cartographer-source-smoke.XXXXXX")
trap 'rm -rf "$WORK"' EXIT
DEV="$WORK/dev"
mkdir -p "$DEV"
printf '%s\n' \
  '{"event_id":"evt-source-smoke","timestamp":"2026-07-25T00:00:00Z","type":"milestone","provider":"codex","project":"source-smoke","summary":"repository marketplace search works"}' \
  '{"event_id":"evt-source-noise-1","timestamp":"2026-07-25T00:01:00Z","type":"milestone","provider":"claude","project":"source-smoke","summary":"unrelated alpha fixture"}' \
  '{"event_id":"evt-source-noise-2","timestamp":"2026-07-25T00:02:00Z","type":"milestone","provider":"codex","project":"source-smoke","summary":"unrelated beta fixture"}' \
  > "$DEV/changelog.jsonl"

RESULT=$(CARTOGRAPHER_DEV_DIR="$DEV" bash "$PLUGIN/scripts/cartographer-search.sh" "repository marketplace search" --limit 5)
printf '%s' "$RESULT" | LC_ALL=C grep -q 'evt-source-smoke'

# Exercise the actual checkout marketplace path when the agent CLIs are
# available. GitHub runners still validate the exact checked-in plugin above.
if command -v codex >/dev/null 2>&1; then
  mkdir -p "$WORK/codex"
  CODEX_HOME="$WORK/codex" codex plugin marketplace add "$ROOT" --json >/dev/null
  CODEX_HOME="$WORK/codex" codex plugin add session-cartographer@session-cartographer --json >/dev/null
  INSTALLED="$WORK/codex/plugins/cache/session-cartographer/session-cartographer/$VERSION"
  [ -f "$INSTALLED/scripts/cartographer-search.sh" ]
  [ -f "$INSTALLED/explorer/server/index.js" ]
  RESULT=$(CARTOGRAPHER_DEV_DIR="$DEV" bash "$INSTALLED/scripts/cartographer-search.sh" "repository marketplace search" --limit 5)
  printf '%s' "$RESULT" | LC_ALL=C grep -q 'evt-source-smoke'
fi

if command -v claude >/dev/null 2>&1; then
  mkdir -p "$WORK/claude"
  CLAUDE_CONFIG_DIR="$WORK/claude" claude plugin marketplace add "$ROOT" >/dev/null
  CLAUDE_CONFIG_DIR="$WORK/claude" claude plugin install session-cartographer@session-cartographer --scope user >/dev/null
  INSTALLED="$WORK/claude/plugins/cache/session-cartographer/session-cartographer/$VERSION"
  [ -f "$INSTALLED/scripts/cartographer-search.sh" ]
  [ -f "$INSTALLED/explorer/server/index.js" ]
fi

echo "Source marketplace smoke test passed: $VERSION"
