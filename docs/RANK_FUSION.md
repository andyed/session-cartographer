# Rank Fusion Search

## Problem

Session Cartographer searches 4+ heterogeneous sources: changelog, research log, milestones, and transcripts. Each source has different schemas and signal quality. Dumping results sequentially by source (changelog first, then research, then transcripts) gives poor ranking — a highly relevant transcript hit might appear after 15 irrelevant research log entries.

## Solution: Reciprocal Rank Fusion (RRF)

Each source produces a ranked list of matches. RRF combines them with:

```
RRF_score(item) = Σ 1/(k + rank_in_source)
```

Where `k=60` (standard constant from Cormack et al. 2009). Items appearing in multiple sources get boosted scores.

## Implementation

### Pipeline (all in bash + awk, no jq dependency for keyword path)

```
grep -in QUERY changelog.jsonl ─┐
grep -in QUERY research-log.jsonl ─┤  awk: extract fields,
grep -in QUERY milestones.jsonl ─┤  assign within-source rank
grep -in QUERY transcripts/*.jsonl ─┘  → TSV intermediate format
                                          │
                                    rank_fuse_and_display (awk)
                                          │
                                    ┌─────┴──────┐
                                    │ RRF scoring │
                                    │ dedup by key│
                                    │ sort by score│
                                    │ format output│
                                    └─────────────┘
```

### Intermediate TSV format

All sources — JSONL logs AND transcripts — emit the same format:

```
source \t rank \t key \t timestamp \t project \t summary \t extras
```

- **source**: `changelog`, `research`, `milestones`, `transcript:user`, `transcript:assistant`
- **rank**: within-source position (1 = best match in that source)
- **key**: unique identifier (event_id, milestone name, or uuid)
- **summary**: display text, extracted via field fallback chain (see below)
- **extras**: pipe-separated `key:value` pairs (url, deeplink, transcript path, session id)

Transcripts participate in fusion as equal citizens — they're not appended at the bottom. A highly relevant transcript excerpt can outrank a research log entry if it appears in multiple files or has a lower within-source rank.

### Field extraction: indexing vs. display

**Critical distinction:** indexing and display use fields differently.

**For BM25 indexing** (`explorer/server/bm25.js` and `bm25-search.awk`), all text fields are **concatenated** so every word is searchable:

```js
// bm25.js — extractSearchText()
[event.summary, event.description, event.display, event.prompt,
 event.url, event.query, event.title].filter(Boolean).join(' ')
```

```awk
// bm25-search.awk — get_search_text()
val = extract("summary") " " extract("description") " "
      extract("prompt") " " extract("url") " " extract("query")
```

**For display** (`EventCard.jsx`), fields have distinct roles — DO NOT put prompt in the summary fallback chain:

| Field | Display role | Example |
|-------|-------------|---------|
| `title` | Primary headline (if available) | "Abramov et al. (1991) - Color appearance..." |
| `summary` / `description` | Primary headline (fallback) | "Fetched: https://..." → parsed to domain+path |
| `prompt` | Context line (italic, below headline) | "What datasets does FixaTons include?" |
| `query` | Context line (italic, below headline) | "query: foveated rendering eccentricity" |
| `url` | Link icon + compact display | `arxiv.org/abs/2010.07399` |
| `files_changed` | Inline file list (commits) | `shader.frag, app.js` |

**The bug we fixed:** `prompt` was in the display fallback chain (`title || description || prompt`), so it became the headline. Then the "show prompt as context" check saw `prompt === summary` and hid it. The prompt should never be the headline — it's the "why was this fetched" context shown separately.

The `extract()` function uses awk pattern matching instead of jq:

```awk
function extract(json, field) {
    pat = "\"" field "\"[[:space:]]*:[[:space:]]*\""
    if (match(json, pat)) {
        val = substr(json, RSTART + RLENGTH)
        sub(/".*/, "", val)
        return val
    }
    return ""
}
```

No jq process spawned per line. Trade-off: won't handle escaped quotes in values, but event log fields (timestamps, event IDs, project names) are clean ASCII.

### Deduplication

Same event appearing in multiple sources (e.g., a research fetch logged in both `research-log.jsonl` and `changelog.jsonl`) is identified by matching `event_id` and scored once with accumulated RRF score. The `sources` field shows provenance: `[changelog+research]`.

### Event sources

The Explorer API loads events from these JSONL files (configured in `explorer/server/jsonl.js`):

| Key | File | Contents |
|-----|------|----------|
| `changelog` | `$DEV/changelog.jsonl` | Unified event index (all hook-generated events) |
| `research` | `$DEV/research-log.jsonl` | WebFetch/WebSearch with prompts, URLs, categories |
| `milestones` | `$DEV/session-milestones.jsonl` | Compactions, session ends, agent completions |
| `tool-use` | `$DEV/tool-use-log.jsonl` | File edits, bash commands, git commits |
| `claude-history` | `~/.claude/history.jsonl` | Claude Code's own session history index |

Events from multiple sources sharing the same `event_id` are **merged** (not replaced) — each field keeps whichever value is non-empty and longer. The `_source` label prefers the domain log over changelog.

### Language support

| Script | BM25 keyword | Semantic (Qdrant) |
|--------|-------------|-------------------|
| Latin (English, French, German, Spanish...) | Full support. Accented characters normalized via NFD (`résumé` → `resume`). | Full support. |
| CJK (Chinese, Japanese, Korean) | Not supported. Tokenizer strips non-Latin characters. | Full support (`mxbai-embed-large` is multilingual). |
| RTL (Arabic, Hebrew) | Not supported. | Full support. |
| Cyrillic (Russian, Ukrainian...) | Not supported. | Full support. |

The BM25 tokenizer (`/[^a-z0-9]+/`) operates on ASCII after NFD normalization. `LC_ALL=C` is set on grep/awk to avoid multibyte conversion errors — this means case-insensitive matching is ASCII-only.

For non-Latin content, semantic search is the path. If Qdrant isn't running, those events are invisible to keyword search but still exist in the JSONL logs for future indexing.

## Performance

On Andy's home machine (3,355 total events across 3 log files + ~200 transcript files):

- **Before (jq per source)**: ~2-4 seconds, sequential source dumps
- **After (awk rank fusion)**: ~1-2 seconds, unified ranked output

The bottleneck is transcript search (grep across many JSONL files). The 5-file cap on transcript search keeps this bounded.

## Limitations

1. **Within-source ranking is by file position**, not relevance. First grep match = rank 1. For chronologically-ordered logs this means oldest first, which may not be what the user wants. Semantic search (Qdrant path) provides true relevance ranking.

2. **Multi-word queries match as phrases**, not individual terms. `"TTM pooling regions"` won't match a line containing "TTM" and "pooling" separately. Consider splitting into OR matches in a future iteration.

3. **awk JSON extraction is fragile on nested objects or escaped quotes.** Fine for the flat JSONL schemas used by the hooks, but wouldn't handle arbitrary JSON. This is acceptable because we control the log format.

4. **Transcript content extraction truncates at 150 chars** and strips `\n`/`\t` escapes. Long messages lose context. The deep-link to the full transcript is the escape hatch.

## Code Generation Events

`log-tool-use.sh` captures Edit/Write/Bash events including file paths, git commits (with GitHub permalinks and changed files), and bash commands. Gated by `CARTOGRAPHER_LOG_TOOL_USE=true` at runtime — the hooks are always registered but the script exits early if the env var is unset.
