# Migrating to Turn-Based Transcript Indexing

## What changed

Transcript indexing moved from **one document per JSONL line** to **one document per conversation turn** (a user prompt plus every assistant message up to the next user prompt). This pulls a question and its resolution into the same document, which is how BM25 and semantic retrieval both want to see it.

Inspired by Dropbox's [witchcraft/pickbrain](https://github.com/dropbox/witchcraft) — same chunking unit, but the implementation stays in awk (zero dependency) and keeps session-cartographer's Qdrant + event-log architecture.

## Impact by surface

| Surface | Action required | Why |
|---|---|---|
| CLI (`/remember`, `cartographer-search.sh`) | **None** | Preprocessor runs on-the-fly. Every transcript gets turn-grouped before BM25 scoring on every query. |
| Event logs (changelog, research-log, milestones, tool-use) | **None** | Unchanged. The event-log path is untouched. |
| Qdrant semantic index | **Recommended migration** | Legacy `hist-<sid>-<ts>` per-message points remain until you replace them. |
| Explorer UI / `/carto` | **Recommended migration** | Uses Qdrant for semantic. Same story as above. |

If you use the CLI only, you can stop reading.

## Qdrant migration (three commands)

### 1. Delete legacy per-message transcript points

```bash
curl -X POST 'http://localhost:6333/collections/session-cartographer/points/delete?wait=true' \
  -H "Content-Type: application/json" \
  -d '{"filter":{"must":[{"key":"event_id","match":{"text":"hist-"}}]}}'
```

This removes documents with `hist-<session>-<timestamp>` IDs. Turn-based points use `turn-<session>-<index>` and are untouched. Event logs, git commits, and synthesized tool events (`synth-*`, `git-*`, `evt-*`, `session-bound-*`) are untouched.

**Expected drop:** ~1,000–25,000 points depending on how much transcript history you've indexed.

### 2. Rebuild transcripts into Qdrant

```bash
PE_GATE_REJECT=2.0 bash scripts/retro-index.sh
```

The `PE_GATE_REJECT=2.0` override disables the prediction-error gate for this run. The gate normally skips near-duplicate events (cosine > 0.85), but turns are already deduplicated by deterministic `turn-<sid>-<idx>` IDs — the gate adds no value here and the semantic overlap between turn text and the existing `synth-*` tool-invocation points otherwise rejects most turns.

Restrict the window with `--limit-days 30` or `--project <name>` if you want a smaller first pass before committing to full history.

**Expected throughput:** ~10 seconds per substantive session. A 30-day window is 5–30 minutes depending on session size. Full history can be multi-hour — run it overnight.

### 3. (Optional) Refresh the rich reconstruction

```bash
node scripts/reconstruct-history.js
```

This re-runs the deeper pass: session-boundary milestones, synthesized `WebFetch`/`Bash`/`Edit` events, and (now) turn-based transcript events with filename and command recall baked into each turn's summary. Safe to run after step 2 — deterministic IDs mean no duplicates.

## Graceful skip

Doing nothing is fine. The only cost is that semantic search will return both legacy per-message points and new turn points until you clean up — you'll see near-duplicate results in the fused output. No data loss. No broken features.

## Verification

After step 2, sanity-check that turn points landed:

```bash
curl -sf 'http://localhost:6333/collections/session-cartographer/points/count' \
  -H "Content-Type: application/json" \
  -d '{"filter":{"must":[{"key":"event_id","match":{"text":"turn-"}}]},"exact":true}' \
  | python3 -c 'import sys,json; print("turn points:", json.load(sys.stdin)["result"]["count"])'
```

And legacy points are gone:

```bash
curl -sf 'http://localhost:6333/collections/session-cartographer/points/count' \
  -H "Content-Type: application/json" \
  -d '{"filter":{"must":[{"key":"event_id","match":{"text":"hist-"}}]},"exact":true}' \
  | python3 -c 'import sys,json; print("legacy points:", json.load(sys.stdin)["result"]["count"])'
```

## Rollback

If you want to revert, the per-message indexing code is preserved in git history before this change. `reconstruct-history.js` at an earlier commit will repopulate `hist-*` points. But there's no correctness reason to roll back — turn-based is a strict improvement.
