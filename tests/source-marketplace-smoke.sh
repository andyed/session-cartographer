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
  "$PLUGIN/scripts/cartographer-feed.sh" \
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
  "$ROOT/explorer/public/og-card-1200x630.png" \
  "$ROOT"/explorer/public/js/*.js; do
  relative=${source#"$ROOT/"}
  target="$PLUGIN/$relative"
  cmp -s "$source" "$target" || {
    echo "Source marketplace Explorer runtime is stale: $target" >&2
    exit 1
  }
done

# Social metadata and the card's PNG header are release contracts. Validate
# them without ImageMagick so the source-marketplace smoke remains portable.
node - "$ROOT/explorer/public/og-card-1200x630.png" "$ROOT/explorer/index.html" <<'NODE'
const fs = require('fs');
const [pngPath, htmlPath] = process.argv.slice(2);
const png = fs.readFileSync(pngPath);
if (png.readUInt32BE(16) !== 1200 || png.readUInt32BE(20) !== 630) {
  throw new Error(`Unexpected OG dimensions: ${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`);
}
const html = fs.readFileSync(htmlPath, 'utf8');
for (const required of [
  'https://andyed.github.io/session-cartographer/og-card-1200x630.png',
  'property="og:image:alt"',
  'name="twitter:image:alt"',
]) {
  if (!html.includes(required)) throw new Error(`Missing social metadata: ${required}`);
}
NODE

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
  '{"event_id":"evt-source-noise-3","timestamp":"2026-07-25T00:02:10Z","type":"milestone","provider":"codex","project":"source-smoke","summary":"unrelated gamma fixture"}' \
  '{"event_id":"evt-source-noise-4","timestamp":"2026-07-25T00:02:20Z","type":"milestone","provider":"claude","project":"source-smoke","summary":"unrelated delta fixture"}' \
  '{"event_id":"evt-source-noise-5","timestamp":"2026-07-25T00:02:30Z","type":"milestone","provider":"codex","project":"source-smoke","summary":"unrelated epsilon fixture"}' \
  '{"event_id":"evt-private-work","timestamp":"2026-07-25T00:03:00Z","type":"milestone","provider":"codex","project":"private-work","summary":"repository marketplace search employer material"}' \
  > "$DEV/changelog.jsonl"

RESULT=$(CARTOGRAPHER_DEV_DIR="$DEV" \
  CARTOGRAPHER_QDRANT_URL="http://127.0.0.1:1" \
  bash "$PLUGIN/scripts/cartographer-search.sh" "repository marketplace search" --limit 5)
printf '%s' "$RESULT" | LC_ALL=C grep -q 'evt-source-smoke'

JSONL_RESULT=$(CARTOGRAPHER_DEV_DIR="$DEV" CARTOGRAPHER_SERVED_LOG=/dev/null \
  CARTOGRAPHER_QDRANT_URL="http://127.0.0.1:1" \
  bash "$PLUGIN/scripts/cartographer-search.sh" "repository marketplace search" \
  --project source-smoke --limit 5 --format jsonl)
printf '%s\n' "$JSONL_RESULT" | jq -e \
  'select(.event_id == "evt-source-smoke" and .project == "source-smoke" and .rank == 1)' \
  >/dev/null

FEED_RESULT=$(CARTOGRAPHER_DEV_DIR="$DEV" \
  CARTOGRAPHER_QDRANT_URL="http://127.0.0.1:1" \
  bash "$PLUGIN/scripts/cartographer-feed.sh" \
  --projects source-smoke \
  --since 2026-07-24 \
  --before 2026-07-26 \
  --query "repository marketplace search" \
  --max-results 5)
printf '%s' "$FEED_RESULT" | LC_ALL=C grep -q '# Session Cartographer Pulse'
printf '%s' "$FEED_RESULT" | LC_ALL=C grep -q 'evt-source-smoke'
if printf '%s' "$FEED_RESULT" | LC_ALL=C grep -q 'evt-private-work'; then
  echo "Bounded feed leaked a project outside its allowlist" >&2
  exit 1
fi
if CARTOGRAPHER_DEV_DIR="$DEV" CARTOGRAPHER_QDRANT_URL="http://127.0.0.1:1" \
  bash "$PLUGIN/scripts/cartographer-feed.sh" \
  --since 2026-07-24 >/dev/null 2>&1; then
  echo "Bounded feed accepted an unscoped corpus search" >&2
  exit 1
fi

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
