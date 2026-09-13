# Memory as a work desk

The Memory tab serves three connected jobs: find the thread to enter, understand
what changed during an absence, and inspect the actual work. It defaults to all
projects, grouped by session. The existing Field, Wake, and Compare instruments
support that desk in a secondary column instead of competing as main features.

## Implemented slice

- Search session titles, projects, observations, and resolved file paths.
- All threads, In flight, Changed and Landed filters; Projects, Threads and Artifacts depth.
- At Artifacts depth the trail is one row per path across every thread that
  touched it, documents ahead of code, newest edit first. A row opens the newest
  thread's review; its thread count zooms to those threads as the selected cohort.
  The Documents toggle (`kind=md`) keeps only Markdown. Here the find box narrows
  files as well as threads: a thread matched by path contributes only matching
  paths, one matched by title or note contributes all of its files.
- A manually saved return point, persisted in this browser. Polling, navigation,
  and reload never advance it. Saving another point explicitly replaces it.
- Catch-up windows: last hour, the shown time window, or since the return point.
  An older checkpoint shows a coverage notice rather than claiming full coverage.
- Thread selection persists in canonical Memory permalinks, with a switcher in
  session and artifact review. Verified Codex session identities offer a native
  `codex://threads/<id>` link; known providers offer a quoted resume command.
  The installed Codex app's thread URL generation and both CLIs' help were checked.
- Markdown Preview/Source, semantic tables/lists/headings, and session-bounded
  diffs in split or unified layout with old/new line numbers. Raw HTML stays
  text. Remote images are not fetched.

## Evidence boundaries

“In flight” means an observation within 15 minutes of the selected frame. It is
not live process status. Quiet does not mean complete. A recorded session end or
wrapup is shown as a handoff only until newer activity arrives. Polling failures
leave the last snapshot visible and labeled; offline counts are not live counts.

“Landed” lists recorded commit and wrapup notes, not verified merges, pushes, or
releases. Commit totals come from the selected event interval; outcome notes are
retained separately from the 60 most recent notes so a busy session does not
silently lose its earlier outcomes. Sparse logs cannot explain every outcome.

File review shows the current workspace content and a Git diff bounded by the
session: from the last commit at or before its first recorded event to either
the last commit within two minutes of its final event (when that commit changed
the file and the session has left the field) or the working tree. Boundaries are
commit times, not authorship, and the review names both ends and lists every
caveat it can detect: the file missing at the base, an untracked file, later
commits, uncommitted work beyond the bounded head, and a working tree standing
in for a session that committed nothing. Side-by-side is the default layout;
`diff=unified` in the permalink selects the dependency-free unified table.
Session/file path validation, file-size bounds (on every version read), and
symlink protection remain canonical server gates.

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
compact mode. Wake uses event ticks across the selected time window; Compare uses
endpoint ticks and retains a separate strip for missing usage. Partial usage
keeps its dashed mark. Open the axis summary beside Compare to choose dimensions.

Hover or keyboard focus reveals a readout inside Field and highlights the
same session throughout the desk. The readout overlays the chart without moving
its marks and disappears when neither preview nor selection is present. Unrelated text retains its contrast. Drag a
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
text labels on demand and keep chart geometry fixed so hover cannot move a target.
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

Find filters the loaded time window across the task index, Field, Wake and
Compare; the desk then intersects that shared search scope with its brush and
work filter; Clear find and Clear selection are independent. All-history search
has its own Explorer tab. Cross-window search IA and age-based z-ordering remain future work.

## Secondary brush

The primary brush holds a task or cohort and its Field neighbourhood. A secondary
brush temporarily emphasizes a connected neighbour and the primary connections
leading to it; it never expands into the neighbour's other connections. The
primary IDs, find query, task order, page and camera stay unchanged. Shared
activity continues to use the Field's existing project-mix evidence; concurrency
remains a separate session-view concern.

Hover or focus a connected mark in any chart, or hover its Field connection. The
secondary mark receives a dashed cyan ring across Field, Wake and Compare; its
connection is drawn above the quieter primary context. The existing on-demand readout shows
the pair and their shared projects. There are no added labels, controls or panels.
Pointer leave or blur restores the primary readout. Escape clears the secondary
brush first, then the primary brush. On touch, tap a connected neighbour to inspect
it and tap the primary mark or empty chart space to return. Space still explicitly
edits primary membership; Enter and task links still navigate into detail.

Secondary state is transient and absent from permalinks. It is derived from the
canonical primary IDs and preview identity, using the same relationship threshold
as the drawn edges. Unrelated or unavailable marks cannot replace the primary
readout.


## Time windows and navigation history

The global time control replaces playback. It defaults to 24h; temporal zoom
steps through 1h, 6h, 24h, 3d, 7d, 30d and 90d. Field zoom remains semantic depth.
The backend accepts exact integer hours from 1 to 2160 and projects all matching
recorded events before enrichment. Window bounds and whole-corpus available
bounds are returned explicitly; wider windows do not imply continuous coverage.
State, session fallback, and file evidence use the same requested duration.
Old pinned `at`/`end` links remain readable; Live returns to the current endpoint.
The static demo retains its recorded 24h fixture and disables time changes.

Search, work filter, catch-up interval and checkpoint, page offset, explicit
sorting, phone Overview/Charts focus, primary brush, camera and comparison axes
are canonical URL state. Each committed action pushes browser history. A short
find-as-you-type burst pushes its first edit and replaces only subsequent edits
in that burst; blur or Enter completes it. Camera gestures publish once settled.
Back, Forward, reload and Copy link therefore restore the same filter context.
Secondary brushing remains transient. Entering a project sets depth and cohort
as one action. New scopes start at the first page; revisiting a scope retains
its task order during polling.

Wide windows refresh 30 seconds after the previous request completes; windows
up to 24h retain the 5-second interval. Dense Field layouts use bounded work and
only a viewport-local subset of valid shared-activity connections. Every task
remains in the index and chart data; a secondary brush explicitly restores its
connection to the primary selection.


## Muriel delta — quiet chrome

Idle charts carry their data and controls, without tutorial paragraphs or a
reserved readout/footer. Brushing reveals task evidence inside Field, opposite
the inspected mark; the overlay accepts no pointer events and leaves every
chart target in place. Chart titles expose concise encoding descriptions on
hover and canvases retain accessible descriptions. Work-filter definitions live
on their controls rather than in extra rows.

Copy link uses a 44px chain-glyph control. Hover or keyboard focus reveals its
name; successful copying briefly changes the glyph to a check and announces the
result to assistive technology. Canonical links and browser history are unchanged.


## Shared search scope

Query matching is owned by the shared Memory projection, before data reaches
any view. Titles, projects, recorded notes and artifact paths use one matcher
and the selected time boundary. Every chart receives the same matching task
identities and their evidence; empty search results remove every chart mark.
The thread switcher uses that scope too, while an already opened detail retains
its original source evidence. Clearing search or restoring history recovers the
full scope. A primary brush excluded by search stays in the permalink but does
not leave a stale readout or mark on the chart. Semantic depth controls center
on the visible selection, or on the search results when no selection is visible;
this camera movement never turns search results into a primary brush.
