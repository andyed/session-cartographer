# Memory workspace and timeline focus: implementation plan

Implementation status and the revised compact range interaction are recorded in [MEMORY_WORKSPACE_DELIVERY.md](MEMORY_WORKSPACE_DELIVERY.md). The Save/Return/Undo toolbar described in this original plan was replaced after preview feedback by an inline range editor and a dated return marker.

Planning baseline: September 18, 2026. Canonical repository: `/Users/andyed/Documents/dev/session-cartographer`, branch `feat/carto-codex-port`, clean at `fbb3af652a36133924ffc25519d433ab0b527622`, package 0.7.7. This document plans the implementation; application code has not been changed for it.

The existing Explorer is running from the installed 0.7.7 plugin cache. Its `WorkingMemory.jsx` and `memory-route.js` matched canonical source by SHA-256 at inspection. Source inspection, live captures, the earlier critique, and three delegated Sol reviews inform this plan. The proposed focus-window preview uses a frozen snapshot; production routing, storage, polling, and server behavior remain to be built.

## 1. Product decision

Make Memory a workspace for **catching up, returning to a task, and reviewing its evidence**. A persistent results list and evidence inspector carry these flows. The return point becomes one explicitly saved **absolute focus interval plus filters**. Existing timelines remain the activity views; the new compact control selects their time scope rather than introducing another full timeline destination.

The intended flow is:

```text
Save focus → leave → Since saved focus → changed tasks
                                     → task evidence → file / changes → resume

Return to focus → exact saved interval and filters → continue the earlier review

Explore this window → existing Timeline or Memory activity view
                    → inspect records / overlap → return to the same workspace
```

The default Memory screen contains, in order: scope and local Find; the compact focus timeline; Tasks / Files with an explicit result count; results and inspector. More elaborate activity views are deliberately opened. Duration metrics and raw commands are supporting evidence. Neither “agent stopped” nor “commit recorded” becomes a claim that work shipped.

**Muriel synthesis — Direct.** Decision ID: `memory-focus-implementation-20260918`. Purpose: make time, filtering, and drill-down one understandable interaction. Integration: the existing Memory route/projection, file reader, Timeline renderers, and application shell. Risk: a visually useful new selector could become a competing navigation authority. Proof: exact-scope fixtures, cross-view route tests, five complete task journeys, and rendered desktop/narrow review. The main structural direction comes from the critique; this plan resolves the remaining implementation choices.

### Decisions to build against

| Question | Decision |
|---|---|
| Saved focus count | One saved focus per browser origin and corpus initially. Optional rename is unnecessary for v1. A library of saved investigations is deferred. |
| Saved object | Absolute endpoints and project/query/provider/evidence/result/file-kind scope. Exclude inspector selection, chart camera, scroll position, and temporary chart cohort. |
| Initial time scope | Last 24 hours, resolved against a successful source snapshot. An explicit live mode keeps a rolling 24-hour window; a manual adjustment freezes it. |
| Return to focus | Restore exact saved endpoints and saved filters in fixed mode. It never follows new activity. |
| Since saved focus | Restore saved filters, anchor the left endpoint at saved `through`, exclude that boundary, and follow the source on the right. |
| Timeline viewport | Presentation state, separate from focus. Preserve in the mounted view/history entry; omit from the shareable route in v1. Reload derives a useful framing around the exact interval. |
| Maximum range | Retain the current 90-day request span initially; historical windows may be positioned anywhere the source supports. A wider focus cannot activate in v1: preserve the saved record/requested URL, show the unsupported span, and require an explicit narrower choice. Never silently clamp it. |
| Result types | Tasks and Files, independent of camera scale. Documents is a Files kind filter. |
| Shared filters | OR within a multiselect facet; AND across facets. Named project is a predicate, never an automatically captured list of task IDs. |
| Ordering | Stable rows across refresh; explicit “N new tasks” / “Refresh order.” Direct filter changes may establish a new ordering. |
| Narrow layout | One reading pane at a time, with labeled Back, retained scope, scroll anchor, and focus restoration. Ordinary vertical scrolling is allowed. |

## 2. Use the existing timeline views

Live inspection covered Event Feed, Sessions, and Concurrent. They are materially different views. In the captured Concurrent view, a selected 7-day request still displayed older ticks because axis bounds come from whole sessions that remain eligible. This illustrates why a selected lookback is not already an exact event interval. It is an observation about the present contract, not a claim that those views should be discarded.

