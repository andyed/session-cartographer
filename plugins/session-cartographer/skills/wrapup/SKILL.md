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

Not every session needs an authored synthesis. Transcripts and lifecycle hooks
are the automatic substrate; `/wrapup` promotes a material session into durable
strategic memory. Use `node "$ROOT/scripts/wrapup-coverage.js"` to see material
sessions that still lack that synthesis.

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

## Step 0.5: Reconcile the project roadmap

For projects touched by this session that maintain `roadmap.toml` or
`roadmap.json`, reconcile the plan before writing the synthesis. Skip projects
without a roadmap; do not create one just to satisfy this step.

- Read the owning roadmap and the session's decisions, relevant commits and
  release/validation receipts. Every material feature, experiment or changed
  dependency should map to an existing item or a justified new backlog item.
- Inspect branch-local plan changes as well as the main checkout. If Roadmaip
  is available, use its read-only `branch-review --roadmap <owning-plan> --json`
  command (or `node <roadmaip-checkout>/src/cli.mjs branch-review ...`). It
  compares committed local branch plans to their merge base and current plan,
  and reports unresolved/cyclic dependencies. It does not inspect uncommitted
  work on other worktrees, infer features from code, or verify delivery. If it
  is unavailable, inspect the relevant Git refs and roadmap diffs directly.
- Update authored entries within the session's authorized scope. Preserve
  feature ids, ownership, dependency edges, and source/branch references.
  Record implementation, validation, staging, TestFlight and publication as
  separate evidence states. A branch, push, build or upload does not establish
  a release commitment or store availability. Keep unscheduled work in the
  backlog; never invent a release assignment or convert a tentative decision
  into an accepted one.
- When a plan change is only on a feature branch, make that explicit. Reconcile
  it into the owning plan when supported and within scope, or leave a named
  unresolved item with branch/commit and the remaining decision. Do not merge
  implementation branches just to make their features visible. Resolve
  contradictory branch versions from evidence rather than taking the newest.
- Check dependency references, cycles and the remaining prerequisites of
  downstream features. “Depends on” is authored; don't derive it automatically
  from prose, release coordination, or shared names. Run the owning roadmap's
  validator when available, and inspect the diff for unintended scheduling.

Report the outcome in the wrapup: which items changed, where their plan is
committed, and any unreconciled work. A reconciliation gap is an `unresolved[]`
entry, not grounds to claim the plan is current. Keep the roadmap edits with
normal task commits. This step does not install a Git hook or authorize a push.

## Step 0.75: Leave the disk as you found it

Clean up what this session created, and nothing else. The digest's `leaving`
lines are the starting list. Several sessions share one machine, so another
session's worktree, build output or cache is never yours to remove, however idle
it looks.

A sweep on 2026-11-15 found why this step exists. Of 59 worktrees, 49 could not
be removed, nearly all because they held commits that were never pushed, so the
branch existed only on that disk. Release build staging had grown to 30 GB
because nobody ran the documented prune after an upload.

1. **Push or record.** For each branch this session committed to, run
   `git rev-list --count HEAD --not --remotes`. If it is not 0, push when the
   session is authorized to push. Otherwise add an `unresolved[]` item that names
   the branch and why it stays local: "Push feat/x (3 commits, this machine
   only) once the copy is approved".
2. **Remove worktrees this session made and has finished with**, such as an
   agent's scratch worktree or a side-task checkout. Remove one only if all of
   these hold:
   - `git status --porcelain` is empty;
   - it has no commits that aren't on a remote;
   - no process has its cwd inside (`lsof -d cwd`);
   - `git worktree list --porcelain` does not mark it `locked`;
   - every untracked or ignored file is rebuildable (`node_modules` next to a
     `package.json`, `dist/` from a build script).

   Then run `git worktree remove <path>`; the branch is kept. Captures,
   screenshots and `test-results/` receipts are not rebuildable. Copy them
   somewhere durable first, or keep the worktree. Use `--force` only after that
   check passes. Leave alone the worktree the session is still running in, but
   say in the hand-off whether it is safe to remove.
3. **Prune build output the project's docs say to prune**, for example a release
   staging prune once an upload has finished. Leave output whose upload or
   publication you can't confirm.
4. **Check free space.** Run `df -k "$HOME"`. Below
   `CARTOGRAPHER_DISK_WARN_GIB` (default 50 GiB), give the figure in the
   synthesis and add an `unresolved[]` item: "Free disk is 31 GiB; reclaim
   before the next build".

Report what was removed and what was kept, with the reason. A kept worktree that
holds unpushed work is an `unresolved[]` item, not a footnote.

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

