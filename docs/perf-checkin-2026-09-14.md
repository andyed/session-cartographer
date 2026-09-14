# Recall performance check-in — 2026-09-14

*Produced by `node scripts/perf-checkin.js --synthetic 127000` on a 4-CPU Linux
container, Node 22.22. Rerun it on your own corpus with the script; every
number below is a property of this machine and this corpus, not of the code
alone.*

## Why a synthetic corpus

The container that ran this has no session history, so the script generated
one with the shape of the maintainer's: five logs, twelve projects, two
providers, ~13.5k sessions, Zipfian summaries with file paths and commit hashes
mixed in, 400 days of timestamps with ~1% in the last 24 h, and ~15% of
research rows dual-logged into the changelog under the same `event_id` so dedup
has work to do. 127,000 rows, 30 MB on disk — the same order as the reference
corpus in [FACTS.md](FACTS.md) (127,129 events).

Absolute latencies therefore do not compare to the reference table one to one
(a container fold is slower than a laptop fold). The *ratios* do: load cost
against fold cost, warm against portable, single request against burst.

## Results

| Path | Operation | Median | p95 | Note |
|---|---|---:|---:|---|
| in-process | load five logs (readAllEvents) | 1265.32 ms | — | 127,000 events resident |
| in-process | build BM25 index | 1202.99 ms | — | 127,000 docs, +256 MB RSS |
| in-process | scoreBM25, limit 500 | 29.78 ms | 57.26 ms | 8 queries × 5 |
| in-process | hybridSearch, keyword leg only | 30.29 ms | 45.84 ms | RRF + facets, semantic pinned off |
| in-process | scoreBM25 with a 24 h window | 57.3 ms | — | 156/156 rows in window |
| in-process | facts census, 24 h | 47.11 ms | — | scan 46.75 ms |
| in-process | facts census, whole corpus | 145.68 ms | — | scan 145.58 ms |
| in-process | facts tempo | 86.67 ms | — | scan 86.54 ms |
| in-process | facts delta baseline / resume | 1.22 / 1.36 ms | — | reported 50 new after 50 appended |
| CLI | cartographer-search.sh, Turbo off | 676.65 ms | 698.07 ms | bash + awk, 3 queries, wall clock |
| CLI | cartographer-search.sh, Turbo on | 277.74 ms | 289.01 ms | wall clock incl. node client startup |
| Turbo | enable → ready | 2863.28 ms | — | spawn + load 127,050 events; http listening, port answered 50.84 ms later |
| Turbo | POST /api/recall, warm | 37.91 ms | 63.34 ms | server stages 35.4 ms median |
| Turbo | POST /api/facts census + tempo | 75.81 ms | 110.95 ms | |
| Turbo | 20 concurrent recalls | 435.31 ms | 772.48 ms | 774.75 ms wall, 0 failed |
| Turbo | contract rejection round trip | 1.78 ms | — | HTTP 400; client exit 75 in 110.42 ms |
| Turbo | live append visible in recall | 147.97 ms | — | no restart |
| Turbo | server RSS after the run | 478 MB | — | heap 354 MB |
| Turbo | disable → stopped | 1666.91 ms | — | process alive after: false |

### Checks

- PASS — windowed keyword rows all fall inside the window (156/156)
- PASS — 24h census count survives an independent scan (census 1283 vs written 1283)
- PASS — delta cursor reports exactly the appended rows (reported 50, appended 50)
- PASS — portable CLI returns ranked rows on every query (0/10 0/13 0/12)
- PASS — controller spawns a Turbo service and reports it listening (enable reported http=listening; port answered 50.84 ms after enable returned)
- PASS — warm /api/recall answers 200 with rows (0 non-200)
- PASS — warm /api/facts answers 200
- PASS — 20 concurrent recalls all succeed inside the 1500 ms budget
- PASS — contract rejection is a fast 4xx (400 in 1.78 ms)
- PASS — malformed JSON is a 400
- PASS — client exits non-zero on rejection without spool fallback (exit 75 in 110.42 ms)
- PASS — a live append is recallable without a restart (147.97 ms)
- PASS — CLI with Turbo on returns ranked rows on every query (0/15 0/15 0/15)
- PASS — status reports a compatible managed service
- PASS — disable stops the service and clears its state