| Existing surface | Existing purpose and implementation | Planned role / reuse |
|---|---|---|
| **Event Feed** | `Timeline.jsx`, `EventGroup.jsx`, `EventCard.jsx`. Grouped reverse-chronological records; live-arrival affordance. Initial request loads 400 records. | Keep the event lens and grouping renderer. Feed it exact, paged records when opened with shared scope. Retain stable scrolling and explicit new-record handling. |
| **Sessions** | `Timeline.jsx`, `SessionCard.jsx`, `SessionSparkline.jsx`. Session cards and a relative sparkline per session. | Keep the session lens and card/sparkline components. Display scoped activity versus full-session identity explicitly. Single-event tasks must remain eligible in an exact window. |
| **Concurrent** | `ConcurrentTimeline.jsx`. Vertical absolute time, project lanes, 15-minute gap segmentation, overview/detail scales, facets, overlap inspection. Owns its current fetch and URL updates. | The primary full timeline for manipulating focus. Keep the vertical lane renderer; add the interval band, saved outline and evidence inspector directly here. Extract fetching/navigation ownership behind a controlled adapter. Share interval logic with the compact Memory selector. |
| **Memory Wake** | `memory-weather.js`. Horizontal rows of task activity, with session-cohort brushing. | Keep the detailed task-time view inside Explore activity. It is the closest visual precedent for the compact horizontal selector. Reuse category colors and time geometry conventions; keep cohort selection separate from interval selection. |
| **Memory Field** | Spatial project/task/file map; semantic camera; linked cohort selection. | Keep for spatial exploration. Its camera no longer chooses Tasks versus Files in the work list. Reuse its commit-on-release / cancel-to-restore gesture pattern. |
| **Memory Compare** | Metric comparison and cohort selection, currently cumulative through a replay cursor. | Keep for deliberate comparison. Derive interval-capable metrics from the exact scope; identify or disable metrics whose provenance remains whole-session. |
| **Search TimeSparkline** | `FacetBar.jsx` / `Search.jsx`. Visible results above full result distribution; clicking a mark navigates to a result. | Preserve its search-distribution meaning. Reuse compact overview visual ideas, not its selection semantics. Memory Find must not become BM25 Search merely by changing routes. |
| **Session Logged activity** | `MemorySession.jsx`. Relative 96-bin event/token summary. | Keep inspector-local. Distinguish focused activity from whole-session context and token coverage. It does not independently change global time. |
| **Artifact changes** | `MemoryArtifact.jsx`, `memory-artifact.js`, server `memory.js`. Actual session/commit-bounded diff. | Preserve its own provenance and reader. An arbitrary focus interval does not redefine a commit diff. |
| **Internals Daily trace** | Operational telemetry trend. | No redesign; include adjacent-route regression coverage. |

**Navigation concentration:** keep the current top-level Memory, Timeline, Search, and Internals destinations. Memory has one **Explore activity** entry offering its existing Field/Wake/Compare views and an **Open in Timeline** handoff that defaults to Concurrent with Sessions/Event Feed still available. Add “Review in Memory” from a timeline task. This is one connected workspace, without a seventh timeline mode or a merged graph containing every representation.

**Shared implementation:** extract small pure time/scope utilities and controlled focus representations. Memory and Timeline call the same saved-focus helper through their route controllers. The top-level Timeline gains the interval overlay once its bounded data adapter is in place. Keep view-specific rendering, zoom, and scrolling local. Do not reuse `memory-brush.js` for time: “brush” already means a selected session cohort.

### Specific anchor: `/?view=concurrent`

The user's explicit link identifies the existing Concurrent view as the full timeline foundation. A fresh live inspection confirmed its vertical, newest-at-top axis and project lanes. Build the focus interaction into this surface, alongside the compact Memory representation:

- Draw the active interval as a horizontal band spanning the visible project lanes, with a dashed saved interval outline. Because time is inverted, the **top edge is Through** and the **bottom edge is From**. Label both endpoints explicitly.
- Drag an edge to resize; drag a dedicated grip in the time gutter to move the interval. Keep the band body transparent to session-bar clicks. Ordinary vertical scrolling remains scrolling; selecting a time window must not turn the whole chart into a drag trap.
- Keep timeline context visible outside the active band, with clear subdued styling. Context coverage and in-focus results are separate projections; fetching only focus records would erase the context needed to position the window. Never count those contextual records as in-focus work.
- Click or keyboard-activate a session segment to open the shared evidence inspector beside the timeline. Preserve scroll position, scale, lane position, focus interval, and origin on close. Open transcript becomes an explicit inspector action; retain a real link for opening it separately.
- Label the existing 1/3/7/30-day controls as context framing presets. Overview/detail controls scale. Neither should silently resize the focus. Offer Fit focus when either endpoint is offscreen. Project/provider filters change the lane population and evidence, but never redefine the time axis from the newly filtered sessions during a gesture.
- Share one interval reducer and save/return model across this vertical overlay and Memory's horizontal strip. Use a geometry adapter for axis direction and scroll offset, rather than copying drag mathematics or nesting another horizontal timeline above Concurrent.

The existing view also needs readable, sticky project labels and lane sizing that uses the available chart width: at 1440 px, the current lane-width calculation packs lanes into roughly 600 px and leaves much of the chart empty. Reserve room for the evidence inspector deliberately. Improve those local presentation constraints in the Concurrent integration packet, while retaining its recognizable time/project structure.

Acceptance includes selecting an interval directly in Concurrent, saving it, opening a session and file, returning without a jump, then opening Memory with identical endpoints and filters. Exercise inverted-axis keyboard semantics, scroll-offset mapping, offscreen endpoints, narrow layouts, and session clicks through the band. This exact URL remains a supported entry point throughout migration.

## 3. State and evidence contracts

### Three independent time concepts

