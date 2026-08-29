# Turbo Mode — utility-first Explorer recall

Status: draft for implementation · 2026-08-29

## Decision

Offer the Explorer's warm in-memory search engine as **Turbo Mode**, an explicit
opt-in for ordinary `/remember` queries. Introduce it early, measure utility on
real recall traffic, and reconcile ranking differences only when they reduce
observed utility.

Exact CLI/API result parity is not the launch gate. Turbo Mode never enables
itself silently: the portable CLI remains the default, control path, and
fallback. Memory use is measured and exposed, but the observed ~583 MB resident
footprint is not by itself a blocker if the opt-in creates materially better
recall behavior.

## Why now

Reference measurements on the local corpus on 2026-08-29:

| Path | Observed behavior |
|---|---:|
| Optimized CLI hybrid recall | ~13.90 s |
| Warm Explorer search | ~20.55 ms median, ~33.02 ms p95 |
| Explorer process | ~583 MB RSS, ~283 MB JavaScript heap |
| Explorer event load after linear dedup fix | 1.00 s for ~108k events |
| Internals aggregation | ~20–35 ms cold; sub-millisecond server cache hit |

These measurements establish opportunity, not a product verdict. Search latency
is only useful if it reduces time to recovered context without lowering the
chance that the agent uses a relevant result.

The current exact-attribution telemetry can measure result use and rank. It
cannot yet measure query-stage latency or distinguish the backend that produced
a result, so measurement comes first but must not become a long pre-launch
program.

## Evidence reviewed

- `scripts/cartographer-search.sh` and `scripts/bm25-search.awk`: portable
  multi-source BM25, semantic fusion, activation, delta serving, and telemetry;
- `explorer/server/search.js` and `explorer/server/bm25.js`: current warm JS
  search engine and its known ranking shape;
- `explorer/server/jsonl.js`: current incremental event corpus and startup path;
- `docs/SCORING.md`, `docs/RANK_FUSION.md`, and `docs/INTERNALS.md`: scoring,
  attribution, and utility definitions;
- checked-in truth-query fixtures plus the live exact served/access ledgers;
- the timings and process-memory measurements above.

## Product contract

Turbo Mode accelerates the standard query phase only:

```text
user recall intent
  → /remember orchestration
    → warm Explorer search when Turbo Mode is enabled and available
    → portable CLI ranking otherwise
  → one normalized result set
  → existing --get / --touch / transcript workflow
```

The `/remember` wrapper remains authoritative for:

- session and provider resolution;
- `call_id` generation and propagation;
- delta-serving state;
- terminal rendering;
- durable served-result telemetry;
- one completed search-call timing row;
- `--get`, `--touch`, `--thread`, and `--transcript` control modes.

The Explorer Turbo backend owns candidate retrieval, ranking, facets, and stage
timings for a standard search request. It does not append served rows. This
single-writer boundary prevents a failed request, fallback, or retry from
double-counting a call.

## Ownership

| Concern | Canonical owner |
|---|---|
| Backend choice, session/delta state, final rendering, served/timing writes | `scripts/cartographer-search.sh` |
| Local HTTP adapter and contract validation | proposed `scripts/turbo-search-client.js` |
| Versioned request/response validation | proposed `explorer/server/recall-contract.js` |
| Recall endpoint and health | proposed `explorer/server/recall.js`, mounted by `explorer/server/index.js` |
| Keyword/semantic ranking | `explorer/server/search.js` and `explorer/server/bm25.js` |
| Utility aggregation and display | `explorer/server/internals-*.js` and `explorer/src/components/Internals.jsx` |
| Agent workflow and result-use behavior | `plugins/session-cartographer/skills/remember/SKILL.md` |
| Distribution | `scripts/copy-plugin-runtime.sh` plus source/package smoke |

Root `scripts/` and `explorer/` files remain canonical. Files copied under
`plugins/session-cartographer/` are distribution mirrors and must not drift.

## Success framework

### Primary outcomes

1. **Exact recall success**
   - Definition: exact-attributed calls with at least one used result divided by
     exact-attributed calls.
   - Source: `served-log.jsonl` joined to `access-ledger.jsonl` by
     `(call_id, event_id)`.
   - Role: best available behavioral utility signal.
   - Caveat: an explicit fetch or touch proves use, not helpfulness.

2. **Time to first use**
   - Definition: timestamp of the first exact access minus the search request
     start for that call.
   - Source: new search-call timing row plus the existing access ledger.
   - Role: connects backend speed to actual workflow acceleration. Report it
     among successful calls and always pair it with recall success so no-use
     calls cannot disappear from the interpretation.
   - Caveat: includes agent reading and reasoning time, which is desirable for
     the product outcome but noisier than response latency.

