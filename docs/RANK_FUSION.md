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

```
source \t rank \t key \t timestamp \t project \t summary \t extras
```

- **source**: `changelog`, `research`, `milestones`, `transcript:user`, `transcript:assistant`
- **rank**: within-source position (1 = best match in that source)
- **key**: unique identifier (event_id, milestone name, or uuid)
- **extras**: pipe-separated `key:value` pairs (url, deeplink, transcript path, session id)

### Field extraction

Uses awk pattern matching instead of jq for speed:

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

This handles standard JSON field extraction without spawning a jq process per line. Trade-off: won't handle escaped quotes in values, but event log fields (timestamps, event IDs, project names) are clean.

### Deduplication

Same event appearing in multiple sources (e.g., a research fetch logged in both `research-log.jsonl` and `changelog.jsonl`) is identified by matching `event_id` and scored once with accumulated RRF score. The `sources` field shows provenance: `[changelog+research]`.

### Unicode handling

`LC_ALL=C` is set for both grep and awk to avoid multibyte conversion errors on emoji/unicode in JSONL content. Trade-off: case-insensitive matching (`-i`) becomes ASCII-only, but query terms are typically ASCII.

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
