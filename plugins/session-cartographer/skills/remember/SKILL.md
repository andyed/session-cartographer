---
name: remember
description: Search conversation history across all Claude Code sessions. Finds past discussions, decisions, research URLs, and milestones by keyword. Returns deep links to the original conversation context.
argument-hint: "<what to find>"
allowed-tools:
  - Bash
  - Read
  - Grep
---

# Remember

Search across all Claude Code session history to find past conversations, decisions, research, and milestones.

## How it works

The user describes what they're looking for in natural language. You search multiple sources:

1. **Changelog** (`~/Documents/dev/changelog.jsonl`) — unified event index with `event_id`, every milestone/research/bridge event
2. **Milestones** (`~/Documents/dev/session-milestones.jsonl`) — session lifecycle events with `claude-history://` deep links
3. **Research log** (`~/Documents/dev/research-log.jsonl`) — every WebFetch/WebSearch URL with category and project
4. **Transcripts** (`~/.claude/projects/*/*.jsonl`) — actual conversation content (user prompts and assistant responses)

## Steps

1. **Parse the user's query** into search terms. Extract:
   - Keywords (e.g., "TTM", "foveation", "shader")
   - Project name if mentioned (e.g., "scrutinizer", "psychodeli")
   - Time range if mentioned (e.g., "last week", "yesterday")

2. **Try semantic search first** (if Qdrant + embedding server are running):
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/../../scripts/semantic-search.js" "<natural language query>" --limit 15
   ```
   If a project was mentioned, add `--project <name>`.
   If this fails (services not running), fall back to step 3.

3. **Fall back to keyword search:**
   ```bash
   bash "${CLAUDE_PLUGIN_ROOT}/scripts/remember-search.sh" "<keywords>" --max-results 15
   ```
   If a project was mentioned, add `--project <name>`.

4. **For deeper results**, search transcripts directly with Grep:
   ```bash
   # Search all transcripts for keyword
   grep -r -i "<keyword>" ~/.claude/projects/ --include="*.jsonl" -l
   ```
   Then read matching transcripts to extract relevant conversation context:
   ```bash
   # Extract matching messages with context
   jq 'select(.type == "user" or .type == "assistant") | select(.message.content | type == "string") | select(.message.content | test("<keyword>"; "i")) | {timestamp, type, uuid, content: .message.content[:200]}' <transcript_path>
   ```

5. **Present results** organized by relevance:
   - Lead with the most relevant hits (exact keyword matches in conversation)
   - Include the `deeplink` URL if available (for history viewer navigation)
   - Include the `transcript_path` and `uuid` for direct reference
   - Quote the relevant excerpt from the conversation
   - Note the project and date for context

6. **If the user wants more detail** on a specific result, read the full transcript at that point:
   ```bash
   # Read messages around a specific UUID
   jq 'select(.uuid == "<uuid>" or .parentUuid == "<uuid>")' <transcript_path>
   ```

## Example queries

- `/remember TTM pooling regions` — find discussions about Texture Tiling Model
- `/remember that paper about foveated rendering` — find research URLs
- `/remember what we decided about the shader approach` — find decision points

## Output format

For each result, show:
```
[2026-03-22 14:30] scrutinizer session
  "We discussed TTM pooling regions — Rosenholtz defines them as..."
  deeplink: claude-history://session/...
  transcript: ~/.claude/projects/.../abc123.jsonl
```

Keep it scannable. The user wants to jog their memory, not read a report.