3. **Mean reciprocal rank of first use**
   - Definition: `1 / first-accessed-rank`, averaged over the jointly ordered
     exact-call cohort with no-use calls contributing zero. Multi-result batches
     use their recorded 1-based access ordinal; historical tied batches without
     ordinals remain order-unknown rather than receiving an invented order.
   - Source: existing served/access join.
   - Role: catches a fast backend that buries the result eventually used.

4. **Mean reciprocal rank of last use**
   - Definition: `1 / last-accessed-rank` over the same jointly ordered cohort;
     if either boundary is unknown, that call is excluded from both MRR values.
   - Role: secondary diagnostic for how deep successful exploration ultimately
     went. It does not replace first-use MRR as the promotion gate.

### Drivers

- search response latency by backend: p50, p95, cold versus warm;
- result-row use rate;
- first-use rank distribution;
- fast-path selection rate and fallback reason;
- same-session reformulation rate: another standard recall within ten minutes
  before any exact use from the prior call;
- index lag at request time.

### Guardrails

- exact attribution coverage remains at least 95% for new calls;
- a telemetry write failure never suppresses valid results;
- the wrapper writes at most one served row per `(call_id, event_id)`;
- no source class disappears silently from accelerated results;
- RSS and heap are reported in Internals, but have no launch threshold during
  the utility canary;
- localhost binding remains `127.0.0.1`.

### Provisional decision thresholds

Evaluate only after at least 50 exact calls in each backend cohort. This is a
pragmatic directional floor for one user's workflow, not a statistically
powered population experiment. Until then, show the metrics and uncertainty
without declaring a winner.

Graduate Turbo Mode from experiment to supported opt-in when:

- matched response latency is at least 20× faster and accelerated p95 is under
  1 second;
- median time to first use improves by at least 30%;
- exact recall success is no more than 5 percentage points below the matched
  CLI cohort;
- first-access MRR is at least 90% of the matched CLI cohort;
- no critical truth query loses every relevant result from the top 10.

These are provisional anchors. The speed targets are grounded in observed
performance; the utility tolerances should be revised after the first 50-call
canary rather than optimized against a tiny baseline.

## Request and response contract

Add a dedicated `POST /api/recall` endpoint instead of overloading the Explorer
UI's `GET /api/search` contract.

Request:

```json
{
  "contract_version": 1,
  "call_id": "recall-...",
  "query": "psychodeli audio reactivity",
  "project": "psychodeli-audio-lab",
  "since": "30d",
  "before": "",
  "limit": 15,
  "purpose": "remember",
  "session_id": "...",
  "provider": "codex",
  "excluded_event_ids": []
}
```

Response:

```json
{
  "contract_version": 1,
  "backend": "explorer",
  "index_generation": "<fingerprint>",
  "index_lag_ms": 42,
  "results": [],
  "facets": {},
  "stages_ms": {
    "keyword": 18.4,
    "embedding": 7.1,
    "semantic": 11.2,
    "fusion_activation": 0.8,
    "total": 31.0
  }
}
```

Rules:

- reject unsupported contract versions rather than guessing;
- apply `excluded_event_ids` before the final rank/limit window;
- return source-specific contribution labels, not only `keyword`;
- return full event identifiers and fields needed by the existing renderer;
- never write to the served or access ledgers;
- report unavailable semantic search as a stage status while returning keyword
  results;
- include index freshness even when it is zero or unknown.

Add `GET /api/recall/health` with contract version, event count, index
generation, newest indexed event timestamp, source fingerprints, semantic
service status, process RSS, and JavaScript heap.

The wrapper appends one record per completed standard query to
`CARTOGRAPHER_SEARCH_CALL_LOG`, defaulting to
`$CARTOGRAPHER_DEV_DIR/.carto/search-calls.jsonl`. Required fields are:
`timestamp`, `call_id`, `requested_backend`, `selected_backend`, `purpose`,
`session_id`, `provider`, filters, result count, stage timings, index
generation, semantic status, and `fallback_reason`. The API never writes this
ledger.

## Opt-in and backend selection

The user-facing contract is deliberately small:

| Setting | Meaning |
|---|---|
| `--turbo` | Enable Turbo Mode for one `/remember` call. |
| `CARTOGRAPHER_TURBO=1` | Persistently opt this environment into Turbo Mode. |
| `--no-turbo` | Force the portable CLI for one call. |
| unset / `CARTOGRAPHER_TURBO=0` | Default: portable CLI, with no service start or probe. |

