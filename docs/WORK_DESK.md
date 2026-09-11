# Memory as a work desk

The Memory tab serves three connected jobs: find the thread to enter, understand
what changed during an absence, and inspect the actual work. It defaults to all
projects, grouped by session. The existing Field, Wake, and Compare instruments
support that desk in a secondary column instead of competing as main features.

## Implemented slice

- Search session titles, projects, observations, and resolved file paths.
- All threads, In flight, Changed and Landed filters; Projects, Threads and Artifacts depth.
- A manually saved return point, persisted in this browser. Polling, navigation,
  and reload never advance it. Saving another point explicitly replaces it.
- Catch-up windows: last hour, the shown 24 hours, or since the return point.
  An older checkpoint shows a coverage notice rather than claiming full coverage.
- Thread selection persists in canonical Memory permalinks, with a switcher in
  session and artifact review. Verified Codex session identities offer a native
  `codex://threads/<id>` link; known providers offer a quoted resume command.
  The installed Codex app's thread URL generation and both CLIs' help were checked.
- Markdown Preview/Source, semantic tables/lists/headings, and unified diffs with
  old/new line numbers. Raw HTML stays text. Remote images are not fetched.

## Evidence boundaries

“In flight” means an observation within 15 minutes of the selected frame. It is
not live process status. Quiet does not mean complete. A recorded session end or
wrapup is shown as a handoff only until newer activity arrives. Polling failures
leave the last snapshot visible and labeled; offline counts are not live counts.

“Landed” lists recorded commit and wrapup notes, not verified merges, pushes, or
releases. Commit totals come from the selected event interval; outcome notes are
retained separately from the 60 most recent notes so a busy session does not
silently lose its earlier outcomes. Sparse logs cannot explain every outcome.

File review remains current workspace content and a bounded Git diff from HEAD.
It is not a reconstruction of that session's historical edits. Session/file path
validation, file-size bounds, and symlink protection remain canonical server gates.

## Adjacent use cases

| Job | Useful next mechanism | Evidence needed |
| --- | --- | --- |
| Return after lunch | Stable checkpoint and a change queue | Timestamped observations; implemented |
| Find where intervention helps | Separate running, waiting, and failed threads | Provider process/approval state; not inferred from silence |
| Follow an artifact | Document lineage across sessions and commits | File identity, rename history, historical revisions |
| Detect collisions | See concurrent edits of the same file | Exact paths now; actual diff overlap later |
| Recover intent | Prompt → decision → artifact → commit | Transcript and explicit decision evidence |
| Prepare a handoff | Copy a compact briefing with source links | Remaining questions explicitly recorded by the session |
| Review what shipped | Link commits to PR, merge, deploy, release receipts | Distribution evidence beyond local logs |
| Park a thread | Pin its return question and checkpoint | Explicit user note, separate from automatic memory |
| Revisit a decision | Show why an approach was superseded | Competing decisions and the evidence that changed them |
| Prepare a weekly review | Outcomes and unresolved work across projects | Time coverage and exact source identities |
| Resume on another machine | Carry a reading position and open artifact | Sync authority, machine identity, available checkout |
| Inspect agent disagreement | Compare approaches against the same question | Matched intent and scope, not token-count ranking |
| Recover after compaction | Show what survived and what still needs checking | Compaction boundary, decisions, artifacts |
| Audit research provenance | Follow claims back through notes to sources | Citation and source identities |
| Recognize repeated friction | Find recurring blocked steps across projects | Explicit blockers, not slow activity alone |
| Assemble a review queue | Mark artifacts read without marking work complete | Per-user reading state with stable revision identities |

## Muriel synthesis — Compare

Question: what deserves the main surface? A graph-led cockpit supports spatial
exploration but makes thread switching indirect. A chronological feed supports
catch-up but repeats low-value actions. A work desk supports switching and artifact
reading through the existing session/file routes; its tradeoff is reducing chart
area. Choose the desk, retaining the instruments and their permalinks.

