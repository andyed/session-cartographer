---
name: remember
description: Recall past work across all Claude Code sessions. Finds decisions, research, fixes, and conversations by intent — not just keyword matching.
argument-hint: "<what to recall>"
allowed-tools:
  - Bash
  - Read
---

# Remember

Recall past work from Claude Code session history. The user is trying to recover context — a decision, a fix, a paper, an approach — not run a database query.

## What can be remembered

Hooks determine what's in the searchable index:
- **Research activity** — every URL fetched, every web search query
- **Session lifecycle** — compactions, session ends, agent completions
- **Code changes** — file edits, bash commands (when `CARTOGRAPHER_LOG_TOOL_USE=true`)
- **Raw transcripts** — full conversation text (slower, searched as fallback)

If the user asks about something that wasn't captured by a hook, the transcript fallback may still find it — but it's slower and keyword-only.

## IMPORTANT: Use the search script

Do NOT freestyle grep or jq commands. Always use the unified search script.

## Step 1: Run the search

Think about what the user is trying to recall, then translate to search terms. `/remember that shader fix` → search for "shader fix". `/remember the paper about pooling regions` → search for "pooling regions".

```bash
bash ~/Documents/dev/session-cartographer/scripts/cartographer-search.sh "<search terms>"
```

If the user mentioned a specific project, add `--project <name>`:
```bash
bash ~/Documents/dev/session-cartographer/scripts/cartographer-search.sh "<terms>" --project scrutinizer
```

For more results, add `--limit 25`.

The script automatically:
- Tries semantic search via Qdrant (if running)
- Runs BM25 keyword search across all JSONL event logs
- Falls back to transcript search
- Handles missing files and cold starts gracefully

## Step 2: Present results

Show results as-is from the script output. They're already formatted with timestamps, projects, and deep links. Keep it scannable.

## Step 3: Read the full transcript when needed

Search results are summaries — event descriptions and short excerpts. When you need the full context (the actual conversation, the reasoning, the code that was written), **read the transcript file directly**. Don't wait for the user to ask — if recovering context is the goal, the transcript is where the real content lives.

Every search result with a `transcript:` path points to a session JSONL file. Read it:

```bash
# Read messages around a specific UUID (the search result's ID)
jq 'select(.uuid == "<uuid>" or .parentUuid == "<uuid>")' <transcript_path>
```

Or read a broader window to get the full conversation flow:
```bash
# Read the 20 messages around a timestamp
jq -c 'select(.type == "user" or .type == "assistant") | select(.message.content | type == "string") | {type, timestamp, content: .message.content[:500]}' <transcript_path> | grep -A5 -B5 "<keyword>"
```

**The search result is the map. The transcript is the territory.** Use both.

## Example queries

```
/remember TTM pooling regions
/remember that paper about foveated rendering
/remember what we decided about the shader approach
/remember the commit that fixed blur
```

## The remember → recall pipeline

```
/remember "that shader fix"          ← intent (what the user wants to recall)
        ↓
  search event index                 ← find the event (BM25 + Qdrant)
        ↓
  [2026-03-07] shader fix evt-abc    ← located (summary + transcript path)
        ↓
  Read transcript at that point      ← retrieve the full memory (declarative recall)
        ↓
  Full reasoning, code, decisions    ← context recovered
```

**Don't stop at the search result.** The search result tells you *when and where* something happened. The transcript tells you *what and why*. When the user says "remember," they want the full context — go get it from the transcript automatically.
