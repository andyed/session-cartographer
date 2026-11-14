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
| `scripts/retro-index.sh` (and `catch-up-transcripts.sh`, which runs it) | streamed through `zstd -dc`, from the live tree and the archive; skipped as already indexed when its checkpoint was written while it was plain |
| `scripts/infer-codex-project.js` | a `.zst` path through `transcript-file.js`; rows on stdin (`-`) from the indexer |
| `cartographer-search.sh --transcript` | searched with `rg -z`, into the slots plain transcripts left |
| `scripts/repair-transcript-paths.js` | counted as on disk, never rewritten |

On a Node without zlib zstd, and for a `.zst` file that does not decode, the
Explorer routes answer 503 `TRANSCRIPT_COMPRESSED` and the Memory Desk reports
the transcript as compressed. Neither says "not found" or "empty".

## The indexer (measured 2026-11-13, read-only)

`retro-index.sh` matched `*.jsonl` under the live tree. Its checkpoint key is
`codex <session id> <mtime> <project>` in `.carto/retro-index-progress`, and
compression keeps the mtime, so a rollout indexed while plain stays
checkpointed under its `.zst` name. Rollouts with a checkpoint at their current
mtime:

| store, spelling | rollouts | checkpointed | checkpoint from an earlier write | never indexed |
|---|---|---|---|---|
| live, compressed | 3,024 | 3,024 | 0 | 0 |
| live, plain | 251 | 251 | 0 | 0 |
| archive, compressed | 622 | 396 | 181 | 45 |
| archive, plain | 19 | 4 | 14 | 1 |

So compression had cost the live tree nothing yet: catch-up indexes a rollout
inside its first week. A `--fresh` reindex or a new install would have passed
over 3,646 of the 3,916 Codex rollouts.

The archive was the larger gap, and it is older than compression. The script
declared `CODEX_ARCHIVED` and never walked it. A session that is archived
between its last turn and the next catch-up keeps the checkpoint of an earlier
write: for the 195 such rollouts the last index trailed the last write by
under a minute in 12, under an hour in 108, under a day in 65 and longer in
10. With the 46 never indexed, 241 of the 641 archived rollouts were not
indexed at their last write. They hold 3,032 turns (148 in the 15 plain ones,
2,884 in the 226 compressed); 18 of them hold no turn at all.

After the change the indexer walks both stores in both spellings:

- A compressed rollout with a checkpoint at its mtime is skipped from its name
  alone, before anything opens it.
- One without is tested (`zstd -t`), then streamed to the two `jq` passes, the
  project inferer and the turn grouper. The turn's `transcript_path` is the
  path on disk, `.zst` included.
- With no `zstd` binary, or a file that does not decompress, the rollout is
  named on its own line, counted on the summary line (`…; 3 compressed
  rollout(s) not read (zstd not installed).`), and left uncheckpointed. The
  run still exits 0, so a missing tool does not void the catch-up cooldown.
- A plain file beside its compressed twin is the one read.

