# Provider Architecture

Session Cartographer has no process-wide Claude or Codex mode. Claude Code and
Codex are concurrent producers and consumers of one shared memory plane.

```text
Claude hooks ──> Claude adapter ──┐
                                 ├─> normalized JSONL turns/events
Codex hooks ───> Codex adapter ──┘              │
                                                ├─> BM25
                                                ├─> Qdrant + RRF
                                                └─> Explorer
```

## Invariants

1. **Provider is provenance, not partitioning.** Every new event or normalized
   turn carries `provider: "claude" | "codex" | "hermes" | "antigravity" | "unknown"`. All providers use
   the same logs, Qdrant collection, scoring, and Explorer index.
2. **Consumers search across providers by default.** Claude can recall Codex
   work and Codex can recall Claude work. Provider filters are optional facets,
   never implicit silos.
3. **Raw formats stop at adapters.** Claude and Codex transcript wire formats
   are independently owned and may change. Their adapters emit the stable
   Cartographer turn schema; downstream ranking code never branches on raw
   transcript structure.
4. **No mutable mode file.** Hook invocations detect their provider from the
   transcript path and provider-specific payload fields. This is safe when both
   agents are working at once.
5. **Unknown is preferable to a false label.** Custom hook producers may set
   `CARTOGRAPHER_PROVIDER=claude|codex|antigravity`; otherwise ambiguous inputs are stored
   as `unknown` and remain searchable.

## Boundaries

| Boundary | Claude | Codex | Antigravity | Shared output |
|---|---|---|---|---|
| Plugin manifest | `.claude-plugin/plugin.json` | `.codex-plugin/plugin.json` | `.antigravity-plugin/plugin.json` + root `hooks.json` + `mcp_config.json` | Same skills, MCP, and hooks |
| Transcript root | `~/.claude/projects` | `~/.codex/sessions` (+ `archived_sessions`) | `~/.gemini/antigravity/brain` (+ `-ide`/`-cli`) | Normalized `transcript` events |
| Turn adapter | `transcript-to-turns.awk` | `codex-transcript-to-turns.awk` | `antigravity-transcript-to-turns.awk` | One JSON object per user turn |
| Natural end | `SessionEnd` | No equivalent currently | No equivalent currently | Provider-specific lifecycle event |
| Turn completion | `Stop` | `Stop` | `Stop` (via `antigravity-hook-bridge.cjs`) | Turn milestone; ignored for Claude to avoid duplication |
| File edit tools | `Edit`, `Write` | `apply_patch` | `edit_file`, `write_file`, `replace_file_content` | `tool_file_edit` |
| Web tools | `WebFetch`, `WebSearch` | built-in web/MCP tools | `search_web`, `read_url_content`, `fetch_url` | research events |

Codex hook transcripts are a convenience interface, not a stable public wire
format. Keep the Codex parser isolated and fixture-tested.

## Provider selection

Normal use requires no selection:

- Hooks auto-detect the producer for each event.
- `cartographer-search.sh` searches both raw transcript roots when
  `--transcript` is explicitly enabled.
- `retro-index.sh` backfills both roots into the same Qdrant collection.

Administrative backfills can be scoped without changing consumer behavior:

```bash
bash scripts/retro-index.sh --provider all
bash scripts/retro-index.sh --provider claude
bash scripts/retro-index.sh --provider codex
bash scripts/retro-index.sh --provider antigravity
```

Provider-specific root overrides are:

```text
CARTOGRAPHER_CLAUDE_TRANSCRIPTS_DIR
CARTOGRAPHER_CODEX_TRANSCRIPTS_DIR
CARTOGRAPHER_ANTIGRAVITY_TRANSCRIPTS_DIR
```

`CARTOGRAPHER_TRANSCRIPTS_DIR` remains a backwards-compatible alias for the
Claude root.

## Stable normalized turn schema

```json
{
  "event_id": "turn-codex-<session>-<index>",
  "timestamp": "2026-07-13T18:00:00Z",
  "project": "session-cartographer",
  "type": "transcript",
  "provider": "codex",
  "summary": "user prompt and retained assistant/tool text",
  "transcript_path": "/absolute/provider-owned/path.jsonl",
  "session": "<provider session id>",
  "turn_idx": 1
}
```

Claude retains its existing deterministic `turn-<session>-<index>` IDs for
backwards compatibility. Codex IDs include the provider prefix so a coincident
session identifier cannot overwrite another provider's Qdrant point.