Precedence is `--no-turbo`, then `--turbo`, then `CARTOGRAPHER_TURBO`. When
enabled, Turbo Mode uses a compatible healthy Explorer backend and otherwise
falls back once to the portable CLI. Control operations always bypass Turbo.

Developer and canary controls remain underneath that product surface:

| Setting | Meaning |
|---|---|
| `CARTOGRAPHER_SEARCH_BACKEND=cli` | Portable control cohort. |
| `CARTOGRAPHER_SEARCH_BACKEND=explorer` | Strict Turbo backend; surface an error instead of falling back. |
| `CARTOGRAPHER_SEARCH_BACKEND=canary` | Select Explorer or CLI by stable session/query hash. |
| `CARTOGRAPHER_TURBO_URL` | Defaults to `http://127.0.0.1:2526`. |
| `CARTOGRAPHER_TURBO_TIMEOUT_MS` | Warm request budget; provisional default 1000 ms. |
| `CARTOGRAPHER_TURBO_CANARY_RATE` | Explorer share in canary mode; provisional default 0.8. |
| `CARTOGRAPHER_TURBO_SHADOW_RATE` | Optional non-blocking CLI replay rate from 0 to 1. |

## Implementation sequence

### Slice 1 — make utility measurable

Owner: retrieval telemetry and Internals.

1. Add one append-only search-call record per completed standard query to
   `.carto/search-calls.jsonl` with:
   `call_id`, backend, request/start/end timestamps, stage timings, filters,
   result count, semantic status, index generation, and fallback reason.
2. Give both CLI and Explorer paths the same backend names and timing field
   names.
3. Extend Internals with backend cohorts for latency, recall success, first- and
   last-access MRR, result-row use, time to first use, fallback reasons, and
   index lag.
4. Keep missing latency visibly unavailable for historical rows.

Acceptance:

- new timing coverage is at least 95% in fixtures and a 20-query local run;
- malformed or unwritable timing telemetry does not change displayed results;
- exact use still joins through the original `call_id`;
- Internals never compares a cohort with fewer than 10 calls without a
  low-sample label.

### Slice 2 — ship the thinnest real Turbo path

Owner: Explorer API and `/remember` adapter.

1. Extract a versioned recall result contract shared by `/api/recall` tests and
   the adapter.
2. Implement `/api/recall` on the current warm Explorer index.
3. Add a small Node client in `scripts/` that performs the localhost request,
   validates the contract, and emits normalized rows to the existing terminal
   renderer.
4. Route only ordinary queries through it. Preserve CLI implementations for
   `--get`, `--touch`, `--thread`, and `--transcript`.
5. Let the wrapper own delta exclusions and write served telemetry only after
   one backend's final result set is selected.

Acceptance:

- `CARTOGRAPHER_SEARCH_BACKEND=explorer` completes a real standard recall and
  its used result joins exactly in Internals;
- project, since, before, wildcard, limit, `--all`, and session delta behavior
  have fixture coverage;
- one request produces one served cohort with no duplicate logging;
- source and packaged runtimes remain byte-identical;
- extracted release smoke exercises the client against a fixture server.

### Slice 3 — utility canary before broad parity work

Owner: retrieval evaluation.

1. Run the local `/remember` workflow in `canary` mode until each backend has at
   least 50 exact calls.
2. Assign the CLI comparison cohort by stable query/session hash, not by
   manually choosing easy queries. Persist the assignment on the search-call
   row so a replay uses the same cohort.
3. Optionally shadow a small sample after returning accelerated results; shadow
   work must not delay the visible answer or write served telemetry.
4. Add the checked-in truth queries as an offline regression cohort, but keep
   live exact use as the primary decision signal.
5. Review utility by query shape, project, source contribution, and warm/cold
   state—not only as a global average.

Acceptance:

- Internals can answer whether the speedup reduced time to first use;
- the decision thresholds above can be calculated without manual joins;
- every accelerated miss can be replayed through both backends using the
  recorded query contract;
- the canary ends with a support, reconcile, or stop decision, not an indefinite
  dashboard.

### Slice 4 — reconcile only utility-relevant differences

Owner: ranking.

Known differences to audit:

