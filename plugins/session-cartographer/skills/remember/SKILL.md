---
name: remember
description: Recall past work across all Claude Code sessions. Finds decisions, research, fixes, and conversations by intent.
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
- **Code changes** — file edits, bash commands, git commits (when `CARTOGRAPHER_LOG_TOOL_USE=true`)
- **Raw transcripts** — full conversation text (slower, searched as fallback)

## IMPORTANT: Use the search script

Do NOT freestyle grep or jq commands. Always use the unified search script.

## Step 1: Run the search

Think about what the user is trying to recall, then translate to search terms.

```bash
bash ~/Documents/dev/session-cartographer/scripts/cartographer-search.sh "<search terms>"
```

If the user mentioned a specific project, add `--project <name>`:
```bash
bash ~/Documents/dev/session-cartographer/scripts/cartographer-search.sh "<terms>" --project scrutinizer
```

For more results, add `--limit 25`.

## Step 2: Present results

Show results as-is from the script output. Keep it scannable.

## Step 3: Read the transcript when needed

Search results are summaries. When you need full context, **read the transcript file directly** — don't wait for the user to ask.

```bash
jq 'select(.uuid == "<uuid>" or .parentUuid == "<uuid>")' <transcript_path>
```

Or read a broader window:
```bash
jq -c 'select(.type == "user" or .type == "assistant") | select(.message.content | type == "string") | {type, timestamp, content: .message.content[:500]}' <transcript_path> | grep -A5 -B5 "<keyword>"
```

**The search result is the map. The transcript is the territory.**

## Examples

```
/remember that paper about foveated rendering
/remember what we decided about the shader approach
/remember the commit that fixed blur
/remember Blauch collaboration notes
```
