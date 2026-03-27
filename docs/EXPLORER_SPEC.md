# Session Cartographer Explorer

Interactive web UI for browsing, searching, and visualizing session history. Companion to the CLI `/remember` skill.

## Core UX: Remember vs. Explore

Two commands, two flow states:

### `/remember <query>`
Fast, mid-flow context recovery without leaving the terminal. BM25 + Qdrant RRF results in terminal text. Footer links into the Explorer:
```
Explore full context: http://localhost:2527/explore?q=<query>
```

### `/explore [query]`
Deep investigation while the agent is working. Opens the Explorer in browser via `open` command, pre-filtered to query. Same search backend, rich visual output.

Both commands hit the same search pipeline. `/remember` renders in terminal. `/explore` renders in browser.

## Architecture

```
┌──────────────┐     SSE      ┌──────────────┐    fs.watch     ┌───────────────┐
│  React App   │◄────────────│  Node API    │◄──────────────│  JSONL files  │
│  :2527       │   /api/stream │  :2526       │                │  (changelog,  │
│              │──────────────►│              │───────────────►│   research,   │
│  search bar  │  /api/search  │  Qdrant proxy│  localhost:6333 │   milestones) │
└──────────────┘               └──────────────┘                └───────────────┘
                                      │
                                      │ /v1/embeddings
                                      ▼
                               ┌──────────────┐
                               │  llama.cpp   │
                               │  :8890       │
                               └──────────────┘
```

### Why SSE, not WebSockets

Data flow is strictly one-way: backend reads JSONL, pushes new events to the frontend. SSE is standard HTTP, auto-reconnects, requires no library:

```js
const source = new EventSource('/api/stream');
source.onmessage = (e) => {
  const event = JSON.parse(e.data);
  dispatch({ type: 'NEW_EVENT', payload: event });
};
```

### Why proxy Qdrant through Node

React at :2527 cannot query Qdrant at :6333 directly — CORS. The Node API at :2526 proxies semantic search and runs BM25 keyword search, fusing both via RRF.

## Security

The Explorer has raw access to session transcripts. Local-only hardening:

1. **Localhost binding**: API and Vite servers bind to `127.0.0.1`, never `0.0.0.0`.
2. **Path traversal protection**: Transcript endpoint (`/api/transcript?path=...`) verifies the resolved path is a descendant of `CARTOGRAPHER_TRANSCRIPTS_DIR`. Reject anything reaching outside.
3. **XSS sanitization**: Transcript content rendered through DOMPurify before injection. Claude generates arbitrary code/markdown — treat it as untrusted.

## Node API (:2526)

### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/stream` | SSE stream of new events (real-time tail) |
| GET | `/api/search?q=...&project=...&limit=N` | Hybrid search (BM25 + semantic via Qdrant) |
| GET | `/api/events?project=...&since=...&limit=N` | Paginated event history |
| GET | `/api/projects` | List of all projects seen in logs |
| GET | `/api/stats` | Event counts by type, project, day |
| GET | `/api/health` | Service health (JSONL files exist, Qdrant status) |

### SSE stream (`/api/stream`)

Uses `fs.watch()` on the JSONL files. On file change:

1. Read new lines since last known byte offset
2. Parse each line with `JSON.parse()` in try/catch
3. **Silently skip incomplete lines** — Claude writes to these files in real-time, the watcher may read a line mid-flush. Never crash on bad JSON. The complete line will arrive on the next file change.
4. Emit parsed events as SSE `data:` frames

```js
function parseNewLines(buffer) {
  const lines = buffer.split('\n');
  const events = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      // Incomplete write — Claude is mid-flush. Skip.
    }
  }
  return events;
}
```

Track byte offsets per file. Detect truncation via `fs.stat()` (offset > file size = file was rotated → reset to 0).

### Search (`/api/search`)

1. Embed query via `POST http://localhost:8890/v1/embeddings`
2. Search Qdrant via `POST http://localhost:6333/collections/session-cartographer/points/search`
3. Run BM25 keyword search (shell out to `cartographer-search.sh` and parse TSV, or port awk logic to JS)
4. Fuse via RRF (k=60)
5. Return unified results

If Qdrant/embedding server is down, return keyword-only results. Never error on missing services.