1. **Focus interval** filters the records being reviewed.
2. **Viewport** is the visible context around it. Zooming or panning context does not change the filter.
3. **Loaded coverage** is what the response actually contains. Neither the viewport nor a pair of observed corpus extrema establishes completeness.

Saved focus is a fourth object: an immutable copy of the active interval and scope until explicit Save. The solid active band and dashed saved outline communicate the distinction. If the saved band is offscreen, show its timestamp and Return action, rather than stretching the axis automatically.

Canonical conceptual state:

```js
{
  interval: { from, through, lower: 'closed' | 'open' }, // UTC epoch ms
  timeMode: 'fixed' | 'rolling' | 'since-saved',
  rollingDurationMs: null, // present only for rolling mode
  scope: {
    q, project, providers: [], evidence: [],
    result: 'tasks' | 'files', fileKind: 'all' | 'md',
    sessions: null // explicit fixed cohort, never implicit project selection
  },
  selection: {
    session: null, file: null, contributor: null,
    review: null | 'changes' | 'file',
    diff: 'split' | 'unified', document: 'preview' | 'source'
  },
  activity: { surface: 'results' | 'activity', view, camera, cohort },
  presentation: { viewport, scrollAnchor, focusOrigin, orderRevision }
}
```

Keep snapshot metadata separate: `requestedRange`, `loadedRange`, `observedExtent`, `snapshotAt`, `sourceRevision`, `coverageStatus`, and any continuation cursor. “Complete” means complete for the loaded source revision and requested predicate, not proof every historical tool action was logged. Unknown or partial coverage must remain distinguishable from zero matching records.

### Exact membership

- Normal focus is **`from <= timestamp <= through`**.
- Since saved focus is **`savedThrough < timestamp <= through`**.
- A task qualifies if it has any recorded event in the interval. Its latest overall event may be later.
- File rows require at least one qualifying edit in the interval. Their last-edited timestamp and contributing-task order use only those edits.
- Events, recorded outcomes, notes, counts, and interval-capable chart metrics use the same boundary predicate.
- Deduplicate identified events before aggregation. Preserve anonymous/unattributed evidence as such; do not manufacture session ownership.
- A stop event is lifecycle evidence. A wrapup is a recorded handoff. A commit is a commit. Only genuine recorded outcomes lead a task summary.
- Prefer actual event project/provider evidence. Document any session-level fallback and mixed/unknown attribution; never silently equate cwd, primary project, and all projects a task touched.

Evidence filters qualify a task by recorded evidence inside the focus; they do not imply that a commit belongs to every file the task touched. Files from an eligible task still require in-focus edits. Show the reason for inclusion, including indirect query matches.

For Files, direct path matches admit matching paths. A task-title or in-window note/outcome match can admit that task's in-window files, labeled **From matching task**. A row may have several reasons. No query or evidence filter resurrects a file edited only outside the interval. Counts name their unit: tasks, files, edits, or recorded commits; one shared file is not counted once per contributor.

### One projection pipeline, two time domains

Create shared, pure interval/scope helpers rather than another collection of component-local filters. Normalize and deduplicate → apply exact time and project/provider predicates → derive per-task evidence → qualify evidence/query → group Tasks/Files and compute match reasons/contributors → sort/paginate presentation.

Run this pipeline over the **focus** for results, and over the **viewport** for contextual density. Context bins are calculated before applying the active focus selection. Dragging the band never recomputes the context's axis or density under the pointer. Non-time filters or an explicit viewport change may recompute context. Density is labeled recorded activity, not number of tasks, and its shaded sum is not presented as an exact result count under task-level query qualification.

Use 30-minute bins for the initial 24-hour context. For large windows, deterministically coarsen to keep roughly one mark per 2–4 CSS pixels; disclose the bin unit. Bin origin is stable in UTC. Local tick labels include timezone/offset when needed for DST ambiguity. Duplicate local clock times must represent different UTC instants.

### Exactness before truncation

The current server keeps only the last 60 notes per task, while the desk can search those notes. Simply loading an integer-hour covering snapshot and filtering client-side can lose an older in-focus note. Fix this as correctness work: normalize complete bounded evidence first and retain a compact complete `evidenceIndex` containing IDs, timestamps, attribution, and the title/path/note fields used by the scope predicate. Derive query/evidence membership and counts from that index, then create the last-60 display-note preview separately. Both server and client use the same pure predicate. This permits exact local gesture previews without fetching per pixel. Local Find searches this recorded metadata; full transcript retrieval stays a separate search action.

Responses declare `evidenceComplete`, indexed record count, and display-preview truncation separately from temporal coverage. A partial evidence index cannot produce a definitive zero or total; show the incomplete state and recover/retry. The initial implementation favors correctness with complete bounded metadata; performance work may move projection server-side only with equivalent query and gesture-preview contracts proved.

Full-session titles, transcript metadata, and file contents can be enrichment. They must not be mistaken for evidence that an outcome occurred within focus. Token totals with inadequate timestamps must remain labeled whole-session/unknown rather than being copied into an “in this window” total.

## 4. Routes, saved focus, and history

### Canonical routes

