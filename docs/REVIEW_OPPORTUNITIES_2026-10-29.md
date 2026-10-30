# Applying the session's interaction patterns elsewhere

2026-10-29 · original opportunity sweep. The broad follow-up is now implemented
locally; see [implementation and verification](REVIEW_REGROUPING_2026-10-29.md).
Descriptions below preserve the inspected starting state and acceptance intent.

The useful generalization is **review an object with its supporting context**:
a document with changes and sources; a search hit with its distinct occurrences;
an operation with its result. Repeated labels are one symptom. Fragmented evidence,
inaccessible grouped records and controls that displace the work are others.

Muriel Direct / audit contract: identify places where grouping and fewer navigation
steps can improve recovery of work, using existing components and state owners.
Evidence is current source inspection plus the previously generated, inspected
390px browser captures. Proposed usefulness gains require task testing; no new
production behavior or human-performance result is claimed by this sweep.

## First repair: compression that loses access

### 1. Search hides grouped records behind a nonfunctional disclosure

[Search.jsx](../explorer/src/components/Search.jsx), `GroupedResults` and
`DupeIndicator`: grouping uses the first 120 characters of the selected text.
The duplicate records are collected, but only their count reaches the indicator.
Its expanded state changes the arrow, without rendering any records. The keyboard
navigation separately repeats the same prefix-based grouping.

**Apply:** one result bundle with an actual member list. A 120-character prefix is
not identity. Preserve different sessions, timestamps, full text and source IDs.
Group exact source duplicates safely; title similar-text collections as related
occurrences rather than claiming duplication. Use one grouping projection for
rendering, keyboard order, counts and source navigation.

**Proof:** two records with the same prefix and different endings remain reachable;
two equal texts from different sessions retain both destinations; expanding with
pointer or keyboard reveals every member; result counts name hits versus bundles.

### 2. Preview caps have no route to the remaining items

- [MemorySession.jsx](../explorer/src/components/MemorySession.jsx) renders only
  `outcomes.slice(0,3)`; the outcome section has no reveal control.
- [MemoryDay.jsx](../explorer/src/components/MemoryDay.jsx), `ProjectDay`, reports
  the full edited-file count but renders only `files.slice(0,5)`, with no reveal.
- [EventCard.jsx](../explorer/src/components/EventCard.jsx) clips its primary
  summary at 300 characters; “more” exposes IDs, paths and metadata, not the rest
  of that summary. Opening the transcript is not an equivalent local reveal,
  especially when a transcript is unavailable.

**Apply:** a compact preview plus a truthful full-count disclosure, retaining all
loaded members. Expanded prose replaces its clipped preview. Label metadata
separately from the action that reveals content.

**Proof:** recover outcome 4, file 6 and text after character 300 through the
visible controls. Expansion must not duplicate the excerpt or lose source links.
This is about UI access to loaded records, not a claim of complete source logging.

## Largest layout opportunity: let the work enter the first screen

### 3. Reading views inherit the entire scope-editing interface

[WorkingMemory.jsx](../explorer/src/components/WorkingMemory.jsx) renders heading,
Timeline handoff, `FocusToolbar`, `FocusTimeline` and then view navigation before
Recall/Day content. The prior 390px captures show controls occupying nearly the
whole first viewport; Day's project/commit content is below it.

**Apply:** in Tasks, Files, Recall and Day, start with a compact persistent scope
summary and the current view. Keep active restrictions, interval semantics and
staleness/errors visible. Put the range chart, presets and less-used editing
controls behind one scope disclosure. The Activity/Timeline exploration surfaces
can retain their prominent chart. Reuse the existing toolbar, focus owner and
range editor; do not create independent filter state.

**Proof:** a populated 390px reading view shows at least one useful result before
scrolling. Every active filter remains visible/removable. Editing and canceling
scope preserve exact bounds, fixed/rolling mode, focus and copied URLs.

**Limit:** this is a composition proposal supported by inspected captures, not a
measured improvement in reading speed. It needs before/after captures and a
recover-an-output task, not just shorter CSS dimensions.

## Largest evidence opportunity: use the file or operation as the review unit

### 4. The evidence inspector remains organized by logging mechanism

[TranscriptEvidence.jsx](../explorer/src/components/TranscriptEvidence.jsx),
`TranscriptEvidenceIndex`, renders separate Errors, Files referenced by tools and
Tools lists. Each file operation repeats the full path; each call repeats a tool
name and generic result status. The same activity can appear across all three.
[transcript-evidence.js](../explorer/server/transcript-evidence.js) already retains
file path, operation, message/block/call IDs and status, so explicit joins exist.

**Apply:** one file bundle: relative path, recorded operations, related failures,
preview/diff when available and exact sources. Show shared directory once. Distinguish
read/reference from attempted write and confirmed output. Keep remaining operations
in a subordinate activity list. Never collapse same basenames from different
worktrees or join unrelated calls by nearby timestamps.

**Proof:** a read → failed edit → successful edit for one file can be reviewed in
one place; all three records remain recoverable and the earlier failure is not
silently treated as unresolved. A second worktree's same-named file remains separate.

