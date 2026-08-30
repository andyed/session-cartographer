---
name: remember
description: Recall past work across Claude Code and Codex sessions. Finds decisions, research, fixes, and conversations by intent.
allowed-tools:
  - Bash
  - Read
---

# Remember

Recall past work from the shared Claude Code and Codex session history. The
consumer and producer do not need to match: Claude can recover Codex work and
Codex can recover Claude work. The user is trying to recover context — a
decision, a fix, a paper, an approach — not run a database query.

## Resolve the runtime once

Before running commands, resolve `ROOT` to the Session Cartographer plugin
root. Prefer `CARTOGRAPHER_ROOT`, then `CLAUDE_PLUGIN_ROOT` or `PLUGIN_ROOT`.
If none is set, derive it from this skill's reported base directory (`../..`
from `skills/remember`). Use the conventional checkout only as a legacy
fallback. Verify that `$ROOT/scripts/cartographer-search.sh` exists.

### Backend selection is shared, not provider-specific

`cartographer-search.sh` reads one user-level Cartographer preference for both
Claude Code and Codex. When Turbo Mode is globally enabled, run the ordinary
commands below unchanged; the wrapper selects the warm backend, starts the
headless service on demand, and falls back to the portable CLI if necessary.
Do not add `--turbo` to every call. `--no-turbo` is the one-call diagnostic
escape hatch. Exact fetch, touch, thread traversal, intent-only search, and raw
transcript search remain portable control operations.

## What can be remembered

Hooks determine what's in the searchable index:
- **Research activity** — every URL fetched, every web search query
- **Session lifecycle** — compactions (with git state snapshot), session ends, agent completions
- **Code changes** — file edits, bash commands, git commits with type classification (when `CARTOGRAPHER_LOG_TOOL_USE=true`)
- **Semantic index** — turn-grouped embeddings of every transcript (Qdrant) for intent-match recall
- **Raw transcripts** — opt-in via `--transcript`. Expensive (per-query awk over 100MB+ files); use only when the event logs + semantic index both miss

### The profile: start at the top of the pyramid

`~/Documents/dev/.carto/profile.md` (override with `CARTOGRAPHER_DEV_DIR`) is a
length-budgeted standing summary derived from the whole corpus: active
projects, standing preferences, durable decisions, work shape, cadence. Read it
when the question is about the person or the shape of their work rather than a
specific past moment — "what am I working on", "what did I decide about X in
general", "what's my usual release process" — and when you need orientation
before a vague search.

It is derived, never hand-written. Rebuild it when it looks stale (the file
states its own generation date and corpus end):

```bash
node "$ROOT/scripts/build-profile.js"
```

Do not read it reflexively on every recall. A profile read costs ~3k characters
and answers standing questions; a specific "when did we fix the blur bug"
question should go straight to search.

### Exact fetch: `--get`

Search output is lossy on purpose — summaries are single-line and truncated for
display. `--get` returns the complete records for ids the search surfaced,
including `transcript_path`, `files_changed`, and `diff_shape`:

```bash
CARTOGRAPHER_PURPOSE=remember bash "$ROOT/scripts/cartographer-search.sh" _ --get <event_id>[,<event_id>...]
```

Cheap (~0.1s) and the right move before deciding which transcript is worth
opening. Ids that resolve to nothing are reported as missing rather than
dropped — if you asked for five and got four, say so instead of answering
around the gap.

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

### Threading: trace a work-arc with `--thread`

Hooks link successive events from the same session into a `parent_event_id` chain (the prior event must be in the same session and within 60s). Over time this turns the JSONL from a flat log into a graph you can traverse.

When the user asks "show me how I got to X", "what led up to that commit", or "what was the chain of work around Y", run a normal search to find the anchor `event_id`, then walk the arc:

```bash
CARTOGRAPHER_PURPOSE=remember bash "$ROOT/scripts/cartographer-search.sh" _ --thread evt-xxxxxxxxxxxx
```

