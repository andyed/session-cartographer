# Validating Session Cartographer against LongMemEval

Status: assessment, not a run. Nothing here has been measured yet · 2026-08-14

[LongMemEval](https://arxiv.org/abs/2410.10813) (Wu et al., ICLR 2025) is the
standard benchmark for long-term memory in chat assistants: 500 questions across
five ability categories, embedded in chat histories that scale to sustained
interaction length. Its headline finding — commercial assistants lose ~30%
accuracy as history grows — is the empirical case for purpose-built memory
tooling, which makes it the obvious external yardstick for a project like this
one.

This document records what running it would actually validate, what it
structurally cannot, and what the configuration has to look like for the number
to mean anything.

## Why bother

Cartographer's quality evidence is currently all internal: a nine-query truth
set (`demo/truth/`), a co-occurrence eval, and live retrieval telemetry. All
three measure the system against its own corpus. That is the right place to
measure the thing that makes it different — and it is worth nothing to anyone
comparing projects, because no one else can run it.

LongMemEval is the cheapest path to a number that is comparable to Mem0, Zep,
A-Mem, MemGPT, and NapMem, all of which report on it or its siblings.

## What it would actually validate

The benchmark's five categories, against the current implementation:

| Category | What it tests | Cartographer's position |
|---|---|---|
| **Information extraction** | Single-shot recall of an earlier fact | Directly served by hybrid BM25 + semantic. The path most likely to score respectably. |
| **Multi-session reasoning** | Synthesizing across several past conversations | Partially addressed since the April assessment. `--thread` walks the `parent_event_id` arc, and the co-occurrence graph surfaces cross-project siblings, but neither performs a *join* — the reading model still stitches the returned events. |
| **Knowledge updates** | Handling a fact that changed (said X, later Y) | **Still open.** The log is append-only and last-write-wins is implicit, invisible to ranking. This is the gap the topic-tracks work in `TODO.md` is meant to close. |
| **Temporal reasoning** | "When did I tell you about Z?" | **Shipped since the April assessment.** `--since` / `--before` accept natural-language phrases, relative durations, and absolute dates, and `/remember` maps user phrasing onto them. Previously called the highest-leverage gap; a run would show whether that was true. |
| **Abstention** | Knowing not to answer when the information isn't there | **Partially shipped.** Phantom detection flags entity-shaped tokens the corpus has never seen and logs them as knowledge gaps. It does not yet suppress a weak top-K — the CLI still returns results above the RRF cutoff regardless of confidence. |

Two of these five moved after the assessment in `TODO.md` was written
(2026-04-24). That assessment is now the main reason to run the benchmark: it
asserted where the gaps were, work shipped against two of those assertions, and
nothing has re-measured them. A run converts three stale claims into evidence.

## What it structurally cannot validate

**LongMemEval is a conversational benchmark.** Its histories are chat sessions.
Cartographer's differentiator is that it indexes tool-use events captured by
hooks — commits with diff shape, file edits, bash invocations, research fetches.
None of that exists in a LongMemEval history.

So a run exercises the transcript-turn path (`transcript-to-turns.awk` →
Qdrant) and the BM25 scorer, and leaves the event pipeline — the part nothing
else in the landscape has — entirely idle. A good score would say the retrieval
stack is sound. It would say nothing about whether capturing the work rather
than the conversation was the right bet.

State that limitation wherever the number gets published. A benchmark that
can't see your differentiator is a floor, not a verdict.

## Configuration: the part that decides whether the number means anything

Cartographer returns **ranked events, not answers.** LongMemEval scores answer
correctness with an LLM judge. Bridging that requires a reader:

```
LongMemEval history → ingest as transcripts → turn-group → embed
                                                             ↓
question → cartographer-search.sh → ranked events → reader model → judge
```

This is the standard RAG evaluation shape, and it is how a comparison against
Mem0 or Zep would have to be run anyway. It carries one serious hazard: **a
strong reader masks weak retrieval.** Claude answering from a mediocre context
window will score well enough to hide a ranking problem entirely.

Mitigations, all cheap:

- **Report recall@k alongside answer accuracy.** The retrieval metric is the one
  that describes cartographer; the answer metric describes the pair.
- **Fix and disclose the reader.** Same model, same prompt, across every
  configuration compared.
- **Run an ablation against no-retrieval.** If the reader scores well with an
  empty context, the question did not need memory and should not count as
  evidence for it.
- **Include the non-memory controls.** NapMem uses GPQA-Diamond and BFCL-v3 to
  show memory tooling does not degrade unrelated tasks. The analogous question
  here is inverted: cartographer's failure mode is *under*-invocation, not
  over-invocation, so the interesting measurement is how often `/remember` goes
  uncalled on questions that needed it.

## Ingestion path

No new machinery is required, which is the main argument for LongMemEval over
LoCoMo or PersonaMem-v2:

1. Convert each LongMemEval history into transcript-shaped JSONL.
2. Turn-group it with `transcript-to-turns.awk` (deterministic ids:
   `turn-<sid>-<idx>`).
3. Index into a **separate Qdrant collection** — set `CARTOGRAPHER_COLLECTION`.
   Never mix benchmark data into the working corpus; it would poison `/remember`
   and every downstream report.
4. Point `CARTOGRAPHER_DEV_DIR` at a fixture directory so the event-log path
   reads benchmark data rather than the live logs.
5. **Unset the session-id variables in the harness.** Delta serving is live: a
   harness that inherits a real session id silently loses repeat results and
   fails passing tests.

## Time decay will corrupt any fixed-label run

Cartographer applies a time-decay factor to ranking (`CARTOGRAPHER_DECAY_LAMBDA`,
default 0.001 ≈ 30-day half-life). That is correct for live recall and fatal for
a benchmark: a benchmark's labels are fixed at authoring time, so decay demotes
exactly the documents the scorer knows how to grade, and the effect compounds
with corpus growth.

Measured on the internal truth set, 2026-08-14, same corpus and same query set:

| | P@5 | recall |
|---|---|---|
| decay on (default) | bm25 0.11 · hybrid 0.13 | 22% · 15% |
| decay off | bm25 0.40 · hybrid 0.42 | 56% · 65% |

A 4x apparent quality difference, entirely an artifact of label age.
`scripts/eval-search.js` now forces `CARTOGRAPHER_DECAY_LAMBDA=0`. Any
LongMemEval harness must do the same, and any published number must state which
setting produced it.

## Known harness blockers

- `scripts/eval-search.js` uses a 120s `execSync` timeout. Any query that lands
  in the transcript BM25 path exceeds it. Either raise the timeout or split
  transcript scoring into its own harness before attempting 500 questions.
- Transcript BM25 costs 2–3s per file. At LongMemEval's history sizes the
  keyword transcript path is not viable; the run has to lean on the semantic
  index, which is the intended design but should be stated rather than
  discovered mid-run.

## Recommendation

Not first. Expanding `demo/truth` from nine to roughly forty graded queries is
cheaper, and it unblocks decisions that are currently stuck for want of an
instrument — phrase matching, stemming, stopword refinement (see the SDM bigram
post-mortem in `TODO.md`, where a correct change was reverted because nine
queries could not detect it).

LongMemEval is the second move: run it once the internal instrument is sharp
enough that a surprising external number can be diagnosed rather than merely
reported.

## References

- Wu et al., *LongMemEval: Benchmarking Chat Assistants on Long-Term
  Interactive Memory*, [arXiv:2410.10813](https://arxiv.org/abs/2410.10813)
- Maharana et al., *Evaluating Very Long-Term Conversational Memory of LLM
  Agents* (LoCoMo), ACL 2024 — sibling benchmark, same ingestion shape
- Jiang et al., *PersonaMem-v2*, [arXiv:2512.06688](https://arxiv.org/abs/2512.06688)
  — the eval that targets the derived profile layer specifically
- NapMem, [arXiv:2607.05794](https://arxiv.org/html/2607.05794v1) — reports on
  all three; the source of this document's framing