### 5. Paired call/result records still require navigation between them

`ToolEvidenceBlock` in the same component shows “Go to result” and “Go to call”
controls, including numbered results. Call/result associations already exist;
search/fetch bundling demonstrated a better presentation approach this session.

**Apply:** one operation disclosure containing its meaningful input and paired
results. Use result/error state as the summary, preserving missing-result and
orphan-result states. Retain both canonical IDs as navigable source anchors so
search hits still reveal the correct part. Multiple outputs keep their identities;
do not invent distinctions or call a returned result successful without evidence.

**Proof:** inspect a command and output without leaving its review unit; exact
call and result links, one-to-many results, failures and short-query matches still
work. Measure location jumps for that task before/after, not only word count.

### 6. A file's evidence trail shows identifiers instead of reviewable changes

[MemoryInspector.jsx](../explorer/src/components/MemoryInspector.jsx), “Recorded
edit evidence”, lists timestamps and edit IDs. It does not identify what those
edits did or link each row to a readable supporting record. Current-file/diff
review is useful already; the provenance tail is still a log.

**Apply:** a file history under its existing filename: named operations or commit
subjects, baseline-relative time, contributor and exact source when available.
Keep current disk contents distinct from historical changes. Inspect the API's
available provenance before promising per-edit text or a historical revision.
An ID is a lookup key, not the human-facing explanation.

**Proof:** answer “which recorded change supports this?” from the file view and
return to the same file/contributor/mode. Missing provenance remains explicitly
unavailable; no inferred joins from filename alone.

## Transfer the interaction contract, not merely the glyph

### 7. Single destinations still have small targets or misleading labels

- [MemoryDay.jsx](../explorer/src/components/MemoryDay.jsx), `CommitRow`: only the
  subject links to a session. Apply the whole-row native link when that is its
  sole action; retain git-only rows as non-navigable unless a real destination exists.
  A session destination must not masquerade as a commit diff.
- [MemoryRecall.jsx](../explorer/src/components/MemoryRecall.jsx), `ResultRow`:
  the summary is inert while `EpisodeLink` is a separate small glyph. Make the
  primary result body the canonical link where episode identity/range exist;
  keep use/fetch markers informational. Preserve served rank and attribution.
- [MemoryDesk.jsx](../explorer/src/components/MemoryDesk.jsx), `SessionHandoff`:
  “Read conversation” builds a plain session URL, while the reader defaults to
  Summary. Set the intended reader mode or change the label to match the destination.
- [EventCard.jsx](../explorer/src/components/EventCard.jsx) uses a containing
  `div` click handler with separate nested actions. Give its primary destination
  a native target alongside distinct source/filter/detail controls; a blanket
  wrapper anchor would create nested-interactive problems.

**Proof:** title/whitespace/native keyboard/modified-click agree; displayed action
matches destination; secondary actions do not trigger the primary one; text
selection still works.

### 8. Recall can share context without hiding ranking or attribution

`MemoryRecall` repeats provider, session title, source, project and absolute time
on result rows. Call headers add purpose/backend and served/used/fetched counts.
`CallResults` has an error-only branch without local Retry, although outer recall
views have recovery controls. Optional `SessionRecall` also prints a no-searches
paragraph for an empty session.

**Apply:** retain ranked order, but move truly shared provider/project/session
context to the appropriate group header; retain per-row exceptions. Express result
age relative to the call with exact time accessible. Suppress optional empty
session recall, while preserving a useful empty state on an explicitly selected
Recall page. Give detail failures their own Retry without closing the call.

**Proof:** rank-12 use remains rank 12; mixed-session results keep identities;
“fetched” is not conflated with “marked used”; an error/retry retains the same
query, selected call and focus. Do not re-sort by session just to reduce labels.

## Sequence

1. Repair inaccessible grouped search members and preview caps. These are
   recoverability defects, not aesthetic preferences.
2. Compact shared scope controls in reading views; prove the first-content and
   exact-state-preservation contracts on mobile.
3. Bundle file evidence and paired operations using existing canonical identities.
4. Propagate native action targets, truthful destinations and local recovery to
   Day, Recall and legacy event cards.

The existing GitHub destination backlog fits inside the file/commit review unit.
Do not add a separate links dashboard: put a verified remote commit/diff beside
that commit, and distinguish local-only work from published state.

## Defenses to add beside repeated-copy scoring

| Question | Observable check |
| --- | --- |
| Did grouping lose anything? | Every input source identity is reachable through the bundle or its disclosure. |
| Does a reveal actually reveal? | Activation changes visible content, not just a chevron; content beyond every preview cap is reachable. |
| Can the work be seen? | Capture first useful result position in a standard populated 390px viewport; retain visible active scope. |
| Are we making people join records mentally? | Count cross-location jumps needed to inspect an object and its existing paired evidence. |
| Is compressed context recoverable? | Full paths/times/provenance remain accessible; exceptions stay visible. |
| Is the action honest? | Native target and input behavior match the named destination; failure offers local recovery. |

These are product review gates and hypotheses about easier use. They are not a
validated composite usability score. Keep them separate rather than letting a
low word-repetition score compensate for inaccessible content.
