# Recall calls with no recorded access

Status: probe built and run 2026-10-17 · `scripts/abandonment-report.js`

On 2026-10-17 `hit-rate-report.js` put first-access MRR at 0.173 over 548
ordered `remember` calls. 365 of them had no access row, so each scored 0. Over
the 183 calls with any access, MRR was 0.519. The question was whether those
zeros hide good abandonment: an agent that read the one-line summaries, answered
from them, and never called `get` or `mark_used`.

It does not, to any extent that matters. Crediting every call where the
transcript shows the agent used a served result moves first-access MRR from
0.173 to 0.193. Most no-access calls that can be read are bad abandonment. The
summary line answering the question outright is rare: 7 calls of 191, and none
in the last 30 days. Six of the 30 implicit uses the probe finds are the agent
calling `get` exactly as the skill says, with the access row then lost by the
recorder (two defects, below, fixed the same day).

## What the probe does

For every `remember`, `mcp` or `prompt-cue` call with no access row of any
source, it resolves the session's transcript (`resolve-transcript.sh`, then the
session's `subagents/` files, then Claude's persisted tool output), finds the
recall's own output in it, and reads what the agent did before the next human
prompt. Each call lands in one category, first match wins:

| category | rule |
|---|---|
| `unmarked_use` | a later tool call names a served result's event_id, transcript or session (a handle), or the calls before the agent next writes carry distinctive tokens that first reached it in one served summary |
| `good_abandonment` | the agent's next text carries distinctive tokens from one served summary |
| `no_need` | recall on turn one, no memory cue in the prompt (`recallCue`), no `/remember`, not a subagent; or a `prompt-cue` hook row |
| `bad_abandonment` | everything else that was located |
| `empty` | the call served nothing |
| `unresolved` | no session, no transcript, or the call is not in it |

The first two are implicit use, credited at the matched result's rank.

**The overlap test.** A token counts if it is distinctive (a sha, a number with
three digits or a unit, a date, a file name, an identifier, or a word of five
letters or more that is rare among served summaries). It must also be absent
from the query and from everything the agent had seen before writing: the
transcript up to the recall, and tool results that arrived after it. Tokens that
many calls' agents produce unprompted (`package.json`, `TODO.md`) are dropped. A
call's score is the most such tokens any one summary shares with the output. The
baseline scores the same output against 99 calls from other sessions with the
same topic project, cut to the same number of results. A call fires at two or
more shared tokens and p ≤ 0.05 against that baseline. Handles need no baseline,
since an event_id cannot turn up in a tool call by chance.

**The gate.** Before it reads a transcript, the probe recomputes the 0.173 with
its own call table and first-access ordering. It compares that number with
`hit-rate-report.js --json` run on the same snapshot of the three telemetry
logs. A delta past 5e-4, or any difference in the call or ordered-call counts,
aborts with exit 3 and `summary.FAILED.json`. On 2026-10-17 it reproduced
0.17335 over 548 of 598 calls exactly (Δ 0). The `gate` block in `summary.json`
pins `hit-rate-report.json` with `utility.firstAccessMrr`, `orderedCalls` and
`calls`.

It writes nothing to `served-log.jsonl` or `access-ledger.jsonl` and never runs
`cartographer-search.sh`. The brief assumed `--get` without `--call-id` writes
no telemetry. It does write: `record_accesses result_fetched` runs whenever an
id is found, attributed through `unique_serve`/`prior_access` when the session
resolves. Summaries therefore come from the recall output in the transcript, or
from the five logs read in place.

## Numbers

All time, `remember` (the 365):

| category | calls | of 365 | of the 191 readable |
|---|---:|---:|---:|
| unmarked_use | 22 | 6.0% | 11.5% |
| good_abandonment | 7 | 1.9% | 3.7% |
| no_need | 23 | 6.3% | 12.0% |
| bad_abandonment | 134 | 36.7% | 70.2% |
| empty | 5 | 1.4% | 2.6% |
| unresolved | 174 | 47.7% | — |

The 191 readable calls are the 365 minus the 174 unresolved; `empty` is counted
among them.