Extend the existing Memory parser/serializer; do not build a second router inside the new control. Proposed fields:

```text
/memory?from=<UTC-ISO>&through=<UTC-ISO>
       &project=<name>&provider=<set>&evidence=<set>&q=<local-find>
       &result=files&kind=md
       &session=<id>&file=<encoded-path>&contributor=<id>
       &review=changes&diff=unified&doc=source
       &mode=since-saved&lower=open
```

Omit defaults. Canonicalize list order, validate endpoint pairs, bounds, enum values and list lengths, and preserve millisecond precision. Time-mode grammar is explicit:

- Fixed: omit `mode` (or accept `mode=fixed`); require resolved `from/through`; omit duration. `lower` defaults to closed but may stay open when a catch-up window is paused or copied.
- Rolling: `mode=rolling&durationMs=<positive-integer>` with duration at most 90 days, plus the last resolved endpoints. The interval duration must agree with the declared duration; both endpoints advance on refresh. Left edge is closed.
- Catch-up: `mode=since-saved&lower=open`, explicit `from/through`, no duration. `from` is the serialized saved boundary and does not depend on the recipient having local saved state. Only the right edge advances.

Unknown modes, reversed/partial bounds, a rolling duration mismatch, open-left rolling mode, missing duration, or duration on another mode are recoverable route errors, not silently repaired guesses. There is no separate canonical `follow` flag. A live link visibly opts into following; **Copy fixed link** snapshots resolved endpoints and preserves the boundary predicate. Following updates replace the current route, never add history per poll. Manual endpoint/pan edits enter fixed mode with a closed left edge; explicit Pause preserves the current predicate.

Add an explicit `/timeline` route before passing shared scope between top-level views. Today root `q` or `project` selects Search, Timeline initializes its mode from `view` only once, and Concurrent independently rewrites query parameters. The new route owns its view and common interval/project/provider/evidence/local-query grammar. Retain `/` and `/?view=concurrent|sessions|chronological` compatibility; preserve existing root search links. Timeline-specific facets must be named separately from common scope.

“Explore this window” and “Review in Memory” transfer the common scope, selected task where relevant, and an origin route. Tasks/Files, document mode, chart camera, and sort are view-specific presentation, retained on return. Shared query semantics use the common scope projection; they never silently switch to full-corpus BM25. A lens-specific facet is labeled as such and cannot silently broaden/narrow the global scope.

### Legacy migration table

| Existing state | Deterministic behavior |
|---|---|
| `hours`, `end`, `at` | Resolve old covering range; map to `[end - hours, at ?? end]`. Live relative links resolve once against the first successful snapshot. |
| `catchup=return`, `checkpoint` | Preserve the checkpoint and old scope; produce the corresponding open-left catch-up interval. |
| `catchup=hour/day` | Resolve the old relative range explicitly; emit canonical fields after resolution. |
| Old localStorage return-point timestamp | Offer a `[oldPoint, latest]` seed with its origin visible. Do not write a new saved focus on read. If too wide/unavailable, preserve the old value and explain the unsupported range. |
| Overview `brush` | Preserve a deliberate fixed cohort as a labeled selection, separate from named project. Never infer a project from its current members. |
| `focus=charts`, `view`, `x/y`, `panels`, `cam` | Open the corresponding activity view and restore its presentation state. Do not let camera depth select Tasks/Files. |
| `filter=flight/changed/landed` | Map through explicit compatibility predicates and literal evidence labels. Commit/wrapup lists become task results with that evidence exposed; document this structural migration. |
| `kind`, `offset`, task/file/review/diff fields | Preserve meaningful scope and selection. Translate offset to an anchor when possible; reset only when old pagination has no valid equivalent. |

Canonicalize with one `replaceState` after required source values resolve. Malformed or unavailable legacy state gets a visible, recoverable fallback; do not silently open a different file or task. Add fixtures for every row before switching defaults.

### Storage and transactions

Use a versioned saved-focus helper, e.g. `cartographer.saved-focus.v1`, namespaced by a stable opaque corpus identity. Live and static demo must not share a focus. Until a corpus identity is available, separate source-mode keys and do not claim cross-corpus safety. Write atomically on Save; preserve the prior record for Undo. Storage denial/corruption must not break browsing. Reading/migrating old state performs no writes.

Save persists absolute endpoints even when invoked from a following mode. It does not necessarily turn off the active live view; the saved copy stays fixed. Save and Undo do not rewrite the current scope. A successful save announces the actual date/time range. Opening tasks, changing filters, polling, and leaving the page never resave it.

| Action | History/focus rule |
|---|---|
| Search editing | First meaningful edit starts one history transaction. Further keystrokes replace until Enter/blur; a 750 ms pause does not split the query. Back restores the previous committed query. |
| Pointer gesture | Draft changes only during move. Pointer-up pushes one entry if changed. Escape, pointer cancellation, or loss of capture restores the original. |
| Keyboard endpoint adjustment | Arrow = 5 minutes; Shift+Arrow = 1 hour. Coalesce a held-key adjustment into one transaction; exact datetime editing commits on Enter/apply. |
| Inspector navigation | Opening and deliberate selection changes push; closing one layer restores the correct parent route. Popovers consume Escape before the inspector. |
| Live refresh | Never push. Retain selected row, list anchor, viewport, and saved record. |
| Outside-scope selection | Keep it open with “Outside current filters.” Close to a stable visible fallback or Find, never to BODY. |

