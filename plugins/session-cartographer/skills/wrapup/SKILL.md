---
name: wrapup
description: Strategic session-end preservation. Captures decisions, discoveries, and state that the automatic hooks miss.
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
---

# Wrapup

Deliberate end-of-session preservation. The hooks capture mechanical facts (files changed, commits made, session ended). This skill captures **strategic context** — the decisions, discoveries, and unfinished threads that make the next session productive.

## What to capture

Synthesize the session into a milestone entry with:

1. **What was accomplished** — commits, features, fixes (count them from the conversation)
2. **Key decisions or discoveries** — the non-obvious things that would be expensive to re-derive
3. **What's unfinished** — threads left open, next steps
4. **The hard problem** — what was actually difficult, not just what was done

## Step 1: Write the milestone

Generate a one-paragraph synthesis of the session. Be specific — name the files, the commits, the discoveries. No filler.

Then log it:

```bash
DEV="${CARTOGRAPHER_DEV_DIR:-$HOME/Documents/dev}"
SESSION_ID="$CLAUDE_SESSION_ID"
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
EVENT_ID="evt-$(LC_ALL=C tr -dc 'a-z0-9' < /dev/urandom | head -c 12)"

# Detect project from cwd
GIT_REPO=$(git rev-parse --show-toplevel 2>/dev/null)
PROJECT=$(basename "${GIT_REPO:-$(pwd)}")
GIT_BRANCH=$(git branch --show-current 2>/dev/null || echo "none")

# Find transcript path
TRANSCRIPT=$(find ~/.claude/projects -name "${SESSION_ID}.jsonl" 2>/dev/null | head -1)
ENCODED_PATH=$(echo "$TRANSCRIPT" | python3 -c "import sys, urllib.parse; print(urllib.parse.quote(sys.stdin.read().strip(), safe=''))" 2>/dev/null || echo "$TRANSCRIPT")

jq -n -c \
  --arg eid "$EVENT_ID" \
  --arg ts "$TIMESTAMP" \
  --arg milestone "session_wrapup" \
  --arg description "SESSION_SYNTHESIS_HERE" \
  --arg session "$SESSION_ID" \
  --arg transcript "$TRANSCRIPT" \
  --arg deeplink "claude-history://session/${ENCODED_PATH}" \
  --arg project "$PROJECT" \
  --arg cwd "$(pwd)" \
  --arg event "Wrapup" \
  --arg branch "$GIT_BRANCH" \
  '{event_id: $eid, timestamp: $ts, milestone: $milestone, description: $description, session_id: $session, transcript_path: $transcript, deeplink: $deeplink, project: $project, cwd: $cwd, event: $event, git_branch: $branch}' \
  >> "$DEV/session-milestones.jsonl"
```

Replace `SESSION_SYNTHESIS_HERE` with your synthesis paragraph.

## Step 2: Index it

```bash
tail -1 "$DEV/session-milestones.jsonl" | bash ~/Documents/dev/session-cartographer/scripts/index-event.sh
```

## Step 3: Update memory if warranted

If the session produced a non-obvious discovery, preference, or decision that future sessions need — save it to memory. Most sessions don't warrant a new memory. Don't force it.

## What NOT to do

- Don't summarize every tool call or file read
- Don't write a changelog (the hooks handle that)
- Don't create memory entries for things derivable from git log
- Don't be verbose — one paragraph, specific, done

## Examples

Good synthesis:
> "Trimmed root CLAUDE.md from 20KB to 4KB by moving project map, testing, and library details to per-project CLAUDE.md files. Created CLAUDE.md for scrutinizer2025, iblipper2025, interests2025. Pruned 4 stale memories. Key insight: /focus and /remember make the project map redundant in root context — saves ~4000 tokens per turn."

Bad synthesis:
> "Worked on various improvements to the codebase. Made things more efficient. Updated some files."
