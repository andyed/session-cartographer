# Archival recall — frecency and query-aware decay

Status: plan, measurement not yet run · 2026-09-24

Old material is unreachable by default. This document states the evidence,
the design agreed on 2026-09-24, and the measurement that gates any ranking
change. It replaces the "Archival recall is buried by recency weighting" entry
at the top of `TODO.md` as the working plan; that entry stays as the record of
the original evidence.

## Evidence

- **Decay dominates relevance on lookup queries.** `scripts/eval-search.js`
  records that on 2026-08-14, with the same corpus and truth set, decay on gave
  keyword P@5 0.11 / recall 22% and hybrid 0.13 / 15%; decay off gave keyword
  0.40 / 56% and hybrid 0.42 / 65%. The harness now runs with
  `CARTOGRAPHER_DECAY_LAMBDA=0` for that reason.
- **The curve is steep.** `exp(-0.001 · hours)` (~30-day half-life) weights a
  237-day-old event at 0.0034 against ~0.98 for yesterday: a ~290× handicap
  before relevance is considered (TODO, 2026-09-07).
- **The noise trim runs after decay.** On the Turbo path,
  `explorer/server/search.js` applies `applyActivation` and then drops
  everything below 10% of the top score, so the trim removes old items for
  their age, not their relevance. This is the likely cause of the observed
  173-item pool collapsing to 2. The portable path is not yet checked.
  (The comment above that filter says 20%; the code says 10%.)
- **Reuse compounds it.** Promote-on-reuse resets an item's effective age to
  its last access, a further ~50× over an untouched contemporary.

## Two query intents, one curve

"What was I doing" wants recency. "Blauch feedback", a commit hash, or
"diff shape" is a known-item lookup where age is irrelevant. A single decay
curve cannot serve both, which is why no single λ has worked. The design
therefore separates **how old material earns its place** (frecency) from
**how much a query cares about age** (query-aware decay).

## Frecency: what later work keeps returning to

A visit is later *work* touching an entity, never retrieval exposure. Serving a
result records nothing, as today; counting it would recreate the
rich-get-richer loop promote-on-reuse already has.

| Entity | A visit is |
|---|---|
| File | edited in a later session |
| URL / paper | fetched or cited in a later session |
| Decision / wrapup | its distinctive terms recurring in later sessions (later) |

Commit shas were tested and dropped: in the probe, one commit in the whole
corpus was ever mentioned by a later session.

Visit weight, strongest first: explicit use (`--touch`, Explorer open) >
cited by a wrapup or decision > revisited in later work > shown (weight 0).

Rules the probe established:

- **Own activity only.** Count the owner's edits, fetches, and commits under
  `ownership.js`. Imported history from cloned repositories is excluded; the
  first probe was polluted by 203 of another author's commits until
  `repair-foreign-commit-sessions.js` (21525fe).
- **Distinct sessions, not events.** Forty edits in one session are one visit.
  The same-session wrapup is not a revisit.
- **Chores and hubs are not memories.** Release manifests (`package*.json`,
  `latest-mac.yml`, changelogs, `MEMORY.md`) and files touched by most of their
  project's sessions are excluded or damped.
- **Dormant, not live.** Frecency lifts entities whose last touch is old.
  A file edited this week (psychodeli `index.html`, first seen in March) is
  already served by recency; lifting its March events would resurface stale
  edits. The target is the 2026-09-24 dormant list: the March vision-science
  reading (FOVI, castleCSF, chromatic eccentricity, Visual Clutter),
  `lorenz-attractor.js`, `motion-primitives.js`, `adserp.tex`, `paper-v4.md`.
  Andy reviewed that list and confirmed it as valuable.
- **Events inherit from entities** (max over the entities an event names),
  and frecency multiplies onto relevance with a ceiling; it never ranks alone.

Form: ACT-R base-level activation over session-visits,
`B = ln Σ_j t_j^-d`, d = 0.5 (Anderson & Schooler 1991). Reuse adds a term
instead of resetting age.

Storage: a derived, regenerable sidecar `.carto/frecency.json`, built from the
logs like `profile.md`, updated incrementally with the facts delta cursor, held
in memory by Turbo and read from disk by the portable path.

**Limit.** Frecency cannot rescue material that was important once and never
revisited (the January prompt in the TODO evidence). That case belongs to
query-aware decay.

## Query-aware decay

Candidates, to be compared by the measurement below:

1. **Power-law instead of exponential.** `t^-d` with d = 0.5 costs a 237-day
   gap ~15× instead of ~290×.
2. **Specificity-conditioned decay.** High-IDF terms, quoted phrases, hashes,
   and proper nouns mark a lookup and get little or no decay; vague queries
   keep it. Deterministic from the query and index statistics.
3. **Event-type half-lives.** Wrapups, decisions and research fade slowly;
   bash and routine edits fade fast. Salience already types them.
4. **Archive slots.** Reserve 2 of the top 10 for the best undecayed matches
   older than 30 days, labelled as archive. Needs no weak-result threshold.

## Measurement

### Offline: known-item age curve (the gate)

1. Sample text-bearing events (prompts, wrapups and milestones, research
   fetches with topics, commits) stratified by age: <1 wk, 1–4 wk, 1–3 mo,
   3+ mo. Owner's events only.
2. For each, build a query from its 3–4 highest-IDF terms. Drop queries whose
   terms match more than N events (not a known item).
3. Run every query through each arm and record the target's rank:
   success@10, MRR, and success@10 by age bucket.
4. Add the recency-intent cases from `tests/private/search-test-cases.md` and
   the `demo/truth/` set, so an arm cannot win by never decaying.

Arms: current exponential (λ = 0.001); no decay (λ = 0); power law (d = 0.5);
trim-before-decay with each; frecency prior; specificity-conditioned decay.

Engine: the Turbo search module in-process, one corpus load per arm, because
the portable path costs ~12–16 s per query. Spot-check a sample on the portable
path for parity, as the scope-parity fixes require.

Pass criteria (provisional): the chosen arm raises 3+ month success@10
substantially over the current arm, loses no more than 5 points of
success@10 in the <1 week bucket, and loses no recency-intent truth case from
the top 10.

### Online: interleaving

After an arm passes offline, serve team-draft interleavings of the current and
candidate rankings and credit whichever contributed an explicitly used result
(`--touch`, Explorer opens). The 186 calls with explicit use are usable as
training pairs but not as the judge: they are biased toward what the current
ranker showed.

## Order of work

1. Build the age-curve harness; record the baseline for the current arm and
   λ = 0. Check trim order on the portable path.
2. Move the noise trim before decay on both paths; re-measure.
3. Build `.carto/frecency.json` from own activity; add it as an arm.
4. Add power-law and specificity-conditioned decay as arms; pick by the gate.
5. Ship behind one flag on both engines; run interleaving before making it the
   default.

The exploratory probe that produced the dormant list is not checked in; step 3
rebuilds it as `scripts/build-frecency.js`.

## Reference

Anderson, J. R., & Schooler, L. J. (1991). Reflections of the environment in
memory. *Psychological Science*, 2(6), 396–408.
