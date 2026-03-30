# Context Briefings

Optional feature that auto-compiles project context when you mention a project name. Saves 5-6 orientation tool calls at session start.

## How it works

A `UserPromptSubmit` hook watches for project keywords in your message. When matched, it compiles a briefing to `~/.claude/briefings/<family>.md` containing:
- Git status (dirty files, branch)
- Recent commits
- TODO excerpts
- Recent session milestones from cartographer event logs

The agent reads the briefing instead of running `git status`, `git log`, `cat TODO.md`, etc. individually.

## Project families

Defined in `extras/briefings/project-families.json`. Each family maps keyword patterns to a set of repos:

```json
{
  "psychodeli|psycho|p+|fractal": {
    "label": "Psychodeli+",
    "repos": [
      "psychodeli-webgl-port",
      "psychodeli-plus-tvos",
      "psychodeli-plus-firetv",
      "psychodeli-metal",
      "psychodeli-osx-vx",
      "psychodeli-brand-guide"
    ]
  }
}
```

**Keywords** (left side): regex-style patterns matched against the user's prompt. First match wins.

**Repos** (right side): directories under `~/Documents/dev/` to include in the briefing. Each gets git status + recent commits.

### Current families

| Family | Keywords | Repos |
|--------|----------|-------|
| Scrutinizer | `scrutinizer`, `scrut`, `foveated` | scrutinizer2025, scrutinizer-www, PooledStatisticsMetamers, fovi, clicksense |
| Psychodeli+ | `psychodeli`, `psycho`, `p+`, `fractal` | psychodeli-webgl-port, -plus-tvos, -plus-firetv, -metal, -osx-vx, -brand-guide |
| TV Apps | `tv app`, `oled`, `fireworks`, `cymatics`, `pixelbop`, `screensaver` | oled-fireworks-tvos, -firetv, cymatics-firetv, pixelbop |
| Interests & FrakBot | `interest`, `magazine`, `histospire`, `browsing`, `frakbot`, `openclaw` | interests2025, histospire, mcp-chrome |
| SciprogFi | `sciprogfi`, `scifi`, `narrative`, `tunupa` | sciprogfi-web, sciprogfi |
| Websites | `website`, `site`, `mindbending`, `brand` | mindbendingpixels-www, scrutinizer-www, sciprogfi-web |
| iBlipper | `iblipper`, `kinetic`, `typography`, `rsvp` | iblipper2025 |
| Dev Tools | `bridge`, `session`, `cartographer`, `history-viewer` | session-cartographer, claude-code-session-bridge, claude-code-history-viewer |
| Nanobot | `nanobot` | nanobot |
| WyrdForge | `wyrdforge`, `dice` | wyrdforge |

## Adding a family

Edit `extras/briefings/project-families.json`. Add a new key with pipe-separated keywords and a `repos` array:

```json
"myproject|myproj": {
  "label": "My Project",
  "repos": ["my-repo-name"]
}
```

Keywords are case-insensitive. Repos are directory basenames under `~/Documents/dev/` (configurable via `CARTOGRAPHER_DEV_DIR`).

## Install

Briefings are opt-in. Add the hook to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "UserPromptSubmit": [{
      "hooks": [{
        "type": "command",
        "command": "bash /path/to/session-cartographer/extras/briefings/compile-briefing.sh",
        "async": true
      }]
    }]
  }
}
```

Then add to your CLAUDE.md:

```markdown
## Context Briefings
A UserPromptSubmit hook auto-compiles ~/.claude/briefings/<family>.md when
you mention a project. Read the briefing first instead of running orientation
tool calls.
```

## Session end & compaction context

The `log-session-milestones.sh` hook enriches `SessionEnd` and `PreCompact` events with git context, making milestone entries useful as lightweight handoff records:

| Field | Example |
|-------|---------|
| `git_branch` | `feat/search-v2` |
| `git_dirty_files` | `3` |
| `recent_commits` | `abc1234 fix search\|def5678 add tests` (pipe-delimited oneline) |
| `session_event_count` | `12` |

The changelog summary also includes this context inline, so `/remember` results show branch + dirty state without needing to read the full milestone entry.

Example changelog summary:
```
Session ended (normal) [feat/search-v2, 3 dirty, 12 events]
```

This replaces the need for a separate `last-session.md` handoff file — the same data lives in the searchable event logs.

## Dependency

Briefings read from the JSONL event logs (the map) for recent milestones. They don't depend on `/remember` or the Explorer — just the hooks that produce the data.

## Manual generation

To generate a briefing without the hook:

```bash
echo '{"prompt":"psychodeli"}' | bash extras/briefings/compile-briefing.sh
cat ~/.claude/briefings/psychodeli.md
```
