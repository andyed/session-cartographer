# Facts — deterministic aggregates over the warm corpus

Status: implemented on the Turbo service for 0.7.x; speed measured, agent
utility unmeasured · 2026-09-08

## Decision

Add a second endpoint to the warm Turbo service, `POST /api/facts`, that answers
counting questions about the event corpus instead of relevance questions about a
phrase. Three verbs ship in this slice: `census`, `tempo`, `delta`.

`/api/recall` answers "which records are relevant to this phrase."
`/api/facts` answers "what is true of the corpus." These are different questions
with different loss functions, and conflating them is not a tuning problem. A
ranking engine asked a census question — "what happened yesterday" — has no
relevance gradient to work with. It returns *an* answer, and the caller has no
way to know it is not *the* answer.

Ranking keeps judgment about relevance. Facts own counting, and counting is not
a judgment: it is either right or wrong, and it must be checkable. Every count
therefore ships with a bounded sample of the `event_id`s behind it, so the
caller can verify it with `cartographer-search.sh --get` rather than trust it.

## Why now

The motivating failure is measured, not hypothetical. FrakBot's daily pulse
asked the ranking path for the last 24 hours and received **1 event** from a
window that deterministically contained **736 events, 22 sessions, 12 projects,
and 20 commits/pushes across four repos**. Nothing errored. The pulse simply
described a day that did not happen.

Reference measurements on the local corpus:

| Operation | Cost | Note |
|---|---:|---|
| Load 127,129 events from the five logs | 881 ms | The expensive step. The warm service pays it once at spawn and holds the array resident. |
| Full linear fold — project × day tempo | 21.7 ms | Over every resident event. |
| Full linear fold — session rollup (13,575 sessions) | 20.3 ms | Over every resident event. |
| Full linear fold — 24 h census | 12.3 ms | Over every resident event. |
| Warm census through the engine | 44 ms | End to end, including index-generation hashing. |
| Extraction-derived file-path postings | 368 ms | Regex extraction over free-text summaries. The one measured outlier. |

Turbo's warm request budget is 1500 ms (`CARTOGRAPHER_TURBO_TIMEOUT_MS`). A full
fold over all 127k events spends 0.8–1.5% of that budget; the measured 44 ms
end-to-end census spends under 3%.