`unresolved[]` is also the hand-off. The next session to start in this project
gets the latest wrapup's items in its SessionStart note
(`hooks/surface-focus-on-start.sh`), one per line and cut at 100 characters,
with this event's id so it can `--get` the rest. Write each item for that
reader, an agent at its first turn that has not seen this conversation:

- one open thread per item, on one line;
- the next action or the open question first, then the evidence: "Verify X on
  the Windows box", not "The Windows box has not been tried";
- name the file, command, branch or id it concerns;
- what is left to do, not what was done. The paragraph covers what was done.

An empty list says "nothing left open", so leave it empty only when that is true.

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

# Detect project from cwd. Resolve a worktree to its PARENT repo: a session run
# in repo/.claude/worktrees/<name> whose project is the worktree basename orphans
# every record the moment that worktree is pruned, and agent tools create and
# discard worktrees routinely. cartographer-project.sh is the command-line face
# of cartographer_project() in hooks/common.sh — one definition, two consumers.
ROOT="${CARTOGRAPHER_ROOT:-${CLAUDE_PLUGIN_ROOT:-${PLUGIN_ROOT:-$HOME/Documents/dev/session-cartographer}}}"
GIT_REPO=$(git rev-parse --show-toplevel 2>/dev/null)
PROJECT=$(bash "$ROOT/scripts/cartographer-project.sh" 2>/dev/null) || PROJECT=""
if [ -z "$PROJECT" ]; then
  PROJECT=$(basename "${GIT_REPO:-$(pwd)}")
  echo "warning: cartographer-project.sh unavailable — project \"$PROJECT\" is cwd-derived and is wrong inside a worktree" >&2
fi
GIT_BRANCH=$(git branch --show-current 2>/dev/null || echo "none")

# Find transcript path
TRANSCRIPT=$(find ~/.claude/projects -name "${SESSION_ID}.jsonl" 2>/dev/null | head -1)
if [ -z "$TRANSCRIPT" ] && [ "$SESSION_ID" != "unknown" ]; then
  TRANSCRIPT=$(find ~/.codex/archived_sessions ~/.codex/sessions -name "*${SESSION_ID}*.jsonl" 2>/dev/null | head -1)
  [ -n "$TRANSCRIPT" ] && PROVIDER="codex"
fi
ENCODED_PATH=$(echo "$TRANSCRIPT" | python3 -c "import sys, urllib.parse; print(urllib.parse.quote(sys.stdin.read().strip(), safe=''))" 2>/dev/null || echo "$TRANSCRIPT")
DEEPLINK=""
[ "$PROVIDER" = "claude" ] && DEEPLINK="claude-history://session/${ENCODED_PATH}"

# Attach the digest's scalars so the milestone stays checkable after the
# transcript hits Claude Code's ~30d TTL. Falls back to null if the digest
# could not run — never block the wrapup on it.
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
# Each open thread on its own line: the next session's start note lists them
# one per line, so lead with the action and keep each under ~100 characters.
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

# The helper preserves the JSONL write and semantic-index result as separate
# states, verifies the exact Qdrant event id, and returns one JSON receipt. Never
# append here and then `tail -1`: concurrent sessions share the milestone log.
ROOT="${CARTOGRAPHER_ROOT:-${CLAUDE_PLUGIN_ROOT:-${PLUGIN_ROOT:-$HOME/Documents/dev/session-cartographer}}}"
WRAPUP_STATUS=0
WRAPUP_RECEIPT=$(printf '%s\n' "$MILESTONE_EVENT" \
  | bash "$ROOT/scripts/record-wrapup.sh") || WRAPUP_STATUS=$?

LOG_OUTCOME=$(printf '%s' "$WRAPUP_RECEIPT" | jq -r '.log_outcome // "unknown"')
INDEX_OUTCOME=$(printf '%s' "$WRAPUP_RECEIPT" | jq -r '.index.outcome // "unknown"')
INDEX_STAGE=$(printf '%s' "$WRAPUP_RECEIPT" | jq -r '.index.stage // "unknown"')

case "$LOG_OUTCOME:$INDEX_OUTCOME" in
  written:indexed|already_present:indexed)
    echo "logged + indexed + verified: $EVENT_ID"
    ;;
  written:*|already_present:*)
    echo "logged, not indexed: $EVENT_ID ($INDEX_OUTCOME at $INDEX_STAGE)" >&2
    ;;
  *)
    echo "wrapup not logged: $EVENT_ID ($LOG_OUTCOME; $INDEX_STAGE)" >&2
    ;;
esac

