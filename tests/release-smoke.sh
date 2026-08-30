#!/usr/bin/env bash
set -euo pipefail

# Delta serving suppresses event_ids already returned this session. A harness
# that inherits a live session id silently loses repeat results and fails on
# runs that are actually fine. Tests must be hermetic.
unset CARTOGRAPHER_SESSION_ID CLAUDE_SESSION_ID CLAUDE_CODE_SESSION_ID CODEX_SESSION_ID

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
VERSION=${1:-$(node -p "require('$ROOT/package.json').version")}
VERSION=${VERSION#v}

bash "$ROOT/tests/source-marketplace-smoke.sh"
bash "$ROOT/scripts/build-release.sh" "$VERSION" >/dev/null

WORK=$(mktemp -d "${TMPDIR:-/tmp}/session-cartographer-smoke.XXXXXX")
trap 'rm -rf "$WORK"' EXIT
tar -C "$WORK" -xzf "$ROOT/dist/release/session-cartographer-$VERSION.tar.gz"
BUNDLE="$WORK/session-cartographer-$VERSION"
PLUGIN="$BUNDLE/plugins/session-cartographer"

for required in \
  "$PLUGIN/.codex-plugin/plugin.json" \
  "$PLUGIN/.claude-plugin/plugin.json" \
  "$PLUGIN/hooks/hooks.json" \
  "$PLUGIN/hooks/log-compact-summary.sh" \
  "$PLUGIN/scripts/cartographer-search.sh" \
  "$PLUGIN/scripts/cartographer-feed.sh" \
  "$PLUGIN/scripts/catch-up-transcripts.sh" \
  "$PLUGIN/scripts/codex-transcript-to-turns.awk" \
  "$PLUGIN/scripts/infer-codex-project.js" \
  "$PLUGIN/scripts/record-wrapup.sh" \
  "$PLUGIN/scripts/wrapup-coverage.js" \
  "$PLUGIN/scripts/cooccurrence-graph.js" \
  "$PLUGIN/explorer/public/og-card-1200x630.png" \
  "$PLUGIN/explorer/server/index.js" \
  "$PLUGIN/project-registry.json"; do
  [ -f "$required" ] || { echo "Missing release file: $required" >&2; exit 1; }
done

# Prove hooks resolve their bundled runtime without a source checkout.
RESOLVED=$(CARTOGRAPHER_ROOT= bash -c '. "$1/hooks/common.sh"; cartographer_script index-event.sh' _ "$PLUGIN")
[ "$RESOLVED" -ef "$PLUGIN/scripts/index-event.sh" ] || {
  echo "Bundled runtime resolved to the wrong path: $RESOLVED" >&2
  exit 1
}

# Prove the zero-service keyword path works from the extracted plugin.
DEV="$WORK/dev"
mkdir -p "$DEV"
printf '%s\n' \
  '{"event_id":"evt-release-smoke","timestamp":"2026-07-13T12:00:00Z","type":"milestone","provider":"codex","project":"release-smoke","summary":"self contained release search works"}' \
  '{"event_id":"evt-release-noise-1","timestamp":"2026-07-13T12:01:00Z","type":"milestone","provider":"claude","project":"release-smoke","summary":"unrelated alpha fixture"}' \
  '{"event_id":"evt-release-noise-2","timestamp":"2026-07-13T12:02:00Z","type":"milestone","provider":"codex","project":"release-smoke","summary":"unrelated beta fixture"}' \
  > "$DEV/changelog.jsonl"
RESULT=$(CARTOGRAPHER_DEV_DIR="$DEV" \
  CARTOGRAPHER_QDRANT_URL="http://127.0.0.1:1" \
  bash "$PLUGIN/scripts/cartographer-search.sh" "self contained release" --limit 5)
printf '%s' "$RESULT" | LC_ALL=C grep -q 'evt-release-smoke'

# When Codex is available (developer machines), exercise the real local
# marketplace and managed-cache install path. GitHub-hosted runners currently
# skip this block and still validate the exact archive contents above.
if command -v codex >/dev/null 2>&1; then
  CODEX_HOME="$WORK/codex"
  mkdir -p "$CODEX_HOME"
  CODEX_HOME="$CODEX_HOME" codex plugin marketplace add "$BUNDLE" --json >/dev/null
  CODEX_HOME="$CODEX_HOME" codex plugin add session-cartographer@session-cartographer --json >/dev/null
  INSTALLED="$CODEX_HOME/plugins/cache/session-cartographer/session-cartographer/$VERSION"
  [ -f "$INSTALLED/scripts/cartographer-search.sh" ]
  [ -f "$INSTALLED/explorer/server/index.js" ]
fi

# Exercise Claude Code's managed-cache path when its CLI is available. A
# temporary config root keeps the smoke test isolated from the user's plugins.
if command -v claude >/dev/null 2>&1; then
  CLAUDE_CONFIG_DIR="$WORK/claude"
  mkdir -p "$CLAUDE_CONFIG_DIR"
  CLAUDE_CONFIG_DIR="$CLAUDE_CONFIG_DIR" claude plugin marketplace add "$BUNDLE" >/dev/null
  CLAUDE_CONFIG_DIR="$CLAUDE_CONFIG_DIR" claude plugin install session-cartographer@session-cartographer --scope user >/dev/null
  INSTALLED="$CLAUDE_CONFIG_DIR/plugins/cache/session-cartographer/session-cartographer/$VERSION"
  [ -f "$INSTALLED/scripts/cartographer-search.sh" ]
  [ -f "$INSTALLED/explorer/server/index.js" ]
fi

echo "Release smoke test passed: $VERSION"
