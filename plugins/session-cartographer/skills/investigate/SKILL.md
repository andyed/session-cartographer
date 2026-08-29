---
name: investigate
description: Root-cause-first diagnosis gate. Forces a written hypothesis with evidence before any bug-fix code change, and logs it to the event log for later recall.
allowed-tools:
  - Bash
  - Read
  - Grep
  - Glob
---

# Investigate

A diagnosis gate for bug work. Andy's usage data shows repeated cycles where a plausible fix is shipped before the real failure mode is understood — tvOS IAP rejection patched as product-loading when the bug was focus management; gaze replay patched as routing when the bug was coordinate-space; OptiGest tests green on synthetic data while the live app stayed broken. This skill enforces diagnosis before edit.

## When to invoke

User runs `/investigate <bug summary>` when a bug is reported or discovered. Do NOT propose or write fix code until the user confirms the diagnosis produced by this skill.

## When to skip

The ~5–10K token overhead is pure tax on obvious bugs. Skip this skill when:

- The cause is stated in the error message (typo, import error, off-by-one in a visible loop).
- The fix is a one-line change and the call path is already in context.
- The user explicitly names both the cause and the fix.

Use it when the symptom could plausibly come from more than one layer (logic / state / boundary / validation gap / build) — that's where misdiagnosis cascades burn 50–200K tokens.

## The contract

Complete these five steps **in order**. Stop and wait for user input after step 5.

### 1. Reproduce or confirm the failure mode

- If the user gave error output / screenshot / console log, quote the exact line that proves the bug.
- If not, ask for it before continuing — do not guess. One ask, then wait.

### 2. Read the failing code path end-to-end

- Grep for the symptom string, entry point, or suspected function.
- Read the whole path, not just the matching line. Note file:line anchors.
- If the path crosses a boundary (JS↔native, Electron↔renderer, Playwright↔browser, host↔device), name the boundary explicitly — most of Andy's coordinate and binary-staleness bugs live at boundaries.

### 3. Identify the root-cause layer

State which layer owns the bug:
- **Logic** — the code does the wrong thing
- **State** — stale cache, stale binary, uncleared hysteresis, wrong env
- **Boundary** — coordinate space, DPR, unit mismatch, focus, lifecycle
- **Validation gap** — tests pass on synthetic data; live runtime differs
- **Config/build** — plugin not loaded, manifest missing, xcodegen wiped capability

If the symptom points one way but the evidence points another, trust the evidence. When Andy names the likely cause, investigate that first (per `feedback_listen_first`).

### 4. Write the hypothesis

One short paragraph, plain text. Must contain:

- **Cause:** the specific line / boundary / state responsible
- **Mechanism:** how that cause produces the observed symptom
- **Disproof:** one concrete observation that would falsify the hypothesis (a log line, a coord value, a test on real hardware)

### 5. Log it and wait

Write the hypothesis to `changelog.jsonl` — the log `/remember` actually
searches — and index it.

**Run this block as written.** Until 0.5.0 it was routinely paraphrased, which
produced four different record shapes and 64 diagnoses written to
`.carto/events/`, a path nothing reads. Every one was unrecoverable until a
backfill rescued them. The field names below are not stylistic: `event_id` and
`timestamp` are what the pipeline indexes on, and `summary` is first in the
extraction chain, so text outside it is invisible to search.

```bash
DEV="${CARTOGRAPHER_DEV_DIR:-$HOME/Documents/dev}"
CLAUDE_SID="${CLAUDE_SESSION_ID:-${CLAUDE_CODE_SESSION_ID:-}}"
SESSION_ID="${CARTOGRAPHER_SESSION_ID:-${CLAUDE_SID:-${CODEX_SESSION_ID:-unknown}}}"
PROVIDER="${CARTOGRAPHER_PROVIDER:-unknown}"
[ "$PROVIDER" = "unknown" ] && [ -n "$CLAUDE_SID" ] && PROVIDER="claude"
[ "$SESSION_ID" = "unknown" ] && echo "warning: session id unresolved — this event will not link to a transcript" >&2
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
EVENT_ID="evt-$(LC_ALL=C tr -dc 'a-z0-9' < /dev/urandom | head -c 12)"
GIT_REPO=$(git rev-parse --show-toplevel 2>/dev/null)
PROJECT=$(basename "${GIT_REPO:-$(pwd)}")

# Find the transcript so the record links back to this conversation.
TRANSCRIPT=$(find ~/.claude/projects -name "${SESSION_ID}.jsonl" 2>/dev/null | head -1)
if [ -z "$TRANSCRIPT" ] && [ "$SESSION_ID" != "unknown" ]; then
  TRANSCRIPT=$(find ~/.codex/sessions -name "*${SESSION_ID}*.jsonl" 2>/dev/null | head -1)
  [ -n "$TRANSCRIPT" ] && PROVIDER="codex"
fi

# $SYMPTOM is the user's bug summary; $HYPOTHESIS is the paragraph from step 4;
# $LAYER is the root-cause layer from step 3.
# Flatten to one line — the pipeline is TSV/line-based and a newline in the
# summary splits the row, whose fragments then mis-parse as rank and outrank
# every real result.
SUMMARY=$(printf 'Investigated: %s — %s' "$SYMPTOM" "$HYPOTHESIS" | tr '\n\t' '  ')

INVESTIGATION_EVENT=$(jq -nc \
  --arg eid "$EVENT_ID" \
  --arg ts "$TIMESTAMP" \
  --arg session "$SESSION_ID" \
  --arg provider "$PROVIDER" \
  --arg project "$PROJECT" \
  --arg cwd "$(pwd)" \
  --arg transcript "$TRANSCRIPT" \
  --arg summary "$SUMMARY" \
  --arg symptom "$SYMPTOM" \
  --arg hypothesis "$HYPOTHESIS" \
  --arg layer "$LAYER" \
  '{event_id:$eid, timestamp:$ts, type:"investigation", provider:$provider,
    session_id:$session, project:$project, cwd:$cwd, transcript_path:$transcript,
    summary:$summary, symptom:$symptom, hypothesis:$hypothesis,
    root_cause_layer:$layer, salience:0.8}')

[ -z "$INVESTIGATION_EVENT" ] && { echo "error: investigation JSON not built" >&2; exit 1; }
printf '%s\n' "$INVESTIGATION_EVENT" >> "$DEV/changelog.jsonl"

# Index it, or it is keyword-only and invisible to intent-match recall.
# Pipe the event just built rather than re-reading the log: concurrent sessions
# append to the same file, so a re-read can index a neighbour's event instead.
ROOT="${CARTOGRAPHER_ROOT:-${CLAUDE_PLUGIN_ROOT:-${PLUGIN_ROOT:-$HOME/Documents/dev/session-cartographer}}}"
printf '%s\n' "$INVESTIGATION_EVENT" | bash "$ROOT/scripts/index-event.sh"
```

Then present the hypothesis to the user and **stop**. Do not touch code until they confirm the diagnosis or redirect.

## What this skill does NOT do

- Does not write fix code. That's a separate turn, after confirmation.
- Does not run long exploration. If the path is deep, spawn an Explore agent with a tight brief rather than grepping serially.
- Does not replace end-to-end verification. After the fix lands, validate against the live artifact (real device, real screenshot, real sensor trace) — synthetic tests passing is not sufficient.
