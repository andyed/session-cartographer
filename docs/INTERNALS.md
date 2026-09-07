# Explorer Internals

Internals is Cartographer's system-observation surface. The Timeline explains
the chronology and concurrency of human work; Internals explains how
Cartographer captured, indexed, served, and observed reuse of that work. The
two views deliberately do not share lane, overlap, or project-color semantics.

## Measurement contract

The default cohort is exact-attributed `remember` traffic. A served row counts
as exact only when it has both `call_id` and `event_id`. A use is credited only
when `access-ledger.jsonl` contains the same pair. Legacy proximity inference is
not used in the Explorer.

- **Calls with access**: calls with at least one exact fetch or use / exact-attributed calls. The API retains `callSuccessRate` for compatibility.
- **Result-row use**: exact used rows / exact served rows.
- **First-access MRR**: `1 / first-accessed-rank` over the jointly ordered call
  cohort. Calls with no observed use remain in the denominator as zero. This is
  the primary MRR and is also returned in the compatibility `mrr` field.
- **Last-access MRR**: `1 / last-accessed-rank` over that exact same cohort. This
  is a secondary exploration-depth diagnostic, not a replacement for first
  access.
- **First access rank**: distribution of the first exact access in each call,
  including an explicit `none` bucket.
- **Attribution coverage**: rows carrying the identifiers needed for exact
  joins. Coverage is a trust guardrail, not a product outcome.

An observed access means a result was fetched or touched. Fetching is inspection;
`--touch` is the caller's statement that the result contributed to the answer.
Neither is a relevance judgment or proof that the intended episode was recovered.
Purposes that do not emit comparable access records must not be compared as if
their zero-access counts were outcomes.

The API preserves the existing access metrics and adds `fetched` and `explicitUse`
under `utility` and every mode cohort. Each has the same call, result, rank, and
MRR fields, filtering respectively to `source=result_fetched` and
`source=result_used`. Each retains the full call denominator, including calls
with no results. These measures overlap: a result fetched and later marked used
appears once in each, and only once in the combined access metric. Historical
access rows without a source remain in the combined metric only.

The UI places access and explicit-use rates/MRR side by side. It never labels
fetches as successful recall. No-use calls contribute zero in each measure;
ambiguous access ordering is handled independently for each evidence category.

New multi-result access rows carry an `access_batch_id` and 1-based
`access_ordinal`; the ordinal resolves first and last within a tied batch.
Historical same-time multi-result batches without ordinals remain `unknown`
instead of receiving an invented append or lexical order. If either boundary
is unknown, the call is excluded from both MRR denominators so the two values
remain directly comparable.

## Data and API

`GET /api/internals?window=30d&purpose=remember` reads:

- `served-log.jsonl`
- `access-ledger.jsonl`
- `.carto/index-errors.jsonl`

Supported windows are `7d`, `30d`, and `all`. `refresh=1` bypasses a completed
cache entry while still coalescing identical in-flight builds. The response is
one atomic snapshot containing metadata, coverage, utility outcomes, daily
activity, source/project/purpose breakdowns, and operational file/error state.
Current in-memory event and keyword-index counts are attached by the Explorer
server without rescanning the event corpus.

Source labels are canonicalized as deduplicated `+` combinations. RRF itself
also accepts at most one contribution per `(source, event_id)`, preventing
duplicate historical rows from inflating scores or telemetry labels.

## Refresh and performance

The browser follows the proven mbp-dash stale-while-revalidate interaction:
render the latest versioned local snapshot immediately, keep it mounted during
refresh, and atomically replace it after a successful response. Abort signals
and request generations prevent a late response for one window from replacing
a newer selection.

Explorer views mount lazily on first use and then remain mounted. A direct
`/internals` visit therefore avoids loading Timeline or Search data, while a
return visit still preserves those views' scroll and filter state.

On the server, `(source fingerprint, window, purpose)` is the cache key. The
fingerprint uses path, size, and modification time. Duplicate simultaneous
requests share one promise. Small ledgers aggregate inline because worker
startup and serialization cost more than the work; inputs above the configured
threshold move to a worker to protect the Express event loop.

Explorer startup separately deduplicates overlapping event logs through an
`event_id -> event` map. Do not replace it with a repeated linear array search:
that makes startup quadratic on overlapping six-figure corpora.

## Honest gaps

Search-call telemetry supplies response and stage latency for newer calls.
Historical calls without timing remain unavailable. Semantic *index coverage*
is not known; it is distinct from semantic *availability at request time*.

Each mode cohort includes `semanticCohorts` for recorded `available`,
`unavailable`, and `unknown` states, with access/use metrics and latency in each.
The availability rate uses only measured available/unavailable calls; unknown
counts stay visible. Faster keyword-only responses must not imply equivalent
full-search quality. Response maximum and fallback counts remain visible even
when a rare slow fallback sits beyond p95. A fallback stays in the requested
mode and keeps unknown semantic state when the CLI does not measure it.

Session attribution is reported independently of exact call/result IDs. Missing
session identity limits reformulation and adoption analyses; an exact join alone
does not establish that the last query caused the use. Historical ledgers are
never rewritten to manufacture missing provenance.

New calls record request-start and result-served timestamps; new accesses include
millisecond timestamps. `timeToFirstAccess` reports samples, p50/p95/maximum,
missing-start counts, missing-access-time counts, and negative samples excluded.
The same measure under `explicitUse` ends at the first explicit use. Historical
response timestamps are never treated as request start, and no-use calls remain
in the paired call-success denominator.

The 50-call-per-mode floor is a prerequisite for comparing Turbo and CLI, not
proof that the cohorts are matched. Query/task/provider mix and semantic
availability still need to be considered.

## Verification

The unit suite covers exact-versus-legacy attribution, no-use calls, source
normalization, missing files, cache coalescing, duplicate-source RRF behavior,
and linear event-log deduplication. The Explorer production build and the
source/plugin parity smoke must pass before packaging.
