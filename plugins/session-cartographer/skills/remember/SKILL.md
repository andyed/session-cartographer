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
- **Session lifecycle** — compactions (with git state snapshot), session ends, agent completions
- **Code changes** — file edits, bash commands, git commits with type classification (when `CARTOGRAPHER_LOG_TOOL_USE=true`)
- **Semantic index** — turn-grouped embeddings of every transcript (Qdrant) for intent-match recall
- **Raw transcripts** — opt-in via `--transcript`. Expensive (per-query awk over 100MB+ files); use only when the event logs + semantic index both miss

### Search facets

Results include faceted summaries (project, source, event type, time range). Use these to narrow searches:

- **`--project <name>`** — filter to a specific project
- **`--since WHEN` / `--before WHEN`** — temporal filter. WHEN accepts natural-language phrases (`today`, `yesterday`, `"this morning"`, `"this afternoon"`, `"this evening"`, `tonight`, `"this week"`, `"last week"`, `"this month"`, `"last month"`), relative durations (`7d`, `2h`, `30m`, `1w`, `3mo`), or absolute dates (`2026-04-20`). When the user mentions time — "what did I work on Wednesday", "this morning's debugging session", "last week's audio fixes" — translate to the matching `--since` flag rather than searching unbounded.
- **Commit types** — git commits are classified as `feature`, `fix`, `refactor`, `enhancement`, `docs`, `test`, `chore`, `perf`, `ci`, `style`, `revert`, or `other`. These appear in summaries as `[feature] Commit abc1234: ...` and are searchable as keywords.
- **Event types** in results: `git_commit`, `research_fetch`, `research_search`, `milestone_session_end_*`, `milestone_compaction_*`, `tool_file_edit`, `tool_bash`
- **Session end events** now include git branch, dirty file count, and session event count — useful for finding "what was I working on last time"

### Temporal phrase mapping (use these, don't unbounded-search)

| User says | Use |
|-----------|-----|
| "today", "earlier today", "this morning's work" | `--since today` |
| "yesterday", "last night" | `--since yesterday` |
| "this afternoon" | `--since "this afternoon"` |
| "this week", "the past few days" | `--since "this week"` |
| "last week" | `--since "last week"` |
| "this month" | `--since "this month"` |
| "last month" | `--since "last month"` |
| "the last hour" | `--since 1h` |
| "the last few hours" | `--since 4h` |
| specific date like "April 20th" | `--since 2026-04-20` |
| "between A and B" | `--since A --before B` |

Beyond ~30 days, transcript files are deleted by Claude Codes default TTL — event-log results still surface but the "read the transcript" step (Step 3 below) will hit a missing file. When that happens, present the event metadata as the answer and note that full context isn't available.

### Delta serving (automatic in-session)

When you call `/remember` repeatedly in the same session, the script automatically suppresses event_ids that were returned in earlier calls — so each subsequent call surfaces *fresh* material rather than re-returning the same top-K. Activated whenever `$CLAUDE_SESSION_ID` is set (which it always is in skill context).

If you actually need to re-cite an event from a prior call (the user is asking about something you already showed them), pass `--all` to bypass suppression for that single call:

```bash
bash ~/Documents/dev/session-cartographer/scripts/cartographer-search.sh "<terms>" --all
```

To wipe the per-session served list entirely (rare; only when starting a genuinely fresh investigation): pass `--reset-served`.

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

For more results, add `--limit 25` or `--limit 50`. If the user says "more" or "keep going" after seeing results, re-run with a higher limit:
```bash
bash ~/Documents/dev/session-cartographer/scripts/cartographer-search.sh "<same terms>" --limit 30
```

Wildcard prefix search works: `shader*` matches `shader`, `shaders`, `shaderlab`, etc.

If event logs + semantic come up empty and you genuinely need raw transcript keyword matching, opt in with `--transcript`. Expect it to be slow; some sessions are 100MB+.

## Step 2: Present results

Show results as-is from the script output. Keep it scannable.

## Step 3: Read the transcript when needed

Search results are summaries. When you need full context, **read the transcript file directly** — don't wait for the user to ask.

Find the transcript path — it's in the search result as `transcript:`. If missing, resolve from `session:`:
```bash
find ~/.claude/projects -name "<session-id>.jsonl" 2>/dev/null
```

Then read around the relevant moment:
```bash
jq -c 'select(.type == "user" or .type == "assistant") | select(.message.content | type == "string") | {type, timestamp, content: .message.content[:500]}' <transcript_path> | grep -A5 -B5 "<keyword>"
```

Or jump to a specific message by UUID:
```bash
jq 'select(.uuid == "<uuid>" or .parentUuid == "<uuid>")' <transcript_path>
```

**The search result is the map. The transcript is the territory.**

## Examples

```
/remember that paper about foveated rendering
/remember what we decided about the shader approach
/remember the commit that fixed blur
/remember Blauch collaboration notes
/remember recent feature commits --project scrutinizer
/remember what was I working on last session
/remember what did I do this morning on Psychodeli
    → bash cartographer-search.sh "Psychodeli" --since today
/remember the audio reactivity work from last week
    → bash cartographer-search.sh "audio reactivity" --since "last week"
/remember Wednesday's debugging session
    → bash cartographer-search.sh "debug" --since "last week" --before yesterday
```
