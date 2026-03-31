# GitHub Pages Demo Site

Static demo of Session Cartographer Explorer running against cached real search results. Deployable to `andyed.github.io/session-cartographer/`.

## Goal

Let people try the Explorer UI without installing anything. Shows timeline, search, faceted results, and transcript viewing — all from pre-computed results that faithfully represent what the real pipeline produces.

Secondary goal: the same cached result sets serve as **ground truth for search quality evaluation** — labeled relevance judgments for precision/recall measurement across search configurations (phrase matching, transcript fallback, time decay, etc.).

## Architecture

The live Explorer hits a Node API. The demo replaces API calls with static JSON fetches. No client-side search reproduction — results come from the real pipeline, cached at build time.

```
Build:  real pipeline → N queries → cached result JSON + event snapshots
Demo:   React → static JSON (pre-computed, faithful to real pipeline)
Live:   React → Express API → JSONL files + Qdrant
```

### Why cached results, not client-side BM25

Previous approach bundled a client-side BM25 scorer against demo data. Problems:
- **Fidelity gap** — client scorer would diverge from the real awk/JS BM25, RRF fusion, time decay, and transcript fallback. Demo results wouldn't match what users actually get.
- **No semantic** — Qdrant can't run in the browser. Demo would be keyword-only, missing half the pipeline.
- **Can't serve as truth data** — if the demo reproduces results differently than the real pipeline, it can't be used to evaluate search quality.

Cached results solve all three: faithful, include semantic, and directly usable as labeled ground truth.

## Data Pipeline

### Step 1: Define query set

`demo/queries.json` — curated queries spanning different search behaviors:

```json
[
  { "id": "q1", "query": "diff shape", "notes": "multi-word, event log hits" },
  { "id": "q2", "query": "facets", "notes": "transcript-only, no event log matches" },
  { "id": "q3", "query": "concurrent timeline", "notes": "feature work, recent" },
  { "id": "q4", "query": "BM25 scoring", "notes": "self-referential, tests dedup" },
  { "id": "q5", "query": "backfill git history", "notes": "3-word phrase" },
  { "id": "q6", "query": "session milestones", "notes": "infrastructure, broad matches" },
  { "id": "q7", "query": "fisheye autocomplete", "notes": "specific feature, narrow" },
  { "id": "q8", "query": "transcript viewer enrichment", "notes": "recent work, semantic helps" }
]
```

### Step 2: Run real pipeline, cache results

`scripts/build-demo-data.js`:

```bash
node scripts/build-demo-data.js
```

For each query in `demo/queries.json`:
1. Run `cartographer-search.sh` with `--limit 50`
2. Parse the structured output (facets + results)
3. Write to `demo/results/<query-id>.json`

Also snapshot:
- `demo/events.json` — recent events for the timeline view (from `/api/events`)
- `demo/sessions.json` — session groupings (from `/api/sessions`)

All paths and session IDs sanitized (replace `/Users/andyed/...` with generic paths, truncate UUIDs).

### Step 3: Build and deploy

```bash
cd explorer && VITE_DEMO=true npx vite build --base /session-cartographer/
npx gh-pages -d explorer/dist
```

## Explorer Demo Mode

When `import.meta.env.VITE_DEMO` is set:

- **Search** — user selects from a dropdown of pre-defined queries (or types freely, with closest-match suggestion). Fetches `demo/results/<query-id>.json` instead of hitting `/api/search`.
- **Timeline** — renders from `demo/sessions.json`. Static (no SSE).
- **Facets** — computed from cached result sets, same as live.
- **Transcript viewer** — include 1-2 sanitized transcript excerpts to demonstrate the viewer. Other transcript links show a "transcript not available in demo" placeholder.
- **Banner** — "Demo — viewing cached results from Session Cartographer's own development history. [Install for real data →](https://github.com/andyed/session-cartographer)"

## Ground Truth / Evaluation

The cached result sets double as truth data for search quality evaluation.

### Labeling

`demo/truth/<query-id>.json` extends each cached result with relevance judgments:

```json
{
  "query": "facets",
  "results": [
    { "event_id": "...", "relevant": true, "notes": "FacetBar.jsx implementation" },
    { "event_id": "...", "relevant": false, "notes": "mentions facets in unrelated context" },
    ...
  ],
  "expected_sessions": ["a40a6caa-...", "37b2b595-..."],
  "notes": "No event log matches — tests transcript fallback recall"
}
```

### Evaluation script

`scripts/eval-search.js` — runs queries against the live pipeline, compares against truth labels:

- **Precision@k** — what fraction of top-k results are relevant?
- **Recall** — what fraction of expected sessions were found?
- **Latency** — per-query timing
- **Source attribution** — what fraction came from keyword vs semantic vs transcript?

Run after any search pipeline change to measure impact:

```bash
node scripts/eval-search.js              # compare current pipeline vs truth
node scripts/eval-search.js --baseline   # save current results as new baseline
```

### What the truth data tests

| Query | Tests |
|-------|-------|
| "diff shape" | Event log BM25, multi-word matching |
| "facets" | Transcript fallback when event logs have zero hits |
| "concurrent timeline" | Recency bias (time decay), feature-specific recall |
| "BM25 scoring" | Self-referential dedup, keyword precision |
| "backfill git history" | Phrase-like query (3 words), precision vs bag-of-words noise |
| "session milestones" | Broad term, tests score cutoff quality |
| "fisheye autocomplete" | Narrow/specific, tests recall for rare terms |
| "transcript viewer enrichment" | Semantic search value-add over keyword-only |

## Pages Config

```yaml
# .github/workflows/deploy-demo.yml
name: Deploy Demo
on:
  push:
    branches: [main]
    paths: ['explorer/**', 'demo/**', 'scripts/build-demo-data.js']
  workflow_dispatch:  # manual trigger for data refresh
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: cd explorer && npm ci
      # Demo data is pre-built and checked in (no pipeline deps in CI)
      - run: cd explorer && VITE_DEMO=true npx vite build --base /session-cartographer/
      - uses: peaceiris/actions-gh-pages@v4
        with:
          github_token: ${{ secrets.GITHUB_TOKEN }}
          publish_dir: explorer/dist
```

Note: demo data is built locally and committed (requires the real pipeline + Qdrant). CI just builds the React app against the checked-in demo data.

## What's Testable in Demo

- Timeline with concurrent sessions, gap splitting, sky gradient
- Search with real BM25 + semantic results (cached)
- Faceted filtering (project, event type, source, time)
- Diff shape quadrant badges on git commits
- Commit type classification (`[feature]`, `[fix]`, etc.)
- Transcript viewer with token attribution (on included excerpts)
- Deep link URLs

## What's NOT in Demo

- Arbitrary queries (limited to pre-defined set)
- SSE live streaming
- Live Qdrant queries
- Full transcript corpus
