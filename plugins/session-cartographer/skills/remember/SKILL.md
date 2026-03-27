---
name: remember
description: Search conversation history across all Claude Code sessions. Finds past discussions, decisions, research URLs, and milestones by keyword or semantic similarity.
argument-hint: "<what to find>"
allowed-tools:
  - Bash
  - Read
---

# Remember

Search across all Claude Code session history.

## IMPORTANT: Use the search script

Do NOT freestyle grep or jq commands. Always use the unified search script which handles semantic search, keyword search, and transcript search automatically.

## Step 1: Run the search

```bash
bash ~/Documents/dev/session-cartographer/scripts/cartographer-search.sh "<user's query>"
```

If the user mentioned a specific project, add `--project <name>`:
```bash
bash ~/Documents/dev/session-cartographer/scripts/cartographer-search.sh "<query>" --project scrutinizer
```

For more results, add `--limit 25`.

The script automatically:
- Tries semantic search via Qdrant (if running)
- Falls back to keyword search across all JSONL event logs
- Searches session transcripts
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

## Typical workflow

1. `/remember shader fix` → finds 3 results with timestamps and transcript paths
2. Read the top result's transcript → recover the full reasoning and code
3. Continue working with that context, or hand the transcript path to a new session
