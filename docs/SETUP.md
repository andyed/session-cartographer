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

## Resource Usage

- **Qdrant**: ~50-100MB RAM for small collections (<50k events)
- **llama.cpp embedding**: ~670MB model + ~200MB runtime
- **Total**: under 1GB for both services
- **Disk**: Qdrant storage grows ~1KB per event; negligible for session logs
