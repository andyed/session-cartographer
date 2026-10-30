# Session Cartographer interaction style guide

2026-10-29 · v1 · Rules for future interaction changes. Current conformance is
tracked in the [interaction audit](INTERACTION_AUDIT_2026-10-29.md) and
[implementation follow-up](INTERACTION_FIXES_2026-10-29.md).

## Purpose and authority

Help someone recover useful work, understand a change, inspect its basis, and
resume with context. The unit of review is a named output, finding, or decision
with related evidence. A chronological log is a secondary route.

The user's rules govern this guide:

- **If it is worth showing, it is worth rendering.** No raw JSON, orchestration,
  transport envelopes, or anonymous numbered evidence menus.
- **One row action means one row-sized target.** The icon communicates the action;
  it must not be the only operable patch of an otherwise inert row.
- Shared context appears once: common directories, a time baseline, metric
  headers. Keep distinguishing information and exact provenance recoverable.
- Glyphs remove visible-word repetition. They still need understandable meaning,
  input parity, accessible names, and adequate targets.
- Optional categories earn space through useful content. No empty headings,
  zero-count artifact panels, or permanent instructions for basic operations.

Existing project state, source identities, accessibility constraints and the
user's corrections take precedence over a visual preference. This guide does
not authorize a new store, router, component library, or wholesale redesign.

## The interaction grammar

| Intent | Visible contract | Element and input | State owner |
| --- | --- | --- | --- |
| Navigate to a named destination | Title describes what opens; external destination has an external-link cue | Real anchor with canonical `href`; Enter and modified click retain browser behavior | `App`, `workspaceHref`, transcript return route |
| Inspect a task/file in context | The primary row surface opens one inspector; selected row remains identifiable | Row-sized anchor when a permalink exists, otherwise a native button; separate secondary actions | `useFocusWorkspace` → `MemoryInspector` |
| Reveal local detail | Whole single-action header toggles; chevron and open state agree; detail appears adjacent | Native `details`/`summary`, or button with `aria-expanded` and a controlled region; Enter/Space | The owning component's disclosure state |
| Filter membership | Active restrictions are visible and removable; counts describe the resulting population | Named controls, checkboxes and chips; immediate reversible change | `memory-route`, `projectMemoryScope`, `useFocusWorkspace` |
| Preview | Temporary feedback; leaving restores prior context; no committed selection or filtering | Hover **and** focus; touch has an explicit equivalent | View-local preview state |
| Select | Selected identity stays stable across views; selection has a clear/remove operation | Named row/point action and keyboard equivalent; no color-only state | Canonical session/brush route |
| Move a viewport | Camera/scroll changes what is visible; it does not silently change membership | Pan/zoom plus visible Fit and non-drag alternatives | Existing viewport/gesture owner |
| Perform a command | Action names its effect; completion feedback is truthful | Native button for copy/retry; anchor for an actual download | Existing async/action owner |

Do not reuse the document glyph indiscriminately for navigate, inspect and
expand without a state/destination cue. “Evidence” names a category; an action
must identify its consequence through its context and accessible name.

## Rows: the primary rule

### One action

Make the title, metadata and unused header space part of the same native target.
Use one tab stop. Hover and keyboard focus cover that same surface. A decorative
icon inside it is not another control.

For a commit with multiple evidence sources, the **entire commit header** should
be the disclosure summary: subject, short SHA and chevron. Its body contains
named links such as **Commit record** and **Git output**. The collapsed count
means sources; expanding does not introduce 1/2/3 indexes. A single source can
be a direct row link without an unnecessary intermediate chooser.

Structural contract used by the commit-row repair:

```html
<details>
  <summary>
    <span>Commit subject</span><code>short SHA</code>
    <span aria-hidden="true">disclosure cue</span>
  </summary>
  <nav aria-label="Sources for this commit">
    <a href="canonical-event-location">Commit record</a>
    <a href="canonical-transcript-location">Git output</a>
  </nav>
</details>
```

This is a contract example, not a second implementation. Implement it in
`SessionArtifacts`, preserving its source locations and callbacks.

### Several actions

Keep a dominant primary target plus separate peer targets for genuinely
different operations: document review, download, source inspection. Secondary
clicks must not trigger the primary action. Do not wrap a button/link around
other buttons/links. Do not add a catch-all click handler to the containing
`li` to simulate a native control.

A session card containing provider filters, artifacts, source navigation and
an Events disclosure is **not** a single-action row. Choose a primary target
within it; do not make the whole card capture every click.

For all row variants, text selection remains possible. Opening two neighboring
rows must not overlap their content or stretch a narrow icon column into empty
space. Row width is not a reason to limit the hit target to 44 pixels: 44×44 is
our minimum target, not our ideal row action area.

## Disclosures and source review

