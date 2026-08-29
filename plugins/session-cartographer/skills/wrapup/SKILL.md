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

When a runtime script is needed, resolve `ROOT` from `CARTOGRAPHER_ROOT`,
`CLAUDE_PLUGIN_ROOT`, or `PLUGIN_ROOT`. If none is set, derive the plugin root
from this skill's reported base directory (`../..` from `skills/wrapup`), with
the conventional checkout as a legacy fallback.

Deliberate end-of-session preservation. The hooks capture mechanical facts (files changed, commits made, session ended). This skill captures **strategic context** — the decisions, discoveries, and unfinished threads that make the next session productive.

Wrapup serves two audiences at once. The **log** gets a synthesis paragraph that `/remember` can recall months later. The **human** gets a digest panel they can verify at a glance — every line traces back to a logged event or to `git`, so a wrong claim is visible rather than merely plausible.

## Step 0: Render the digest — do this first

```bash
ROOT="${CARTOGRAPHER_ROOT:-${CLAUDE_PLUGIN_ROOT:-${PLUGIN_ROOT:-$HOME/Documents/dev/session-cartographer}}}"
node "$ROOT/scripts/session-digest.js"
```

The script resolves the session from `CARTOGRAPHER_SESSION_ID` / `CLAUDE_CODE_SESSION_ID`; pass `--session <id>` to override. It prints a panel covering span and tempo, commits with type and diff-shape mix, hottest files, research hosts, `/remember` served-vs-used, and the live dirty/unpushed state of every repo the session touched.

**Show the panel to the user verbatim.** Do not paraphrase it into prose or re-type its numbers into a bulleted list — the alignment is what makes it scannable, and re-typing is where the numbers drift.

Then read it before writing anything. This step exists so the synthesis is written *against the log* rather than from your own recollection of the conversation — recollection is exactly where confident, unfalsifiable summaries come from. If the digest disagrees with your memory of the session, the digest is right about what happened; your memory is only better on *why*.

If the digest exits non-zero (no events logged for this session), say so plainly and write the synthesis from the conversation, noting that it is unverified.

## What to capture

The digest already covers *what happened* mechanically — do not restate it. Your synthesis adds the layer no hook can infer:

1. **Key decisions or discoveries** — the non-obvious things that would be expensive to re-derive
2. **What's unfinished** — threads left open, next steps
3. **The hard problem** — what was actually difficult, not just what was done
4. **Why** — the reasoning behind the commits the digest lists

Items 1 and 2 are written **twice**: woven into the prose paragraph, and again as
structured `decisions[]` / `unresolved[]` arrays in Step 1. That is not
redundancy. The prose is what `/remember` searches; the arrays are what
`.carto/profile.md` harvests into "Durable decisions". Before 0.5.1 only the
prose existed, so 508 syntheses contributed nothing to the profile and the
section drew all five of its entries from a single project on a single day.

Do not skip the arrays as a shortcut — nothing downstream can recover them from
the paragraph. Measured across 508 descriptions, explicit decision markers
appear in about 4%, so no later parser can reconstruct what you did not record.

## Step 1: Write the milestone

Generate a one-paragraph synthesis of the session. Be specific — name the files, the commits, the discoveries. No filler.

Then log it:

