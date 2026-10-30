# Review regrouping implementation

2026-10-29 · local, uncommitted · Session Cartographer

Implements the [opportunity sweep](REVIEW_OPPORTUNITIES_2026-10-29.md) using the
existing workspace, source identities, inspector and reader. The earlier commit-row,
artifact, search/fetch and live-refresh changes remain in place. This report covers
the broader follow-up, not unrelated concurrent recall tooling in the dirty tree.

## What changed

| Review task | Result |
| --- | --- |
| Recover another occurrence of a search hit | Exact full-text bundles expose every member, source and original rank. Different endings no longer collapse under a 120-character prefix. Rendering and keyboard navigation share one member projection. |
| Read beyond a preview | Outcome 4, Day file 6 and prose beyond character 300 have working local reveals. Content expansion is separate from Metadata. |
| Find useful work on a phone | Compact scope controls retain active restrictions, interval mode and freshness. Reading charts live inside the time editor. Activity keeps its chart below stationary view navigation. Day projects precede optional activity charts. |
| Review a file's attempts | Exact-path bundles contain reads, requested old/new replacements, responses, historical errors and exact source actions. Relative paths without recorded directory provenance stay separate. |
| Inspect a command and response | One disclosure contains input and all explicitly paired results. Both call and result IDs remain unique canonical anchors. Orphan, unavailable and search/fetch evidence keep their own valid paths. |
| Follow a file's history | Named evidence rows use a shared time baseline and exact event/source links where supported. Transcript calls resolve only when unique; missing sources remain unavailable and fetch failures offer Retry. Current disk contents are not presented as historical versions. |
| Activate the visible object | Day commits and Recall result bodies use native links. Event cards have a native primary destination with separate peer controls and selectable text. Read conversation now opens Conversation. |
| Interpret Recall | Shared context appears once only when every loaded result agrees. Mixed identities and served rank stay visible. Time offsets share one search baseline; exact times remain available. Local Retry preserves call and focus. Empty optional session Recall/files/observations are absent. |

## Defensive checks

New isolated built-app browser proofs:

- `tests/browser/search-review.cjs`: exact identity/rank recovery, long text,
  pointer selection, keyboard and modified-click destinations, secondary controls,
  and 390px layout. Synthetic API fixtures never access the live corpus.
- `tests/browser/review-disclosures.cjs`: outcome/file preview limits, whole Day
  row target, git-only nonlinks, shared/mixed Recall identities, rank 12 and exact time.
- `tests/browser/evidence-review.cjs`: file attempts, same-name worktrees,
  requested edits, multiple responses, unique anchors, reload/search navigation,
  absent empty categories, readable filenames and mobile evidence recovery.

These three are added to the existing Explorer CI workflow. CI itself has not run
for these uncommitted changes. The real isolated-backend memory/artifact and focus
journeys continue to cover API composition, file review, live refresh and scope.

The [style guide](INTERACTION_STYLE_GUIDE.md) now makes source recoverability,
truthful preview disclosures, first-result visibility and object/evidence grouping
separate gates. The repeated-copy metric is not a substitute for these checks.

## Verification and limits

Focused grouping/navigation units passed on BIGFU (15 tests), plus the evidence
slice's 12-test run and final search slice's 5-test run. These overlap; they are not
32 distinct tests. The complete focus-workspace browser journey passed after the
layout repair. Artifact review passed with inline command/results. All three new browser proofs passed against the final built asset, including actual
pointer text selection without injected styles. The last complete memory-entry
run also passed against that asset.

The complete memory-entry journey passed, including 8:1 measured text contrast,
file history source identity, local Recall retry, original rank, fixed-window links,
and the compact mobile views. All 20 audited page states pass the 5% repeated-copy
gate: Recall 3.08%, event feed 3.11%, Internals 4.22%, other measured states 0%.
Expanded file evidence separately measures 2.9%; its mobile error review 0%.

In the populated 390×844 fixture, the first Recall call begins at **622px** and
Day's first project at **695px**. The prior captures placed the work below the
first screen. These are viewport positions, not measured time savings.

| View | Before | After |
| --- | --- | --- |
| Recall, 390px | [Capture](assets/review-regrouping/before-carto-memory-recall-390.png) | [Capture](assets/review-regrouping/carto-memory-recall-390.png) |
| Day, 390px | [Capture](assets/review-regrouping/before-carto-memory-day-390.png) | [Capture](assets/review-regrouping/carto-memory-day-390.png) |

[Copy measurements](assets/review-regrouping/copy-summary.json),
[interaction measurements](assets/review-regrouping/interaction-audit.json),
[file evidence](assets/review-regrouping/file-bundle-1200.png),
[recoverable search members](assets/review-regrouping/search-occurrences-390.png).

During verification, the checks caught and corrected moving Activity navigation,
a narrow filter popover leaving the viewport, native links interfering with text
selection, counts squeezing filenames into a column, and repeated time labels
exceeding the copy budget. The final build is `index-BCk831Ns.js` with
`index-Drx60hLC.css`. Screenshots are deterministic fixtures, not evidence of measured human speed
or acceptance. Physical touch and assistive-technology acceptance remain untested.

No ranking, backend schema, source logging, remote publication or deployment change
was required. Existing Vite at port 2527 serves this worktree's local source. Build
still reports the existing large-bundle warning; that is not a usability result.