- Closed headers provide identity and enough evidence to decide whether to open.
- Expanded content replaces a redundant excerpt. Do not repeat the same response
  above and inside the open body.
- Source bodies use the available row/panel width. Keep related controls compact.
- Each source has an interpretable name. Repeated identical source names require
  a recorded distinguishing attribute, such as time or operation; do not invent
  differences or rely on anonymous indexes.
- A source jump opens the containing disclosure/group and reveals the target.
  Preserve the route back to the originating result and its scope.
- Inline disclosure state may be local. Major review modes and target identity
  must survive reload and a copied link. Routine polling must not close what
  someone is reading.
- Never mark an artifact “created” from a read/reference, a command as successful
  from its invocation, or an assistant response as a verified outcome.

Owners: `SessionArtifacts`, `TranscriptEvidence`, `EventGroup`,
`transcript-navigation`, `TranscriptViewer`.

## Compression must preserve access

A bundle is a presentation of recorded identities, never a new identity. Use one
projection for rendered members, keyboard traversal and source navigation. Equal
text can share a header; different suffixes, sessions and source IDs stay reachable.
Do not group on a clipped prefix. Retain served rank when moving context to a header.

Every preview cap has a working reveal for the remaining loaded records. Test the
first excluded member explicitly (outcome 4, file 6, character 301). Expansion
replaces the excerpt; it must not merely change a chevron or expose metadata.

Pair requests and responses by recorded block/call links. File bundles use exact
paths; ambiguous relative paths stay separate. Keep all attempts and errors, without
calling a returned result successful or a historical failure currently unresolved.
Canonical source links must open both the containing operation and the specific result.

Reading views show a useful populated result within a 390×844 first viewport.
Active filters, range semantics and freshness remain visible. Scope editing stays
available through the existing state owner. View navigation must stay stationary
when switching projections; Activity's chart belongs below that navigation.

A low repeated-copy score cannot compensate for inaccessible content. Gate source
identity recovery, truthful disclosures, first-result visibility, input parity and
local retry separately. Retain full paths/times on demand and exact source return.

### Command previews are subjects, not shell excerpts

A truncated command prefix is not a useful summary. Put the recorded description
or operation first, followed by independently wrapping filenames and literal
search anchors. A long `cd` path, pipeline or orchestration wrapper must not push
`solverAB` (or another distinguishing subject) outside the collapsed view.
Use lexical extraction only; never execute a command to label it, infer its
outcome, or promote a dynamic expression to a literal fact. Keep exact commands,
patterns and original source IDs available for expansion and search.

Test token recoverability separately from repeated-copy scoring: source content
can contain a huge repeated path blob while the interface-copy score stays low.

## Navigation, focus and recovery

Use the same canonical identity in list rows, charts, URLs, inspectors and
source links. Presentation shortening must never become a routing key.

| Transition | Preserve | Feedback and return |
| --- | --- | --- |
| Results → task inspector | Query, facets, interval, order, selected identity, originating control | Visible selection; inspector heading receives keyboard focus; close restores origin |
| Task → file review | Owning task, contributor, exact file path, review mode | Filename identifies the file; Back/Escape returns to the file row, including rows initially below the preview limit |
| Artifact → source | Artifact identity, source block/event identity, origin route | Target source is revealed; return restores the review context |
| Summary ↔ Conversation | Session identity and chosen view | Both selection styling and URL/reload agree with the chosen major mode |
| File failure → recovery | File, contributor, interval, mode and other readable results | Local error and Retry; successful recovery resumes the same review |
| Live refresh | Focus, scroll, camera, open disclosures and working input | Freshness changes truthfully; explicitly incorporate reordered/new results |

Escape dismisses the innermost **transient** layer first: menu or tooltip,
then file review, then task inspection. It does not clear unrelated filters or
silently discard a time-range draft. Inline reading disclosures are not all
closed merely because Escape was pressed elsewhere. Browser Back follows
semantic navigation history; keyboard focus follows the corresponding content.

Prevent stale responses from replacing a newer selection. A changing label,
spinner, or route is an acknowledgment, not proof that an async operation
succeeded. Use the current request/abort mechanism; do not add visual state
that contradicts it.

## Time, paths, counts and vocabulary

| Data | Presentation rule | Exact value |
| --- | --- | --- |
| Outcomes in a chronological list | One labeled baseline, then offsets with units; establish which record anchors it | Hover/focus or disclosure includes date, year and zone; keyboard dismissal retains context |
| Related file paths | One shared directory; relative suffixes preserve differing folders/worktrees | Selectable full path in Location/shared-directory disclosure and meaningful hover title |
| Counts | Name the counted unit in context; distinguish focus records from whole-session artifacts | Do not imply a recording interval from a single milestone |
| Status | Say what was observed: recorded commit, last response, failed attempt, missing file | Preserve provenance; historical failure does not establish a currently unresolved issue |
| Source controls | Glyph for a compact familiar action; named sources after disclosure | Accessible name includes action and object; count tooltip states its unit |