```json
{
  "results": [
    {
      "event_id": "evt-abc123",
      "timestamp": "2026-03-13T20:45:00Z",
      "source": "research+semantic",
      "project": "scrutinizer2025",
      "summary": "Extract Nick Blauch's full explanation...",
      "score": 0.033,
      "url": "https://...",
      "deeplink": "http://localhost:2527/session/...",
      "transcript": "~/.claude/projects/.../abc.jsonl"
    }
  ],
  "meta": {
    "query": "pooling region approach",
    "keyword_count": 12,
    "semantic_count": 8,
    "fused_count": 15,
    "duration_ms": 47
  }
}
```

## Configurable Viewer Links

Deep link prefix is configurable via env var so `/remember` CLI output stays tool-agnostic:

```bash
# Use the Companion Explorer (default when explorer is running)
CARTOGRAPHER_VIEWER_PREFIX="http://localhost:2527/session/"

# Use claude-code-history-viewer instead
CARTOGRAPHER_VIEWER_PREFIX="claude-history://session/"
```

`/remember` prepends `CARTOGRAPHER_VIEWER_PREFIX` to transcript paths in its output. The search script doesn't hardcode a viewer.

## React App (:2527)

### Views

#### 1. Timeline (default)

Vertical event stream, most recent first. Each event card:
- Timestamp (relative, absolute on hover)
- Source badge (changelog, research, milestones, tool-use, transcript)
- Project tag (color-coded)
- Summary text
- Expandable: deep link, transcript path, URL

New events arrive via SSE, prepend with animation. "N new events" pill when scrolled down.

#### 2. Search

Full-width search bar with project filter dropdown (populated from `/api/projects`). Results as event cards. Source badges show pipeline contribution (`[keyword]`, `[semantic]`, `[keyword+semantic]`).

Debounce 300ms. Show `meta.duration_ms` and source counts.

#### 3. Energy (stretch)

Stacked area chart of events by project over time. Data from `/api/stats`.

#### 4. Session topology (roadmap, not 1.0)

Force-directed graph of session relationships. Which sessions touched which projects, when milestones handed context between sessions. `react-force-graph` when we get there.

### Tech stack

- **React 19** + Vite
- **Tailwind CSS** — dark theme
- **DOMPurify** — transcript content sanitization
- **No state library** — `useReducer` + context
- **No router** — tab switching, not pages

### File structure

```
explorer/
  src/
    App.jsx
    components/
      Timeline.jsx
      Search.jsx
      EventCard.jsx
      ProjectBadge.jsx
      SourceBadge.jsx
    hooks/
      useEventStream.js    — SSE connection + reconnect
      useSearch.js         — debounced search with loading
    api.js
  server/
    index.js               — Express, localhost-only
    stream.js              — SSE + fs.watch
    search.js              — hybrid search (BM25 + Qdrant proxy)
    jsonl.js               — resilient JSONL reader
  package.json
  vite.config.js
```

## Environment

| Variable | Default | Description |
|----------|---------|-------------|
| `CARTOGRAPHER_DEV_DIR` | `~/Documents/dev` | JSONL log directory |
| `CARTOGRAPHER_TRANSCRIPTS_DIR` | `~/.claude/projects` | Session transcripts |
| `CARTOGRAPHER_QDRANT_URL` | `http://localhost:6333` | Qdrant endpoint |
| `CARTOGRAPHER_EMBED_URL` | `http://localhost:8890/v1/embeddings` | Embedding endpoint |
| `CARTOGRAPHER_EMBED_MODEL` | `mxbai-embed-large` | Embedding model |
| `CARTOGRAPHER_COLLECTION` | `session-cartographer` | Qdrant collection |
| `CARTOGRAPHER_VIEWER_PREFIX` | `http://localhost:2527/session/` | Deep link prefix |
| `CARTOGRAPHER_API_PORT` | `2526` | Node API port |
| `CARTOGRAPHER_UI_PORT` | `2527` | React app port |

## Error handling

- **Qdrant down**: keyword-only results. Health reports `qdrant: false`. No UI errors.
- **Embedding server down**: same — keyword only.
- **JSONL file missing**: empty timeline, cold start message.
- **Malformed JSONL line**: silently skipped, stderr debug log. Never crashes server or SSE stream.
- **JSONL file rotated/truncated**: offset > size → reset to 0.
- **SSE disconnection**: `EventSource` auto-reconnects. React hook shows reconnection state.

## What this is NOT

- Not a transcript reader (that's claude-code-history-viewer). This shows the event index — the map, not the territory. Transcript depth will iterate.
- Not a memory editor. Read-only. Events are append-only JSONL.
- Not a multi-user tool. Single-machine, single-user. No auth beyond localhost binding.