Unresolved, across all 392 no-access calls of the three purposes: 173 have no
session (July–August rows written before session attribution, and every Codex
MCP call), 14 could not be found in their transcript, and 5 have no transcript
(Hermes). Of the 194 located calls, 74 were found by call_id. For output from
before mid-September, which printed no call_id, 73 were found by the
`Searching for: "<query>"` header within 3 minutes. 47 were found by the tool
call carrying the query, for output an agent piped through `grep` or `head`.

Last 30 days, `remember`: 10 unmarked use, 0 good abandonment, 6 no-need, 32
bad abandonment, 1 empty, 17 unresolved (of 66).

### MRR

| | remember, all time | remember + mcp, all time | remember, 30 days | remember + mcp, 30 days |
|---|---:|---:|---:|---:|
| ordered calls | 548 | 578 | 106 | 136 |
| first access (any access row) | 0.173 | 0.165 | 0.201 | 0.161 |
| + good abandonment | 0.178 | 0.170 | 0.201 | 0.161 |
| + unmarked use | 0.189 | 0.182 | 0.245 | 0.203 |
| + both (implicit use) | **0.193** | **0.186** | **0.245** | **0.203** |
| + a decoy's implicit labels (null, mean of 5) | 0.174 | 0.166 | 0.201 | 0.161 |
| explicit use (`result_used`) | 0.160 | 0.153 | 0.194 | 0.156 |
| explicit use + implicit use | 0.180 | 0.174 | 0.238 | 0.197 |
| given any access | 0.519 | 0.511 | 0.532 | 0.499 |
| given any access or implicit use | 0.499 | 0.496 | 0.519 | 0.502 |

Calls the probe could not read stay in the denominators at their recorded
value, so the credited rows are lower bounds. Implicit use sits deeper than
recorded access: of the 29 credited `remember` calls, 7 matched at rank 1 and
the median is rank 6. That is why MRR given use falls when implicit use is
added.

## How far to trust it

**Decoys.** Every located call is classified again 5 times with a decoy call's
results in place of its own. Implicit use fired on 30 of 194 calls with their
own results, and on 0.8 on average with a decoy's. The decoys add 0.0002 to
MRR. With donors drawn from any project instead of the call's own, 32 fire, 1.6
fire on decoys, and remember MRR is 0.197; the project baseline is the default.

**Hand check.** Ten implicit and ten abandoned calls were drawn by seed from the
all-time run and read in full (`--hand-check 10`; the file quotes transcripts
and is written only outside the repository).

| call | label | verdict | why |
|---|---|---|---|
| call-20260814T233729-61091 | unmarked use, handle, rank 1 | agree | read the rank-1 result's transcript |
| call-20260908T025359-92914 | good abandonment, rank 2 | agree | the answer paraphrases the rank-2 summary |
| call-20260928T010354-67259 | unmarked use, tokens, rank 4 | **disagree** | the match is a mail domain the agent would write unprompted |
| call-20261002T034244-18864 | unmarked use, handle, rank 8 | agree | `--get` of the rank-8 id with this call_id; the row was lost (below) |
| call-20260831T014447-49951 | good abandonment, rank 2 | agree | names the doc the rank-2 result opened, then reads it |
| call-20261017T045517-mcp55373-2 | unmarked use, tokens, rank 1 | agree | a subagent listed a repository it learned of only from the rank-1 result |
| call-20260821T002802-41911 | unmarked use, tokens, rank 14 | weak | three file names from a commit, 23 calls on; transcripts of that age omit the system prompt, which may have named them |
| call-20260901T132516-8370 | unmarked use, handle, rank 7 | agree | `--get` of the rank-7 turn id; nothing recorded (below) |
| call-20260910T035703-9861 | good abandonment, rank 12 | agree | cites the doc the rank-12 result names |
| call-20260906T053805-91735 | unmarked use, handle, rank 1 | agree | read the rank-1 result's transcript |
| call-20260901T150329-42015 | bad abandonment | **mislabel** | the query is a malformed `--touch`; no need |
| call-20260821T035554-39923 | bad abandonment | agree | nothing relevant served; no text before the next prompt |
| call-20260923T193348-8736 | no need | questionable | turn one, no cue, but the agent then mined history by hand |
| call-20261016T132147-mcp26261-1 | no need | agree | results unrelated; answered from the network |
| call-20260827T015048-1076 | bad abandonment | agree | no hits for any term; the agent said so |
| call-20260926T165645-7231 | bad abandonment | agree | "recall isn't surfacing it"; one of five searches in a row |
| call-20260821T001410-29572 | bad abandonment | uncertain | reports recall findings after two further searches, which may hold them |
| call-20260902T134459-76215 | bad abandonment | **mislabel** | a smoke-test search during a release, not a need |
| call-20260911T012459-60318 | bad abandonment | uncertain | restates an earlier intent after reading code; source unclear |
| call-20260908T135630-12448 | bad abandonment | agree | searched again with a narrower query and answered from that |

