# Project Registry & /focus

## Project registry

`project-registry.json` maps short aliases to sets of project names as they appear in event logs. Not git-specific — any project that produces JSONL events can be listed.

```json
{
  "aliases": {
    "devtools": ["session-cartographer", "claude-code-session-bridge", "claude-code-history-viewer"],
    "scrutinizer": ["scrutinizer2025", "scrutinizer-www", "PooledStatisticsMetamers", "fovi", "clicksense"]
  }
}
```

Used by:
- **`cartographer-search.sh --project <alias>`** — expands to multi-project filter
- **`/focus <alias>`** — orient on a project family from event logs
- **`/remember <query> --project <alias>`** — scoped history search

### Current aliases

| Alias | Projects |
|-------|----------|
| scrutinizer | scrutinizer2025, scrutinizer-www, PooledStatisticsMetamers, fovi, clicksense |
| psychodeli | psychodeli-webgl-port, -plus-tvos, -plus-firetv, -metal, -osx-vx, -brand-guide |
| tvapps | oled-fireworks-tvos, -firetv, cymatics-firetv, pixelbop |
| interests | interests2025, histospire, mcp-chrome |
| sciprogfi | sciprogfi-web, sciprogfi |
| websites | mindbendingpixels-www, scrutinizer-www, sciprogfi-web |
| iblipper | iblipper2025 |
| devtools | session-cartographer, claude-code-session-bridge, claude-code-history-viewer |
| nanobot | nanobot |
| wyrdforge | wyrdforge |

### Adding an alias

Edit `project-registry.json`:

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
  --projects psychodeli,interests,sciprogfi,session-cartographer \
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
