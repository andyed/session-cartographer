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

## Step 3: Summarize

Present a concise orientation:
- What branch/state was last recorded
- What was being worked on (from milestones + commits)
- Any recent research
- Where the transcript is if they want full context

## Examples

```
/focus scrutinizer
/focus devtools
/focus psychodeli
```
