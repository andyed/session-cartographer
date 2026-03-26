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

Cartographer searches JSONL files created by Claude Code hooks:

| File | Contents |
|------|----------|
| `~/Documents/dev/changelog.jsonl` | Unified event index (all event types) |
| `~/Documents/dev/session-milestones.jsonl` | Session lifecycle events with deep links |
| `~/Documents/dev/research-log.jsonl` | Every WebFetch/WebSearch URL |
| `~/.claude/projects/*/*.jsonl` | Session transcripts (`--transcripts` flag) |

Paths are configurable via environment variables — see `scripts/remember-search.sh`.

## Usage

```
/remember TTM pooling regions
/remember that paper about foveated rendering
/remember what we decided about the shader approach
/remember the commit that fixed the blur kernel
```

Results include timestamps, project names, excerpts, and deep links for [claude-code-history-viewer](https://github.com/jhlee0409/claude-code-history-viewer) navigation.

## Roadmap

- [ ] Semantic search via embeddings (Qdrant integration)
- [ ] Session topology graph (which sessions touched which projects)
- [ ] Auto-generated energy viz from live event data
- [ ] CLI tool for non-plugin usage

## See also

- [docs/landscape-survey.md](docs/landscape-survey.md) — Survey of 30+ Claude Code memory/session projects and how Cartographer fits
- [docs/CHANGELOG_SPEC.md](docs/CHANGELOG_SPEC.md) — Event log format specification

## Attribution

Search concept originated in a fork of [claude-code-session-bridge](https://github.com/PatilShreyas/claude-code-session-bridge) by Shreyas Patil (MIT License).

## License

MIT
