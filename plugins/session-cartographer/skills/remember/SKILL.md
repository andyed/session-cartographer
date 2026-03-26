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

## Step 3: Drill deeper (only if asked)

If the user wants more detail on a specific result, use Read to open the transcript file at the relevant section:
```bash
jq 'select(.uuid == "<uuid>" or .parentUuid == "<uuid>")' <transcript_path>
```

## Example queries

```
/remember TTM pooling regions
/remember that paper about foveated rendering
/remember what we decided about the shader approach
/remember the commit that fixed blur
```
