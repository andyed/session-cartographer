# Session Cartographer

![Session Cartographer](docs/wordmark.png)

Search your Claude Code session history. Find the decision, paper, or fix from last week's conversation.

## grep vs. cartographer

Default Claude Code search is `grep -r` on transcript files — raw JSON, no ranking, no event logs. Cartographer adds BM25 scoring, event log coverage, deduplication, and RRF fusion across sources.

Benchmark against session-cartographer's own development history (8 queries, 1,839 transcript files, 2.7GB):

```
                           ── grep ──        ── carto ──
Query                       hits    sec       hits     ms
─────────────────────────  ────── ──────     ────── ──────
"BM25 scoring"                 4   32.8         4    521
"rank fusion awk"              1   37.7         6    716
"session cartographer"         5   49.4        15    673
"hook log research"            1   45.9        15    585
"cold start"                  82   34.2         3    548
"Qdrant embedding"             7   35.4         0    491
"real-time indexing"           3   47.4        15    732
"JSONL event"                  5   46.8         1    564
─────────────────────────  ────── ──────     ────── ──────
TOTAL                        108  329.8s       59   4.8s
```

grep takes 33-49 seconds per query scanning 2.7GB of transcripts, returning raw JSONL blobs. Cartographer returns BM25-ranked, formatted results in under a second.

## How it works

Hooks log session events (web fetches, searches, compactions, file edits) to append-only JSONL files. The search script runs BM25 scoring across all logs + raw session transcripts, fuses results via Reciprocal Rank Fusion, and deduplicates by event ID. Optional Qdrant integration adds semantic search — results from both are fused through the same RRF pipeline.

```
Sessions → hooks → JSONL event logs → BM25 + RRF → ranked results
                                     ↗
              Qdrant (optional) ────┘
```

No jq dependency for the search path. The BM25 scorer and field extraction are pure awk.

## Install

```bash
git clone https://github.com/andyed/session-cartographer.git
claude install ./session-cartographer
```

Or use standalone (no plugin install needed):
```bash
bash scripts/cartographer-search.sh "your query" --project myproject --limit 10
```

## What gets logged

| Hook | Triggers on | Captures |
|------|-------------|----------|
| `log-research.sh` | WebFetch, WebSearch | URLs, search queries, auto-categorization |
| `log-session-milestones.sh` | PreCompact, SessionEnd, SubagentStop | Session lifecycle with deep links |
| `log-tool-use.sh` | Edit, Write, Bash | File modifications, commands (opt-in: `CARTOGRAPHER_LOG_TOOL_USE=true`) |

Transcripts (`~/.claude/projects/*/*.jsonl`) are also searched directly.

All paths configurable via `CARTOGRAPHER_DEV_DIR` and `CARTOGRAPHER_TRANSCRIPTS_DIR`.

## Semantic search (optional)

With a local Qdrant binary + llama.cpp embedding server, `/remember` adds vector similarity to the keyword pipeline. Both always run, results fuse via RRF. See [docs/SETUP.md](docs/SETUP.md). No Docker — two binaries, under 1GB total.

## Limitations

- **BM25 matches whole tokens, not substrings.** Searching `"shader"` won't match `"shaders"`. No stemming. Multi-word queries try exact phrase first, fall back to AND (all words present, any order) if too few results.
- **Hooks only capture what they're registered for.** Code decisions only appear in search if they hit a logged event or exist in a transcript. Pre-hook history is invisible to the fast JSONL path.
- **Transcript search is slow on large histories.** Capped at 5 files per search. Semantic indexing is the fix.
- **awk JSON extraction is fragile.** Works for the flat JSONL schemas we control. Escaped quotes in values will break field extraction.
- **Ranking is by BM25 score within source, then RRF across sources.** Not a relevance model — a document mentioning your query word 3 times scores higher than one mentioning it once, regardless of context.

## Deep link viewer

Cartographer includes a built-in transcript viewer (the Explorer at `:2527`), but you can also use [claude-code-history-viewer](https://github.com/jhlee0409/claude-code-history-viewer) as an alternate deep link handler. Set `CARTOGRAPHER_VIEWER_PREFIX` to route links to whichever viewer you prefer:

```bash
# Built-in Explorer (default)
CARTOGRAPHER_VIEWER_PREFIX="http://localhost:2527/session/"

# claude-code-history-viewer
CARTOGRAPHER_VIEWER_PREFIX="claude-history://session/"
```

**TODO:** Wire `CARTOGRAPHER_VIEWER_PREFIX` into `/remember` CLI output and EventCard links so the viewer is fully swappable.

## See also

- [docs/RANK_FUSION.md](docs/RANK_FUSION.md) — How BM25 + RRF scoring works
- [docs/SCORING.md](docs/SCORING.md) — What scores mean
- [docs/CUSTOM_HOOKS.md](docs/CUSTOM_HOOKS.md) — Log your own events
- [docs/landscape-survey.md](docs/landscape-survey.md) — Survey of 30+ Claude Code memory projects

## Attribution

Search concept originated in a fork of [claude-code-session-bridge](https://github.com/PatilShreyas/claude-code-session-bridge) by Shreyas Patil (MIT License).

## License

MIT
