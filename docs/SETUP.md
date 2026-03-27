# Setup Guide

Session Cartographer works in two modes:

1. **Keyword search only** — zero dependencies beyond bash + jq (ships with macOS)
2. **Semantic search** — requires Qdrant binary + llama.cpp embedding server

## Minimal Setup (keyword search)

```bash
# Install the plugin
claude install /path/to/session-cartographer

# That's it. Hooks auto-register, /remember works with grep.
```

## Full Setup (semantic search)

### 1. Qdrant binary

Download from [qdrant.tech/documentation/guides/installation](https://qdrant.tech/documentation/guides/installation/):

```bash
# macOS (Apple Silicon)
curl -L https://github.com/qdrant/qdrant/releases/latest/download/qdrant-aarch64-apple-darwin.tar.gz | tar xz
chmod +x qdrant

# Start (stores data in ./storage by default)
./qdrant --storage-path ~/Documents/dev/qdrant-storage
```

Runs on port 6333 by default. No Docker needed.

### 2. Embedding server (llama.cpp)

```bash
# Install llama.cpp (if not already)
brew install llama.cpp

# Download the embedding model (~670MB)
mkdir -p ~/.cache/llama-models
curl -L -o ~/.cache/llama-models/mxbai-embed-large-v1-f16.gguf \
  "https://huggingface.co/mixedbread-ai/mxbai-embed-large-v1/resolve/main/gguf/mxbai-embed-large-v1-f16.gguf"

# Start the embedding server
llama-server \
  --model ~/.cache/llama-models/mxbai-embed-large-v1-f16.gguf \
  --port 8890 --embedding --ctx-size 512 -ngl 99
```

Runs on port 8890. ~670MB model, lightweight inference, fine on 16GB RAM.

### 3. Index your events

```bash
# First run — indexes all existing events
node scripts/embed-events.js

# Reindex from scratch
node scripts/embed-events.js --reindex
```

Run periodically or add to a cron/launchd to keep the index fresh.

### 4. Test it

```bash
# Semantic search
node scripts/semantic-search.js "foveated rendering paper"

# Via the plugin
/remember foveated rendering paper
```

## Environment Variables

All paths and endpoints are configurable:

| Variable | Default | Description |
|----------|---------|-------------|
| `CARTOGRAPHER_DEV_DIR` | `~/Documents/dev` | Where JSONL event logs live |
| `CARTOGRAPHER_TRANSCRIPTS_DIR` | `~/.claude/projects` | Where session transcripts live |
| `CARTOGRAPHER_EMBED_URL` | `http://localhost:8890/v1/embeddings` | OpenAI-compatible embedding endpoint |
| `CARTOGRAPHER_EMBED_MODEL` | `mxbai-embed-large` | Embedding model name |
| `CARTOGRAPHER_QDRANT_URL` | `http://localhost:6333` | Qdrant REST endpoint |
| `CARTOGRAPHER_COLLECTION` | `session-cartographer` | Qdrant collection name |

Set these in your shell profile or Claude Code settings for your work machine.

## Cold Start: Backfilling History

On a fresh install, the JSONL event logs are empty — hooks only capture events going forward. Two scripts backfill your existing Claude Code session history into the Qdrant index for immediate semantic search.

### Quick backfill (bash + jq)

```bash
# Index all historical transcripts into Qdrant
bash scripts/retro-index.sh

# Limit to recent history
bash scripts/retro-index.sh --limit-days 30

# Filter to a specific project
bash scripts/retro-index.sh --project scrutinizer
```

Extracts user/assistant messages from transcript JSONL files and pipes each through `index-event.sh` → Qdrant. Lightweight but only indexes message text.

### Deep reconstruction (Node.js)

```bash
node scripts/reconstruct-history.js
```

Does full transcript analysis: extracts tool_use blocks (WebFetch, WebSearch, Edit, Bash), synthesizes research events and session boundary milestones, and indexes everything into Qdrant. Provides richer search surface than the quick backfill.

**Note:** Both scripts require Qdrant + embedding server to be running. They index into the `session-cartographer` collection for semantic search. Keyword search (`/remember` via BM25) works against the JSONL logs, which only grow from hooks going forward — backfill is Qdrant-only.

## Disk Usage

Cartographer's own data is small. Your existing Claude Code transcripts are the bulk.

Cartographer adds very little to your filesystem relative to what Claude Code already generates.

**Event log overhead:** ~1:2000 ratio. For every 2 GB of Claude Code transcripts, cartographer's JSONL event logs add ~1 MB.

**Source files added to your project:** The plugin installs 3 hook scripts (~200 lines each) and 1 skill definition. The CLI search is 2 scripts (bash + awk, ~350 lines total). The Explorer is ~20 files / ~1,500 lines of JS+JSX. No files are added to your project repos — everything lives in the cartographer directory.

Reference from a heavy user (1,839 sessions, 3-5 concurrent daily, 40+ projects):

| Component | Size | Notes |
|-----------|------|-------|
| Claude Code transcripts | 2.9 GB | Not ours — Claude Code's own data |
| Cartographer event logs | 1.5 MB | changelog + research + milestones |
| Cartographer source | ~2 MB | All scripts, docs, plugin (excl. node_modules) |

## Resource Usage (runtime)

- **Qdrant**: ~50-100MB RAM for small collections (<50k events)
- **llama.cpp embedding**: ~670MB model + ~200MB runtime
- **Explorer server**: ~50-100MB RAM (in-memory BM25 index of ~3k events)
- **Total**: under 1GB for all services
- **Ports**: 2526 (API), 2527 (UI), 6333 (Qdrant), 8890 (embeddings)
