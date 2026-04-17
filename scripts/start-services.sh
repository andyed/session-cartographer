#!/bin/bash
# Start Qdrant and llama-server for session-cartographer semantic search
# Usage: start-services.sh [--stop]

set -euo pipefail

QDRANT_PORT="${CARTOGRAPHER_QDRANT_PORT:-6333}"
EMBED_PORT="${CARTOGRAPHER_EMBED_PORT:-8890}"
QDRANT_STORAGE="${CARTOGRAPHER_QDRANT_STORAGE:-$HOME/Documents/dev/qdrant-storage}"
QDRANT_BIN="${CARTOGRAPHER_QDRANT_BIN:-qdrant}"
MODEL_PATH="${CARTOGRAPHER_EMBED_MODEL_PATH:-$HOME/.cache/llama-models/mxbai-embed-large-v1-f16.gguf}"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m'

log() { echo -e "${GREEN}[services]${NC} $1"; }
warn() { echo -e "${YELLOW}[services]${NC} $1"; }
err() { echo -e "${RED}[services]${NC} $1" >&2; }

is_running() {
    local port=$1
    lsof -i ":$port" >/dev/null 2>&1
}

wait_for_port() {
    local port=$1
    local name=$2
    local max_wait=30
    local waited=0

    while ! curl -sf "http://localhost:$port" >/dev/null 2>&1; do
        sleep 1
        waited=$((waited + 1))
        if [ $waited -ge $max_wait ]; then
            err "$name failed to start on :$port after ${max_wait}s"
            return 1
        fi
    done
    log "$name ready on :$port"
}

stop_services() {
    log "Stopping services..."

    if is_running "$QDRANT_PORT"; then
        pkill -f "qdrant.*--storage-path" 2>/dev/null || true
        log "Qdrant stopped"
    else
        warn "Qdrant not running"
    fi

    if is_running "$EMBED_PORT"; then
        pkill -f "llama-server.*$EMBED_PORT" 2>/dev/null || true
        log "llama-server stopped"
    else
        warn "llama-server not running"
    fi

    exit 0
}

start_services() {
    # Check prerequisites
    if ! command -v "$QDRANT_BIN" >/dev/null 2>&1; then
        err "qdrant binary not found. Install from https://qdrant.tech/documentation/guides/installation/"
        exit 1
    fi

    if ! command -v llama-server >/dev/null 2>&1; then
        err "llama-server not found. Install with: brew install llama.cpp"
        exit 1
    fi

    if [ ! -f "$MODEL_PATH" ]; then
        err "Embedding model not found at $MODEL_PATH"
        echo "Download with:"
        echo "  mkdir -p ~/.cache/llama-models"
        echo "  curl -L -o ~/.cache/llama-models/mxbai-embed-large-v1-f16.gguf \\"
        echo "    'https://huggingface.co/mixedbread-ai/mxbai-embed-large-v1/resolve/main/gguf/mxbai-embed-large-v1-f16.gguf'"
        exit 1
    fi

    # Start Qdrant
    if is_running "$QDRANT_PORT"; then
        warn "Qdrant already running on :$QDRANT_PORT"
    else
        log "Starting Qdrant..."
        mkdir -p "$QDRANT_STORAGE"
        nohup "$QDRANT_BIN" --storage-path "$QDRANT_STORAGE" >/dev/null 2>&1 &
        wait_for_port "$QDRANT_PORT" "Qdrant"
    fi

    # Start llama-server
    if is_running "$EMBED_PORT"; then
        warn "llama-server already running on :$EMBED_PORT"
    else
        log "Starting llama-server..."
        nohup llama-server \
            --model "$MODEL_PATH" \
            --port "$EMBED_PORT" \
            --embedding \
            --ctx-size 512 \
            -ngl 99 >/dev/null 2>&1 &
        wait_for_port "$EMBED_PORT" "llama-server"
    fi

    log "All services ready"
    echo ""
    echo "  Qdrant:       http://localhost:$QDRANT_PORT"
    echo "  Embeddings:   http://localhost:$EMBED_PORT"
    echo ""
    echo "Stop with: $0 --stop"
}

# Main
case "${1:-}" in
    --stop|-s)
        stop_services
        ;;
    --help|-h)
        echo "Usage: $0 [--stop]"
        echo ""
        echo "Start Qdrant and llama-server for semantic search."
        echo ""
        echo "Options:"
        echo "  --stop, -s    Stop running services"
        echo "  --help, -h    Show this help"
        echo ""
        echo "Environment variables:"
        echo "  CARTOGRAPHER_QDRANT_PORT       Qdrant port (default: 6333)"
        echo "  CARTOGRAPHER_EMBED_PORT        Embedding server port (default: 8890)"
        echo "  CARTOGRAPHER_QDRANT_STORAGE    Qdrant data directory"
        echo "  CARTOGRAPHER_QDRANT_BIN        Path to qdrant binary"
        echo "  CARTOGRAPHER_EMBED_MODEL_PATH  Path to embedding model GGUF"
        ;;
    "")
        start_services
        ;;
    *)
        err "Unknown option: $1"
        exit 1
        ;;
esac
