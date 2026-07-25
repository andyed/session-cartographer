#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
VERSION=${1:-$(node -p "require('$ROOT/package.json').version")}
VERSION=${VERSION#v}

case "$VERSION" in
  ''|*[!0-9A-Za-z.+-]*)
    echo "Invalid release version: $VERSION" >&2
    exit 2
    ;;
esac

MANIFEST_VERSION=$(node -p "require('$ROOT/plugins/session-cartographer/.codex-plugin/plugin.json').version")
CLAUDE_VERSION=$(node -p "require('$ROOT/plugins/session-cartographer/.claude-plugin/plugin.json').version")
MARKETPLACE_VERSION=$(node -p "require('$ROOT/.claude-plugin/marketplace.json').plugins.find(p => p.name === 'session-cartographer').version")

for declared in "$MANIFEST_VERSION" "$CLAUDE_VERSION" "$MARKETPLACE_VERSION"; do
  if [ "$declared" != "$VERSION" ]; then
    echo "Version mismatch: requested $VERSION but a manifest declares $declared" >&2
    exit 2
  fi
done

OUT="$ROOT/dist/release"
WORK=$(mktemp -d "${TMPDIR:-/tmp}/session-cartographer-release.XXXXXX")
trap 'rm -rf "$WORK"' EXIT

BASENAME="session-cartographer-$VERSION"
BUNDLE="$WORK/$BASENAME"
PLUGIN="$BUNDLE/plugins/session-cartographer"
mkdir -p "$PLUGIN" "$OUT"

# The archive is a local marketplace. Both Claude Code and Codex can register
# its root, then install the same self-contained plugin snapshot.
mkdir -p "$BUNDLE/.claude-plugin"
cp "$ROOT/.claude-plugin/marketplace.json" "$BUNDLE/.claude-plugin/marketplace.json"

mkdir -p "$PLUGIN/.claude-plugin" "$PLUGIN/.codex-plugin" "$PLUGIN/skills"
cp "$ROOT/plugins/session-cartographer/.claude-plugin/plugin.json" "$PLUGIN/.claude-plugin/plugin.json"
cp "$ROOT/plugins/session-cartographer/.codex-plugin/plugin.json" "$PLUGIN/.codex-plugin/plugin.json"
cp -R "$ROOT/plugins/session-cartographer/hooks" "$PLUGIN/hooks"
for skill_file in "$ROOT"/plugins/session-cartographer/skills/*/SKILL.md; do
  skill=$(basename "$(dirname "$skill_file")")
  mkdir -p "$PLUGIN/skills/$skill"
  cp "$skill_file" "$PLUGIN/skills/$skill/SKILL.md"
done
bash "$ROOT/scripts/copy-plugin-runtime.sh" "$PLUGIN"
cp "$ROOT/docs/RELEASE_INSTALL.md" "$BUNDLE/README.md"

find "$BUNDLE" \( -name '.DS_Store' -o -name 'CLAUDE.md' \) -delete

ARCHIVE="$OUT/$BASENAME.tar.gz"
CHECKSUM="$ARCHIVE.sha256"
tar -C "$WORK" -czf "$ARCHIVE" "$BASENAME"
(
  cd "$OUT"
  shasum -a 256 "$(basename "$ARCHIVE")" > "$(basename "$CHECKSUM")"
)

printf '%s\n' "$ARCHIVE" "$CHECKSUM"
