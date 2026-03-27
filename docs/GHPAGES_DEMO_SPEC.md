# GitHub Pages Demo Site

Static demo of Session Cartographer Explorer running against sample data. Deployable to `andyed.github.io/session-cartographer/`.

## Goal

Let people try the Explorer UI without installing anything. Shows timeline, search, and transcript viewing against synthetic session data from the project's own development history.

## Architecture

The live Explorer needs a Node API server (BM25, SSE, Qdrant proxy). The demo version replaces this with:

1. **Pre-computed static JSON** — BM25 index and search results baked at build time
2. **Client-side BM25** — the same `bm25.js` scoring runs in the browser against the bundled data
3. **No SSE** — timeline is static (no live updates in demo)
4. **No Qdrant** — keyword search only

```
Live:   React → Express API → JSONL files + Qdrant
Demo:   React → bundled JSON (pre-indexed at build time)
```

## Data Source

`tests/private/fixtures/collaboration-log.jsonl` — 21 synthetic events documenting this project's creation. This is the fixture data that already passes our test suite. Safe to publish (synthetic, no real session content).

For richer demo, also include a sanitized excerpt from the research log (replace personal paths/session IDs with generic placeholders).

## Build Pipeline

```bash
# 1. Generate demo data bundle from fixture JSONL
node scripts/build-demo-data.js

# 2. Build React app with demo data bundled
VITE_DEMO=true npx vite build --base /session-cartographer/

# 3. Deploy to gh-pages branch
npx gh-pages -d explorer/dist
```

### `scripts/build-demo-data.js`

Reads fixture JSONL, builds BM25 index (term frequencies, document frequencies, avg doc length), serializes to `explorer/src/demo-data.json`:

```json
{
  "events": [ ... ],
  "index": {
    "docs": { ... },
    "df": { ... },
    "avgdl": 12.3,
    "totalLength": 258
  }
}
```

### `explorer/src/api.js` changes

When `import.meta.env.VITE_DEMO` is set:
- `fetchEvents()` returns from the bundled JSON instead of `/api/events`
- `searchEvents()` runs BM25 client-side against the bundled index
- `fetchProjects()` extracts from bundled events
- SSE hook is a no-op (no live updates)

## Demo-Specific UI

- Banner at top: "Demo — viewing sample data from Session Cartographer's development. [Install for real data →](https://github.com/andyed/session-cartographer)"
- SSE status indicator hidden (no live connection)
- Transcript viewer shows synthetic conversation (the collaboration log events don't have real transcripts, so transcript links are disabled or show a placeholder)

## Pages Config

```yaml
# .github/workflows/deploy-demo.yml
name: Deploy Demo
on:
  push:
    branches: [main]
    paths: ['explorer/**', 'tests/private/fixtures/**', 'scripts/build-demo-data.js']
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: cd explorer && npm ci
      - run: node scripts/build-demo-data.js
      - run: cd explorer && VITE_DEMO=true npx vite build --base /session-cartographer/
      - uses: peaceiris/actions-gh-pages@v4
        with:
          github_token: ${{ secrets.GITHUB_TOKEN }}
          publish_dir: explorer/dist
```

## What's Testable in Demo

- Timeline with grouped events (the 21 collaboration log entries group into ~8 groups)
- Search with BM25 scoring (e.g., "RRF" returns ranked results)
- Project filter (all events are project: session-cartographer)
- Event type badges (decision, file_created, validation, bug)
- Dual-color source indicator (keyword only in demo, no semantic)
- Permalink URLs

## What's NOT in Demo

- SSE live streaming
- Semantic search (no Qdrant)
- Real transcript viewing (no transcript files)
- "Next 10" pagination (only 21 events)