Back/Escape must work both after in-app navigation and on a directly loaded permalink. A direct link gets an explicit parent route instead of blindly calling `history.back()` into another site. In-memory history state retains stable result identities and anchors; the permalink remains sufficient to restore evidence and scope after reload.

## 5. Data/API work and existing Timeline integration

### Mandatory correctness work

1. Add exact `from/through/lower` support to the Memory state contract, preserving `hours/end` compatibility. Apply bounds before any preview truncation. Cache keys include exact range, source revision, source mode, and relevant scope; invalid inputs fail consistently in Express and managed Turbo.
2. Extract reusable scope/provenance helpers with fixtures. Keep APIs behind `api.js` so the static demo sees every request. Extend cancellation/request-key handling to state, selected task, file, and timeline data.
3. Add an exact activity contract, provisionally `/api/activity-scope`, for the existing Timeline renderers. It shares the same normalized time/project/provider/query/evidence semantics as Memory; no second independent matcher. Its response contains resolved scope, source/coverage metadata, complete scoped session aggregates, required event timestamps/segments, and paged raw event records with totals/cursors.
4. In that contract, deduplicate and filter before aggregating or paginating. Include one-event sessions. Derive in-window counts, first/last observation, project/provider/type totals, segments, and overlaps from the full scoped set; never from a 200-row preview. Preserve full-session bounds separately when displayed as context.
5. Make `Timeline` the route/data owner and `ConcurrentTimeline` a controlled renderer in the scoped path. Replace its independent `replaceState` effect with callbacks. All three view modes respond to popstate/reload, not only initial URL parsing. Existing unscoped endpoints remain compatible during rollout.

The new activity API is required for truthful exact-window handoff. `/api/events` currently has a 500 maximum and defaults to high-signal rows; `/api/sessions` summarizes whole sessions, drops one-event sessions, and limits previews to 200. Filtering those limited responses locally cannot establish completeness.

Query/evidence filters qualify the same task cohort in every lens. A task-title or in-window note match makes its in-window records eligible for Event Feed, its card eligible for Sessions, and its scoped segments eligible for Concurrent. Event Feed does not silently narrow to only text-matching individual events; direct matches may be highlighted within the qualified records. An explicitly named event-type/high-signal lens filter can narrow those records afterward. Unattributed records can match directly and remain labeled unattributed; they never become invented tasks or concurrent lanes. Every lens distinguishes common-scope task totals from displayed event, lane, or file totals.

Retain explicit event visibility policy: **All recorded activity** is the complete scoped view; a high-signal filter is a named view option with truthful counts. Concurrent overlap means overlap of observed spans/segments under a stated method, not proof two agents were continuously working. Preserve the 15-minute gap rule with a visible explanation. Scope counts and optional whole-session metrics remain separate.

Pagination cursors bind to a source revision plus stable timestamp/ID ordering. If a revision changes, retain the old visible snapshot and offer refresh; do not combine pages from incompatible revisions. SSE invalidates scoped data or adds records through the same predicates; it must never prepend unrelated-project records because the stream is global.

### Coverage and refresh behavior

Show the last successful snapshot while loading. A local refresh indicator belongs beside the affected scope/inspector, not across the whole page. Abort obsolete work and reject late responses by request key even if cancellation loses a race. Source revisions must not move a fixed window or a saved interval.

For rolling mode, advance both endpoints by elapsed source time. For Since saved focus, advance only the right edge, anchored to the saved end. Manual interval movement enters fixed mode. Use the successful source snapshot's `snapshotAt`, not the last event timestamp, for “through now”; a quiet source can still advance in time. Late-arriving events with older timestamps appear on refresh in the interval they actually belong to. They do not overwrite the saved object.

Existing `availableStart/availableEnd` are observed extrema, not completeness flags. Show unavailable coverage separately from an empty result. Never pad missing data with a visually certain zero-density area. When reaching coverage bounds, offer an explicit earlier/later load, leaving the active focus unchanged until the user chooses otherwise. A focus wider than 90 days, including a legacy return point or long-running catch-up, opens an unsupported-range state with the requested dates intact and explicit narrower alternatives. No results are labeled as covering that unsupported interval. Loading/chunking a wider interval to completeness is deferred.

### Conditional performance work

Measure before adding a density service, worker, or index. Client context bins over a bounded snapshot are the first implementation. If measured costs demand it, add a lightweight aggregate/density response and selected-task enrichment on demand, using the same scope code and coverage metadata. Virtualize long result lists only after stable row/anchor semantics exist; always bound rendered rows. Cache normalized evidence by source revision rather than repeating transcript work on every pointer move.

No hook, CLI BM25, semantic retrieval, Qdrant, or global Turbo preference redesign is required. The Memory handler is shared by Express and managed Turbo and both must retain the same contract. Do not edit the installed plugin cache to develop this feature.

## 6. Component and interaction work

