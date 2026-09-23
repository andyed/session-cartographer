# Project Registry & /focus

## Project registry

`project-registry.json` maps short aliases to sets of project names as they appear in event logs. Not git-specific — any project that produces JSONL events can be listed.

### Which registry is in effect

Three layers, first hit wins, **no merging** — a user registry *replaces* the shipped one:

| # | Location | For |
|---|----------|-----|
| 1 | `$CARTOGRAPHER_PROJECT_REGISTRY` | explicit path; tests and one-offs |
| 2 | `~/.config/session-cartographer/project-registry.json` (or `$CARTOGRAPHER_CONFIG`'s directory) | **yours** |
| 3 | the plugin's own `project-registry.json` | shipped empty: every name is literal |

Layer 2 replaces layer 3 wholesale rather than merging with it, so an alias you deliberately deleted stops resolving. The plugin ships layer 3 empty: a project list describes one person's machine and is no use to anyone else.

Ask which one is live:

```bash
bash scripts/project-registry.sh --path
bash scripts/project-registry.sh --aliases
bash scripts/project-registry.sh --expand widget
```

A registry that is present but unparseable is an error, not a fallback: falling back would answer your query from a different registry and never say so.

```json
{
  "aliases": {
    "devtools": ["session-cartographer", "claude-code-history-viewer"],
    "widget": ["widget-api", "widget-web", "gizmo-sdk", "billing-core"]
  }
}
```

Used by:
- **`cartographer-search.sh --project <alias>`** — expands to multi-project filter
- **`/focus <alias>`** — orient on a project family from event logs
- **`/remember <query> --project <alias>`** — scoped history search

### The registry is precision, not the mechanism

Scoping does not require an alias. `--project` matches by **case-insensitive
substring** (`projectMatcher` in `explorer/server/project-filter.js`), so
`--project widg` already selects every `widget-*` repository, and
`--project api` selects anything with `api` in its name. The registry earns
its keep where a substring cannot express the set — `widget` also has to reach
`gizmo-sdk` and `billing-core`, which share no common string — and where a loose
prefix would over-select.

Both ladders honour the same predicate. The semantic leg used to scope by exact
equality against Qdrant, which meant an unregistered prefix returned keyword
results and *zero* semantic ones; it now resolves the spec against the project
values present in the corpus and filters on those. `/api/recall` performs no
registry expansion at all, so an API caller passing a family name depends
entirely on that substring behaviour.

### Bootstrapping your own

The plugin ships no aliases. An alias that is not defined falls through as a
literal project name rather than erroring, which is safe: substring matching
still scopes most searches. Derive a registry from your event logs:

```bash
node scripts/bootstrap-project-registry.js --dry-run   # see what it infers
node scripts/bootstrap-project-registry.js             # write it (refuses to clobber; --force to replace)
node scripts/bootstrap-project-registry.js --update    # later: add projects seen since
```

It groups project names by shared stem (`widget-api` + `widget-web` →
`widget`) and drops cwd-derived non-projects: the
workspace root, your home directory, auto-named agent worktrees
(`brave-thompson-40e495`), and bare `repo`/`dist`/`spec`. Grouping by prefix is
a guess about how you think about your work — the script prints what it grouped
and what it left alone, and expects you to edit the result.

`--update` maintains an existing registry. It records every project name it has
considered in a `_known` list and only acts on names absent from it: a new name
joins the alias its stem names, or two or more new names sharing a stem form a
new alias. Aliases you wrote, and members you removed, stay as you left them.
Run it with `--dry-run` first to see the proposed changes.

### Adding an alias by hand

Edit your **user** registry (`~/.config/session-cartographer/project-registry.json`),
not the plugin's — an update overwrites the shipped file:

```json
"myalias": ["repo-name-1", "repo-name-2"]
```

Names are directory basenames as they appear in event log `project` fields.

## /focus

`/focus <project>` orients on a project by searching recent event log activity. No git calls, no file compilation — just queries the same JSONL data that `/remember` uses, scoped to the project.

Shows: recent milestones (with git branch/dirty state from capture time), commits with type classification, research activity, and last session end events.

## Session end & compaction context

The `log-session-milestones.sh` hook enriches `SessionEnd` and `PreCompact` events with git context at capture time:

| Field | Example |
|-------|---------|
| `git_branch` | `feat/search-v2` |
| `git_dirty_files` | `3` |
| `recent_commits` | `abc1234 fix search\|def5678 add tests` (pipe-delimited oneline) |
| `session_event_count` | `12` |

Changelog summary includes this inline: `Session ended (normal) [feat/search-v2, 3 dirty, 12 events]`

This eliminates the need for compiled briefing files — the same data lives in the searchable event logs, captured at the moment it happens rather than re-derived later.

## Bounded machine feeds

`scripts/cartographer-feed.sh` produces a compact Markdown pulse for another
local agent or scheduled job. It reuses the canonical hybrid search and never
copies the Cartographer index. The caller must provide an explicit project
allowlist; an unscoped whole-corpus feed fails closed.

```bash
bash scripts/cartographer-feed.sh \
  --projects widget,notes,session-cartographer \
  --since 24h \
  --max-results 20
```

The feed contains ranked summaries, event IDs, provenance, and transcript
pointers when available. It does not include raw transcript text. Results are
deduplicated, filtered by salience, drop routine bash/file-edit events by
default, and are checked against caller-configurable deny expressions.
Automated feed searches use `purpose=feed`, disable
reuse ranking, and write served telemetry to `/dev/null`, so they do not inflate
human `/remember` use metrics.

Use a feed as an evidence index, not as another memory authority. A consuming
agent should exact-fetch or read the original transcript only when a result
materially changes its work, keep session evidence distinct from live-world
evidence, and preserve the source system's privacy and authorization boundary.
