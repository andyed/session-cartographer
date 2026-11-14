# Attributing sessionless MCP recall calls from Codex transcripts

Codex gives an MCP child no session id ([MCP.md](MCP.md)), so a recall made
through `cartographer-mcp.js` under Codex is recorded with
`attribution_status: "no_session"`, and a `get` or `mark_used` against it is
recorded with no `call_id`. The Memory Desk listed those calls under
Unattributed and their marks as stray.

The Codex rollout says who made each one. The Recall view now reads that at
request time and shows it beside the record. No log is changed.

## What was measured

2026-11-13, last 30 days of `served-log.jsonl` and `search-calls.jsonl`, against
1,702 rollouts written in that window (1,432 of them zstd-compressed):

| | calls |
|---|---|
| `mcp` recall calls | 1,278 |
| recorded without a session (all Codex) | 953 |
| call id minted in exactly one rollout | 661, across 156 sessions |
| minted in no rollout | 292 |
| minted in more than one rollout | 0 |

Marks on those 953 calls: 481 use marks were stray as recorded. With the
transcripts, 362 results count as marked used and 525 as fetched; 118 use
marks stay stray.

The 292 belong to MCP server processes that left no such row anywhere: none of
them shares a server process (the `mcp<pid>` in the call id) with an
attributed call, and 289 of the ids appear in no rollout even as text. 191 of
them fall on 2026-11-06 or later, 122 on 2026-11-07 alone. Which Codex threads
made them, and why those threads have no rollout under either root, was not
established.

Reproduce with `node scripts/codex-call-evidence.js --days 30` (read-only;
add `--session <id>` to list one session's calls).

## What counts as evidence

Each MCP tool call leaves one `event_msg` / `item_completed` row in the
rollout, with `item.type` `McpToolCall`, the arguments the agent sent and the
text the server answered. Two facts are read from it:

- **Minted.** The first line of the result prints a call id that the arguments
  do not contain. The server made that id for this call, so the call belongs
  to the rollout's session. `get` and `mark_used` echo the `call_id` they were
  given, which is not a mint.
- **Named.** `get` or `mark_used` was called with `{call_id, event_ids}`.

A call id appearing as text proves nothing. 428 of the 953 ids appeared in
more than one rollout, because agents quote ids, subagents inherit their
parent's, and sessions read each other's logs. Two ids were named by tool
calls in two rollouts each: minted in a parent session, then fetched and
marked by its subagent as well. The mint attributes the call to the parent.

A row whose `thread_id` is not the rollout's own session is counted
(`foreign_rows`, 0 in this window) and ignored.

## What the Desk does with it

`scripts/recall-join.js` applies the evidence when a reader passes
`callEvidence` to `buildRecallIndex`:

- A call recorded without a session, minted in exactly one rollout, gets
  `derived_session_id` and `session_derivation: "codex_rollout"`. `session_id`
  stays `null`. A call minted in several rollouts gets neither and carries
  `derivation_conflict`; one minted in none is unchanged. Both stay in the
  Unattributed group and in `totals.unattributed`.
- A recorded session is never replaced.
- A `no_session` mark that names such a call joins the result when the call
  served that event and the call's own session's rollout names that pair with
  the matching tool. It lands in `derived_used` or `derived_fetched`. `used`
  and `fetched` stay exact, so the session digest and Internals, which pass no
  evidence, report what they did before. A mark made only by another session,
  such as a subagent, stays stray.

`/api/memory/recall?session=<id>` returns a Codex session's derived calls with
its recorded ones. The view labels each as "session from transcript" and each
derived mark as "per transcript".

## Cost and the "scanning" answer

Rollouts are read on worker threads and remembered per file version
(`explorer/server/call-evidence.js`). A request reads only rollouts written at
or after its earliest unattributed call: one session's view took 0.6 s cold
(26 rollouts), and a cold 30-day window took 8 s on three workers, then 29 ms.
A request waits at most 4 s. Past that it is answered from the record with
`transcript_attribution.status: "scanning"`, attributes nothing, and the scan
finishes for the next request. A partial scan cannot show that an id was
minted only once, so it is never used.

## Limits

- A session that archives or compresses mid-scan is read again at its new
  path; both paths fold to one session.
- Node before 22.15 has no zlib zstd. Compressed rollouts are then reported in
  `transcript_attribution.unreadable`, and calls they hold stay unattributed.
- Other readers of rollouts in this repo (`codexSessionIndex()`,
  `resolve-transcript.sh`, the transcript indexers) match `*.jsonl` only and do
  not see `*.jsonl.zst`. That is outside this change.
- Hermes also gives an MCP child no session. Nothing here reads Hermes.
