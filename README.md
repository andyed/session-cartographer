# Session Cartographer

Search your Claude Code session history, or better yet, have Claude do it for you with `/remember`. In the pictured case, "/remember remember skill"

![/remember in action](docs/remember_remember_skill.png)

Cartographer creates a lightweight metadata index via hooks at critical moments in your sessions — every URL fetched, every file edited, every git commit, every context compaction. This preserves your research trace and decision history past Claude's default 30-day transcript retention.

To query this index, it fuses BM25 keyword scoring with optional semantic similarity (via Qdrant), merged through Reciprocal Rank Fusion. The BM25 engine is implemented purely in `awk` — zero runtime dependencies.

## grep vs. cartographer

```
                           ── grep ──        ── carto ──
Query                       hits    sec       hits    sec
─────────────────────────  ────── ──────     ────── ──────
"BM25 scoring"                 4   32.8         4    0.5
"rank fusion awk"              1   37.7         6    0.7
"session cartographer"         5   49.4        15    0.7
"hook log research"            1   45.9        15    0.6
"cold start"                  82   34.2         3    0.5
"Qdrant embedding"             7   35.4         0    0.5
"real-time indexing"           3   47.4        15    0.7
"JSONL event"                  5   46.8         1    0.6
─────────────────────────  ────── ──────     ────── ──────
TOTAL                        108  329.8        59    4.8
```

grep takes 33-49 seconds per query scanning 2.7GB of transcripts, returning raw JSONL blobs. Cartographer returns BM25-ranked, formatted results in under a second.

## Architecture

Hooks are the foundation. Everything else is a lens.

```
Hooks (produce JSONL event logs)
  ├── /remember — CLI search (bash + awk, zero dependencies)
  ├── /carto explore — web UI (Node + React, visual browsing)
  ├── extras/briefings — project summaries (grep + jq)
  └── Qdrant indexer — semantic search (optional)
```

Each layer is independent. You can use `/remember` without the Explorer, briefings without `/remember`, or just the hooks with your own tooling. The JSONL event logs ([schema](docs/LOG_SCHEMAS.md)) are the shared data layer.