Suggested modules, adapted to existing naming conventions during implementation:

| Component/module | Responsibility |
|---|---|
| Shared `activity-scope` / `time-range` helpers | UTC normalization, predicates, identity/match reasons, bins, scoped aggregation. No DOM or network dependencies. |
| `memory-route.js` | Canonical route parsing/serialization and legacy migration; shared common fields are extracted rather than duplicated. |
| `memory-focus-storage.js` | Versioned saved record, validation, migration seed, atomic Save/Undo, corpus isolation. |
| `FocusTimeline.jsx` / `FocusRangeOverlay.jsx` + shared gesture helper | Horizontal Memory strip and vertical Concurrent overlay over one controlled interval reducer. Geometry adapters handle axis direction/scroll offset. No fetching, storage, or direct history writes. |
| `WorkingMemory.jsx` | Memory integration, source data, committed state, refresh lifecycle, inspector requests. Extract a scope/navigation hook to keep this file from growing further. |
| `MemoryDesk.jsx` | Results, filter chips, Tasks/Files, stable order/anchors, explicit contributor choices. Receives projected rows. |
| `MemorySession.jsx` / `MemoryArtifact.jsx` / `SplitDiff.jsx` | Outcome-first inspector, current-file versus bounded-changes review, Markdown modes, provenance and keyboard return. Reuse existing rendering/security. |
| `Timeline.jsx` + `ConcurrentTimeline.jsx` adapters | Existing lens selection/rendering under explicit route/data ownership. |
| `App.jsx`, `api.js`, `demo.js` | Route disambiguation, long/narrow layout, API boundary, equivalent static fixtures. |

### Focus control

Drag either endpoint to resize; drag the center to pan at constant duration. Clamp to known loaded bounds, never allow endpoints to cross. Home/End on the center moves the whole interval to a context edge; on an endpoint it moves that endpoint to its valid edge. A zero-duration interval can select an exact timestamp via fields; the band keeps a usable minimum visual width without changing its timestamps. Invalid typed times produce inline validation rather than silent rounding.

At narrow widths, separate overlapping handle targets vertically. Use pointer capture and intentional horizontal touch handling while preserving normal vertical page scrolling. Provide two labeled endpoint controls plus exact time fields; users must not need a precise drag. Freeze axis and source revision during a gesture and reconcile incoming data afterward. A completed drag produces one history step and at most one new data request for newly required coverage; no fetch per pixel.

### List, filters, and drill-down

The result list stays mounted beside the inspector when space permits. A task row leads with recognizable identity and a compact recorded outcome, then time/project/provider and files. Replace duplicate title/arrow targets with a clear main opening target. Files show edit time, match reason, and contributing-task count. Opening a shared file shows the contributor choice; preselecting latest is allowed only when explicitly labeled and encoded in the route.

Project/query/evidence/time filters are visible, removable, and count the same result set. Each chip clears only itself. Changing Tasks/Files preserves common scope. Zero results show useful broaden actions with the restriction they remove. Clearing query clears dependent chart hover/highlight readouts as well as results, without resetting unrelated scope.

The inspector leads with recorded outcomes and files, followed by provider-appropriate conversation/resume actions. Raw commands, duration, and token diagnostics live under Activity evidence. An absent diff stays in **Changes** with its reason and an explicit **Open current file** choice. Current content is labeled workspace state; the diff displays actual base/head/session provenance. File editing history is never advertised as a time-bounded content reconstruction.

### Layout and visual contract

Keep Cartographer's existing palette and event-category grammar. Make the results/evidence hierarchy dominant. New controls use at least 40×40 px pointer targets and preferably 44×44 px; primary row actions are at least 44 px high. Under Muriel's review contract, body/caption text is at least 16 px/500 and text contrast at least 8:1. Measure rendered layouts rather than copying current tiny timeline labels. Retained charts are audited for legibility in their own slice, without turning this into a global theme rewrite.

Allow vertical scrolling and reading-length content. Fix the shell's `h-screen` / `overflow-hidden` assumptions where they prevent this; preserve the existing Timeline scroll containers. Do not impose one common scroll geometry on every lens. At 390 px use one reading pane and a compact persistent scope summary; keep exact times available without stacking the entire desktop toolbar. Reduced motion retains every state change without animated sorting. Loading/errors/count changes use restrained announcements, not narration on every poll.

## 7. Delivery sequence and delegation

Use one integrator and at most three active workers. Sol **medium** handles bounded state/data and interaction work; Sol **low** handles mechanical fixtures, capture harnesses, and packaging checks once contracts are frozen. The integrator owns architecture reconciliation, hot-file integration, rendered acceptance, and any difficult cross-cutting defect. Lower effort is for a well-bounded task, not for unresolved evidence semantics.

