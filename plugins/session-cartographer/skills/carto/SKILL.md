---
name: carto
description: Open the Session Cartographer Explorer web UI for visual browsing of session history.
allowed-tools:
  - Bash
---

# Carto

Launch the Explorer web app for the human to browse session history visually.

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

## Examples

```
/carto
/carto shader
```
