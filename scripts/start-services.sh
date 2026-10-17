#!/bin/bash
# Start Qdrant and llama-server for session-cartographer semantic search
# Usage: start-services.sh [--stop]

set -euo pipefail

QDRANT_PORT="${CARTOGRAPHER_QDRANT_PORT:-6333}"
EMBED_PORT="${CARTOGRAPHER_EMBED_PORT:-8890}"
QDRANT_STORAGE="${CARTOGRAPHER_QDRANT_STORAGE:-$HOME/Documents/dev/qdrant-storage}"
# The clients look here too (scripts/qdrant-auth.sh, qdrant-auth.js), so a key
# provisioned below reaches every one of them with nothing exported.
QDRANT_KEY_FILE="${CARTOGRAPHER_QDRANT_API_KEY_FILE:-$QDRANT_STORAGE/api-key}"
MODEL_PATH="${CARTOGRAPHER_EMBED_MODEL_PATH:-$HOME/.cache/llama-models/mxbai-embed-large-v1-f16.gguf}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./qdrant-auth.sh
. "$SCRIPT_DIR/qdrant-auth.sh"

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

    # Qdrant answers / without a key, so this probe works before and after
    # the API key is set.
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

# Sets QDRANT_KEY to the key Qdrant will be started with, and leaves it in
# QDRANT_KEY_FILE (mode 600) for the clients. CARTOGRAPHER_QDRANT_API_KEY wins
# when set and is written to the file, so a key supplied once at start still
# reaches clients that never see that variable. Otherwise the file's key is
# reused, and only a first start generates one. The key is never echoed: logs
# name the file, not its contents.
provision_qdrant_key() {
    CARTOGRAPHER_QDRANT_API_KEY_FILE="$QDRANT_KEY_FILE"
    cartographer_qdrant_auth "http://127.0.0.1:$QDRANT_PORT"
    QDRANT_KEY="$CARTOGRAPHER_QDRANT_KEY"
    if [ -z "$QDRANT_KEY" ]; then
        # 32 random bytes as 64 hex characters: no shell, YAML or header
        # metacharacters, and od is in every POSIX base system.
        QDRANT_KEY=$(LC_ALL=C od -An -tx1 -N32 /dev/urandom | tr -d ' \n')
        if [ "${#QDRANT_KEY}" -ne 64 ]; then
            err "Could not generate a Qdrant API key from /dev/urandom"
            exit 1
        fi
        log "Generated a Qdrant API key in $QDRANT_KEY_FILE"
    fi
    # The key is interpolated into YAML and sent as a header, so refuse
    # anything outside the token characters rather than quote around it.
    case "$QDRANT_KEY" in
        *[!A-Za-z0-9._~+/=-]*)
            err "CARTOGRAPHER_QDRANT_API_KEY (or $QDRANT_KEY_FILE) holds characters outside A-Z a-z 0-9 . _ ~ + / = -"
            exit 1
            ;;
    esac
    local existing=""
    [ -f "$QDRANT_KEY_FILE" ] && { IFS= read -r existing < "$QDRANT_KEY_FILE" || true; }
    if [ "$existing" != "$QDRANT_KEY" ]; then
        mkdir -p "$(dirname "$QDRANT_KEY_FILE")"
        # umask in a subshell so the file is never readable by others, not
        # even between creation and a later chmod; mv makes the swap atomic.
        local tmp="$QDRANT_KEY_FILE.tmp.$$"
        ( umask 077 && printf '%s\n' "$QDRANT_KEY" > "$tmp" ) && mv -f "$tmp" "$QDRANT_KEY_FILE"
    fi
    chmod 600 "$QDRANT_KEY_FILE"
}

stop_services() {
    log "Stopping services..."

    if is_running "$QDRANT_PORT"; then
        pkill -f "qdrant" 2>/dev/null || true
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
        # Not started here, so its config is not ours to rewrite. Say when it
        # takes keyless requests: that Qdrant accepts blind writes from any web
        # page (see provision_qdrant_key and the config comment below).
        if curl -sf "http://127.0.0.1:$QDRANT_PORT/collections" >/dev/null 2>&1; then
            warn "It accepts requests without an API key. Set service.api_key (or QDRANT__SERVICE__API_KEY) on it to close blind writes."
        fi
    else
        log "Starting Qdrant..."
        mkdir -p "$QDRANT_STORAGE"

        # Generate config file with custom storage path.
        # enable_cors is false because no browser talks to Qdrant: the Explorer
        # proxies semantic search through Node (explorer/server), and every
        # other client is a script. Qdrant here has no API key, and its CORS
        # reflects any Origin, so leaving it on (Qdrant's default) lets any web
        # page the browser opens try to read the corpus from :6333. Off stops
        # reads, not blind writes: Qdrant 1.12.1 parses a text/plain POST, which
        # needs no preflight, as JSON. Only an API key closes that, so one is
        # always set: with service.api_key the same POST gets 401, as does the
        # preflight a page would need to add an api-key header itself
        # (measured on 1.12.1, 2026-10-16). Every client sends the header
        # (scripts/qdrant-auth.js, qdrant-auth.sh). The config holds the key,
        # so it is written mode 600 like the key file.
        provision_qdrant_key
        local config_file="$QDRANT_STORAGE/config.yaml"
        ( umask 077 && cat > "$config_file" ) <<EOF
storage:
  storage_path: $QDRANT_STORAGE/data
  snapshots_path: $QDRANT_STORAGE/snapshots
service:
  host: 127.0.0.1
  http_port: $QDRANT_PORT
  grpc_port: $((QDRANT_PORT + 1))
  enable_cors: false
  api_key: "$QDRANT_KEY"
telemetry_disabled: true
EOF
        # umask only governs creation; a config left by an earlier version of
        # this script keeps its old mode unless it is narrowed here.
        chmod 600 "$config_file"

        nohup qdrant --config-path "$config_file" >/dev/null 2>&1 &
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
    if [ -n "${QDRANT_KEY:-}" ]; then
        echo "  Qdrant key:   $QDRANT_KEY_FILE (clients read it; nothing to export)"
    fi
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
        echo "  CARTOGRAPHER_QDRANT_API_KEY    Qdrant API key (default: generated on first start)"
        echo "  CARTOGRAPHER_QDRANT_API_KEY_FILE  Where the key is kept (default: \$CARTOGRAPHER_QDRANT_STORAGE/api-key)"
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