| Packet | Owner / files | Dependencies | Reviewable exit criterion |
|---|---|---|---|
| **P0 — Baseline and contract fixtures** | Sol low: tests/browser fixture/capture work; integrator: spec decisions | None | Fixed-time adversarial corpus, current screenshots/performance sample, legacy route inventory; independent expected IDs/counts recorded. |
| **P1 — Exact scope/data truth** | Sol medium: shared projection helpers, server `memory.js`, unit tests | P0 contract | Exact bounds before truncation; old-hour API parity; historical notes/files, provider/project attribution, coverage metadata proved. |
| **P2 — Route and saved focus** | Sol medium: `memory-route.js`, shared route fields, new storage helper/tests | P0 contract | UTC round-trip, legacy cases, corpus isolation, storage denial, Save/Undo, fixed/follow/rolling transitions proved. |
| **P3 — Focus control** | Sol medium: shared reducer, horizontal strip, vertical overlay, scoped CSS/tests | P0 state interface; integrate after P1/P2 | Both orientations share pointer/keyboard/exact inputs, cancel, clamping and one history commit; Concurrent scroll geometry and inverted endpoints are proved. |
| **P4 — First complete Memory flow** | Integrator: `WorkingMemory`; Sol medium: `MemoryDesk` and desk styles; separate inspector owner as needed | P1–P3 | Focus → project → task → file → Changes/unavailable → two returns, with URL/reload and narrow keyboard parity. |
| **P5 — Existing Timeline under shared scope** | Sol medium: activity API/adapters; one writer for `App`, `Timeline`, `ConcurrentTimeline`, `api.js` | P1/P2/P3; P4 stable inspector interfaces | Concurrent edits/saves focus in place and opens the inspector without losing position. All three existing Timeline views honor shared exact scope, counts, Back, single-event tasks, SSE and pagination. Legacy links remain valid. |
| **P6 — Concentrated activity exploration** | Sol medium: `memory-weather.js`, metric adapters, activity styles | P4/P5 common scope | Field/Wake/Compare moved behind Explore activity; camera/cohort cannot change result type/time; unsupported metrics labeled. |
| **P7 — Proof and performance** | Sol low for repeatable capture/benchmarks; Sol medium for behavioral regression | Starts P0; acceptance after P4–P6 | Five task journeys, adverse async cases, all timeline/search regressions, demo and responsive rendered matrix pass. |
| **P8 — Delivery integration** | Integrator; Sol low may run parity/check scripts | P7 | Canonical build, demo, mirror parity, packaging smoke, docs and rollback instructions reviewed. No release/version action implied. |

The initial execution wave can run P1, P2, and P0's remaining measurement work in parallel after interfaces are written. P3 starts when one slot is free. Do not concurrently edit `WorkingMemory.jsx`, `App.jsx`, `api.js`, the main browser harness, or the plugin mirror. Workers return a focused diff, checks, and unresolved assumptions; one owner integrates each hot file.

**Critical path:** scope correctness → route/gesture integration → complete Memory flow → bounded handoff to existing Timeline → exploration consolidation → acceptance. P5 is part of the intended delivery, not an optional polish ticket; otherwise the user's existing timelines remain disconnected from the focus window.

Use several reviewable implementation commits or draft changes rather than one large patch. The first useful milestone is P4, but do not describe the overall redesign as complete until P5–P8 pass. Effort is concentrated in data/history integration and browser proof; cosmetic CSS is a small part. Calendar estimates should follow P0 measurements and the first integrated slice rather than assume all packets parallelize.

## 8. Verification and acceptance

Read `docs/TESTING.md` before writing tests. Its principal rule applies directly: **assert composition and provenance, not just successful responses**. Expected memberships must come from a small independent fixture scan, not from calling the production helper twice.

### Required adversarial fixture

Include a task beginning before focus and continuing after it; events exactly at both endpoints; one-event tasks; multiple events with equal timestamps; duplicate and anonymous records; an in-focus note displaced beyond the current last-60 preview; a file touched by two tasks inside/outside focus; mixed projects/providers; a missing transcript; an unavailable diff; a late-arriving record; no new activity; and an interval outside loaded coverage. Include enough out-of-window records that a filter-after-limit implementation demonstrably fails.

### Five user journeys

1. Since saved focus → find a changed task in a chosen project → identify its recorded commit without opening the raw command log.
2. Files → Markdown path → shared file → identify the contributing task and edit timestamp → deliberately choose bounded changes/current file.
3. Open task then file → Escape to task → Escape to the same row → continue filtering with keyboard. Repeat on a direct permalink and with the originating row filtered away.
4. While a project scope and inspector are open, append a matching new task and an unrelated-project event → only correct counts change; rows, selection, saved focus, and viewport remain stable.
5. Copy a fixed link, reload, and recover exact endpoints, query, project/provider/evidence scope, result type, selected contributor, and Markdown/diff reading mode. Open the window in each existing Timeline lens and return intact.

### Interaction and route tests

Cover Save/Return/Since; open-left exclusion; fixed versus rolling versus left-anchored follow; manual freeze; quiet source time; DST repeated/missing local times; overlapping handles; cancellation; key-repeat grouping; search typed 750 ms apart; one history step per drag; deep-link parent fallback; request race rejection; localStorage denial; legacy migration without writes; coverage limits; and all scope filters on subsequent SSE refresh.