These measurements establish opportunity, not a verdict. See
[Open questions](#open-questions-and-what-is-not-yet-proven).

## Evidence reviewed

- `explorer/server/facts-contract.js` — verbs, bounds, cursor encode/decode,
  request normalization, response validation;
- `explorer/server/facts.js` — the three folds and the delta reader;
- `explorer/server/jsonl.js` — `readAllEvents` (resident corpus, dedup, field
  normalization), `boundaryHash` rewrite detection, and the new `logPositions` /
  `readAppended` position primitives;
- `explorer/server/event-time.js`, `explorer/server/project-filter.js` — the
  shared time and scope definitions the ranking path and the facts path must
  agree on;
- `scripts/sentinels.js` — `isResolved` / `firstResolved`, and the 0.5.0 phantom
  incident recorded in its header;
- `scripts/turbo-server.js` — HTTP and spool mounting, `kind` routing;
- `scripts/trust-digest.js` — the standing evidence on how extraction
  heuristics fail, and how they were corrected;
- `docs/TURBO_MODE_SPEC.md`, `docs/SCORING.md`, `docs/RANK_FUSION.md`,
  `docs/INTERNALS.md` — the recall contract, scoring semantics, and the
  telemetry boundary this endpoint must not cross;
- the timings and the FrakBot starvation case above.

## Why there is no index

The obvious design for "make aggregate questions cheap" is to precompute
aggregates. Measured on this corpus, that would have been wasted work.

The expensive step is reading 127k events off disk — 881 ms — and the warm
service already pays it once and holds the result. Once the events are resident,
a full linear fold over every one of them costs 12–22 ms. Precomputing anything
would buy back a fraction of 22 ms and cost an invalidation path forever.

So these are **folds, not indexes**:

- nothing is precomputed;
- nothing has to be invalidated;
- nothing can go stale against the array it reads, because it reads the array;
- a new fact is a new function, not a new data structure plus its maintenance
  path.

The measured exception is extraction-derived facts. Pulling file paths out of
free-text summaries with a regex costs 368 ms — an order of magnitude more than
any fold here, and the one place an index would earn its keep.

It is also the one place the heuristic is most likely to be confidently wrong.
`scripts/trust-digest.js` is the standing evidence: its command-token extraction
and its hostname extraction were both wrong on the first pass, and both were
fixed by replacing a guess with a fact — resolving command tokens against
`PATH`, and shape-checking hostnames — rather than by maintaining a stoplist.
An index built over a wrong extraction is a fast wrong answer, which is the
failure mode this endpoint exists to prevent.

Extraction-derived verbs are therefore deliberately out of this slice. When one
arrives it will need both a validated extractor and an invalidation path, and
that is a separate decision.

## Why delta is a cursor, not a timestamp

This is the subtlest part of the design.

**The corpus is backfilled.** `backfill-git-history.sh`, `retro-index.sh`,
`catch-up-transcripts.sh`, and `backfill-app-sessions.js` all append events
dated months or years in the past. So:

- "everything with a timestamp after my last run" and
- "everything that arrived since my last run"

are different sets, and only the second is what "what's new" means. A `since`
window silently omits every backfilled row, which is exactly the class of row a
scheduled agent most wants to hear about.

**Arrival order lives in the logs, not in the resident array.** The in-memory
corpus is loaded file-by-file at spawn and sorted by timestamp; the watcher
`unshift`s newly appended events onto the front. "The first N entries" therefore
means different things before and after a restart. The append-only logs *are*
the arrival order. Hence per-log byte offsets, read from disk — bounded by how
much was appended, not by corpus size.

Three guards make the cursor trustworthy.

### 1. Boundary fingerprinting

A byte offset alone cannot distinguish an append from an in-place history
repair, and the failure is silent in the direction that matters: a repair that
also grows the file (rewriting a path to a longer one, say) makes the shifted
tail read as fresh appends while every already-consumed record silently keeps
its stale value.

Each cursor position is therefore `{ offset, boundary }`, where `boundary` is a
SHA-1 of up to `BOUNDARY_BYTES` (4096) of file content *immediately before* the
offset. On the next call the fingerprint is recomputed and compared. A file at
offset 0 has no fingerprint (`''`) and the check is skipped — there is nothing
before byte zero to fingerprint. An unreadable file also yields `''`, which
compares unequal to any real stored boundary and is therefore reported as
`rewritten`: the failure direction is loud.

`boundaryHash` lives in `jsonl.js` and there is exactly one copy of it:
`watchFiles` and `logPositions` / `readAppended` use the same function. A second
implementation of this rule is a second chance to get it wrong.

### 2. The cursor advances only past what was consumed

`budget` caps how many events one `delta` returns. When it binds, each source's
offset advances only past the lines actually taken off its queue, and the
remainder is reported in `pending`. A saturated delta is **resumable, not
lossy** — `budget` is a page size, not a ceiling on what can be recovered.

Two deliberate exceptions, both documented in the code:

- **Blank and unparseable lines are consumed without being returned.** A
  malformed row that is never consumed would wedge the cursor at that byte
  forever.
- **Project-filtered events are consumed.** `delta` reads first and applies
  `project` scope after, because the cursor has to advance past events the
  caller filtered out; otherwise an agent watching one project would re-read
  every unrelated event on every call, forever. `read` reports what was taken
  from the logs, `returned` reports what survived the scope filter.

Sources are drained round-robin, so a saturated `changelog` cannot starve
`prompts` out of every delta.

### 3. A stale source is reported, not diffed

If a log was truncated (`size < prior.offset`) or rewritten
(`boundaryHash` mismatch), that source contributes **no events**, is listed in
`stale` with a reason (`truncated` or `rewritten`), and its position is
re-baselined to the current end of file. The caller's diff is incomplete for
that source and is told so.

The honest response to "your cursor no longer describes this file" is to say so,
not to emit a diff computed against bytes that no longer mean what they meant.
This is the same refuse-rather-than-guess rule `scripts/session-match.js`
applies to ambiguous orphan matches.

### The cursor itself

The token is opaque on purpose: base64url of
`{ v, corpus, pos }` where `pos` is the per-source `{ offset, boundary }` map. A
caller that parsed and edited it would be constructing a claim about the logs
that nothing verified. Callers store the token and hand it back.

It carries `corpus_root` because the offsets are meaningless against a different
corpus, and a wrong-corpus delta would look authoritative — the offsets would
resolve, the response would validate, and the numbers would describe someone
else's machine. Same guard, same reason, as the recall contract's `corpus_root`.

A malformed cursor throws. It is never quietly downgraded to "start from now."

**A first call with no cursor is a baseline**: it records a position, returns
zero events, and claims nothing is new. The alternative — replaying 127k events
as "changes" — would be true only in the most useless sense.

## The contract

### Transport

| Surface | Shape |
|---|---|
| `POST /api/facts` | JSON request body, JSON response. Mounted by **both** `scripts/turbo-server.js` (headless) and `explorer/server/index.js` (the Express Explorer API). They bind the same port by design, so whichever one is running is the one a client reaches — an endpoint present in only one of them would make a scheduled job's answer depend on which process happens to be up. The headless path caps the body at 1 MB and destroys the connection above it. |
| `GET /api/facts/health` | `{status, contract_version, backend, corpus_root, verbs, events, index_generation}`, from both servers. Advertised separately so a client can discover the verb list instead of probing it — a verb added later must not look like a malformed request to an older client. |
| Spool file transport | `~/.../requests/<id>.request.json` with envelope `{request_token, kind: "facts", request}`. `kind` is what routes it; an envelope with **no** `kind` is a recall request from an older client and is handled as one. A service that predates this endpoint hands a facts body to the ranking contract and rejects it — a loud failure, not a wrong answer. |
| Client | `scripts/cartographer-facts.js`. HTTP first, spool fallback, the same transport pair as `turbo-search-client.js` because the reason the spool exists is unchanged: a Codex sandbox is denied the loopback connect outright. The fallback fires only for an *unreachable* service — a service that answered with a status has given a final verdict, and retrying it on the spool would only run the same rejection twice and report a composite error that reads like a transport problem. |

Loopback only (`127.0.0.1`), as with recall.

### Request

Every verb takes the same envelope. Unused fields are rejected where they would
mislead rather than ignored.

```json
{
  "contract_version": 1,
  "verb": "census",
  "call_id": "facts-20260908T0913-41822",
  "project": "",
  "since": "24h",
  "before": "",
  "top": 20,
  "sample": 3,
  "budget": 200,
  "purpose": "frakbot-pulse",
  "corpus_root": "/Users/andyed/Documents/dev",
  "cursor": ""
}
```

`project` is scoped by handing it every alias the family expands to —
`"session-cartographer|carto|explorer"` — not by naming one repository.

| Field | Type | Default | Notes |
|---|---|---|---|
| `contract_version` | int | required | Must equal 1. Mismatch is **409**. |
| `verb` | string | required | `census`, `tempo`, or `delta`. Anything else is rejected, not guessed. |
| `call_id` | string | required | Non-empty, ≤ 160 chars. Echoed in the response. |
| `project` | string | `""` (all) | Pipe-delimited alternation, case-insensitive substring match. |
| `since` / `before` | string | `""` | Parsed by `parseTimeArg` — `24h`, `7d`, `2w`, `3mo`, `yesterday`, `this week`, `2026-09-01`. Rejected on `delta`. |
| `top` | int | 20 | Buckets per dimension (projects for `tempo`). |
| `sample` | int | 3 | Audit `event_id`s per bucket. `0` omits `event_ids` entirely. |
| `budget` | int | 200 | `delta` page size. Ignored by `census` and `tempo`. |
| `purpose` | string | `"facts"` | `[A-Za-z0-9_-]+`, ≤ 64 chars. Validated; not currently used by the engine or echoed in the response. |
| `corpus_root` | string | `""` | If set and it does not match the service's corpus, **409**. |
| `cursor` | string | `""` | `delta` only, ≤ 65536 chars. Rejected on other verbs. |

### Bounds, and why each is where it is

| Constant | Value | Reason |
|---|---:|---|
| `FACTS_PROJECT_MAX` | 2048 | Matches `RECALL_PROJECT_MAX`. Callers do not pass one name; they pass every alias a family expands to. FrakBot's feed alone expands 20 names into 37 aliases packing to 576 characters. A tighter bound would reject the exact caller this endpoint is for. |
| `FACTS_TOP_MAX` | 200 | Generous enough to cover every project in the corpus at once (the registry is well under this), bounded so a response cannot grow with the corpus. |
| `FACTS_SAMPLE_MAX` | 10 | Audit ids per bucket. Cheap enough to attach to every bucket of every dimension; the default of 3 is enough to spot-check a count. |
| `FACTS_DELTA_BUDGET_MAX` | 2000 | A page size, not a ceiling. The cursor advances only past consumed lines, so a saturated delta is resumable. |

### Rejections

| Case | Status | Message shape |
|---|---:|---|
| Request `contract_version` ≠ 1 | **409** | `unsupported contract_version <v>` |
| Request `corpus_root` ≠ service corpus | **409** | `this service indexes <root>, not <requested>` |
| Cursor `v` ≠ 1 | **409** | `cursor contract_version <v> is not supported` |
| Cursor issued for a different corpus | **409** | `cursor was issued for <a>, but this service indexes <b>` |
| Body is not an object | 400 | `request body must be an object` |
| Unsupported `verb` | 400 | names the supported verbs |
| Missing or empty `verb` or `call_id` | 400 | `<field> must not be empty` |
| Oversized `call_id` (160), `project` (2048), `since`/`before` (128), `corpus_root` (4096), `cursor` (65536) | 400 | `<field> is too long` |
| Any of those fields present but not a string | 400 | `<field> must be a string` |
| `top`, `sample`, `budget` out of range or non-integer | 400 | `<field> must be an integer from <min> to <max>` |
| `purpose` outside `[A-Za-z0-9_-]+` | 400 | `purpose contains unsupported characters` |
| `delta` with `since` or `before` | 400 | `delta is bounded by cursor, not by since/before; omit the time window` |
| `cursor` on `census` or `tempo` | 400 | `cursor is only meaningful for delta, not <verb>` |
| Cursor unparseable / no `pos` / malformed position | 400 | never read as "start from now" |
| Unparseable `since` / `before` value | 400 | `cannot parse <field> value '<v>'` |
| Non-JSON body | 400 | `invalid JSON` (server) |
| Any other route or method | 404 | `not found` |
| Unexpected engine failure | 500 | `request failed` |

The 409s are the mismatch class: **version and corpus**. Both mean "this answer
would be about something other than what you asked", and both are conditions the
caller can act on — upgrade the client, or point at the right corpus. Everything
else the caller got wrong in the request body is a 400.

`validateFactsResponse` raises **502** for a malformed response, but it is
client-side only: `scripts/cartographer-facts.js` calls it and exits 75 rather
than rendering half a census. Half a census is indistinguishable from a small
one, and the caller has no way to tell that the number it just read describes
less than it claims. The service never emits 502 itself.

Client exit codes: `0` success, `2` a caller error (an unknown `--verb` caught
locally, or a 4xx rejection from the service), `75` unavailable (both transports
failed, a 5xx, or a response that failed validation).

The `delta` and window rejections are rejections rather than silent drops
deliberately. A silently discarded parameter is how a caller ends up trusting a
filter that never ran.

### Response envelope

Identical for all three verbs; only `facts` changes shape.

```json
{
  "contract_version": 1,
  "backend": "explorer",
  "verb": "census",
  "call_id": "facts-20260908T0913-41822",
  "corpus_root": "/Users/andyed/Documents/dev",
  "index_generation": "b41e0c7d92a55f10",
  "corpus_events": 127129,
  "indexed_docs": 127129,
  "window": { "since": "24h", "before": null },
  "project": null,
  "facts": { },
  "stages_ms": { "scan": 43.11, "total": 44.02 }
}
```

`index_generation` ties an answer to a corpus state. Two facts carrying the same
generation were computed over the same events and can be compared; two carrying
different generations cannot, and a caller diffing them would be measuring the
index rather than the work. It is sampled at answer time, not at request entry,
because the watcher mutates the resident array in place.

`corpus_events` and `indexed_docs` describe the resident corpus. `delta` reads
the log tails rather than the resident array, so for that verb they are context,
not the thing that was counted.

### `census` — what is in this window, counted

```json
{
  "events": 736,
  "windowed_out": 126393,
  "undated_dropped": 0,
  "unattributed": { "project": 41, "session": 31, "provider": 12, "type": 0, "event_id": 0 },
  "sessions": { "resolved": 22 },
  "span": { "oldest": "2026-09-07T09:41:02Z", "newest": "2026-09-08T09:12:55Z" },
  "by_project": [
    { "name": "session-cartographer", "count": 312, "event_ids": ["chg-1f2a", "chg-1f88", "tul-04c1"] }
  ],
  "by_type":     [ { "name": "git_commit", "count": 20, "event_ids": ["chg-2001", "chg-2004", "chg-2010"] } ],
  "by_source":   [ { "name": "changelog", "count": 402, "event_ids": ["chg-1f2a", "chg-1f88", "chg-1f90"] } ],
  "by_provider": [ { "name": "claude-code", "count": 604, "event_ids": ["chg-1f2a", "chg-1f88", "chg-1f90"] } ],
  "commits": [
    {
      "event_id": "chg-2001",
      "project": "session-cartographer",
      "type": "git_commit",
      "timestamp": "2026-09-08T02:14:07Z",
      "summary": "feat(facts): deterministic aggregates over the warm corpus"
    }
  ]
}
```

Details that matter:

- Buckets sort by count descending, then by name ascending, then truncate at
  `top`.
- `commits` is every event whose resolved type matches `/^git_/`, capped at 200
  rows independently of `top`, each summary clipped to 300 characters. These are
  the highest-confidence deterministic rows in the corpus — they are not
  inferred from prose, they happened — and they are the rows relevance ranking
  is least able to surface, because a commit summary shares no vocabulary with a
  question like "what happened yesterday".
- `windowed_out` counts rows excluded by `since`/`before`. Project-scoped-out
  rows are not counted anywhere; they simply do not appear.
- `undated_dropped` counts rows with no readable timestamp, **and is only
  incremented when a window is requested** — an unwindowed census has no reason
  to place a row inside or outside anything, so it reports 0. Dropping rather
  than defaulting to "now" is the same rule `rank_fuse` applies in
  `scripts/cartographer-search.sh`; defaulting would file every malformed row
  into the most recent window.
- A scoped census (`project` non-empty) excludes unattributed rows entirely,
  because `projectMatcher` returns false for an empty project value.

### `tempo` — the project × day series, and how unusual the window is

```json
{
  "undated_dropped": 3,
  "projects": [
    {
      "project": "session-cartographer",
      "days": [
        { "day": "2026-09-06", "count": 96,  "complete": true },
        { "day": "2026-09-07", "count": 407, "complete": true },
        { "day": "2026-09-08", "count": 57,  "complete": false }
      ],
      "total": 560,
      "partial_day": { "day": "2026-09-08", "count": 57, "scored": false },
      "scored_day": "2026-09-07",
      "scored_count": 407,
      "baseline_days": 13,
      "baseline_mean": 121.85,
      "z": 2.41,
      "z_status": "ok"
    }
  ]
}
```

This exists so "is 407 events a lot for this project" stops being a judgment
call made by reading a list. The caller gets the trailing baseline and a
z-score; deciding what to do about an unusual day is the part worth spending a
language model on.

The `days` array is elided above; a real 14-day window carries all fourteen
entries, which is why `baseline_days` is 13 (every complete day except the one
being scored).

`top` bounds the number of projects. The per-project `days` array is bounded by
the requested window, not by `top`, so a wide window makes a `tempo` response
grow along the day axis even though the project axis is capped.

`tempo` counts only rows with a resolved `project` and a readable timestamp;
undated rows are dropped unconditionally (unlike `census`) and reported in
`undated_dropped`.

### `delta` — what was appended since the caller last looked

Baseline (no cursor supplied):

```json
{
  "cursor": "eyJ2IjoxLCJjb3JwdXMiOiIvVXNlcnMv…",
  "baseline": true,
  "events": [],
  "returned": 0,
  "pending": {},
  "stale": {},
  "summary": { "by_source": [], "by_project": [], "by_type": [] }
}
```

Resumed:

```json
{
  "cursor": "eyJ2IjoxLCJjb3JwdXMiOiIvVXNlcnMv…",
  "baseline": false,
  "stale": { "milestones": "rewritten" },
  "pending": { "changelog": 412 },
  "returned": 137,
  "read": 200,
  "summary": {
    "by_source":  [ { "name": "changelog", "count": 96, "event_ids": ["chg-31a0", "chg-31a4", "chg-31b1"] } ],
    "by_project": [ { "name": "session-cartographer", "count": 137, "event_ids": ["chg-31a0", "chg-31a4", "chg-31b1"] } ],
    "by_type":    [ { "name": "file_edit", "count": 71, "event_ids": ["tul-9c02", "tul-9c07", "tul-9c19"] } ]
  },
  "events": [
    {
      "event_id": "chg-31a0",
      "source": "changelog",
      "timestamp": "2026-09-08T09:04:11Z",
      "project": "session-cartographer",
      "type": "file_edit",
      "session_id": "0f31…",
      "summary": "edited explorer/server/facts.js"
    }
  ]
}
```

`read` is present only on a resumed call. `stale` is `{source: "truncated" |
"rewritten"}`; `pending` is `{source: count}` of parsed-but-unreturned events.

**`delta` events are raw log rows.** They come from `readAppended`, which parses
the appended bytes directly. They do **not** get the normalization
`readAllEvents` applies to the resident corpus, so:

- no cross-log dedup by `event_id` — an event appended to both `changelog` and
  its domain log appears twice in one delta;
- no `sessionId → session_id` alias, so a row carrying only `sessionId` reports
  `session_id: null`;
- no `type ← _source` default, so a row with no type reports `type: null` where
  `census` would show the source name.

This is a property of reading the arrival log rather than the resident array. It
is the same trade that makes the cursor trustworthy at all.

### Running a scheduled delta

`scripts/cartographer-facts.js --cursor-file <path>` makes the cursor durable
across runs. A missing file is a baseline call, not an error — that is how a
scheduled job makes its first run:

```bash
node scripts/cartographer-facts.js --verb delta \
  --cursor-file ~/.carto/frakbot-pulse.cursor \
  --project "session-cartographer|carto" --budget 500
```

The stored file is a JSON envelope carrying the token plus the `corpus_root`,
`verb`, and `call_id` it was issued for; a bare token pasted in by hand is
accepted too, so an operator gets a resumed delta rather than a silent baseline.

The cursor file is written **only after** the response has validated and
rendered. Advancing the stored token before the caller has actually seen the
events would drop them permanently and silently on a render that threw — which
is the one outcome a durable cursor exists to prevent.

## Auditability: every count carries its receipts

Each bucket in `census.by_*` and `delta.summary.by_*` carries up to `sample`
(default 3, max `FACTS_SAMPLE_MAX` = 10) of the `event_id`s it counted. They
feed straight into:

```bash
# ids are comma-separated; the query argument is ignored, so any placeholder works
scripts/cartographer-search.sh x --get chg-1f2a,chg-1f88,tul-04c1
```

`--get` prints the complete untruncated record for each id and reports missing
ids rather than silently dropping them, which is what makes it a verification
step rather than another search.

The reason is plain: **a deterministic answer that is silently wrong is strictly
worse than a slow one.** A ranked answer advertises its own uncertainty — the
reader knows a search may have missed something. A counted answer does not. If
"736 events" cannot be checked, it has to be trusted, and a number that has to
be trusted is exactly the kind of number that goes wrong quietly.

`--get` uses `rg` where available specifically so this verification step is
cheap enough to actually take (see CLAUDE.md: BSD `grep` over the four event
logs costs ~1 s per invocation, which teaches an agent to skip the check).

Not everything is sampled, and the doc should not overclaim:

| Carries `event_id` samples | Does not |
|---|---|
| `census.by_project`, `by_type`, `by_source`, `by_provider` | `census.sessions.resolved` (a set cardinality) |
| `delta.summary.by_source`, `by_project`, `by_type` | `census.unattributed.*` (counts only) |
| `census.commits` (full `event_id` per row) | `tempo` day counts and z-scores |
| | any bucket when `sample: 0` was requested |

`tempo` is the notable gap: its day counts are not currently auditable through a
sample. Verifying one means re-running `census` with a `since`/`before` pinned
to that day.

## Sentinel discipline

Every grouping in `facts.js` goes through `scripts/sentinels.js` — `isResolved`
for identity fields, `firstResolved` for the type and session fallback chains.
None of it re-derives the absent-value set inline.

The failure it prevents is real and is recorded in CLAUDE.md and in the
`sentinels.js` header. The pipeline spells absence three ways — `""`,
`"unknown"`, and `null` — and `/wrapup` alone has written all three.
`"unknown"` is truthy and equal to itself, so `if (sid)` passes and
`groupBy(sid)` silently merges every unattributed record into one phantom
entity. During the 0.5.0 orphan repair that phantom `"unknown"` session window
spanned the whole corpus, "matched" 148 orphans, and overstated the reported
recovery rate by **54%**. Nothing errored. The number was just wrong.

For an aggregates endpoint the consequence is direct: the phantom would appear
in `by_project` as the busiest project on the machine, and in a session count as
one very long session.

So `census` reports unattributed rows as their own number, per dimension, and
never folds them into a bucket:

> 22 sessions, plus 31 rows I cannot attribute

never "23 sessions". `unattributed` carries `project`, `session`, `provider`,
`type`, and `event_id` counts alongside the resolved buckets.

Coverage by verb, stated exactly:

| Verb | Groups by | Sentinel-guarded |
|---|---|---|
| `census` | project, type, source, provider, session, `event_id` | all of them |
| `tempo` | project × UTC day | project (`isResolved`); no session or provider grouping exists |
| `delta` | source, project, type; session reported per event | all of them |

The `type` chain deserves its own note. The five logs do not agree on a field
name: `changelog` and `tool-use` write `type`, milestones write `event` and
`milestone`. `eventType` resolves `type → event → milestone` through
`firstResolved`. Hardcoding one field would make whole sources vanish from a
breakdown while the totals still looked plausible — the documented
fallback-chain invariant of this pipeline.

## Tempo's partial-day rule

Three rules, all of which exist because the naive version was measured and was
wrong.

**The current UTC day is reported but never scored.** A day two hours old
compared against complete 24-hour days always reads as a collapse in activity.
This is not a small bias, it is a guaranteed one: on the first run of this verb
**every project scored negative for exactly that reason.** So `partial_day`
carries `{day, count, scored: false}`, `days[].complete` is `false` for it, and
`scored_day` is the last day that actually finished.

**The baseline excludes the day being scored.** Including it drags the mean
toward the value under test, so the more extreme the day, the more it corrupts
its own comparison — which is how a genuinely anomalous day scores as ordinary.
`baseline` is `complete.slice(0, -1)`.

**Insufficient history or zero variance returns `z: null` with a stated
status, never `0.0`.**

| Condition | `z` | `z_status` | `baseline_mean` |
|---|---|---|---|
| fewer than 3 complete baseline days | `null` | `insufficient_history` | `null` |
| baseline standard deviation is 0 | `null` | `zero_variance` | the mean |
| otherwise | rounded to 2 dp | `ok` | the mean |

`0.0` would read as "perfectly ordinary", which is a claim. "Not enough history
to say" is a different and honest answer, and the caller needs to be able to
tell them apart.

## Boundaries

**The endpoint never writes.** `scripts/cartographer-search.sh` remains the
single writer of `served-log.jsonl` and `access-ledger.jsonl`. That
single-writer boundary is what stops a failed request, a fallback, or a retry
from double-counting a call — see `docs/TURBO_MODE_SPEC.md` — and a facts
endpoint that logged its own activity would reintroduce exactly the double-write
the recall contract was shaped to prevent. `scripts/cartographer-facts.js`
appends nothing either: a census counted against the corpus is not a search
result served to anyone, and logging it would inflate the hit-rate report
(`scripts/hit-rate-report.js`) with rows no one could ever `--touch`.

`scripts/cartographer-pulse.sh` is the first consumer and holds the same line:
it prints a deterministic census *above* a relevance sample from
`cartographer-feed.sh`, labels which half is which, and writes nothing. An
unlabelled sample reads as a census, which is the original failure restated.

**Facts are projections, not events.** No sixth log. Nothing here writes to
`changelog.jsonl`, `research-log.jsonl`, `session-milestones.jsonl`,
`tool-use-log.jsonl`, or `prompt-history.jsonl`, so the five-searched-logs rule
in CLAUDE.md is untouched. A fact is recomputed on demand from the same events
`/remember` searches; if a caller wants a fact preserved, it belongs in a
milestone written by `/wrapup` like any other durable claim.

**Loopback only.** `127.0.0.1`, and the spool directory is created `0o700`.

**Shared definitions, not parallel ones.** `event-time.js` and
`project-filter.js` exist so the ranking path and the facts path agree on which
events fall inside a window and inside a scope. A census and a recall over the
same `--since` and `--project` that disagreed about their own corpus would
produce two defensible answers with no way to tell which one described the
requested corpus. `event-time.js` is the shared home of the timestamp
normalization `search.js` used to own privately; `project-filter.js` matches the
case-insensitive substring behaviour of `bm25.js`, so a family name selects its
repositories (`psychodeli` selects `psychodeli-webgl-port`).

## Ownership

| Concern | Canonical owner |
|---|---|
| Verbs, bounds, cursor encode/decode, request/response validation | `explorer/server/facts-contract.js` |
| `census`, `tempo`, `delta` folds and the response envelope | `explorer/server/facts.js` |
| Append positions, rewrite detection, tail reads | `explorer/server/jsonl.js` (`logPositions`, `readAppended`, `boundaryHash`) |
| "When did this happen" | `explorer/server/event-time.js` |
| "Is this event in scope" | `explorer/server/project-filter.js` |
| "Is this field a real identity" | `scripts/sentinels.js` |
| Endpoint mounting, spool `kind` routing, health | `scripts/turbo-server.js` and `explorer/server/index.js` — both, and they must not diverge |
| Two-part activity pulse (census above a ranked sample) | `scripts/cartographer-pulse.sh` |
| Client transport, rendering, durable cursor file | `scripts/cartographer-facts.js` |
| Served/access telemetry | `scripts/cartographer-search.sh` — and nothing else |
| Tests | `tests/unit/facts-contract.test.js`, `facts-engine.test.js`, `facts-positions.test.js` |

Root `scripts/` and `explorer/` files remain canonical; anything copied under
`plugins/session-cartographer/` is a distribution mirror and must not drift.

## Verification matrix

| Layer | Required proof | Status |
|---|---|---|
| Contract | Valid request; unsupported version → 409; unsupported verb → 400; `delta` + window → 400; cursor on non-delta → 400; bounds at min/max/over for `top`, `sample`, `budget`; `project` at and above `FACTS_PROJECT_MAX`; `purpose` charset | covered by `tests/unit/facts-contract.test.js` |
| Cursor | encode → decode round-trip; wrong corpus → 409; wrong version → 409; garbage cursor rejected outright; cursor with no corpus claim accepted | covered by `tests/unit/facts-contract.test.js` |
| Response validation | Well-formed response validates; malformed → 502; `delta` response without a cursor rejected | covered by `tests/unit/facts-contract.test.js` |
| Census correctness | Buckets by project/type/source/provider; sentinel session, project, provider, type and `event_id` values reported as unattributed rather than bucketed; the `type -> event -> milestone` fallback; unparseable timestamps dropped from a windowed census; substring project matching; `sample` bounds including `sample: 0` | covered by `tests/unit/facts-engine.test.js` |
| Tempo correctness | Scores the last complete day and never the partial current day; `z: null` with a reason rather than a misleading zero; a quiet day is a zero, not a missing observation; undated events dropped and counted | covered by `tests/unit/facts-engine.test.js` |
| Delta correctness | Baseline claims nothing is new; project scope applied after the read so the cursor still advances; budget saturation reports `pending` and resumes losslessly; a garbage cursor is refused rather than silently re-baselined; the cursor is a position token, not a wall-clock window | covered by `tests/unit/facts-engine.test.js` |
| Append positions | First call does not replay history; round-robin across two logs so neither starves; immediate re-read returns nothing; trailing line with no newline not consumed until the newline arrives; malformed line consumed rather than wedging the cursor; in-place rewrite reports `stale: rewritten`; truncation reports `stale: truncated`; a missing log is position zero and not stale | covered by `tests/unit/facts-positions.test.js` |
| Transport | HTTP path; spool path with `kind: "facts"`; spool envelope with no `kind` still routes to recall; oversized body; unknown route → 404; parity between the two mount points | **not yet automated** |
| Boundaries | No write to `served-log.jsonl` or `access-ledger.jsonl` on any verb or any failure path; no sixth log created | **not yet automated** |
| Performance | Warm census inside the 1500 ms Turbo budget on the live corpus | measured at 44 ms; not yet a regression test |

Test harnesses must unset `CARTOGRAPHER_SESSION_ID`, `CLAUDE_SESSION_ID`,
`CLAUDE_CODE_SESSION_ID`, and `CODEX_SESSION_ID`, and point
`CARTOGRAPHER_DEV_DIR` at a temp corpus before importing anything (`jsonl.js`
resolves `LOG_FILES` at module load, so the imports must be dynamic and come
after the assignment). All three facts test files do this.

## Non-goals

- Ranking. Facts do not score relevance and must not acquire a relevance
  parameter.
- Extraction-derived verbs (file-path postings, command inventories, host
  inventories). Measured at 368 ms and heuristic; they need a validated
  extractor first.
- Precomputed or persisted aggregates. The measurement says folds are enough.
- A sixth event log, or any write path from this endpoint.
- Replacing `/remember`. A census tells the caller what exists; recovering what
  it meant is still a search plus a transcript read.
- Making the cursor human-readable or hand-editable.
- Remote or multi-user access.
- Participation in the Turbo recall utility canary or its promotion gates.

## Open questions and what is not yet proven

**Utility is unmeasured.** The speed is real and the FrakBot starvation is
measured, but nobody has yet shown that a *counted* pulse produces better agent
behavior than a *ranked* one. It is entirely possible that an agent handed 736
events and 20 commits writes a worse daily summary than one handed a single
well-ranked event, because the counted answer is longer and less selective. That
is an empirical question and it has not been asked. This is the same discipline
`docs/TURBO_MODE_SPEC.md` applies to Turbo itself: measurement establishes
opportunity, not a verdict.

**There is no utility signal to measure with.** Facts write no telemetry by
design, so the served/access join that powers `docs/INTERNALS.md` cannot see
them at all. Whatever evaluation happens will need a different instrument, and
adding one must not breach the single-writer boundary.

**The auditability claim is untested in practice.** Every bucket carries sample
ids, but nobody has yet caught a wrong count with them, so we do not know
whether an agent actually spends the `--get` call or just reports the number.

**`tempo` day counts are not auditable.** They carry no sample. Whether that
matters depends on whether z-scores get acted on.

**The z-score model is a placeholder.** A Gaussian z over daily event counts
assumes a stationary, roughly symmetric process. Work cadence is neither — it is
bursty, weekday-shaped, and project-switching. `baseline_days ≥ 3` is a low bar
and `z` will be noisy on short histories. It is reported with its baseline and
its status so a caller can discount it; it has not been validated against
anything.

**No idle or freshness policy for `delta`.** A cursor held for months across
several log rotations will report `stale` and re-baseline, which is correct but
loses the interval. Whether a caller should then fall back to a `census` over a
time window is undecided.

**The 200-row `commits` cap is a guess.** It is not derived from any measured
distribution, and a busy day across many repos could exceed it silently — the
response gives no "truncated" flag for that list.

**`purpose` is validated but unused.** It exists so a future consumer can
attribute facts traffic by caller, and it is dead weight until something reads
it. If nothing does, it should be removed rather than left as an implied
promise.
