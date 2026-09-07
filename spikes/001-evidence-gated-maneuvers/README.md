# Spike 001: Evidence-gated maneuver learning lab

## Question

**Given** immutable Session Cartographer-style outcome events, **when** a bounded learning pass induces reusable procedures, **then** can it produce attributable candidate maneuvers, refuse unsupported promotion, preserve negative evidence, and evaluate the candidates in shadow mode without writing canonical memory or skills?

## Boundaries

- Standalone and disposable under `spikes/`.
- Reads fixture or explicitly supplied JSONL only.
- Writes no Session Cartographer logs, profile, memory, skills, configuration, or source files.
- A candidate can become `eligible_for_promotion`; it never becomes `active` here.
- Promotion to a canonical skill remains a separate, human-approved action.
- Deterministic verifier receipts outrank model judgment and self-report.

## Planned tracer bullets

1. One strongly verified trajectory may create an eligible candidate, but its status remains `candidate`.
2. Repeated moderate evidence may create eligibility; weak self-report may not.
3. Attributed failure disputes a candidate and blocks eligibility.
4. Shadow evaluation compares verified completion, regressions, retries, and token cost against a baseline.
5. Missing provenance is rejected rather than guessed.

## Running

```bash
node --test spikes/001-evidence-gated-maneuvers/learning-lab.test.js
node spikes/001-evidence-gated-maneuvers/learning-lab.js \
  --episodes spikes/001-evidence-gated-maneuvers/fixtures/episodes.jsonl \
  --trials spikes/001-evidence-gated-maneuvers/fixtures/trials.jsonl
```

## Verdict: PARTIAL

### What worked

- The ledger preserves event provenance and rejects records without `event_id`.
- Duplicate event IDs cannot count as independent support, and missing project scope is rejected rather than pooled globally.
- One deterministic strong verifier or two independent moderate verifiers can make a maneuver eligible while leaving it `candidate` and `shadow_only`.
- Verifier-type ceilings prevent self-report from relabeling itself as strong; missing artifacts and unverified outcomes cannot inflate successful support.
- Repeated self-report remains ineligible.
- Attributed failure changes the maneuver to `disputed` and blocks eligibility.
- Project scope prevents evidence from unrelated repositories from pooling.
- The shadow comparator measures paired verified completion, regressions, retries, and token cost.
- Incomplete pairs, duplicate variants, and malformed or negative metrics withhold validation and remain visible as rejected evidence.
- The CLI reports `canonical_writes: false`; it has no write path.

### What did not get validated

- The fixture shadow run improved verified completion from 2/3 to 3/3, removed four retries, and used 2,700 fewer tokens, but those are constructed trials. They prove the evaluator's behavior, not that induced maneuvers improve real agent work.
- The spike consumes already-structured outcome events. Session Cartographer does not yet emit this schema from ordinary work.
- Eligibility is policy evidence, not semantic truth. A generated lesson could still overstate what its verifier established.
- No candidate is retrieved into a live Hermes task, and no held-out real-task comparison has run.

### Verification

- Spike tests: **16 passed**.
- Existing project unit tests: **134 passed, 2 failed** across 136 tests. The two failures are the pre-existing non-hermetic Turbo recall tests that leak live semantic-index results into fixture expectations (`tests/unit/turbo-recall.test.js`).

### Recommendation for the real build

Keep the three-store boundary: immutable events, revisable candidates, and separately approved canonical skills/facts. The next experiment should instrument 12–20 real but low-risk tasks, randomize baseline versus candidate-assisted recall, and require deterministic verifier receipts where available. Do not add a promotion write path until the shadow cohort improves verified completion without increasing regressions.