Provocation PV-M1 (change the unit): shift from aggregate activity to the thread
and the artifact a person can act on. Kept. PV-T3 (design the echo): an absence
leaves a return point whose boundary does not move during catch-up. Kept.

Shared mechanism: existing session identity and event timestamps serve navigation,
catch-up, and artifact provenance. No competing agent state store was introduced.
The return point is intentionally a browser reading preference, not corpus memory.

Proof: helper tests for exact catch-up boundaries, replay exclusion, state labels,
shared paths, safe resume commands, Markdown parsing, and diff line provenance;
isolated browser flows for reload/history, return point, thread switching, Markdown
preview/source, escaped HTML, current diff, neighboring Explorer routes, and mobile.

## Linked brushing and semantic zoom

Projects, Threads, and Artifacts are representations of one canonical camera
scale: below 0.85, 0.85–2.2, and 2.2 or above. Zoom changes the desk's content,
not its font size. A project expands to its threads; near zoom exposes paged file
review entries. Field pan/zoom and the three depth controls
share the existing camera permalink.

Field, Wake, and Compare coexist as small linked charts. The field retains
recorded project affinity and session positions, with contour fill removed in
compact mode. Wake uses event ticks across the recorded 24 hours; Compare uses
endpoint ticks and retains a separate strip for missing usage. Partial usage
keeps its dashed mark. Open the axis summary beside Compare to choose dimensions.

Hover or keyboard focus reveals a name in a fixed readout and highlights the
same session throughout the desk. Unrelated text retains its contrast. Drag a
rectangle on Wake or Compare to select a cohort; use Brush or Shift-drag in the
field (ordinary dragging pans). Wake tests events within the brushed time/row
rectangle, not just each session's final point. Space toggles a focused session
in the selection. Touch taps pin a session for inspection; the desk row or keyboard Enter
then enters it. Clear selection or Escape restores all threads. Pointer cancel
abandons a brush without changing selection.

Selected IDs live in the validated `brush` permalink field alongside the camera,
replay frame, and existing session/file state. Hover is transient. Both source
refreshes and browser reloads retain a committed selection. Brushing never
changes the corpus or the saved return point.

Muriel synthesis — Direct: preserve the work desk and make its existing session
identity the link between compact visual overviews and readable evidence. Keep
text labels on demand and maintain a fixed readout so hover cannot move a target.
Verification adds inclusive/reversed geometry, exact selected IDs, camera anchor
preservation, cross-view focus, keyboard pin/clear, semantic depth, reload,
cancelled drags, and touch inspection to the existing Explorer flows.

## Viewport layout and shipping boundary

The overview is a bounded index, not a scrolling feed. Rows are paginated to
fit the actual available height, with explicit ranges and Previous/Next actions.
The page offset survives detail navigation and resize; changing query, cohort,
filter, or depth starts a new result set. Existing task order remains stable
during live polling; Latest first explicitly refreshes it. New tasks append
without moving existing rows beneath a pointer.

Phone/narrow or short windows expose Overview / Charts focus. Laptop and desktop
show the task index and chart rail simultaneously, with larger layouts assigning
more width to the field. Query and local reading state stay mounted across these
focus changes. The rail fills the available height: Wake and Compare retain
compact fixed heights, and Field absorbs the remainder. Canvas glyphs and type
retain their physical size. Task, Markdown, diff and transcript details retain
reading scroll.

The five-seat Muriel jury split focused-list readability from simultaneous-chart
identity. The responsive combination preserves the user's task-first intent.
The user's subsequent spacing correction was decisive: tighten rows and chrome
instead of filling spare height with padding. Temporary jury artifacts and
illustrative mock marks are not distributed with the application; shipping
uses recorded session evidence and the existing field layout.

Find currently filters the loaded 24-hour corpus and intersects the brush and
work filter; Clear find and Clear selection are independent. All-history search
has its own Explorer tab. Richer find-as-you-type IA and age-based z-ordering
remain future work, not release requirements.