Apply context compression to product chrome. Do not rewrite authored document
content or alter a canonical path. A private user's home prefix must not become
a hard-coded abbreviation rule.

Use **session** for source identity, **task** for the work being reviewed,
**artifact** for a recoverable output, **source** for a particular supporting
record. An aggregate or inferred task description must retain its session basis.

## Filters, charts and live state

Membership, inspection, selection, hover and camera are different operations.
Do not let a hover change a filter or a pan change the selected time interval.
Specify whether a brush previews, filters or selects; commit once, and restore
the prior state on cancellation. Exact fields provide a non-drag route to the
same interval. Active filters remain removable even when they have no results.

Use `useFocusWorkspace`, `memory-route`, `focus.js` and the existing gesture
owner. Saved return points preserve interval semantics, including open/closed
bounds. Never create a second filter or camera model inside a presentation
component.

Live mode is a quiet, inspectable update path. Keep fixed windows fixed. Keep
open work stable. Name whether a new-record count is global or matches the
current scope. An SSE event is an invalidation signal, not automatically a new
visible result. A reconnect/error state must not masquerade as freshness.

## Visual and input floor

Retain the current dark/cyan language and existing tokens. Prefer hierarchy,
alignment and spacing to new boxes or decorative chrome.

- Body, metadata and captions: at least **16px**, weight **500**.
- Readable text: at least **8:1** on its actual background, including selection,
  hover and error states. Do not reduce text opacity to create hierarchy.
- Operable targets: at least **44×44px**; a sole row action occupies its row.
- Visible keyboard focus; logical tab order; native Enter/Space semantics.
- Touch and keyboard paths for information otherwise available only on hover.
- Long names, expanded neighbors and narrow inspectors fit at 390px without
  page-level horizontal overflow. Content-specific horizontal scrolling may
  be appropriate for a diff or source document.

These are project/Muriel constraints, not a claim of full accessibility
conformance. Screen-reader, physical-touch and human comprehension testing
remain separate proof obligations.

## Review gate and evidence

Review the **action contract** before styling a control:

1. What human task does this action advance, and which existing state owns it?
2. Is there one action or several? Does the visible surface match its hit area?
3. What changes, what is preserved, and how does the user return or recover?
4. What do pointer, keyboard and touch do in idle, focus, selected, open, loading,
   failed and recovered states that actually apply to this control?
5. Exercise the task, not only the small icon. Test title, whitespace, icon,
   keyboard, consecutive expanded rows, source destination, reload and recovery.

Representative acceptance journeys:

| Task | Required proof |
| --- | --- |
| Recover a graphic or document | Artifact is visible, identifiable and openable; exact source stays reachable |
| Understand a commit | Whole header activates its sole action; named sources work; return retains context |
| Review a file and return | Canonical file/contributor retained through preview, diff, failure/retry and Back |
| Inspect research | Titled search links own corresponding fetch results/retries; unrelated URLs stay separate |
| Glance at new work | Stable reading position, honest freshness, scope-aware update counts and deliberate reordering |

The [copy audit](UI_COPY_AUDIT.md) and [review guards](UI_REVIEW_GUARDS.md)
remain useful mechanical checks. A passing 5% repetition budget or 44px icon
check cannot establish the usefulness of an inert row. Keep known failures
visible in an audit ledger; passing regression tests are not human acceptance.

## Applying the patterns elsewhere

Use the [opportunity sweep](REVIEW_OPPORTUNITIES_2026-10-29.md) for concrete
remaining sites. Compression must preserve access: every grouped source and
item beyond a preview limit needs a working reveal. A changed chevron alone is
not an expanded state. Keep full source identity when text looks similar.

Group by an explicit object/operation relationship, keep shared context once,
and place exceptions on the affected item. The original rank/order may itself
be evidence; do not reorder merely to reduce repeated labels. Test recovery of
an actual output and the location jumps needed to inspect its supporting records.

## Rationale and limits

Hilbert and Redmiles distinguish event selection, abstraction and recoding when
making UI-event streams useful for analysis. This informs the product's
object-and-source review model; their framework does not validate this interface
or its copy threshold. [Author manuscript](https://ics.uci.edu/~dfredmil/publications/J006-HR00.pdf).

Muriel's microstrategies guidance (`references/microstrategies.md` in the Muriel skill)
informs the question we should test: which extra targeting, reveal, remembering
and return steps does an interaction impose? Whole-row activation is our design
application and follows the user's correction. No time savings, workload
reduction or comprehension benefit has been measured for Cartographer.