The archive was then indexed on this machine, the same day, with the script
from the repository: `retro-index.sh --provider codex` with
`CARTOGRAPHER_CODEX_TRANSCRIPTS_DIR` pointed at a directory that does not
exist, so only the archive was walked, and catch-up's settings
(`TURN_BODY_MAX=1200`, novelty gate off). 241 rollouts, 3,032 turns, no turn
failure, 34 minutes. Afterwards all 641 archived rollouts had a checkpoint at
their mtime, and every expected turn id of the 241 was in Qdrant carrying the
archive path this run recorded (3,032 of 3,032, counted per session from the
rollouts, not from the indexer's own total). The collection went from 264,803
to 267,778 points while other sessions' hooks were writing to it too.

On another install, catch-up (`--limit-days 7`) picks up the plain archived
rollouts still inside its window; compressed ones are older than that window
and need the same one run without `--limit-days`.

## The other readers (measured 2026-11-13, read-only)

**Keyword transcript fallback** (`cartographer-search.sh --transcript`). It
lists the first 20 files that hold the query, Claude transcripts first, then
plain Codex rollouts. Compressed rollouts are 14.6 of the 15.8 GiB of Codex
text. `rg -z` over all 3,646 took 3.3 to 3.9 s at a load average of 15 to 25
(the plain scan of both stores: about 2.2 s). The flag appears in 4 of the
1,867 logged invocations of the script. Two of those four filled their 20
slots from plain transcripts. One (`Jarvis`) found 9 files while 15 compressed
rollouts held the word. So compressed rollouts are now scanned last, and only
when slots are free: `Jarvis` returns 20 files, 11 of them compressed, in 6.1 s
(5.4 s before); a query with free slots and no compressed match pays the whole
scan (1.7 s to 4.8 s); a query that fills its slots pays nothing. Without both
`rg` and `zstd` the compressed rollouts are counted on stderr and not read.

**`repair-transcript-paths.js`.** Its dry run reported 194,747 Codex records
"missing and unresolved". 194,535 of them named a rollout that was on disk
compressed (140,610 beside the recorded name, 53,925 in the archive) and 212
named one that was gone. In Qdrant payloads: 25,702 and 2. The script now
counts the compressed ones apart. It still does not rewrite them: the resolver
tries both spellings at the recorded path and at the archive, and a rewrite of
most of the corpus would be stale again the next week.

**Checked, no change needed.**

- `session-digest.js` and `wrapup-coverage.js` open no transcript. Both read
  the event logs and use `transcript_path` only as a string, to guess a
  provider or to report it.
- `standup-silence.js` (`codexRollouts`, `codexThreadMeta`) reads rollouts
  written inside the standup window, from the last eight dated directories.
  The newest compressed rollout was last written 6.9 days before the
  measurement. Of 359 logged standup runs the widest window was three days,
  and the default is six hours. A window past a week would miss the compressed
  helper threads of its oldest day.
- `record-investigation.sh` looks up the rollout of the session that is
  running it, which is being written and is therefore plain.

## Not covered

- The installed plugin runs its own copy of the indexer. Until it carries this
  change, catch-up walks the live tree only, and a session archived before its
  next catch-up falls behind again.
- A turn indexed from a compressed rollout records the `.jsonl.zst` path; one
  indexed while plain keeps the `.jsonl` path. Both go through the resolver.
- `wrapup`'s SKILL.md and `record-investigation.sh` find the current session's
  rollout with `-name '*<id>*.jsonl'`. Not measured for a Codex session
  resumed more than a week after its last write.
- The hint `cartographer-search.sh` prints when no event log exists suggests a
  `grep --include='*.jsonl'`, which reads plain transcripts only.
- `standup-silence.js` at a window longer than a week, as above.

## Reproducing

```bash
find ~/.codex/sessions ~/.codex/archived_sessions -name 'rollout-*.jsonl' | wc -l
find ~/.codex/sessions ~/.codex/archived_sessions -name 'rollout-*.jsonl.zst' | wc -l
bash scripts/resolve-transcript.sh <session-id-older-than-a-week>
```

```bash
# checkpoint coverage: every rollout whose "codex <id> <mtime> " prefix is absent
# from $CARTOGRAPHER_DEV_DIR/.carto/retro-index-progress
node scripts/repair-transcript-paths.js            # dry run; prints the compressed count
bash scripts/cartographer-search.sh '<rare word>' --transcript --no-turbo
```

`tests/unit/compressed-rollouts.test.js` holds the behaviour of the resolver,
the session index and the Explorer readers. Against the code before that fix,
10 of its 13 tests fail. `retro-index-compressed.test.js` (11 tests),
`transcript-keyword-compressed.test.js` (3) and
`repair-transcript-paths-compressed.test.js` (2) hold the indexer, the keyword
fallback and the repair's counts; run in an export of the commit before them,
15 of those 16 fail, and the one that holds guards the decision not to write
`.zst` paths.
