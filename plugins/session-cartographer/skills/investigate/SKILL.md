---
name: investigate
description: Bring past diagnoses to a bug before fixing it, record the new root-cause hypothesis, and close it as confirmed or refuted once the fix is verified. Use when a bug could come from more than one layer, or looks like something seen before.
allowed-tools:
  - Bash
  - Read
  - Grep
  - Glob
---

# Investigate

Cartographer's part of bug work is memory: what was diagnosed before, which
hypotheses turned out wrong, and what finally fixed it. How to debug is left to
you. This skill adds three steps around your own diagnosis.

Resolve `ROOT` from `CARTOGRAPHER_ROOT`, `CLAUDE_PLUGIN_ROOT`, or `PLUGIN_ROOT`;
otherwise use this skill's base directory (`../..` from `skills/investigate`).

## 1. Recall before diagnosing

Search for the symptom and for the files or components involved:

```bash
bash "$ROOT/scripts/cartographer-search.sh" "Investigated <symptom words>" --limit 10
bash "$ROOT/scripts/cartographer-search.sh" "<file or component name>" --limit 10
```

For each earlier `investigation` result, search its event id to find how it
ended. An `investigation_outcome` event names it in its summary:

```bash
bash "$ROOT/scripts/cartographer-search.sh" "evt-abc123def456" --limit 5
```

Use `--get <ids>` for the full records. Report what bears on this bug, most of
all hypotheses that were **refuted** for a similar symptom, and a confirmed
cause that could be recurring. An investigation with no outcome is an open
guess, not a finding. If nothing relevant comes back, say so in one line.

## 2. Record the hypothesis

Once you have a diagnosis worth testing, record it. It should name the cause,
the mechanism that produces the symptom, and one observation that would
disprove it.

```bash
jq -n -c --arg symptom "$SYMPTOM" --arg hypothesis "$HYPOTHESIS" \
  --arg layer "$LAYER" --argjson files "$FILES_JSON" \
  '{kind:"open", symptom:$symptom, hypothesis:$hypothesis, layer:$layer, files:$files}' \
  | bash "$ROOT/scripts/record-investigation.sh"
```

`layer` is optional (for example `logic`, `state`, `boundary`,
`validation`, `build`); `files` is an optional JSON array of paths. Keep the
printed `event_id` for step 3. The receipt reports the durable write and the
index separately; if indexing failed, the record is still searchable by keyword.

## 3. Close it

After the fix is verified against the real failure, or the hypothesis is
disproved, record the outcome:

```bash
jq -n -c --arg id "$EVENT_ID" --arg outcome confirmed --arg evidence "$EVIDENCE" \
  '{kind:"close", resolves:$id, outcome:$outcome, evidence:$evidence}' \
  | bash "$ROOT/scripts/record-investigation.sh"
```

`outcome` is `confirmed`, `refuted`, or `abandoned`. `evidence` is the
observation that decided it: a log line, a measured value, a passing check on
the real target. A refuted hypothesis is worth closing: it is the record that
saves the next session from repeating it.

If the investigation continues in another session, step 1 finds the open record
and its id there.
