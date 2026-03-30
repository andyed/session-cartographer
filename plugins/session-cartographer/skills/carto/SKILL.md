---
name: carto
description: Open the Session Cartographer Explorer web UI for visual browsing of session history.
argument-hint: "[query]"
allowed-tools:
  - Bash
---

# Carto

Launch the Explorer web app for the human to browse session history visually.

## Usage

```bash
cd "${CLAUDE_PLUGIN_ROOT}/../../explorer" && npm run dev &
sleep 3
open "http://127.0.0.1:2527/"
```

If the user provides a query, open with it pre-filled:
```bash
cd "${CLAUDE_PLUGIN_ROOT}/../../explorer" && npm run dev &
sleep 3
open "http://127.0.0.1:2527/?q=<query>"
```

The Explorer is a tool for the human, not the agent. Start it, open the browser, and tell the user it's ready.

## Examples

```
/carto
/carto shader
```