Replace the current “all overview content fits without vertical scrolling” assertions deliberately. New layout gates are no horizontal overflow, no overlap/clipped controls, usable reading widths, correct scroll/focus return, and accessible scope at 390×844, 1200×800, 1440×1000, and 1680×1000. Review light/dark and reduced motion. Preserve top-level Timeline, Search TimeSparkline, SessionSparkline, transcript and Internals behavior.

### Performance proof

Record production chunk bytes, first results, interval-to-count latency, task/file/diff open latency, DOM row count, long tasks, request counts and payload sizes. Report environment, fixture cardinality, Node/Chromium versions, repeated-run median/p95, and warm/cold cache conditions. Establish tolerances from the baseline before implementation. No current latency claim is made in this plan.

Non-negotiable behavioral budgets: zero network requests per pointer move; one history entry per gesture; bounded rendered rows; no whole-corpus transcript read on every filter keystroke; no mixed-revision paging; no lost selection or reorder under interaction. A measured interaction regression blocks rollout or triggers the targeted worker/density/pagination optimization; it does not justify weakening the scope contract.

### Commands at the delivery gate

Run from the canonical checkout with Node 22 and locked dependencies/Chromium installed as documented. Tests should use temporary corpora/config and loopback ports, not the user's live Explorer.

```bash
env -u CLAUDE_SESSION_ID -u CLAUDE_CODE_SESSION_ID -u CODEX_SESSION_ID -u CARTOGRAPHER_SESSION_ID node --test tests/unit/*.test.js
npm run build --prefix explorer
node tests/browser/memory-entry.cjs
node tests/browser/memory-entry.cjs --preview
node scripts/build-demo-memory.mjs --write
VITE_DEMO=true npm run build --prefix explorer
node tests/browser/demo-memory.cjs
bash scripts/copy-plugin-runtime.sh plugins/session-cartographer
bash tests/source-marketplace-smoke.sh
bash tests/release-smoke.sh
git diff --check
```

Use the repository's Playwright harness and manual screenshot review; no MCP browser testing. The demo test must reject any leaked `/api/*` network request and test all retained chart modes intentionally, rather than require Field on the new default screen. Review generated demo fixture changes. Mirror only after canonical implementation settles; do not hand-edit duplicated runtime files.

## 9. Rollout and completion boundary

Introduce the new workspace behind a temporary development/preview switch, while old routes remain parseable. Validate on the isolated fixture host, then offer a clearly identified canonical preview alongside the still-running installed 0.7.7 instance. Verify listener cwd and asset/source identity before attributing any result to the new build.

Switch the default after the full acceptance set and user review of the real catch-up/file flows. Retain migration parsers and the previous saved-point value through the transition. Remove the temporary switch once the new default is accepted; avoid maintaining two permanent Memory implementations. Rollback reverts the redesign commits or applies a reviewed inverse diff in a verified checkout, preserving unrelated work and both storage formats; then regenerate the mirror and rebuild. Packaging, installed-cache refresh, version choice, tagging, release and deployment are separate actions. This planning task authorizes none of those delivery actions by itself.

Complete means: saved focus survives reload without drift; filtered counts and provenance agree; the list/inspector works on wide and narrow layouts; existing Timeline views accept exact focus handoff; Field/Wake/Compare remain reachable with honest metrics; old links recover meaningfully; live and demo builds pass; and rendered review shows the proposed hierarchy. Passing tests alone is not a claim that human catch-up is faster—observe completion and wrong turns on the five journeys.

**Muriel delta:** the plan now gives every existing time view a defined role, replaces the timestamp checkpoint with explicit saved interval semantics, and puts exact scope below both Memory and Timeline. Integration is mapped to canonical components and staged work packets. Proof so far is source/live inspection and the separate interactive design study; implementation acceptance remains future work.

## Evidence and source map

Review artifact directory: `/Users/andyed/.codex/visualizations/2026/09/19/01a0b779-47a4-79e0-a177-f141b5a8ccc8/memory-review`.

- Design critique and current focus proposal: `critique-and-proposal.md` in the review artifact directory.
- Interactive study: `memory-focus-window.html` in that directory; frozen data and preview-local storage only.
- Existing Timeline captures: `evidence/existing-chronological.png`, `evidence/existing-sessions.png`, `evidence/existing-concurrent.png` in the review artifact directory.
- Core source: `explorer/src/components/{WorkingMemory,MemoryDesk,MemorySession,MemoryArtifact,Timeline,ConcurrentTimeline,SessionCard,SessionSparkline,FacetBar}.jsx` and `memory-{route,desk,weather,artifact}.js` in the same components directory.
- Shell/data: `explorer/src/{App.jsx,api.js,demo.js}`, `explorer/server/{memory,app,sessions}.js`.
- Existing verification: `docs/TESTING.md`, `tests/browser/{memory-entry,demo-memory}.cjs`, `tests/unit/memory-*.test.js`, `scripts/copy-plugin-runtime.sh`.
- Delegated read-only reviews: Sol medium for existing timeline reuse; Sol medium for state/data/routes; Sol low for verification and rollout. The integrator reconciled their differences: viewport stays presentation-only in v1; exact Timeline API work is mandatory; density bins use pre-selection context; corpus extrema do not establish completeness; and searchable evidence cannot be truncated before scope resolution.
