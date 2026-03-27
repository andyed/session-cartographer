# Session Cartographer

Map your Claude Code session history. Find past decisions, research, and conversations. Recover context after missteps, compactions, or cold starts.

**Not a memory store.** Memory projects write facts forward into future sessions. Cartographer maps the territory of where you've been — searchable events, deep links, energy topology — so you can navigate back.

## Why

You're mid-session. The agent compacts, or you `/clear`, or you start a new conversation and need context from yesterday's work. The decision you made, the paper you found, the approach that worked. It's in your session history somewhere — but where?

```
/remember "the shader fix for foveation blur"
```

```
[2026-03-13 16:42] scrutinizer2025 session
  "The DoG sigma was computing in pixels instead of degrees — fixed by
   multiplying by ppd before the gaussian. Commit a3f91bc."
  deeplink: claude-history://session/...
  transcript: ~/.claude/projects/.../abc123.jsonl
```

Now you can read the transcript, recover the full reasoning, and keep going — or hand the deep link to a new session so it starts with that context.

## How it works

```
┌─────────────────────────────────────────────────────────┐
│                  Your Claude Code sessions               │
│  Session A        Session B        Session C             │
│  (scrutinizer)    (psychodeli)     (interests)           │
└─────┬──────────────────┬──────────────────┬──────────────┘
      │ hooks            │ hooks            │ hooks
      ▼                  ▼                  ▼
┌─────────────────────────────────────────────────────────┐
│                    Event Logs (JSONL)                     │
│                                                          │
│  changelog.jsonl ──── unified index, every event         │
│  session-milestones.jsonl ── compactions, agent stops    │
│  research-log.jsonl ──────── URLs fetched/searched       │
│  ~/.claude/projects/*/*.jsonl ── raw transcripts         │
│                                                          │
│  Each event has:                                         │
│    event_id ── unique ID (evt-abc123def456)              │
│    timestamp ── when it happened                         │
│    project ── which repo                                 │
│    deeplink ── claude-history:// URL                     │
│    summary ── human-readable description                 │
└──────────────────────┬──────────────────────────────────┘
                       │
          ┌────────────┼────────────┐
          ▼            ▼            ▼
   ┌────────────┐ ┌─────────┐ ┌──────────────┐
   │ /remember  │ │ Energy  │ │ Deep links   │
   │            │ │ Viz     │ │ to history   │
   │ keyword    │ │         │ │ viewer       │
   │ search now │ │ where   │ │              │
   │ semantic   │ │ energy  │ │ jump to the  │
   │ search     │ │ went    │ │ exact moment │
   │ later      │ │ over    │ │ in a past    │
   │            │ │ time    │ │ session      │
   └────────────┘ └─────────┘ └──────────────┘
```

### The `/remember` loop

```
 You: "What was that approach we tried for the pooling regions?"
  │
  ▼
 /remember pooling regions
  │
  ├── grep changelog.jsonl ──► event matches with summaries
  ├── grep milestones.jsonl ──► session context around the work
  ├── grep research-log.jsonl ──► papers/URLs you read at the time
  └── (--transcripts) grep session files ──► actual conversation text
  │
  ▼
 Results with timestamps, projects, excerpts, deep links
  │
  ▼
 Read the transcript ──► full reasoning recovered
  │
  ▼
 Continue where you left off, or hand context to a new session
```

## Install

```bash
claude install /path/to/session-cartographer
```

Or clone and install from local path:

```bash
git clone https://github.com/andyed/session-cartographer.git
claude install ./session-cartographer
```

## Event sources

The plugin registers hooks that automatically log session activity to JSONL files:

| Hook | Triggers on | Writes to |
|------|-------------|-----------|
| `log-research.sh` | WebFetch, WebSearch | `research-log.jsonl` + `changelog.jsonl` |
| `log-session-milestones.sh` | PreCompact, SessionEnd, SubagentStop | `session-milestones.jsonl` + `changelog.jsonl` |

`/remember` then searches across these files plus raw session transcripts:

| File | Contents |
|------|----------|
| `changelog.jsonl` | Unified event index (all event types) |
| `session-milestones.jsonl` | Session lifecycle events with deep links |
| `research-log.jsonl` | Every WebFetch/WebSearch URL with auto-categorization |
| `~/.claude/projects/*/*.jsonl` | Session transcripts (`--transcripts` flag) |

All log paths default to `~/Documents/dev/` but are configurable via `CARTOGRAPHER_DEV_DIR`. Transcript path configurable via `CARTOGRAPHER_TRANSCRIPTS_DIR`.

## Usage

Via the Claude Code plugin:
```
/remember TTM pooling regions
/remember that paper about foveated rendering
/remember what we decided about the shader approach
```

Or run the search script directly (no plugin install needed):
```bash
# Keyword search with Reciprocal Rank Fusion across all sources
bash scripts/cartographer-search.sh "foveated rendering" --project scrutinizer --limit 10
```

Results are ranked via awk-based RRF across changelog, research log, milestones, and transcripts — unified, deduplicated, scored. See [docs/RANK_FUSION.md](docs/RANK_FUSION.md).

Results include timestamps, project names, excerpts, and deep links for [claude-code-history-viewer](https://github.com/jhlee0409/claude-code-history-viewer) navigation.

## Semantic search

With Qdrant + llama.cpp embedding server running, `/remember` upgrades from keyword grep to vector similarity search. Falls back gracefully when services aren't available.

```bash
# Index your event logs
node scripts/embed-events.js

# Search directly
node scripts/semantic-search.js "that approach we tried for pooling regions"
```

See [docs/SETUP.md](docs/SETUP.md) for full setup (Qdrant binary + embedding model, no Docker, under 1GB total).

## Roadmap

- [ ] Session topology graph (which sessions touched which projects)
- [ ] Auto-generated energy viz from live event data
- [ ] Incremental indexing via hook (embed on write, not batch)
- [ ] CLI tool for non-plugin usage

## See also

- [docs/landscape-survey.md](docs/landscape-survey.md) — Survey of 30+ Claude Code memory/session projects and how Cartographer fits
- [docs/CHANGELOG_SPEC.md](docs/CHANGELOG_SPEC.md) — Event log format specification

## Attribution

Search concept originated in a fork of [claude-code-session-bridge](https://github.com/PatilShreyas/claude-code-session-bridge) by Shreyas Patil (MIT License).

## License

MIT