Implicit: 8 agree, 1 weak, 1 wrong. Abandoned: 5 agree, 3 uncertain, 2 wrong.
None of the abandoned calls hides a use of its own results. Both mislabels are
tool exercises that belong in no-need, so bad abandonment is somewhat
overstated.

**What it cannot see.**
- **Absence as an answer.** An agent that says "nothing in history after
  February" used the recall, but no token can show it.
- **Facets used instead of results.** These leave no token in the output either.
- **Recall chains.** Agents fire two to five searches in a row, and 35 of 137
  bad-abandonment calls were followed by another search before the agent wrote.
  The useful result often belongs to the last call in the chain, while the
  earlier calls read as abandoned.
- **Transcripts from before about October.** These do not record the system
  prompt, so tokens from a project's CLAUDE.md look new.

Only 70 of 194 located calls had no tool call between the recall and the
agent's next text, so most next texts are informed by later reads, which take
the credit. Widening the text channel to every assistant text in the turn fires
on 9 calls (1.2 on decoys); it classifies nothing.

## Two recorder defects behind unmarked use

Six of the 23 unmarked uses are `--get` fetches the agent made as the skill
asks, which then left no access row. Both defects reproduced against temporary
logs, and both are fixed (2026-10-17, `tests/unit/get-access-recording.test.js`).
`--get` now resolves every id, records the fetch, and only then prints. It also
fetches a `turn-*` id the five logs do not hold from the semantic index, in one
batched retrieval by the point id the indexers write. Rows written before the
fix stay as they are: the ledger is append-only, so these calls keep their
zeros.

- **`--get … | head` drops the row.** `--get` prints the records, then records
  the access. A milestone record pretty-prints to 53 lines, so `| head -40`
  closes the pipe first and SIGPIPE ends the script before `record_accesses`.
  The same command writes one `explicit` row without the pipe and none with
  `| head -3`. Three calls, all passing `--call-id`.
- **`--get` of a `turn-*` id records nothing.** Turn ids live only in Qdrant, so
  `--get` reports them missing, exits 1 and writes nothing, even with a valid
  `--call-id` for a served turn. Three calls. Turn ids are about a sixth of
  served `remember` and `mcp` rows.

Five more unmarked uses read the served result's transcript directly. That is
what CLAUDE.md tells an agent to do, and no current writer records it.

## MCP is outside the headline

`hit-rate-report.js` filters to `--purpose remember` by default, so the 0.173
leaves out every MCP call, although the skill now recommends the MCP path. There
were 30 in the last 30 days: 12 from Claude and 18 from Codex. Adding them
lowers first-access MRR to 0.165 over all time and 0.161 over 30 days. The
Codex MCP calls carry no session (`attribution_status: "no_session"`): the probe
cannot resolve their transcripts, and their `get` and `mark_used` rows cannot
join a call.

## Running it

```bash
node scripts/abandonment-report.js                                   # last 30 days, remember + mcp + prompt-cue
node scripts/abandonment-report.js --days all --json
node scripts/abandonment-report.js --days all --out ~/Documents/dev/.carto/reports/abandonment --hand-check 10
node scripts/abandonment-report.js --donor-scope any --min-shared 3 --alpha 0.01
```

It takes about 15 s for 30 days and a minute for all time, nearly all of it
transcript reads. `--out` refuses a path inside this repository. The unit test,
`tests/unit/abandonment-report.test.js`, runs the CLI's own path from transcript
JSONL. It proves the fixture can produce a false positive (a bag-of-words
overlap fires on every decoy, and so does the detector with its token filter and
baseline both off). It also proves that either safeguard alone keeps the decoys
quiet, and that the probe's MRR equals the canonical aggregator on a fixture
where a naive ordering does not.