```bash
DEV="${CARTOGRAPHER_DEV_DIR:-$HOME/Documents/dev}"
CLAUDE_SID="${CLAUDE_SESSION_ID:-${CLAUDE_CODE_SESSION_ID:-}}"
SESSION_ID="${CARTOGRAPHER_SESSION_ID:-${CLAUDE_SID:-${CODEX_SESSION_ID:-unknown}}}"
PROVIDER="${CARTOGRAPHER_PROVIDER:-unknown}"
[ "$PROVIDER" = "unknown" ] && [ -n "$CLAUDE_SID" ] && PROVIDER="claude"
# Fail loudly. A silent "unknown" is how 437 wrapups lost their transcripts.
[ "$SESSION_ID" = "unknown" ] && echo "warning: session id unresolved — this milestone will not link to a transcript" >&2
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
EVENT_ID="evt-$(LC_ALL=C tr -dc 'a-z0-9' < /dev/urandom | head -c 12)"

# Detect project from cwd
GIT_REPO=$(git rev-parse --show-toplevel 2>/dev/null)
PROJECT=$(basename "${GIT_REPO:-$(pwd)}")
GIT_BRANCH=$(git branch --show-current 2>/dev/null || echo "none")

# Find transcript path
TRANSCRIPT=$(find ~/.claude/projects -name "${SESSION_ID}.jsonl" 2>/dev/null | head -1)
if [ -z "$TRANSCRIPT" ] && [ "$SESSION_ID" != "unknown" ]; then
  TRANSCRIPT=$(find ~/.codex/sessions -name "*${SESSION_ID}*.jsonl" 2>/dev/null | head -1)
  [ -n "$TRANSCRIPT" ] && PROVIDER="codex"
fi
ENCODED_PATH=$(echo "$TRANSCRIPT" | python3 -c "import sys, urllib.parse; print(urllib.parse.quote(sys.stdin.read().strip(), safe=''))" 2>/dev/null || echo "$TRANSCRIPT")
DEEPLINK=""
[ "$PROVIDER" = "claude" ] && DEEPLINK="claude-history://session/${ENCODED_PATH}"

# Attach the digest's scalars so the milestone stays checkable after the
# transcript hits Claude Code's ~30d TTL. Falls back to null if the digest
# could not run — never block the wrapup on it.
ROOT="${CARTOGRAPHER_ROOT:-${CLAUDE_PLUGIN_ROOT:-${PLUGIN_ROOT:-$HOME/Documents/dev/session-cartographer}}}"
DIGEST=$(node "$ROOT/scripts/session-digest.js" --json --no-git 2>/dev/null \
  | jq -c '{duration_minutes, event_count, projects, commit_types, commit_shapes, files_touched: (.files | length), recall}' 2>/dev/null)
[ -z "$DIGEST" ] && DIGEST=null

# Structured outcomes for the profile. One item per argument — jq -R turns each
# line into a JSON string and -s slurps them into an array, so commas, quotes,
# and apostrophes in your text are safe. Replace the placeholder lines; keep the
# select() so an empty list stays [] rather than [""].
DECISIONS=$(printf '%s\n' \
  "DECISION_ONE" \
  "DECISION_TWO" \
  | jq -R . | jq -s 'map(select(length > 0))')
UNRESOLVED=$(printf '%s\n' \
  "OPEN_THREAD_ONE" \
  | jq -R . | jq -s 'map(select(length > 0))')
KEY_INSIGHT="THE_ONE_THING_WORTH_REMEMBERING"

MILESTONE_EVENT=$(jq -n -c \
  --argjson digest "$DIGEST" \
  --argjson decisions "$DECISIONS" \
  --argjson unresolved "$UNRESOLVED" \
  --arg insight "$KEY_INSIGHT" \
  --arg eid "$EVENT_ID" \
  --arg ts "$TIMESTAMP" \
  --arg milestone "session_wrapup" \
  --arg description "SESSION_SYNTHESIS_HERE" \
  --arg session "$SESSION_ID" \
  --arg provider "$PROVIDER" \
  --arg transcript "$TRANSCRIPT" \
  --arg deeplink "$DEEPLINK" \
  --arg project "$PROJECT" \
  --arg cwd "$(pwd)" \
  --arg event "Wrapup" \
  --arg branch "$GIT_BRANCH" \
  '{event_id: $eid, timestamp: $ts, milestone: $milestone, provider: $provider, description: $description, session_id: $session, transcript_path: $transcript, deeplink: $deeplink, project: $project, cwd: $cwd, event: $event, git_branch: $branch, digest: $digest,
    decisions: $decisions, unresolved: $unresolved, key_insight: $insight}')

[ -z "$MILESTONE_EVENT" ] && { echo "error: milestone JSON not built — nothing written" >&2; exit 1; }
printf '%s\n' "$MILESTONE_EVENT" >> "$DEV/session-milestones.jsonl"

# Index in this SAME block, piping the event just built. Never `tail -1` the log:
# with 3-5 concurrent sessions appending to it, a re-read routinely picks up a
# neighbouring session's event and leaves this one unindexed — and because
# index-event.sh has a novelty gate that also exits 0, the loss is invisible.
ROOT="${CARTOGRAPHER_ROOT:-${CLAUDE_PLUGIN_ROOT:-${PLUGIN_ROOT:-$HOME/Documents/dev/session-cartographer}}}"
printf '%s\n' "$MILESTONE_EVENT" | bash "$ROOT/scripts/index-event.sh"
echo "logged + indexed: $EVENT_ID"
```