| Difference | Current risk | Action rule |
|---|---|---|
| CLI fuses separate changelog, research, milestone, and tool-use lists; API currently has one deduplicated keyword list | Rank and source-credit changes | Split API keyword rankings only if affected queries lose used/truth results. |
| CLI applies salience during fusion; API activation path must be verified against it | Deliberate milestones may move | Add/fix only when rank deltas affect utility cohorts. |
| Source labels differ (`changelog+semantic` versus `keyword+semantic`) | Weak diagnostics and cohort analysis | Normalize before canary reporting. |
| Semantic thresholds and tail trimming may differ | Recall/noise tradeoff | Tune against used results and graded truth, not overlap alone. |
| `--intent` is not represented in the API contract | Intent-filtered recalls cannot accelerate | Add before enabling those calls. |
| Transcript fallback is CLI-only | Large, slow exceptional path | Keep out of Turbo scope. |

Output overlap is diagnostic. A faster result set may deliberately differ when
it produces equal or better exact use, time to first use, and first-access MRR.

Acceptance:

- each ranking change names the utility cohort it repairs;
- no change is accepted solely because it increases overlap with the CLI;
- checked-in fixtures lock the intended difference after it proves useful.

### Slice 5 — graduate the opt-in and make it on-demand

Owner: runtime and packaging.

1. Document `--turbo` and `CARTOGRAPHER_TURBO=1` as a supported opt-in after the
   utility gate passes. Do not make them the default.
2. First reuse an already-running Explorer API; do not require the React/Vite
   process for agent recall.
3. Add a headless API start command and a bounded on-demand bootstrap only after
   the canary proves that persistent memory buys utility.
4. Keep idle lifetime explicit: always-on, idle timeout, or manual stop must be
   a configuration choice informed by observed usage gaps.
5. Start no background process and make no health probe when Turbo Mode is
   disabled.
6. Expose Turbo status, process state, index freshness, memory, and backend
   selection in Internals.

Acceptance:

- a cold Turbo call either reaches a compatible headless service within its
  bounded startup budget or falls back once to the CLI;
- no duplicate service or port is created when Explorer is already running;
- uninstall and release docs state whether dependencies and a background
  process are present;
- default-off and `--no-turbo` remain complete zero-service paths.

## Verification matrix

| Layer | Required proof |
|---|---|
| Contract | Valid, unsupported-version, malformed-response, and missing-field fixtures |
| Backend choice | default off, per-call Turbo, persistent opt-in, strict Explorer, canary, timeout fallback, and contract-mismatch fallback |
| Retrieval | Project/time/wildcard/limit cases plus representative selective and broad queries |
| Session behavior | Delta suppression, `--all`, stable `call_id`, one served cohort |
| Utility | Backend-stratified success, first- and last-access MRR, first-use latency, and truth-query top 10 |
| Packaging | Canonical/plugin parity, production Explorer build, source smoke, extracted release smoke |
| Operations | Existing service reuse, no-service bootstrap, stale index, semantic unavailable, clean stop |

Benchmark runs must direct served and access telemetry to disposable files so
performance experiments do not contaminate utility cohorts.

## Non-goals

- exact result identity between CLI and Explorer;
- removing the portable bash/awk implementation;
- accelerating `--get`, `--touch`, `--thread`, or raw transcript grep;
- making Explorer remote or multi-user;
- replacing append-only ledgers with a database;
- imposing a memory cap before measuring utility;
- making Turbo Mode the default or enabling it without explicit consent;
- building a launch daemon before the live canary passes;
- treating result access as proof of subjective helpfulness.

## Stop conditions

Stop or narrow Turbo Mode if, after 50 exact calls:

- time to first use does not improve despite response latency improving;
- recall success drops by more than 5 percentage points and the loss is not
  isolated to a correctable query/source cohort;
- first-access MRR falls below 90% of the matched CLI cohort;
- fast results cause materially more reformulation without more eventual use;
- memory pressure measurably degrades the interactive coding workflow.

In that case, retain the instrumentation and Internals cohorts. They remain
useful even if Turbo Mode is not supported beyond the experiment.

## Assumptions and open questions

- The 583 MB reference footprint is acceptable for the first local canary. The
  canary must still record whether memory pressure degrades the coding session.
- Explorer dependencies are already installed on the canary machine. Packaging
  a headless dependency/bootstrap path belongs to Slice 5, after utility proof.
- A 20% CLI control allocation may be too intrusive at ~14 seconds per call. If
  it changes recall behavior, replace some live control traffic with
  non-blocking sampled replay and clearly label the weaker comparison.
- Exact access remains the primary available utility proxy. Add an explicit
  helpful/not-helpful outcome only if the canary shows access cannot explain
  important failures; do not ask the agent to rate every search preemptively.
- The right idle policy—always on, idle timeout, or manual—is intentionally
  undecided until usage gaps and memory pressure are visible in Internals.
