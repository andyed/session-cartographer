# Setup Guide

Session Cartographer works with Claude Code, Codex, or both. Search itself has
two service levels:

1. **Keyword search only** — zero dependencies beyond bash + jq (ships with macOS)
2. **Semantic search** — requires Qdrant binary + llama.cpp embedding server

## Minimal Setup (keyword search)

```bash
# From an extracted GitHub release bundle (choose your agent)
codex plugin marketplace add "$PWD"
codex plugin add session-cartographer@session-cartographer

claude plugin marketplace add "$PWD"
claude plugin install session-cartographer@session-cartographer

# That's it. Hooks auto-register, /remember works with grep.
```

## Full Setup (semantic search)

### Quick start

Once dependencies are installed, start both services with:

```bash
bash scripts/start-services.sh
```

Stop with `bash scripts/start-services.sh --stop`.

### 1. Qdrant binary

Download from [qdrant.tech/documentation/guides/installation](https://qdrant.tech/documentation/guides/installation/):

```bash
# macOS (Apple Silicon)
curl -L https://github.com/qdrant/qdrant/releases/latest/download/qdrant-aarch64-apple-darwin.tar.gz | tar xz
chmod +x qdrant
sudo mv qdrant /usr/local/bin/  # or add to PATH
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
```

~670MB model, lightweight inference, fine on 16GB RAM.

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
| `CARTOGRAPHER_TRANSCRIPTS_DIR` | `~/.claude/projects` | Optional Claude transcript-root override; Codex history is also read from `~/.codex/sessions` |
| `CARTOGRAPHER_EMBED_URL` | `http://localhost:8890/v1/embeddings` | OpenAI-compatible embedding endpoint |
| `CARTOGRAPHER_EMBED_MODEL` | `mxbai-embed-large` | Embedding model name |
| `CARTOGRAPHER_QDRANT_URL` | `http://localhost:6333` | Qdrant REST endpoint |
| `CARTOGRAPHER_COLLECTION` | `session-cartographer` | Qdrant collection name |
| `CARTOGRAPHER_LOG_TOOL_USE` | `false` | Set `true` to log Edit/Write/Bash + git commits |
| `CARTOGRAPHER_REUSE_WEIGHT` | `0.3` | Promote-on-reuse activation weight (`0` disables) |
| `CARTOGRAPHER_FOCUS_ON_START` | `0` | Set `1` to auto-surface `/focus` orientation (related threads + maneuvers) on session start — opt-in, dormant by default |
| `CARTOGRAPHER_AUTO_CATCHUP` | `1` | Set `0` to disable the background Codex transcript catch-up on session start |
| `CARTOGRAPHER_CATCHUP_INTERVAL_SECONDS` | `900` | Minimum interval between successful automatic catch-up runs |
| `CARTOGRAPHER_CATCHUP_LIMIT_DAYS` | `7` | Recent transcript window scanned by automatic catch-up |
| `CARTOGRAPHER_GRAPH` | `$CARTOGRAPHER_DEV_DIR/cooccurrence-graph.json` | Where the co-occurrence graph JSON is written |
| `CARTOGRAPHER_CONFIG` | `~/.config/session-cartographer/config.json` | Provider-neutral settings shared by Claude Code and Codex |
| `CARTOGRAPHER_TURBO` | unset | Explicit `1`/`0` override for the persistent Turbo preference |
| `CARTOGRAPHER_TURBO_URL` | `http://127.0.0.1:2526` | Loopback recall endpoint; file transport is used when a sandbox blocks it |
| `CARTOGRAPHER_TURBO_TIMEOUT_MS` | `1500` | Warm request budget before portable fallback |
| `CARTOGRAPHER_SEARCH_CALL_LOG` | `$CARTOGRAPHER_DEV_DIR/.carto/search-calls.jsonl` | Backend-attributed Turbo call telemetry |

Set these in your shell profile or Claude Code settings for your work machine.

Turbo Mode should normally be configured once through
`/turbo enable` in Claude Code or `$session-cartographer:turbo` in Codex, rather
than by duplicating an environment variable in both agents' settings. The same
skill accepts `status` to inspect the shared preference and managed process, or
`disable` to turn it off and stop the managed headless service. Checkout
developers can call `node scripts/cartographer-turbo.js enable|status|disable`
directly.

When Turbo is active, the shared SessionStart hook gives the agent a concise
reminder to use `remember` or `focus` only when prior work matters. It does not
run a search or show a recurring user-facing banner. Exposure receipts are
deduplicated per session in `.carto/turbo-awareness.jsonl`; join their session
ids to search-call and access telemetry when evaluating whether awareness led
to useful recall.

### Codex hook trust

After installing or updating the Codex plugin, open an interactive Codex CLI,
run `/hooks`, and approve Session Cartographer. The desktop app does not
currently expose this review screen. On macOS, desktop-only users can launch the
bundled CLI at `/Applications/ChatGPT.app/Contents/Resources/codex`. Start a new
task after approval. Codex records trust against the hook definition hash, so a
later hook change requires review again.

## Cold Start: Backfilling History

On a fresh install, the JSONL event logs are empty — hooks only capture events
going forward. The backfill scripts can index existing Claude Code and Codex
history for immediate semantic search.

### Quick backfill (bash + awk)

```bash
# Index both providers (the default)
bash scripts/retro-index.sh --provider all

# Or backfill one provider
bash scripts/retro-index.sh --provider claude
bash scripts/retro-index.sh --provider codex

# Limit to recent history
bash scripts/retro-index.sh --limit-days 30

# Filter to a specific project
bash scripts/retro-index.sh --project scrutinizer
```

Groups each transcript into conversation turns (user prompt + assistant responses up to the next user prompt), then pipes one event per turn through `index-event.sh` → Qdrant. Deterministic `turn-<session>-<idx>` IDs — safe to rerun.

For Codex desktop sessions whose recorded cwd is only the shared workspace root,
the backfill attributes the session to the dominant repository workdir found in
its tool calls. Automatic runs are checkpointed and report their result in
`$CARTOGRAPHER_DEV_DIR/.carto/transcript-catch-up.jsonl`; indexing failures go
to `.carto/index-errors.jsonl` and keep the affected session retryable.
The first run after installing this attribution change intentionally reprocesses
recent Codex checkpoints once so deterministic point IDs repair old
`project=dev` payloads in place.
Embedding starts with a 1,200-character prefix and automatically retries at half
length for unusually token-dense turns; the full normalized turn remains in the
stored payload either way.

**Tip:** For a full rebuild (or the first migration to turn-based indexing), disable the prediction-error gate so every turn lands:

```bash
PE_GATE_REJECT=2.0 bash scripts/retro-index.sh
```

The PE gate normally skips near-duplicate events, but turns are already deduplicated by their deterministic IDs — the gate adds no value here and can reject legitimate turns whose content overlaps other point types (synthesized tool events, prior per-message transcript indexing).

### Deep reconstruction (Node.js)

```bash
node scripts/reconstruct-history.js
```

Does full transcript analysis: extracts tool_use blocks (WebFetch, WebSearch, Edit, Bash), synthesizes research events and session boundary milestones, and indexes everything into Qdrant. Provides richer search surface than the quick backfill.

**Note:** Both scripts require Qdrant + embedding server to be running. They index into the `session-cartographer` collection for semantic search. Keyword search (`/remember` via BM25) works against the JSONL logs, which only grow from hooks going forward — backfill is Qdrant-only.

### App-session metadata (desktop app / Cowork users)

```bash
node scripts/backfill-app-sessions.js --dry-run   # preview
node scripts/backfill-app-sessions.js             # append to changelog.jsonl
node scripts/embed-events.js                      # then index into Qdrant
```

Imports what the transcript pipeline never sees: human-readable session titles from the Claude desktop app, and Cowork sessions (VM-based, no local transcripts) whose title + initial prompt is the only recoverable record. Unlike the transcript backfills above, this writes `app_session` events into `changelog.jsonl`, so keyword search benefits too. Deterministic `app-<uuid>` IDs — safe to rerun.

## Recovering Orphaned Sessions (upgrading from before 0.5.0)

**Run this once if you used Session Cartographer before 0.5.0.** Skip it on a fresh install — there is nothing to repair.

Before 0.5.0 the skills resolved the active session from `CLAUDE_SESSION_ID`, a variable Claude Code never sets (the real one is `CLAUDE_CODE_SESSION_ID`). Records written by `/wrapup` and `/investigate` were stamped `session_id: "unknown"`, which then defeated the transcript lookup and left `transcript_path` empty. The synthesis paragraph survived and still turns up in `/remember` — but the conversation behind it became unreachable, so "read the transcript" hits nothing.

The hooks were never affected (they read the session from the hook payload, not the environment), which is what makes recovery possible: your milestone's sibling events are correctly attributed, so an orphan can be walked back to its session by project and time proximity.

```bash
node scripts/repair-orphan-sessions.js            # dry run — reports only
node scripts/repair-orphan-sessions.js --verbose  # + sample matches to eyeball
node scripts/repair-orphan-sessions.js --write    # repair (takes a .bak first)
```

Then reindex so semantic search picks up the new attribution:

```bash
grep '"repaired_by":"repair-orphan-sessions"' ~/Documents/dev/session-milestones.jsonl \
  | while IFS= read -r line; do printf '%s\n' "$line" | bash scripts/index-event.sh; done
```

**Read the dry run before writing.** Expect a mixed result — on the reference corpus (439 orphans) it recovered 33% with a verified transcript, refused 23% as ambiguous, and found 42% unrecoverable. Yours will differ: recovery depends on how many sessions you run concurrently (overlapping sessions in one project are harder to disambiguate) and how much of your history predates your transcripts' ~30-day TTL.

Records it cannot place confidently keep `session_id: "unknown"`. That is deliberate — a wrong session id is worse than a missing one, because it points `/remember` at an unrelated conversation and presents it as the real thing. The script refuses rather than guesses.

Nothing is modified without `--write`, and `--write` copies the file to `<name>.bak-YYYYMMDD` before touching it. Only repaired lines are rewritten.

## Verify Skills

Legacy symlink installs should expose all seven skills in `~/.claude/skills/`.
Managed plugin installs load them from the plugin cache instead. For a legacy
install, check the inventory and repair any missing link:

```bash
# Check which skills are installed
ls -la ~/.claude/skills/{remember,focus,carto,wrapup,investigate,trustmap,turbo} 2>&1

# Fix any missing one using its name from the list above
ln -s /path/to/session-cartographer/plugins/session-cartographer/skills/<skill> ~/.claude/skills/<skill>
```

All seven should be present. Turbo is `/turbo` in Claude Code and
`$session-cartographer:turbo` in Codex; it manages the shared optional recall
backend without requiring users to locate the installed cache.

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