## What the numbers say

**The folds-not-indexes decision still holds.** A whole-corpus census is ~145 ms
and a tempo series ~87 ms over 127k resident events, against Turbo's 1500 ms
request budget: 6–10% of the budget on a slow machine, 1–3% on the reference
laptop. Nothing here argues for precomputing aggregates. What the check-in did
find is that one fold was paying for formatting, not counting: `utcDay` called
`new Date(ms).toISOString()` once per event and cost 62 of tempo's 168 ms.
Formatting once per distinct day (a corpus has a few thousand) with
byte-identical output took tempo to 87 ms. `eventEpochMs` parses every
timestamp on every fold too (~31 ms per pass); caching the epoch on the
resident event object would recover most of that, but the events are returned
wholesale by some routes and a new stamped field would leak into responses, so
that is deliberately not done here.

**Load dominates, and it is paid once.** Reading the five logs is ~1.3 s and
building the BM25 index another ~1.2 s; a warm keyword recall is then ~30 ms
median, ~46–57 ms p95. This is the whole argument for Turbo — the portable CLI
pays a proportional cost on every call. On this corpus the portable path is
~670 ms wall, faster than the 7–15 s the [July assessment](assessment-2026-07.md)
measured, because the CLI now pre-filters each log with `grep` before the awk
scorer sees it; Turbo through the CLI is ~270 ms wall, of which roughly 40 ms
is the server and the rest is node client startup and telemetry. On a real
corpus with longer summaries the portable path scales with bytes on disk and
Turbo does not.

**Turbo is robust to what the spec says it handles.** All probes passed on the
final run:

- Twenty concurrent recalls all answered 200 with p95 under the 1500 ms budget.
  The server is one process on one thread, so a burst costs roughly
  N × 40 ms; above ~35 simultaneous callers the tail would cross the CLI's
  timeout and callers would fall back to the portable path, which is still
  correct. Nothing today produces that many concurrent recalls.
- A contract rejection (`limit: 99999`) is answered in under 2 ms as HTTP 400;
  the client exits non-zero in ~100 ms and does not try the file spool. This is
  the "an HTTP status is an answer, not an outage" rule from 0.7.5, verified
  rather than assumed.
- Malformed JSON is a 400.
- A row appended to `changelog.jsonl` after spawn was recallable in ~150 ms
  with no restart.
- `status` reports a compatible managed service; `disable` stops it within
  ~2 s and leaves no `ready.json` behind.

**One race, fixed.** On one of three runs `enable` returned with
`http: "starting"`: the server publishes `ready.json` when the corpus is loaded
and again when `listen()` settles, and the controller accepted the first. A
recall fired immediately after `enable` would have raced the listener and
succeeded only through the file spool. The controller now waits for a terminal
HTTP state. The benchmark records how long after `enable` the port actually
answered so a regression here shows up as a number, not a flake.

**Memory.** The server held ~480 MB RSS (~350 MB heap) for 127k events, in line
with the ~583 MB the [Turbo spec](TURBO_MODE_SPEC.md) recorded for ~108k on
the reference machine. The index accounts for ~255 MB of that. This is the cost
of a warm service and is not new; it stays opt-in.

## What this does not establish

- Nothing about recall *quality*. The utility canary in the Turbo spec is
  untouched; speed is measured, better recall is not demonstrated.
- Nothing about the semantic leg. Qdrant was pinned off; the `windowed()`
  backstop and the server-side range clause are covered by unit tests, not by
  this run.
- Nothing about the Explorer UI's render cost. The memory work desk is very
  alpha and has no performance budget yet.

## Reproducing

```bash
node scripts/perf-checkin.js                  # your corpus, or synthetic if none
node scripts/perf-checkin.js --synthetic 127000 --json > perf.json
node scripts/perf-checkin.js --skip-turbo     # in-process + CLI only
```

The script redirects the served log, access ledger, Turbo config, and Turbo
state to a temporary directory and removes it afterwards, so a benchmark run
leaves no trace in the utility telemetry.