The first argument is ignored when `--thread` is set (pass any placeholder like `_`). Output is the full ancestor + descendant arc sorted by timestamp, with the supplied event marked `★`. Present it as a coherent timeline rather than a search result.

### Procedural recall: "how do I do X" (maneuver map)

Procedural questions — "how do I deploy X", "what's my release process", "the cloudflare config dance" — aren't similarity matches, they're *maneuvers*. The co-occurrence graph (`scripts/cooccurrence-graph.js`) detects recurring technical maneuvers and which projects run them. Two entry points, both alias/partial-tolerant:

```bash
# Query names a project → which maneuvers it runs + which projects share them
node "$ROOT/scripts/cooccurrence-graph.js" --maneuvers <project>

# Query names the procedure → which projects run it (e.g. cloudflare, release, merge, overleaf)
node "$ROOT/scripts/cooccurrence-graph.js" --signal <maneuver>
```

The map is an *index*, not a command store — it deliberately holds no commands and no secrets. Recovering the actual invocation is the same "map → territory" move as reading a transcript in Step 3 (so it's exempt from the no-freestyle rule below): grep the changelog for the matching project + maneuver marker.

```bash
jq -r 'select(.project=="<project>" and (.summary|test("wrangler pages deploy|gh release create|netlify"))) | .summary' ~/Documents/dev/changelog.jsonl | sed 's/^Ran: //' | tail -3
```

Present the recovered command(s) with project + recency. They're the user's own past invocations — don't echo any embedded tokens / account IDs gratuitously.

### Cross-thread broadening (related projects)

When a recall centers on one project but the work spans a thread, surface the co-active siblings so you can widen the search. The graph knows, e.g., `approach-retreat` co-threads with `allserp-paper` / `ettac-paper`:

```bash
node "$ROOT/scripts/cooccurrence-graph.js" --related <project>
```

Use it when results cluster on one project and the question is open-ended ("what was I doing around the AOI work") — offer to pull the related threads into the search.

### Salience weighting (automatic)

Hooks emit a `salience` score per event ([0..1]). `/wrapup` milestones (0.9), feature/fix commits (0.7), and research-paper fetches (0.7) outrank routine bash commands (0.2) and chore commits (0.4). Salience multiplies into the RRF score, so deliberate strategic moments naturally rise to the top of results without any extra flag.

### Promote-on-reuse (you participate in this)

Write-time salience is a static prior; the access ledger makes it a learned posterior. When you actually *use* a result — read its transcript in Step 3 — record the access with `--touch`. Reuse refreshes the event's recency and compounds a frequency boost (capped at 2×), so events that keep proving useful rise across future sessions. Results that have been reused before show a `(used xN)` tag — that is why they may rank above fresher events. Serving alone records nothing: searching is free, using is vouching.

### Delta serving (automatic in-session)

When you call `/remember` repeatedly in the same session, the script automatically suppresses event_ids that were returned in earlier calls — so each subsequent call surfaces *fresh* material rather than re-returning the same top-K. Activated whenever the session resolves from `CARTOGRAPHER_SESSION_ID`, `CLAUDE_CODE_SESSION_ID` (what Claude Code actually exports), the legacy `CLAUDE_SESSION_ID`, or `CODEX_SESSION_ID`.

If you actually need to re-cite an event from a prior call (the user is asking about something you already showed them), pass `--all` to bypass suppression for that single call:

```bash
CARTOGRAPHER_PURPOSE=remember bash "$ROOT/scripts/cartographer-search.sh" "<terms>" --all
```

To wipe the per-session served list entirely (rare; only when starting a genuinely fresh investigation): pass `--reset-served`.

## IMPORTANT: Use the search script

Do NOT freestyle grep or jq commands. Always use the unified search script.

## Step 1: Run the search

Think about what the user is trying to recall, then translate to search terms.

```bash
CARTOGRAPHER_PURPOSE=remember bash "$ROOT/scripts/cartographer-search.sh" "<search terms>"
```

If the user mentioned a specific project, add `--project <name>`:
```bash
CARTOGRAPHER_PURPOSE=remember bash "$ROOT/scripts/cartographer-search.sh" "<terms>" --project scrutinizer
```

For more results, add `--limit 25` or `--limit 50`. If the user says "more" or "keep going" after seeing results, re-run with a higher limit:
```bash
CARTOGRAPHER_PURPOSE=remember bash "$ROOT/scripts/cartographer-search.sh" "<same terms>" --limit 30
```

Wildcard prefix search works: `shader*` matches `shader`, `shaders`, `shaderlab`, etc.

If event logs + semantic come up empty and you genuinely need raw transcript keyword matching, opt in with `--transcript`. Expect it to be slow; some sessions are 100MB+.

## Step 2: Present results

Show results as-is from the script output. Keep it scannable.

## Step 2.5: Fetch the full record before opening a transcript

When a result looks right but the truncated summary doesn't settle it, fetch the
complete record first. It costs ~0.1s against a 100MB+ transcript read, and it
carries the `transcript_path` you need for Step 3 anyway.

```bash
CARTOGRAPHER_PURPOSE=remember bash "$ROOT/scripts/cartographer-search.sh" _ --get <event_id>,<event_id>
```

Often this ends the recall — a commit's full `files_changed` and `diff_shape`
answer "what did that change touch" without any transcript at all.

## Step 3: Read the transcript when needed

Search results are summaries. When you need full context, **read the transcript file directly** — don't wait for the user to ask.

Find the transcript path — it's in the search result as `transcript:`. Prefer
that path because it is provider-neutral. If missing, resolve from `session:`
across both provider stores:
```bash
find ~/.claude/projects -name "<session-id>.jsonl" 2>/dev/null
find ~/.codex/sessions -name "*<session-id>*.jsonl" 2>/dev/null
```

For a Claude transcript, read around the relevant moment:
```bash
jq -c 'select(.type == "user" or .type == "assistant") | select(.message.content | type == "string") | {type, timestamp, content: .message.content[:500]}' <transcript_path> | grep -A5 -B5 "<keyword>"
```

For a Codex transcript, retained user and assistant messages are currently in
`event_msg` and `response_item` records:

```bash
jq -c 'select((.type == "event_msg" and .payload.type == "user_message") or (.type == "response_item" and .payload.type == "message")) | {type, timestamp, payload}' <transcript_path> | grep -A5 -B5 "<keyword>"
```

Or jump to a specific message by UUID:
```bash
jq 'select(.uuid == "<uuid>" or .parentUuid == "<uuid>")' <transcript_path>
```

**The search result is the map. The transcript is the territory.**

### After using a result: record the reuse

When a result summary, transcript, or `--thread` arc actually contributes to the answer, touch the event_ids whose context you used — this is both the promote-on-reuse moment and the explicit result-use signal:

```bash
CARTOGRAPHER_PURPOSE=remember bash "$ROOT/scripts/cartographer-search.sh" _ --touch <event_id>[,<event_id>...]
```

Touch only what you used, not everything that was served. A result you read and discarded as irrelevant should NOT be touched — false vouching pollutes future rankings.
When touching more than one result, list the IDs in the order you accessed them.
The access ledger records that order for first- and last-access MRR.

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
/remember show me how I got to that fix
    → bash cartographer-search.sh "the fix" --limit 5     (find anchor event_id)
    → bash cartographer-search.sh _ --thread evt-xxxxxxxxxxxx
/remember what exactly did that commit touch
    → bash cartographer-search.sh _ --get git-abc1234      (full files_changed + diff_shape)
/remember what am I working on these days
    → read ~/Documents/dev/.carto/profile.md               (standing question, not a search)
/remember how do I deploy movies-mindbendingpixels
    → node cooccurrence-graph.js --maneuvers movies-mindbendingpixels   (→ cloudflare-pages)
    → recover the invocation from the changelog, present it
/remember my cloudflare deploy process
    → node cooccurrence-graph.js --signal cloudflare
/remember what else was I working on around the approach-retreat AOI work
    → node cooccurrence-graph.js --related approach-retreat   (→ allserp-paper, ettac-paper…)
```
