---
name: carto
description: Search and explore Claude Code session history. Recall past decisions, research, fixes. Open the Explorer web UI for visual browsing.
argument-hint: "<query> or 'explore'"
allowed-tools:
  - Bash
  - Read
---

# Carto

Session Cartographer — search past session history or launch the Explorer UI.

## Commands

- `/carto <query>` — search for past work (same as the old `/remember`)
- `/carto explore` — start the Explorer web app and open it in the browser

## Search: `/carto <query>`

The user is trying to recover context — a decision, a fix, a paper, an approach.

### What's searchable

Hooks log events to a searchable index:
- **Research activity** — every URL fetched, every web search query
- **Session lifecycle** — compactions, session ends, agent completions
- **Code changes** — file edits, bash commands (when `CARTOGRAPHER_LOG_TOOL_USE=true`)
- **Raw transcripts** — full conversation text (slower fallback)

### Step 1: Run the search

Translate the user's intent to search terms. `/carto that shader fix` → search for "shader fix".

```bash
bash "${CLAUDE_PLUGIN_ROOT}/../../scripts/cartographer-search.sh" "<search terms>"
```

If the user mentioned a specific project, add `--project <name>`:
```bash
bash "${CLAUDE_PLUGIN_ROOT}/../../scripts/cartographer-search.sh" "<terms>" --project scrutinizer
```

For more results, add `--limit 25`.

Do NOT freestyle grep or jq commands. Always use this script.

### Step 2: Present results

Show results as-is from the script output. They're already formatted with timestamps, projects, and deep links. Keep it scannable.

### Step 3: Read the transcript when needed

Search results are summaries. When you need full context, **read the transcript file directly**:

```bash
jq 'select(.uuid == "<uuid>" or .parentUuid == "<uuid>")' <transcript_path>
```

Or read a broader window:
```bash
jq -c 'select(.type == "user" or .type == "assistant") | select(.message.content | type == "string") | {type, timestamp, content: .message.content[:500]}' <transcript_path> | grep -A5 -B5 "<keyword>"
```

**The search result is the map. The transcript is the territory.** Use both.

## Explore: `/carto explore`

Start the Explorer web app for the human to browse visually.

```bash
cd "${CLAUDE_PLUGIN_ROOT}/../../explorer" && npm run dev &
sleep 3
open "http://127.0.0.1:2527/"
```

If the user provides a query, open with it pre-filled:
```bash
open "http://127.0.0.1:2527/?q=<query>"
```

The Explorer is a tool for the human, not the agent. Start it, open the browser, and tell the user it's ready.

## Examples

```
/carto that paper about foveated rendering
/carto what we decided about the shader approach
/carto the commit that fixed blur
/carto explore
/carto explore shader
```