Replace `SESSION_SYNTHESIS_HERE` with your synthesis paragraph. It must be a **single line** — the pipeline is TSV/line-based and a literal newline splits the row.

## Step 2: Confirm it landed

```bash
POINT_ID=$((16#$(printf '%s' "$EVENT_ID" | shasum -a 256 | cut -c1-13)))
curl -s "http://localhost:6333/collections/session-cartographer/points/$POINT_ID" \
  | jq -r '.result.payload.event_id // "NOT INDEXED"'
```

If it prints `NOT INDEXED`, the novelty gate rejected it as too similar to an
existing entry (expected for a routine session) or Qdrant is down — check
`$DEV/.carto/index-errors.jsonl`. The JSONL line is written either way.

## Step 3: Update memory if warranted

If the session produced a non-obvious discovery, preference, or decision that future sessions need — save it to memory. Most sessions don't warrant a new memory. Don't force it.

## What NOT to do

- Don't summarize every tool call or file read
- Don't write a changelog (the hooks handle that)
- Don't create memory entries for things derivable from git log
- Don't be verbose — one paragraph, specific, done
- Don't retype the digest's numbers into prose. It already showed them, aligned and correct; restating them is where drift enters
- Don't claim work the digest doesn't show. If you believe something happened that isn't logged, say it's unlogged rather than asserting it flatly

## Examples

What the digest looks like (Step 0 output — show it as-is):

```
━━ session digest · attentional-foraging ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  session   dbc9ac21 · claude · 1242 events
  span      2026-05-01 02:36 → 2026-05-05 15:23 UTC · 108h47m
  tempo     ▂·▁▁▁▁▁▁··█▄▂▅▄·▁▅▄▁▃▄·▃▂▂▁▁▁·▁▆  (3h24m/mark)
  projects  attentional-foraging 1054 · approach-retreat 77 · movies-mindbendi…
  activity  580 edits · 608 bash · 4 searches · 6 compactions · subagents Plan

  commits   26 · 15 pushes
            15 feature · 8 docs · 2 fix · 1 refactor  ▸  17 construct · 6 surg…

            05-05 13:23  d6be69e  feat(ltr): typed-cascade migration + Pe…  +4724 −139
            05-03 17:55  7de5c98  docs(lit-notes): Dumais 2010 IIiX entry…      +12 −1
            … 20 more

  files     173 touched
            docs/drafts/cikm-2026/paper-v4.md                                   ×41

  recall    3 calls → 22 served · 2 used (9%)
            evt-7apd8osl9sud evt-wprsakq31ca5

  leaving   attentional-foraging@feat/dd-top-…  1 uncommitted
            approach-retreat@main               14 uncommitted

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

Good synthesis:
> "Trimmed root CLAUDE.md from 20KB to 4KB by moving project map, testing, and library details to per-project CLAUDE.md files. Created CLAUDE.md for scrutinizer2025, iblipper2025, interests2025. Pruned 4 stale memories. Key insight: /focus and /remember make the project map redundant in root context — saves ~4000 tokens per turn."

Bad synthesis:
> "Worked on various improvements to the codebase. Made things more efficient. Updated some files."