The hook system started as a [standalone gist](https://gist.github.com/andyed/72f8af0fd2f737dfb9fa3ab343b593b3). Session Cartographer grew from that into the search + visualization layers.

## Install

```bash
git clone https://github.com/andyed/session-cartographer.git
```

### Step 1: Hooks (the foundation)

Add hooks to `~/.claude/settings.json` (see [docs/SETUP.md](docs/SETUP.md)). This starts logging events immediately — everything else builds on this data.

### Step 2: Pick your lenses

| Lens | Install | What it does |
|------|---------|-------------|
| **`/remember`** | `ln -s .../skills/remember ~/.claude/skills/remember` | CLI search via bash + awk. No runtime deps. |
| **`/carto explore`** | `ln -s .../skills/carto ~/.claude/skills/carto` + `cd explorer && npm install` | Web UI with timeline, search, transcript viewer |
| **Qdrant** | See [docs/SETUP.md](docs/SETUP.md) | Adds semantic search to both lenses |
| **Briefings** | Copy `extras/briefings/` hook to settings | Auto-compiled project context on session start |

Or skip all skills and use the search script directly:
```bash
bash scripts/cartographer-search.sh "your query" --project myproject --limit 10
```

### Companion Explorer

Timeline with SSE live updates, BM25-scored search, transcript viewer with inline highlight. Every URL is a [permalink](docs/PERMALINK_SPEC.md): `/?q=shader&project=scrutinizer`.

```bash
cd session-cartographer/explorer && npm install && npm run dev
# API on :2526, UI on :2527
```

### Add to your CLAUDE.md

After installing, add this to your project or global `CLAUDE.md` so the agent knows to use cartographer:

```markdown
## Session History

Session Cartographer is installed. Two skills:
- `/remember <query>` — search past session history (decisions, research, fixes)
- `/carto explore` — open the Explorer web app for visual browsing

When you need context from a previous conversation, use `/remember`. The skill
runs BM25 + RRF search across event logs and transcripts. Don't freestyle grep
— the skill handles search automatically. Read the transcript path from results
to recover full conversation context.
```

### Extend your session history

Claude Code deletes transcripts after 30 days by default. Extend retention in `~/.claude/settings.json`:

```json
{
  "cleanupPeriodDays": 365
}
```

A year of event logs is ~8 MB. Scoring against it takes milliseconds. Your session history is the training data for your future workflow — keep it.

## What gets logged

| Hook | Triggers on | Captures |
|------|-------------|----------|
| `log-research.sh` | WebFetch, WebSearch | URLs, search queries, auto-categorization |
| `log-session-milestones.sh` | PreCompact, SessionEnd, SubagentStop | Session lifecycle with deep links |
| `log-tool-use.sh` | Edit, Write, Bash | File modifications, git commits, commands (opt-in: `CARTOGRAPHER_LOG_TOOL_USE=true`) |

### Backfill scripts

Hooks only capture events going forward. Three scripts index your existing history:

| Script | What it indexes | Source |
|--------|----------------|--------|
| `backfill-git-history.sh` | Git commits with messages, changed files, GitHub permalinks | `git log` across repos |
| `backfill-memories.sh` | Claude Code memory files (feedback, project notes, references) | `~/.claude/projects/*/memory/*.md` |
| `retro-index.sh` | Historical transcript content into Qdrant | `~/.claude/projects/*/*.jsonl` |

Claude's memory files are particularly valuable — curated, high-signal notes with structured frontmatter that survive across sessions but aren't searchable by default.

```bash
bash scripts/backfill-git-history.sh --since 2026-01-01
bash scripts/backfill-memories.sh
bash scripts/retro-index.sh --limit-days 30
```

## Semantic search (optional)

With a local Qdrant binary + llama.cpp embedding server, search adds vector similarity to the keyword pipeline. Both always run, results fuse via RRF. See [docs/SETUP.md](docs/SETUP.md). No Docker — two binaries, under 1GB total.

## Tradeoffs

**Speed vs. recall:** grep scans 2.7GB and finds everything (30-50s). Cartographer searches a 1.5MB index (sub-second, ranked) but only finds what hooks captured. Mitigations: `CARTOGRAPHER_LOG_TOOL_USE=true`, transcript grep fallback, Qdrant backfill.

**BM25 handles Latin scripts only.** Accented characters normalized (`résumé` → `resume`). CJK/RTL needs semantic search, which is multilingual natively.

**No stemming.** `shader*` for prefix matching. See [query rewrite roadmap](docs/query_rewrite_spec.md).

## Deep linking

Every search result carries a [`claude-history://`](docs/PERMALINK_SPEC.md) URI pointing into the source transcript. The Explorer resolves these as clickable links into its built-in transcript viewer. Other tools like [claude-code-history-viewer](https://github.com/jhlee0409/claude-code-history-viewer) can resolve them via `CARTOGRAPHER_VIEWER_PREFIX`. Fragment references (`#uuid-`, `#evt-`, `#t=`) for linking to specific conversation moments are on the [roadmap](docs/PERMALINK_SPEC.md#roadmap-fragment-references).

## See also

- [docs/PERMALINK_SPEC.md](docs/PERMALINK_SPEC.md) — `claude-history://` URI scheme, deep linking, fragment references
- [docs/LOG_SCHEMAS.md](docs/LOG_SCHEMAS.md) — Formal JSONL schemas for all event types
- [docs/RANK_FUSION.md](docs/RANK_FUSION.md) — BM25 + RRF scoring architecture
- [docs/SCORING.md](docs/SCORING.md) — What scores mean, when to chase a result
- [docs/CUSTOM_HOOKS.md](docs/CUSTOM_HOOKS.md) — Log your own events to the index
- [docs/SETUP.md](docs/SETUP.md) — Qdrant setup, cold start backfill, disk usage
- [docs/CHANGELOG_SPEC.md](docs/CHANGELOG_SPEC.md) — Event envelope format
- [docs/EXPLORER_SPEC.md](docs/EXPLORER_SPEC.md) — Explorer implementation architecture
- [docs/companion_explorer_spec.md](docs/companion_explorer_spec.md) — Explorer product spec
- [docs/landscape-survey.md](docs/landscape-survey.md) — 30+ Claude Code memory projects compared

## Uninstall

Remove the skill symlinks, hooks from settings.json, and optionally the JSONL event logs:

```bash
rm ~/.claude/skills/remember ~/.claude/skills/carto    # skill symlinks
# Remove hooks section from ~/.claude/settings.json (or delete the PostToolUse/PreCompact/SessionEnd/SubagentStop entries pointing to session-cartographer)
rm ~/Documents/dev/changelog.jsonl ~/Documents/dev/research-log.jsonl ~/Documents/dev/session-milestones.jsonl ~/Documents/dev/tool-use-log.jsonl   # event logs (optional — these are yours)
rm -rf ~/Documents/dev/session-cartographer              # the repo
```

A proper `scripts/uninstall.sh` that automates this is on the roadmap.

## Attribution

Search concept originated in a fork of [claude-code-session-bridge](https://github.com/PatilShreyas/claude-code-session-bridge) by Shreyas Patil (MIT License).

## License

MIT
