---
name: focus
description: Orient on a project or project family. Shows recent activity, milestones, and commits from event logs.
argument-hint: "<project or alias>"
allowed-tools:
  - Bash
  - Read
---

# Focus

Get oriented on a project before diving in. Pulls recent activity from the event logs — no git calls, no compilation, just what the hooks already captured.

## What it shows

- Recent session milestones (with git branch, dirty state from when they were logged)
- Recent commits (with type classification)
- Research activity
- Last session end events (what was happening when you left off)
- **Related project threads + recurring technical maneuvers** (from the co-occurrence graph, `scripts/cooccurrence-graph.js`)

## How to use it

Run the search script with `--project` and a broad recency query:

```bash
bash ~/Documents/dev/session-cartographer/scripts/cartographer-search.sh "recent activity" --project <PROJECT> --limit 20
```

The `<PROJECT>` argument supports:
- **Direct project names**: `session-cartographer`, `scrutinizer2025`
- **Registry aliases**: `devtools`, `scrutinizer`, `psychodeli` — expanded via `project-registry.json` to match all repos in the family

## Step 1: Resolve the project

If the user gives a vague name, check `project-registry.json` for aliases:

```bash
jq -r '.aliases | keys[]' ~/Documents/dev/session-cartographer/project-registry.json
```

## Step 2: Search recent activity

```bash
bash ~/Documents/dev/session-cartographer/scripts/cartographer-search.sh "recent activity" --project <PROJECT> --limit 20
```

## Step 3: Surface related threads + maneuvers

The co-occurrence graph adds two orientation lenses the search can't: which *other* projects this one is worked on alongside (cross-project research threads), and which recurring technical maneuvers (release, deploy, merge, overleaf-sync…) it runs. Both resolve aliases/partial names automatically.

```bash
node ~/Documents/dev/session-cartographer/scripts/cooccurrence-graph.js --related <PROJECT>
node ~/Documents/dev/session-cartographer/scripts/cooccurrence-graph.js --maneuvers <PROJECT>
```

Skip either line silently if it prints `(no co-active…)` / `(no maneuvers…)`. The maneuver map is an *index*, not a command store — to recover the actual command for a maneuver, grep the changelog on demand:

```bash
jq -r 'select(.project=="<PROJECT>" and (.summary|test("wrangler|gh release|netlify"))) | .summary' ~/Documents/dev/changelog.jsonl
```

## Step 4: Summarize

Present a concise orientation:
- What branch/state was last recorded
- What was being worked on (from milestones + commits)
- Any recent research
- **Related threads** — projects co-active with this one, if any (a nudge toward cross-project context)
- **Maneuvers** — recurring technical procedures this project runs, if any
- Where the transcript is if they want full context

## Examples

```
/focus scrutinizer
/focus devtools
/focus psychodeli
```
