# Compressed Codex rollouts

Codex Desktop zstd-compresses a rollout in place about a week after its
session. `rollout-<ts>-<uuid>.jsonl` becomes `rollout-<ts>-<uuid>.jsonl.zst` in
the same directory (the live tree or `archived_sessions`), with its mtime kept.
On 2026-11-13 the newest compressed rollout on this machine was last written
2026-11-06 21:21 UTC and the oldest plain one 2026-11-06 23:38 UTC.

Until 2026-11-13 only `scripts/codex-call-evidence.js` read the compressed
spelling. Every other reader matched `*.jsonl`, so a Codex session older than a
week had no transcript as far as Session Cartographer could tell, and nothing
reported an error.

## What that cost (measured 2026-11-13, read-only)

Rollouts on disk, both Codex stores: 3,916, of which 270 plain and 3,646
compressed. No session had both spellings.

Codex sessions in the event logs (`changelog`, `session-milestones`,
`tool-use-log`, `research-log`; `provider: "codex"` or a `transcript_path`
under `.codex`; a resolved session id), by the time of their last event. Each
session's recorded paths and its session id were given to
`scripts/resolve-transcript.sh` as it stood before the fix:

| | last 30 days | last 90 days |
|---|---|---|
| Codex sessions | 1,132 | 1,550 |
| with a recorded `transcript_path` | 273 | 511 |
| resolved | 49 | 49 |
| unresolved | 1,083 | 1,501 |
| unresolved, `.jsonl.zst` on disk | 139 | 356 |
| unresolved, no rollout in either spelling | 944 | 1,145 |

Every one of the 139 and the 356 had a recorded path. The sessions with no
rollout at all are mostly Codex helper threads, which fire one hook and persist
nothing (859 of the 944 carry no recorded path either; see
`docs/standup-codex-threads-2026-10-27.md`). Counting only sessions with three
or more events, 128 of 242 unresolved (30 days) and 326 of 619 (90 days) had a
compressed rollout on disk.

`codexSessionIndex()` in `explorer/server/transcripts.js` returned 270 sessions
of the 3,916 on disk.

The ladder was emulated in Node for the count and checked against the real
script on 45 sampled needles (15 resolved, 15 compressed-only, 15 absent), with
no disagreement.

## After the fix

- The resolver returns the `.jsonl.zst` path for all 139 and all 356, from the
  recorded path and from the bare session id.
- `codexSessionIndex()` returns 3,916 of 3,916. One rebuild costs about 23 ms
  (6 ms before), cached for 30 s as before.
- On a scratch Explorer serving the live logs, `/api/sessions?days=90` listed
  947 Codex sessions, 369 of them with a transcript: 328 compressed, 41 plain.

## What reads the compressed spelling

`scripts/transcript-file.js` is the one decompressor (`readTranscriptText`,
`readTranscriptBuffer`, `transcriptStream`; Node `zlib` zstd, Node 22.15 or
newer). A path that ends in `.jsonl.zst` goes through it.

| Reader | Compressed rollout |
|---|---|
| `scripts/resolve-transcript.sh` | returns the `.zst` path; the plain file wins when both exist |
| `codexSessionIndex()`, `resolveTranscriptPath()` | same |
| `/api/transcript`, `/api/workmap` | decompressed |
| `/api/session/artifacts`, `/artifact`, `/document`, the image wall | decompressed |
| Memory Desk tokens, title and tool calls (`memory-transcript.js`) | inflated whole once, then answered from the parsed state |
| `/api/transcript/analysis` | answers 503 `TRANSCRIPT_COMPRESSED`; its parser reads Claude transcripts only |
| `cartographer-search.sh --get`, MCP `get` | `transcript_path_status: "compressed"`, and the MCP line says to read it with `zstd -dc` |
| `scripts/abandonment-report.js`, `scripts/codex-call-evidence.js` | decompressed |

On a Node without zlib zstd, and for a `.zst` file that does not decode, the
Explorer routes answer 503 `TRANSCRIPT_COMPRESSED` and the Memory Desk reports
the transcript as compressed. Neither says "not found" or "empty".

## Not covered

- **The transcript indexers** (`retro-index.sh`, `catch-up-transcripts.sh`)
  still walk `*.jsonl`. This costs nothing today: all 3,024 compressed rollouts
  in the live tree have a `retro-index-progress` checkpoint, because catch-up
  indexed them inside their first week, while they were plain. A full reindex
  (`retro-index.sh --fresh`, or a fresh install) would skip every compressed
  rollout, and that is the case that needs the change: `zstd -dc` into the turn
  grouper and the two `jq` passes, with a checkpoint keyed so a rollout indexed
  while plain is not indexed again under its `.zst` name.
- The indexer walks only the live tree. 45 of the 622 compressed rollouts in
  `archived_sessions` have no checkpoint: they were archived before catch-up
  reached them. That gap is older than compression.
- `cartographer-search.sh`'s keyword transcript fallback greps `*.jsonl`
  (`rg -z` would read `.zst` at a cost per query that has not been measured).
- Readers that open a path themselves, without the resolver:
  `session-digest.js`, `wrapup-coverage.js`, `infer-codex-project.js`,
  `standup-silence.js` (`codexThreadMeta`), `record-investigation.sh`,
  `repair-transcript-paths.js`. All work on sessions from the last few days,
  where rollouts are still plain; a digest of a session older than a week reads
  nothing from its transcript.

## Reproducing

```bash
find ~/.codex/sessions ~/.codex/archived_sessions -name 'rollout-*.jsonl' | wc -l
find ~/.codex/sessions ~/.codex/archived_sessions -name 'rollout-*.jsonl.zst' | wc -l
bash scripts/resolve-transcript.sh <session-id-older-than-a-week>
```

`tests/unit/compressed-rollouts.test.js` holds the behaviour. Against the code
before the fix, 10 of its 13 tests fail.
