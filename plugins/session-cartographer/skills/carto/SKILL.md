---
name: carto
description: Open the Session Cartographer Explorer web UI for visual browsing of Claude Code and Codex session history.
allowed-tools:
  - Bash
---

# Carto

Launch the Explorer web app for the human to browse session history visually.

The Explorer reads the same shared corpus as `/remember`, so it shows **both
Claude Code and Codex** sessions — roughly half this corpus is Codex. Sessions,
search results and timeline cards carry an agent badge, and the facet bar has an
agent dimension (`?fa=codex` in the URL) for narrowing to one producer. This
skill runs from either agent; nothing about it is Claude-specific.

Resolve `ROOT` from `CARTOGRAPHER_ROOT`, `CLAUDE_PLUGIN_ROOT`, or
`PLUGIN_ROOT`. If none is set, derive the plugin root from this skill's
reported base directory (`../..` from `skills/carto`); use the conventional
checkout only as a legacy fallback.

## Usage

```bash
ROOT="${CARTOGRAPHER_ROOT:-${CLAUDE_PLUGIN_ROOT:-${PLUGIN_ROOT:-$HOME/Documents/dev/session-cartographer}}}"
cd "$ROOT/explorer" && npm run dev &
sleep 3
open "http://127.0.0.1:2527/"
```

If the user provides a query, open with it pre-filled:
```bash
ROOT="${CARTOGRAPHER_ROOT:-${CLAUDE_PLUGIN_ROOT:-${PLUGIN_ROOT:-$HOME/Documents/dev/session-cartographer}}}"
cd "$ROOT/explorer" && npm run dev &
sleep 3
open "http://127.0.0.1:2527/?q=<query>"
```

The Explorer is a tool for the human, not the agent. Start it, open the browser, and tell the user it's ready.

`open` is macOS. On Linux use `xdg-open`, or just print the URL and let the user
click it — never block on the browser launching.

Transcripts resolve across both providers. Codex *archives* a finished session
(`~/.codex/sessions/...` → `~/.codex/archived_sessions/`), so a recorded path
goes stale while the data is still on disk; the transcript endpoints run the
`scripts/resolve-transcript.sh` ladder before reporting anything missing. If the
UI still says a transcript is unavailable, that is a real absence, not an
archive move.

The UI host serves timeline, search, sessions, and transcripts directly. It does
not need a second API process or require stopping Turbo. Verify a normal Explorer
endpoint as well as the memory status before reporting that the whole app works.

For the working-memory visual or Turbo entry point, start only the UI host:

```bash
cd "$ROOT/explorer" && npm run memory &
sleep 3
open "http://127.0.0.1:2527/memory"
```

All tabs remain reachable while Turbo is off. The memory page's explicit start/enable
action uses the shared managed controller. A running backend with the memory
API opens directly; an owned older backend offers Refresh Turbo. Do not start
another Explorer API process on Turbo's occupied port for this view.

## Examples

```
/carto
/carto shader
```
