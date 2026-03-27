# Session Cartographer Explorer

Interactive web UI for browsing, searching, and visualizing session history. Companion to the CLI `/remember` skill.

## Architecture

```
┌──────────────┐     SSE      ┌──────────────┐    fs.watch     ┌───────────────┐
│  React App   │◄────────────│  Node API    │◄──────────────│  JSONL files  │
│  :3001       │   /api/stream │  :3000       │                │  (changelog,  │
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

Data flow is strictly one-way: backend reads JSONL, pushes new events to the frontend. SSE is standard HTTP, works through proxies, requires no handshake protocol, and is trivial in React:

```js
const source = new EventSource('/api/stream');
source.onmessage = (e) => {
  const event = JSON.parse(e.data);
  dispatch({ type: 'NEW_EVENT', payload: event });
};
```

No socket.io, no ws library, no reconnection logic (SSE auto-reconnects).

### Why proxy Qdrant through Node

React app at :3001 cannot query Qdrant at :6333 directly — CORS will block it. The Node API at :3000 proxies semantic search:

```
React → GET /api/search?q=foveation&project=scrutinizer&limit=10
Node  → POST http://localhost:6333/collections/session-cartographer/points/search
Node  → POST http://localhost:8890/v1/embeddings (to embed the query)
Node  ← Qdrant results
React ← JSON response
```

The Node API also runs BM25 keyword search and fuses both via RRF — same logic as `cartographer-search.sh` but in JS for the API layer.

## Node API

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

1. Read new lines since last known offset
2. Parse each line with `JSON.parse()` wrapped in try/catch
3. **Silently skip incomplete lines** — Claude writes to these files in real-time, so the watcher may read a line mid-flush. Never crash on bad JSON. Retry on next file change.
4. Emit parsed events as SSE `data:` frames

```js
// Resilient line reader
function parseNewLines(buffer) {
  const lines = buffer.split('\n');
  const events = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      // Incomplete write — Claude is mid-flush. Skip, will catch on next change.
    }
  }
  return events;
}
```

Track file offsets to avoid re-reading the entire file on each change. Use `fs.stat()` to detect truncation (offset > file size = file was rotated).

### Search (`/api/search`)

1. Embed query via `POST http://localhost:8890/v1/embeddings`
2. Search Qdrant via `POST http://localhost:6333/collections/session-cartographer/points/search`
3. Run BM25 keyword search on JSONL files (port the awk logic to JS, or shell out to `cartographer-search.sh` and parse TSV output)
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
      "deeplink": "claude-history://...",
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

## React App

### Views

#### 1. Timeline (default)

Vertical event stream, most recent first. Each event card shows:
- Timestamp (relative: "2h ago", absolute on hover)
- Source badge (changelog, research, milestones, tool-use, transcript)
- Project tag (color-coded)
- Summary text
- Expandable: deep link, transcript path, URL

New events arrive via SSE and prepend to the top with a subtle animation. Show a "N new events" pill if user has scrolled down.

#### 2. Search

Full-width search bar. Results render inline as event cards (same component as timeline). Show source badges indicating which pipeline contributed (`[keyword]`, `[semantic]`, `[keyword+semantic]`).

Debounce at 300ms. Show loading state. Display `meta.duration_ms` and source counts.

Project filter as a dropdown populated from `/api/projects`.

#### 3. Energy (stretch)

Port of `energy-viz.html` — stacked area chart of events by project over time. Data from `/api/stats`. This is the "where did my attention go" view.

### Tech stack

- **React 19** + Vite
- **Tailwind CSS** — dark theme (matches energy-viz aesthetic)
- **No state library** — `useReducer` + context is enough for an event stream
- **No router** — tab switching, not pages

### File structure

```
explorer/
  src/
    App.jsx
    components/
      Timeline.jsx        — SSE-fed event stream
      Search.jsx           — search bar + results
      EventCard.jsx        — shared event display
      ProjectBadge.jsx     — color-coded project tag
      SourceBadge.jsx      — source indicator
    hooks/
      useEventStream.js    — SSE connection + reconnect
      useSearch.js         — debounced search with loading state
    api.js                 — fetch wrappers for Node API
  server/
    index.js               — Express server
    stream.js              — SSE + fs.watch logic
    search.js              — hybrid search (BM25 + Qdrant proxy)
    jsonl.js               — resilient JSONL reader
  package.json
  vite.config.js
```

## Environment

| Variable | Default | Description |
|----------|---------|-------------|
| `CARTOGRAPHER_DEV_DIR` | `~/Documents/dev` | JSONL log directory |
| `CARTOGRAPHER_QDRANT_URL` | `http://localhost:6333` | Qdrant endpoint |
| `CARTOGRAPHER_EMBED_URL` | `http://localhost:8890/v1/embeddings` | Embedding endpoint |
| `CARTOGRAPHER_EMBED_MODEL` | `mxbai-embed-large` | Embedding model |
| `CARTOGRAPHER_COLLECTION` | `session-cartographer` | Qdrant collection |
| `PORT` | `3000` | Node API port |

## Error handling

- **Qdrant down**: Search returns keyword-only results. Health endpoint reports `qdrant: false`. No errors in UI.
- **Embedding server down**: Same as Qdrant down — keyword only.
- **JSONL file missing**: Stream reports no events. Timeline shows cold start message.
- **Malformed JSONL line**: Silently skipped. Logged to stderr at debug level. Never crashes the server or corrupts the SSE stream.
- **JSONL file rotated/truncated**: Detected via offset > file size. Reset offset to 0.
- **SSE disconnection**: `EventSource` auto-reconnects. React hook handles reconnection state.

## What this is NOT

- Not a replacement for claude-code-history-viewer (which shows full transcripts with tool calls). This shows the *event index* — the map, not the territory.
- Not a memory editor. Read-only. Events are append-only JSONL.
- Not a multi-user tool. Single-machine, single-user. No auth.