# Preserve this for Step 2 and for an exact diagnostic if anything failed.
printf '%s\n' "$WRAPUP_RECEIPT" | jq .
[ "$WRAPUP_STATUS" -eq 0 ] || echo "index/write status: $WRAPUP_STATUS" >&2
```

Replace `SESSION_SYNTHESIS_HERE` with your synthesis paragraph. It must be a **single line** — the pipeline is TSV/line-based and a literal newline splits the row. `record-wrapup.sh` flattens any newline or tab left in the synthesis, `key_insight` or an array item to a space before writing, so a stray one costs formatting, not the row.

## Step 2: Confirm it landed

```bash
INDEX_OUTCOME=$(printf '%s' "$WRAPUP_RECEIPT" | jq -r '.index.outcome // "unknown"')
if [ "$INDEX_OUTCOME" = "indexed" ]; then
  POINT_ID=$(printf '%s' "$WRAPUP_RECEIPT" | jq -r '.index.point_id // empty')
  QDRANT_URL="${CARTOGRAPHER_QDRANT_URL:-http://localhost:6333}"
  COLLECTION="${CARTOGRAPHER_COLLECTION:-session-cartographer}"
  # qdrant-curl.sh adds the api-key header when a Qdrant key is configured.
  VERIFIED_EVENT_ID=$("$ROOT/scripts/qdrant-curl.sh" -sf "$QDRANT_URL/collections/$COLLECTION/points/$POINT_ID" \
    | jq -r '.result.payload.event_id // empty')
  if [ "$VERIFIED_EVENT_ID" = "$EVENT_ID" ]; then
    echo "verified indexed: $EVENT_ID"
  else
    echo "verification failed: expected $EVENT_ID, got ${VERIFIED_EVENT_ID:-nothing}" >&2
  fi
else
  printf '%s' "$WRAPUP_RECEIPT" \
    | jq -r '"not indexed: \(.index.outcome) at \(.index.stage)"' >&2
fi
```

Verification is always by the exact `event_id`; Qdrant payloads do not need a
`milestone` field. A failed semantic index never removes the JSONL synthesis.
Check `$DEV/.carto/index-errors.jsonl` for precondition and service failures or
`$DEV/.carto/index-rejects.jsonl` for ordinary non-wrapup novelty rejections.

## Step 3: Update memory if warranted

If the session produced a non-obvious discovery, preference, or decision that future sessions need — save it to memory. Most sessions don't warrant a new memory. Don't force it.

## What NOT to do

- Don't summarize every tool call or file read
- Don't write a changelog (the hooks handle that)
- Don't create memory entries for things derivable from git log
- Don't be verbose — one paragraph, specific, done
- Don't retype the digest's numbers into prose. It already showed them, aligned and correct; restating them is where drift enters
- Don't claim work the digest doesn't show. If you believe something happened that isn't logged, say it's unlogged rather than asserting it flatly
- Don't clean up another session's worktrees, builds or caches, and don't empty the Trash or clear shared caches as part of a wrapup. Step 0.75 covers only what this session made

## Examples

What the digest looks like (Step 0 output — show it as-is):

```
━━ session digest · widget-api ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  session   dbc9ac21 · claude · 1242 events
  span      2026-05-01 02:36 → 2026-05-05 15:23 UTC · 108h47m
  tempo     ▂·▁▁▁▁▁▁··█▄▂▅▄·▁▅▄▁▃▄·▃▂▂▁▁▁·▁▆  (3h24m/mark)
  projects  widget-api 1054 · widget-sdk 77 · docs-site 12
  activity  580 edits · 608 bash · 4 searches · 6 compactions · subagents Plan

  commits   26 · 15 pushes
            15 feature · 8 docs · 2 fix · 1 refactor  ▸  17 construct · 6 surg…

            05-05 13:23  d6be69e  feat(auth): token refresh with retry bud…  +4724 −139
            05-03 17:55  7de5c98  docs(api): pagination cursor semantics        +12 −1
            … 20 more

  files     173 touched
            src/auth/refresh.ts                                                 ×41

  recall    3 calls → 22 served · 2 marked used (9%)
            evt-7apd8osl9sud evt-wprsakq31ca5

  leaving   widget-sdk@feat/retry-budget        1 uncommitted
            docs-site@main                      14 uncommitted

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

Good synthesis:
> "Trimmed root CLAUDE.md from 20KB to 4KB by moving project map, testing, and library details to per-project CLAUDE.md files. Created CLAUDE.md for widget-api, widget-sdk, and docs-site. Pruned 4 stale memories. Key insight: /focus and /remember make the project map redundant in root context — saves ~4000 tokens per turn."

Bad synthesis:
> "Worked on various improvements to the codebase. Made things more efficient. Updated some files."
