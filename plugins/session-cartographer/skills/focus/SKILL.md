---
name: focus
description: Orient on a project or project family. Shows recent activity, milestones, and commits from event logs.
allowed-tools:
  - Bash
  - Read
---

# Focus

Get oriented on a project before diving in. Pulls recent activity from the event logs — no git calls, no compilation, just what the hooks already captured.

Before running commands, resolve `ROOT` to the Session Cartographer plugin
root. Prefer `CARTOGRAPHER_ROOT`, then `CLAUDE_PLUGIN_ROOT` or `PLUGIN_ROOT`.
Otherwise derive it from this skill's reported base directory (`../..` from
`skills/focus`), with the conventional checkout as a legacy fallback.

## What it shows

- Recent session milestones (with git branch, dirty state from when they were logged)
- Recent commits (with type classification)
- Research activity
- Last session end events (what was happening when you left off)
- **Related project threads + recurring technical maneuvers** (from the co-occurrence graph, `scripts/cooccurrence-graph.js`)

## How to use it

Run the search script with `--project` and a broad recency query:

```bash
CARTOGRAPHER_PURPOSE=focus bash "$ROOT/scripts/cartographer-search.sh" "recent activity" --project <PROJECT> --limit 20
```

The `<PROJECT>` argument supports:
- **Direct project names**: `session-cartographer`, `widget-api`
- **Substrings**: `widget` matches every project whose name contains it
- **Registry aliases**: family names defined in the user's project registry, expanded to every repo in the family. The plugin ships no aliases.

## Step 1: Resolve the project

If the user gives a vague name, list the aliases. Resolve the registry through
the shared resolver rather than reading `$ROOT/project-registry.json` directly —
the file that ships is empty, and a user-level registry under
`~/.config/session-cartographer/` replaces it:

```bash
bash "$ROOT/scripts/project-registry.sh" --aliases
bash "$ROOT/scripts/project-registry.sh" --expand widget   # members, one per line
```

If there are no aliases, the user has no registry yet; substring scoping still
works. To derive one, or to add projects that appeared since:

```bash
node "$ROOT/scripts/bootstrap-project-registry.js" --dry-run
node "$ROOT/scripts/bootstrap-project-registry.js" --update --dry-run
```

## Step 2: Search recent activity

```bash
CARTOGRAPHER_PURPOSE=focus bash "$ROOT/scripts/cartographer-search.sh" "recent activity" --project <PROJECT> --limit 20
```

## Step 3: Surface related threads + maneuvers

The co-occurrence graph adds two orientation lenses the search can't: which *other* projects this one is worked on alongside (cross-project research threads), and which recurring technical maneuvers (release, deploy, merge, overleaf-sync…) it runs. Both resolve aliases/partial names automatically.

```bash
node "$ROOT/scripts/cooccurrence-graph.js" --related <PROJECT>
node "$ROOT/scripts/cooccurrence-graph.js" --maneuvers <PROJECT>
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
/focus session-cartographer
/focus widget
/focus devtools
```
