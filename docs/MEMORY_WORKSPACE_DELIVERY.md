# Memory focus workspace

The Memory work desk and the existing Concurrent, Sessions, and Event Feed views now use one exact time-window contract. Work is on `codex/memory-focus-window`, isolated from the installed Explorer.

## Interaction

The default desk concentrates on Tasks and Files. Selecting a result opens the shared evidence inspector; on narrow screens the inspector becomes the single pane. Escape returns one level and restores the originating control and scroll position.

Time is a selectable interval. Memory has a compact density strip; Concurrent retains its vertical, latest-at-top timeline, with Through at the top, From at the bottom, and a movable band. Keyboard adjustments and pointer gestures share the same range arithmetic. Dates can also be entered exactly.

The compact range selector opens an inline editor. Presets, Done, Cancel, Escape, and outside click dismiss it. Draft dates stay intact across source refreshes. Setting a return point lives inside this editor; the saved interval appears as a dated return marker. Clicking the marker restores its exact interval and filters. Since return point uses the saved right endpoint as an open lower bound. There is no always-visible Save/Return/Undo command row.

File results name the contributing tasks. Changes display the actual session commit range; Current file explicitly describes current workspace state. Missing diffs remain an unavailable Changes view rather than silently becoming a file preview. Markdown preview/source and split/unified changes reuse the existing renderers and security checks.

Field, Wake, and Compare remain under Explore activity. Search retains its existing distribution view. A dedicated `/timeline` route preserves query/project filters without accidentally opening Search; `/?view=concurrent` remains supported.

## Evidence and state

- Closed exact intervals include both endpoints. Catch-up excludes the saved endpoint.
- Query and evidence filters qualify tasks using the complete evidence index, before the 60-note display preview.
- Project/provider/time filter records; matching tasks retain all their records within that scope.
- File edits and token samples are clipped to the interval. Anonymous records remain visible in Event Feed and explicit unattributed Sessions groups.
- Saved intervals are browser-local and namespaced by corpus/source. Reading old return points does not write or silently replace them.
- One completed gesture adds one history entry; cancellation adds none. Slow query typing is one history transaction until Enter or blur.
- Result pages render at most 60 rows. Concurrent caps context at 200 tasks and labels that limit.
- Source metadata distinguishes loaded records, observed dates, and unknown historical coverage. Windows wider than 90 days get an explicit recovery state.
- Live polling is ten seconds; fixed views poll every thirty seconds. Timeline requests only the context response shape, avoiding a duplicated full payload.
- Timeline framing changes only the visible span. The loaded source covers the union of the viewport and selected interval, so a one-day view cannot silently narrow a seven-day selection.

## Validation

- Final Node 22.23.2 unit suite: 487 passed, zero failures (40.2 seconds).
- Live rendered checks at 1440×1000 and 390×844: task/file drill-down, both Escape returns, Timeline inspector, and no page errors.
- Inline range editor: save/return marker, Done, Cancel, Escape, outside click, normal document flow, and 390px control bounds passed.
- Final static demo build and browser journey passed: 7 sessions, 5 groups, exact fixed fixture, saved interval reload, Memory/Timeline handoff, Field/Compare, outside-fixture coverage, and no escaped API calls. The normal production build was restored afterward.
- Viewport regression: a seven-day focus retained its complete request coverage and focused count when the visible timeline changed to one day (chart height changed from over 3000px to about 480px).
- Source-marketplace and release archive smoke checks passed at unchanged version 0.7.7, including temporary CLI-managed plugin installations.
- Development browser journeys passed in both `memory-entry.cjs` and `focus-workspace.cjs`, including retained chart behavior, artifact security, exact boundaries, source refresh, and navigation. The normal production build passed (97 modules).
- Both complete browser journeys also passed against the normal production build. Coverage includes the observed 30-second draft-preservation poll, keyboard commit/cancel, two Escape returns, shared-file contributors, legacy root links, same-time anonymous records, and 390px/1440px layout bounds. The exact-focus built-preview journey is included in CI.

Performance observations are local measurements, not cold-start or human usability claims. In Chromium 145.0.7632.6 at 1440×1000, five fresh pages against an already-warm live backend showed first results median 262ms / p95 464ms and filter repaint median 29ms / p95 45ms. Filtering made zero API requests; those runs rendered 16 task rows and recorded no long tasks.

For a seven-day sample with 105 tasks and 10,829 evidence records, the context-only response reduced serialized data from 25,693,076 to 12,670,771 bytes (50.68%). Gzip sizing was measured offline: 3,205,255 to 1,582,069 bytes; this is not a claim that every local host sends compressed responses. Projection p95 was 16.86ms over 200 warmed iterations in Node 26.8.2. Larger corpora still warrant measurement before widening the 90-day limit.

## Preview and implementation

- Preview: http://127.0.0.1:2537/memory and http://127.0.0.1:2537/?view=concurrent
- Worktree: `/private/tmp/carto-focus-window`
- Preview runtime and captured evidence: `/private/tmp/carto-focus-window-runtime`
- Existing installed service on port 2527 remains unchanged.
- Entry points: `WorkingMemory.jsx`, `Timeline.jsx`, `ConcurrentTimeline.jsx`, `FocusToolbar.jsx`, `MemoryInspector.jsx`, `useFocusWorkspace.js`.
- Shared semantics: `explorer/shared/focus.js` and `activity-scope.js`.
- Harnesses: `focus-workspace.cjs`, `memory-entry.cjs`, and `demo-memory.cjs`.

Muriel delta: the focus interval joins the existing timeline grammar; task/file evidence is primary and exploratory charts are secondary. The final range control replaces the command row with an inline editor and dated return marker. Rendered checks and behavioral tests establish those mechanics; faster human catch-up remains for user evaluation. No new jury ranking is claimed for this implementation pass.
