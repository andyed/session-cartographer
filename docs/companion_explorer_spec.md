# Session Cartographer: Companion Explorer — Product Spec

## Overview

Session Cartographer operates as a terminal-native tool via `/remember`. While fast for quick context recovery, the CLI restricts complex data visualization, interactive filtering, and reading dense multi-line code excerpts from transcripts.

This spec outlines the **Companion Web Explorer** — a local web app that serves as the rich visual lens for Cartographer data. See [EXPLORER_SPEC.md](EXPLORER_SPEC.md) for implementation architecture.

## Core UX: Remember vs. Explore

Two commands, two flow states during LLM collaboration.

### 1. `/remember <query>`
- **Purpose**: Fast, mid-flow context recovery without breaking terminal context.
- **Output**: Terminal-native text ranked via BM25 + Qdrant RRF pipeline.
- **Link**: Footer provides an actionable link into the Explorer:
  `Explore full context: http://localhost:2527/explore?q=<query>`

### 2. `/explore [query]`
- **Purpose**: Deep investigation while the LLM is thinking (parsing long outputs or generating large code).
- **Output**: Bypasses the terminal. Uses `open "http://localhost:2527/explore?q=[query]"` to launch the web app into a pre-filtered view.
- **Format**: Rich, interactive web UI with the same search results, rendered visually.

Both commands share the same search backend (BM25 keyword + optional Qdrant semantic, fused via RRF). `/remember` renders results as terminal text. `/explore` renders them in the browser.

## Architecture Summary

- **Backend**: Existing `session-cartographer` bash/awk scripts + Claude Code hooks. Continuously writes JSONL event logs. Manages Qdrant real-time embedding pipeline. Completely unaware of the frontend.
- **Frontend**: Vite + React SPA served alongside a lightweight Node/Express API proxy (:2526 API, :2527 UI).
- **Transport**: Server-Sent Events (SSE) for real-time event streaming. One-way data flow (backend → frontend), auto-reconnects, no library needed.
- **No on-the-fly HTML generation**: Having Claude dump HTML per-query is rejected — sluggish, context-bloating, and browser-security-hostile. The React app guarantees instant loads.

## Security (Local Environment)

The Explorer has raw access to proprietary session transcripts. Hardening:

1. **Localhost binding**: API and Vite servers strictly bind to `127.0.0.1` (never `0.0.0.0`). No LAN access.
2. **Path traversal protection**: Transcript endpoint verifies resolved path is a descendant of `CARTOGRAPHER_TRANSCRIPTS_DIR`. Rejects `../` traversal.
3. **XSS sanitization**: Transcript content through DOMPurify before rendering. Claude generates arbitrary code/markdown — treat as untrusted input.

## Configurable Viewer Links

Keeps Cartographer tool-agnostic. The deep-link prefix in `/remember` output is configurable:

```bash
# Use the Companion Explorer (default)
CARTOGRAPHER_VIEWER_PREFIX="http://localhost:2527/session/"

# Use claude-code-history-viewer instead
CARTOGRAPHER_VIEWER_PREFIX="claude-history://session/"
```

## Unlocked Features (1.x Roadmap)

This web architecture is the prerequisite for the visual roadmap:

1. **Interactive event filtering**: Toggle event streams (code edits, web research, milestones) via UI chips instead of CLI flags.
2. **Real-time session streaming**: Dashboard open on second monitor, updating live via SSE as Claude works.
3. **Rich transcript rendering**: Syntax-highlighted code blocks, markdown rendering. Depth will iterate — starting with event summaries, expanding to full transcript sections.
4. **Energy visualization**: Stacked area chart of events by project over time (port of `energy-viz.html`). "Where did my attention go" view.
5. **Session topology** (roadmap, not 1.0): Force-directed graph clustering related events, showing which sessions intersected and where cumulative focus was spent.

## Search Syntax & Autocomplete
To provide a fast, keyboard-centric filtering experience similar to GitHub, the Explorer search bar will support tokenized prefix queries and intelligent autocomplete.

### 1. GitHub-Style Query Syntax
Users can mix unstructured semantic/keyword terms with strict categorical filters.
- `repo:foo` or `project:foo`: Restricts results to a specific Git repository (e.g., `repo:psychodeli-plus-tvos`). Sent to the backend via the `--project` flag.
- `type:bar`: Filters by event type (e.g., `type:research_fetch`, `type:tool_bash`, `type:session_milestone`, `type:transcript`). Applied as a high-speed post-filter in the React frontend against the incoming TSV stream.
- `path:baz`: Filters results where the transcript path or URL matches the string.

**Example Query**:
`"focus management repo:psychodeli-plus-tvos type:research_fetch"`

### 2. Autocomplete Dictionary
The React frontend will power an autocomplete dropdown to discover available filters without leaving the keyboard.
- **Bootstrapping**: Upon connecting, the frontend will hit a lightweight `/api/facets` endpoint (or parse the initial historical `changelog.jsonl` dump) to build an in-memory dictionary of all unique `project` and `type` values.
- **Triggering**: Typing `repo:` or `type:` will instantly render a popover menu below the search bar.
- **Fuzzy Matching**: Continuing to type (e.g., `repo:psy...`) will fuzzy-filter the dropdown list. Arrow keys map to selection, and `Enter` completes the token.

### 3. Pipeline Integration
1. **Frontend Parser**: A regex tokenizer in React extracts `key:value` pairs from the input string.
2. **API Translation**: Stripped keywords are sent as the `q=` parameter. `repo:` constraints map to `project=` query params.
3. **Backend Execution**: Node Express translates `project=` to the `--project` flag for `cartographer-search.sh`.

## Ports

| Service | Port | Description |
|---------|------|-------------|
| Node API | 2526 | Express server, SSE stream, search proxy |
| React UI | 2527 | Vite dev / static build |
