# Session Cartographer

![Session Cartographer](docs/wordmark.png)

Search your Claude Code session history, or better yet, have Claude do it for you with `/remember`.

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

## How it works

Hooks log session events to append-only JSONL files (~1.5 MB for 3,000 events — a 1:2000 ratio to Claude's own transcript data).

```
Startup:  JSONL files → in-memory BM25 corpus (7 MB, built once)
Query:    tokenize → score 2,000 docs → sort → top N    (~1 ms)
Live:     fs.watch → addToIndex() → SSE push to UI      (real-time)
```

The CLI search path (`cartographer-search.sh`) uses pure awk for BM25 — no Node, no jq dependency.

## Companion Explorer

A local web app for browsing and searching session history visually. Timeline view with SSE live updates, search with BM25 scores and source indicators, and a transcript viewer with inline search and highlight.

```bash
cd session-cartographer/explorer && npm install && npm run dev
# API on :2526, UI on :2527
```

Search results link directly into transcripts — click any event card to read the full conversation context. Every URL is a permalink: `/?q=shader&project=scrutinizer`, `/session/<path>?highlight=foveation`.

## Install

```bash
git clone https://github.com/andyed/session-cartographer.git
claude install ./session-cartographer
```

`claude install` registers the `/remember` skill and event-logging hooks.

Or use the CLI search standalone (no install needed):
```bash
bash scripts/cartographer-search.sh "your query" --project myproject --limit 10
```

### Add to your CLAUDE.md

After installing, add this to your project or global `CLAUDE.md` so the agent knows to use cartographer:

```markdown
## Session History

Session Cartographer is installed as a Claude Code plugin. It provides:
- `/remember <query>` — search past session history (decisions, research, fixes)
- Hooks that automatically log events (web fetches, searches, compactions, file edits)

When you need context from a previous conversation, use `/remember`. The skill
runs BM25 + RRF search across event logs and transcripts. Don't freestyle grep
on transcript files — the skill handles search automatically.

Each search result includes a `transcript:` path pointing to the full session
JSONL file. Read that transcript to recover the complete conversation context
— the search result is the map, the transcript is the territory.
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

## Deep link viewer

Built-in transcript viewer at `:2527`, or use [claude-code-history-viewer](https://github.com/jhlee0409/claude-code-history-viewer) via `CARTOGRAPHER_VIEWER_PREFIX`.

## See also

- [docs/RANK_FUSION.md](docs/RANK_FUSION.md) — BM25 + RRF scoring architecture
- [docs/SCORING.md](docs/SCORING.md) — What scores mean
- [docs/CUSTOM_HOOKS.md](docs/CUSTOM_HOOKS.md) — Log your own events
- [docs/SETUP.md](docs/SETUP.md) — Qdrant setup, cold start backfill, disk usage
- [docs/landscape-survey.md](docs/landscape-survey.md) — 30+ Claude Code memory projects compared

## Attribution

Search concept originated in a fork of [claude-code-session-bridge](https://github.com/PatilShreyas/claude-code-session-bridge) by Shreyas Patil (MIT License).

## License

MIT
