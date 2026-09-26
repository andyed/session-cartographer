# Changelog

## Unreleased

### fix(turbo): fall back once when a recall outruns its budget

Every Turbo recall fallback in the 30 days to 2026-09-26, 6 of 260
remember/focus calls, read "HTTP This operation was aborted; file transport
spool response timed out" while the service was healthy, and took 13 to 89 s.
The spool was working. The client gave the service 1.5 s, the semantic stage
sometimes ran 1.7 to 2.7 s, and the client read its own abort as an unreachable
service. It re-sent the request through the spool, where the same process ran
the query a second time beside the abandoned first run. When that rerun also
missed the spool's 3 s, the portable CLI ran. Every served call since 09-01
whose semantic stage passed 1.2 s had arrived through the spool.

The recall client now tells its own timeout from a failed connect. After a
timeout it exits for the portable fallback at once, with "no answer within N
ms" as the fallback detail. Only a refused connect tries the spool, and that
is the sandbox case the spool exists for: 102 of the 104 spool calls since
08-27 had failed HTTP within about 90 ms. The facts client follows the same
rule and keeps its 1500 ms budget, since a fold costs 12 to 368 ms.

The recall budget default moves from 1500 to 4000 ms
(`TURBO_TIMEOUT_DEFAULT_MS`). The semantic stage ran 165 ms at p50 and 988 ms
at p95 across 338 served calls, peaking at 2.7 s, and missing the budget costs
a 9 to 85 s portable search, so a budget under the tail never made a call
faster. `/turbo enable` writes the budget into the config, so configs written
before this change keep `timeout_ms: 1500` until raised with `enable --timeout
4000`.

`turbo-timeout-fallback.test.js` counts what reaches a fake service: HTTP
requests at the port and request files in the spool. A slow service must see
the request once with no spool file; a 2 s service must be served over HTTP
under the default budget; a refused connect must still be carried by the spool
without waiting out the budget. The first two and the facts case fail against
the previous code, the second with the exact production error.

### fix(explorer): hold the transcript toolbar and the find placeholder to 8:1

The Transcript viewer's search field drew its placeholder in gray-500 on its
gray-900 fill (3.67:1), the defect 7289e7a fixed in the search combobox. The
rest of the viewer's toolbar sits on the page (#0a0a0f): the back button, the
match count and the system and noise toggles' labels were gray-500 (4.09:1),
the message count gray-600 (2.61:1). All of them are now `muted`: 9.69:1 as the
placeholder, 10.78:1 on the page. The two toggle labels share one class,
`TOGGLE_LABEL`. The noise toggle renders only for a transcript that holds
noise, and the fixture holds none, so the system label's measurement stands
for both. The checkboxes carry no text.

The find field in the Timeline and Working memory views (FocusToolbar) had no
placeholder rule and fell to Tailwind's preflight gray-400 (#9ca3af), 7.19:1 on
the field's fill, `--fw-surface` (#11151e). `focus-workspace.css` now colours
every placeholder in either workspace `--fw-muted` (12.99:1).

The Memory Desk's `.md-search input::placeholder` (#b4bbc7) is dead CSS: no
module imports `memory-desk.css`, and the built stylesheet has no `md-search`
rule. There was nothing to measure.

`memory-entry.cjs` measures the transcript search field while empty, on
#111827; the toolbar with a term entered, asserting that the probe reached the
back button, the system label and both counts on the page; the Timeline's find
field while empty; and the Working memory find field before the find test fills
it. Against the old colours the cold phase failed with six entries, the lowest
the message count at 2.61:1. With `.focus-workspace` removed from the new rule,
the Working memory probe failed at 7.19:1. After the fix all 1,532 classic
measurements pass, 1,510 of them non-exempt. The lowest is unchanged: the
co-term flyout heading at 8.01:1.

The rest of the viewer still draws text under 8:1. A one-off probe over the
whole viewer on this fixture found seven more entries: the role label (`user`,
blue-400, 7.32:1), a message's relative time and the summary card's `turns`
label (gray-600, 2.46–2.47:1), and the token attribution sidebar's heading,
collapse glyph, category label and percentage (2.66–4.16:1). No probe measures
them, and they are unchanged here.

### fix(explorer): hold the search combobox's text to 8:1

The search combobox, inside the header, was left out of bf1044e. Its
placeholder was gray-500 on the field's gray-900 (3.67:1). In the suggestion
list (gray-800) each option was split by colour into the typed prefix, gray-200,
and the completion, gray-500: 3.04:1 on the list and 2.13:1 on the active
option (gray-700). The co-term flyout's heading was gray-500 (3.04:1), its
terms gray-400 (5.78:1), and the `›` beside the option it belongs to gray-600,
which renders on the active row at 1.36:1. The idle rows' `hover:bg-gray-750`
is not a Tailwind 3.4 colour and had no effect.

That split cannot be made with a second grey. On gray-700, 8:1 needs a
relative luminance of at least 0.765, and only gray-200 (8.33:1) through white
(10.31:1) qualify: too narrow a band for two greys to read as different.
`muted` is 5.63:1 there. The completion is now set bold and the typed prefix
regular, both in the row's colour: gray-300 idle (9.96:1), gray-100 active
(9.37:1). The completion is the part that differs between rows, and the split
no longer rests on colour alone. Bold monospace has the same advance width as
regular (`auroral` is 147.5 px at 35 px either way), so the fisheye does not
reflow. The flyout's terms are coloured as the list's are, the `›` is drawn in
its row's colour, the heading is `muted` (8.01:1, the least headroom in the
classic views), and the placeholder is `placeholder-muted` (9.69:1). Neither
list has a hover style any more: hovering a row makes it the active one.

`textContrast` now measures a text field's painted text: its value, or while it
is empty its placeholder, in the colour `getComputedStyle(field,
'::placeholder')` reports. `memory-entry.cjs` measures the empty combobox, the
suggestion list with no option active and with one active, and the co-term
flyout (now `#search-coterms`) opened from the keyboard. It also asserts that
the completion computes heavier than the prefix, since no contrast probe would
fail if the weight were lost. Against the old colours all five new probes
failed, seven entries, the lowest the `›` at 1.36:1. After the fix all 1,518
classic measurements pass, 1,496 of them non-exempt, the lowest the flyout
heading at 8.01:1.

The Transcript viewer's search field has the same `placeholder-gray-500` on
gray-900 (3.67:1). It is not measured by any probe and is unchanged here.

### fix(turbo): record why a start failed in the log the error names

On 2026-09-26, at load average 72 on 16 CPUs, `cartographer-turbo.js start`
exited 1 with "Turbo service did not become ready; see .../server.log", and
server.log had not been written since the previous start. The server printed
its first line after its corpus load, so a child that died before then left no
trace, whether the controller killed it at the 5 s deadline or something else
did. `/remember` runs the same path when it auto-starts Turbo, and there the
failure shows only as a drop to the portable CLI.

The server now logs `[turbo] <time> pid N loading corpus from <root> (modules
loaded after N ms)` before it loads, and its `loaded` line gives the load time.
When `start` fails, the controller appends a `[turbo-control]` line to
server.log. The same diagnosis is the first line of its error, which
`cartographer-search.sh` already copies into its fallback detail. The line
separates a child the controller killed at the deadline from one that exited
first, with its signal or exit code, and records the load average and CPU
count. `CARTOGRAPHER_TURBO_READY_TIMEOUT_MS` overrides the deadline.

The deadline stays at 5 s. Load was the suspected cause, but the live corpus
(158,261 events) loaded in 2,100 ms at load average 80 on the same machine, and
the managed service's successful retry took 2,059 ms from spawn to ready. A
load-scaled deadline would have rested on a guess. The original failure's cause
is still open, and the next occurrence will record whether the child was killed
or died first.

`turbo-start-diagnostics.test.js` covers a kill at the deadline, a child killed
from outside before ready, the pre-load line and the override. All four fail
against the previous code.

### fix(facts): report a delta event as census counts it

`delta` read raw log rows and collapsed a dual-logged pair with its own rule:
keep the first copy `readAppended`'s round-robin reached, or spread the domain
copy over changelog's. The resident corpus normalizes each row and folds with
`mergeDuplicateEvent`, so the two verbs described one event differently. A
turn-stop milestone read `Stop` or `milestone_turn_stop` depending on queue
position, a search read `search` against census's `research_search`, a wrapup
read `Wrapup` against `milestone_session_wrapup`, and a domain copy's shorter
summary replaced changelog's, which carries the git context.

`delta` now passes its rows through `normalizeEvent` and folds them with
`mergeDuplicateEvent`, as the watchers do. `readAppended` still returns raw
rows; it is the cursor primitive, and the cursor and its positions are
unchanged. Replayed over a seven-day tail of the live logs, the previous code
disagreed with a load of the same files on 891 of 14,107 types and 536
summaries, and the new code on none. `session_id` and `source` did not differ in
either.

The load's `type` chain gains `event` between `milestone` and the log's name, so
the load and `delta` resolve every row alike. One live row changes: an
`/investigate` hypothesis in changelog with `event: "investigation_hypothesis"`
and no `type`, previously typed `changelog`. `milestone` stays ahead of `event`
because a milestone row's `event` names only the hook that fired, and
`SubagentStop` does not say which agent.

A pair split across two calls, by the budget or by a copy landing after the
first call, is still reported once per call, each as its copy reads.
`docs/FACTS.md` had described delta rows as un-deduplicated and un-normalized,
which was already half out of date; it now describes the current behavior.

A new `facts-engine.test.js` case sends dual-logged milestone and research pairs
through both arrival orders, plus a milestone-only wrapup, a research-only fetch
and an `event`-only changelog row. It asserts that delta's per-event fields and
type and source buckets equal a load's. It fails against the previous code,
against the new `delta` without the load's `event` fallback, and against the
new load with the old `delta`. Full unit suite (Node 26.8.2): 621 tests, 620
pass, 0 fail, 1 skipped.

### fix(explorer): hold the classic views' text to 8:1

The Timeline event feed, Sessions and Search drew secondary text in Tailwind's
gray-500 and gray-400. Across the grounds that text sits on (the page
#0a0a0f, a session card #0d1019, an open session's event list #030712, the
keyboard-active search result #151a23, and a hovered group header, which the
timeline workspace paints #11151e rather than the bg-gray-800/50 its class
names) gray-500 measured 3.62–4.16:1 and gray-400 6.90–7.93:1. Links used
blue-400 (6.89:1 on the active result), a group header's domain blue-400 at 60%
(3.31:1), and a commit hash orange-400 (7.74:1). Event-type and project badges
were One Dark hues on a 13% tint of themselves, 4.62–7.98:1 on the active
result; the grey that the project hash hands one project in ten (#5c6370) sat
at 2.6:1. Facet-pill counts were faded to 50% opacity (1.5–3.5:1), and a
selected pill, white on a 33% fill of its hue, left its count at 5.4–8.4:1 and
its × at 4.5–6.5:1.

`explorer/src/lib/palette.js` now holds the categorical hues. Each keeps its
OKLCH hue angle with lightness raised to clear 9:1 on every classic ground
(9.04–10.14:1 on the active result), and it adds `NEUTRAL` (#b9c0cb, also
AgentBadge's colour for an unrecognised agent) and `LINK` (#93c5fd).
ProjectBadge and FacetBar share its project hash, which they each carried a
copy of, so every project keeps the hue it always hashed to. Badges and pills
are outlined, never tinted. A pill's count is `muted` rather than faded, and a
selected pill is filled with its hue and lettered in the page colour, at least
10.19:1.

Tailwind's `muted` token is now `NEUTRAL` (it was #abb1bb, 8.13:1 on the active
result), and a `link` token joins it; `tailwind.config.js` imports both from
palette.js. In these views gray-400 and gray-500 text is `muted` and blue-400
is `link`. EventGroup's count label ("2 tool_file_edit events") moves to
gray-300, the header's main label now that the time beside it is `muted`.
`muted` is also the Transcript viewer's and the route-error panel's secondary
text, which lightens from 9.16:1 to 10.78:1 on the page. The demo banner's
"Try:" labels and chips were 2.6–6.4:1 and now compute at 8.65–10.75:1,
including hover; the harness strips demo mode, so those are computed, not
measured in the browser.

`tests/browser/memory-entry.cjs` measures every text element, from computed
styles, in the event feed, a hovered group header, an opened group, session
cards closed and open, the header, the whole keyboard-active search card (the
check previously held only its AgentBadge to the floor), the facet bar with a
selected pill, a commit card's detail, and repeated-result, empty and loading
searches. Each probe is guarded to prove it reached its ground, and failures
collect across the journey and fail once. Against the old colours 12 of the 13
probes failed, 93 entries, the lowest a facet count at 2.34:1. After the fix
all 1,488 measurements pass, the lowest the unchanged active tab (gray-200 on
gray-700) at 8.33:1. Each phase writes its measurements to
`carto-classic-contrast-<phase>.json` in the artifacts directory.

`textContrast` gains `exempt`. An element the page marks
`data-contrast-exempt="<reason>"` is measured and reported but never fails.
Two are marked: the header's `SC` monogram (2.61:1) and the facet bar's `·`
group separator (1.92:1). The classic probes also exempt the timeline pager's
disabled button, #a0a9b8 at 45% opacity (2.53:1). WCAG 1.4.3 exempts inactive
controls, but the exemption is flagged for review, not measured as a pass.

### fix(load): type a milestone-only row by its milestone, not its log

The load fills a missing `type` for every resident event. It used the log's
name, so each row that exists only in the milestones log was typed
`milestones`, and the Memory Desk, census and the Explorer's type facet could
not tell a `/wrapup` from a Hermes cron run. It now uses `milestone_<milestone>`,
the type the milestone hook gives the changelog copy of a dual-logged
milestone. A row with no `milestone` still gets its log's name.

On the live corpus 1,923 events change `type` and no other field changes: 790
`/wrapup` rows become `milestone_session_wrapup`, 322 Hermes rows become
`milestone_hermes_*`, and 809 agent and compaction rows from March, written
before the hooks dual-logged them, join the buckets their later siblings already
use (`milestone_compaction_auto` 783 → 880, `milestone_agent_Explore` 376 → 841).
The other two are one-off kinds (`session_rollback`, `session_wrapup_committed`).

The Memory Desk finds a wrapup by testing `type` against /wrapup/, which
`milestones` never matched. Measured on the running service before the change:
a session's wrapup was counted in `wraps` but was missing from `outcomes`, and
its note carried the type `milestones`. It now appears among the session's
outcomes and its note reads as a wrapup.

In the Explorer, `EventCard` labels a compaction row `compaction` whether or not
it was dual-logged. Wrapup and Hermes rows keep the `milestones` label, which
`EventCard` takes from `_source` for types it does not map. The type facet
lists each kind instead of one `milestones` pill.

The `delta` verb reads raw log rows and resolves `event` before `milestone`, so
a delta reports the same wrapup as `Wrapup`. `docs/FACTS.md` now says so.

A new `memory.test.js` case loads a wrapup, a dual-logged compaction and a
milestone-only compaction through `readAllEvents` and asserts the types and the
desk's outcomes. It fails against the previous load, as does the updated
`watcher-normalization.test.js`.

### fix(search): return no results, not a 500, for queries with no terms

`/api/search` threw "Cannot read properties of undefined (reading 'filter')"
for any query that tokenizes to nothing (punctuation only, CJK) and for any
search over an empty index. Since 4925dca `scoreBM25` has returned
`{ items, total }`, but its two early exits still returned a bare `[]`, and
`hybridSearch` reads `.items`. On the Vite host the thrown error appears as an
overlay on every open Explorer page, not only the page that sent the query.
Both exits now return `{ items: [], total: 0 }`. `search-empty-query.test.js`
fails 2 of 3 against the previous code; its control still finds a match.

### fix(explorer): hold selected-row text and the agent badge to 8:1

A selected Memory Desk row is painted `--fw-selected` (#153640), and its
secondary text used `--fw-muted` (#bcc4d2) at 7.32:1: a task row's metadata
and file count, a file row's path and task count. `--fw-muted` is now #d4dae3,
the Recall view's meta colour: 14.05:1 on the page, 12.99:1 on
`--fw-surface`, 9.14:1 on a selected row.

No AgentBadge renders on #153640. In a selected task row the agent appears as
plain text, and Recall rows never take the selected background. The badge does
render on the classic Search view's keyboard-active result (bg-gray-800/50
over the page, #151a23), a surface its docstring never listed. With the
badge's 13%-alpha tint, all four palette entries measured 7.27–7.71:1 there.
The badge is now outlined, never tinted, as the Recall markers already are:
9.57–10.27:1 on the active result and at least 10.40:1 on the page, a session
card, and an open session's event list. Untinted, the palette still measures
7.02–7.54:1 on #153640, so it stays off that surface.

In `tests/browser/memory-entry.cjs`, text is now measured from computed
styles against the ground it is painted on, with every ancestor's background
and the element's own fill composited. The new checks cover the selected task
and file rows and every result made keyboard-active in classic Search, each
guarded to prove the probe reached the surface in question; the Recall probe
uses the same helper. Against the old colours the Search check failed at
7.39:1 (the claude badge over its own tint on the active card) and both row
checks at 7.32:1. The probe waits for CSS transitions to finish: the active
card's background fades in, and read mid-fade it was still transparent, so
the badge would have been measured on the bare page and passed.

### fix(watcher): normalize a delivered row as the load does

`readAllEvents` fills the canonical fields after folding duplicates:
`session_id` from `sessionId` or `session`, `summary` from `display`, and
`type` from `_source`. Rows delivered by `watchFiles` skipped that step, in
Turbo and in the Explorer, so a row with no changelog copy to supply the field
kept its raw shape until the next restart. On the live corpus that covers 1,921
milestone-only rows with no `type` (`session_wrapup`, `hermes_*`, `agent_*`),
which are still being written, and 1,628 research-only rows with `session` and
no `session_id`, the newest from March.

Reproduced against both servers before the fix. While running, recall returned
those rows without `session_id` or `type`. Census typed a milestone-only row by
its `milestone` value (`session_wrapup`) where a load types it `milestones`. A
legacy row carrying only `sessionId` and `display` came back with no
`session_id` or `summary` and counted as unattributed (3 resolved sessions
against a load's 4), since `eventSession` does not read `sessionId`. No live row
has that shape today; the test keeps it because the normalization covers it.

`normalizeEvent` in `jsonl.js` is now the one implementation: the load applies
it after folding, and `watchFiles` applies it to every row it delivers.
Normalizing before a fold needs one more rule. `mergeDuplicateEvent` keeps the
longer of two values, so a derived `type: "milestones"` would outlast a twin's
shorter real type, and a `type: "changelog"` derived from the first copy would
outlive a domain log claiming the source. Derived values are now recorded per
event, ignored on both sides of a fold, and re-derived after it. The load
normalizes after every fold and never sees one: `readAllEvents` output is
identical to the previous code across 157,636 live events, 3,551 of which carry
a derived value, and load time is unchanged within noise (median 907 ms against
892 ms over six alternating runs).

`watcher-normalization.test.js` drives the managed Turbo service and the
Explorer app through domain-only rows and both fold orders, then compares each
with a fresh load. It fails against the previous code, and against a variant
that normalizes on delivery without the fold rule. Every real changelog twin's
type is longer than any source name, so the fold cases use synthetic types.

### fix(memory): keep the field readout below its header and off its point

In the full-size Activity view, the readout under the Field header (thread
title, project, span · tokens · files) had its first line hidden. Since
f1f7a5a moved it into the field's stage, it sat in normal flow at the top of
that stage, and the panel header is absolutely positioned over the stage's top
44 px. Measured in the browser harness: header 526–570 px, title line 554–577 px.
It also covered the point it described (point at 599 px, readout 526–658 px),
because the `data-placement` the field sets for each point was styled only in
the compact desk. The full-size readout now uses the compact desk's overlay: it
sits below the header when the point is in the lower half and at the bottom
when the point is in the upper half. It has an opaque ground and does not take
pointer events.

The browser harness measures the readout for the brushed thread and for one
point in each half of the field. Every line must sit below the header and
inside the stage, and the readout must not cover its point. Against the
previous CSS the brushed-thread check fails on the hidden title line. Without
the placement rule, the lower-half check fails on the covered point.

### fix(turbo): fold a dual-logged event's second copy instead of dropping it

The hooks write one event to its domain log and again to changelog, and each
copy carries fields the other lacks: changelog has `session_id` and
`related_ids`, tool-use has `tool` and `session`. The load folds the pair with
`mergeDuplicateEvent` and labels it with the domain source, and the Explorer's
watcher does the same. Turbo's watcher skipped any id it had already stored, so
an event dual-logged while the service ran kept only the first-arriving copy
until the next restart. Recall returns the stored event's fields and census
counts its `_source`, so a live service and a freshly restarted one disagreed
about the same rows.

Reproduced against the real service before the fix. In the hooks' order
(domain log first), recall returned the event without `session_id` or
`related_ids`. In the reverse order, which a changelog debounce already in
flight can produce, it returned `_source: "changelog"` with no `tool` or
`session`. After a restart both events carried every field under `tool-use`.
`turbo-server.js` now keeps a map from event_id to the stored event and folds a
repeat into it, as `app.js` does, and the reload path rebuilds the map. A row
the startup load read and the watcher's first pass re-delivers (13aa132) still
folds to one event: folding an identical copy changes nothing.

Facts, the Memory Desk and the Turbo client fall back from `session_id` to
`session`, which hid the hooks'-order loss from them. `_source`, `tool` and
`related_ids` have no fallback.

`turbo-duplicate-events.test.js` drives the managed service through both
orders, restarts it, and requires the live and restarted answers to match. It
fails against the previous code. Full unit suite: 614 tests, 613 pass, 0 fail,
1 skipped (Codex CLI not installed). The managed service, restarted, reads
`live` with every log at `bytes_behind: 0`, and an event this session wrote
after the restart recalls with `tool`, `session`, `session_id` and
`related_ids`.

### feat(memory): browse /remember calls and the results agents marked used

The Memory Desk carried no recall data. A **Recall** view beside Tasks, Files
and Activity now lists every call in the window, grouped by session, and each
call expands to its ranked results. A task's detail lists that session's own
searches. A result the agent marked with `--touch` carries a "marked used"
marker with its served rank, so consumption deep in the list (rank 12) reads
as a tuning signal. Each result links to the episode it came from through a
fixed window, because a rolling session link breaks once the session leaves
the window. The label is "marked used", not "helpful": a touch is evidence
that the agent marked the result, not that the result improved the outcome.

Calls with no session sit in an explicit **Unattributed** group. At
2026-09-26T14:22Z the last 24 hours held 75 calls, 68 of them with no session,
and 11 of the 12 use marks in the window named no call (`no_session`). A view
that dropped either set would have read as "no recall happened". Marks that do
not join are listed and never guessed onto a row. An `invalid_call` mark is
shown on the call it names as a result that call never served. `no_session`
and other callless marks are listed as unplaced.

Recall loads on demand from `/api/memory/recall` and `/api/memory/recall/call`,
never with the polled state. Result ids resolve against the warm corpus, then
the semantic index by point id (transcript turns live only there), then the
turn id's own session. An id none of them knows stays listed at its rank as
unresolved. `scripts/recall-join.js` is now the one served/access join for
Internals, the session digest and the desk, and the tests assert that all
three count the same calls and used results. The digest now also counts
zero-result calls, as Internals already did (17 → 20 calls on one real
session).

`memory-recall.test.js` has 12 tests, checked against two deliberate
regressions: dropping unattributed calls fails 4 of them, and crediting a
`no_session` mark by event id fails 3. In the browser harness, a fixture call
must render with its rank-12 marker, the Unattributed group, an unresolved row
and a fixed-window episode link; dropping the unattributed call fails the run.
Every new text colour is measured from computed styles at 8:1 on #0a0a0f and
#153640.

### fix(telemetry): name the caller on every served, call and access row

Over 24 hours on 2026-09-26, 26 of 30 served calls carried `session_id: ""` and
`provider: "unknown"`, and 11 of 17 access rows had neither a session nor a
`call_id`. Each call was traced to its caller through the hook logs, Hermes'
`state.db` and transcripts. Eleven calls and all eleven access rows were Hermes
FrakBot, whose terminal tool binds `HERMES_SESSION_ID` but exports none of the
session chain. The other fifteen were a Claude session that unset the chain on
purpose while replaying FrakBot's queries. Turbo was not dropping ids: the
client writes the session it sends.

Served and search-call rows, from both the awk writer and
`turbo-search-client.js`, now carry `attribution_status` (`session` or
`no_session`) and `session_source`, the chain variable the session came from.
Access rows carry `session_source`. The chain takes the first resolved value,
so `CARTOGRAPHER_SESSION_ID=unknown` can no longer shadow a real id and become
both the rows' session and a delta-serving list shared by every caller that set
it. `HERMES_SESSION_ID` infers `provider: "hermes"` and is never read as a
session, because that would switch on delta serving for gateway sessions open
for weeks; Hermes wrappers opt in with `CARTOGRAPHER_SESSION_ID`
(docs/SETUP.md). After FrakBot's wrapper opted in, 3 of 3 calls, 60 of 60
served rows and 3 of 3 access rows named its session.

`telemetry-attribution.test.js` drives the portable CLI and a fake Turbo with
the variables each caller has. Eight of its nine cases fail against the
previous scripts.

### fix(watcher): index rows appended during startup or written in two parts

The resident index lost events in two ways while `status` read `live`. Both
were found by reading the code after c29a684, and both were reproduced before
the fix.

(1) Startup. The headless service and the Explorer read the logs and built the
index, and only then armed the watchers, each baselined at its log's size at
that moment. A row appended during the load (about a second at 157k events)
landed after the read and before the watcher, so it stayed unindexed until a
restart while the watcher's offset matched the disk. With a preload that
appends while the load runs, Turbo held 6 of 7 events, recall missed the row,
and status read `live` with `bytes_behind: 0`. Both servers now arm the
watchers first. That alone was not enough on macOS: a file watch is registered
with kqueue only when the event loop next polls, so an append in the same tick
raises no event (0 of 5 trials). The directory watch covered it in isolation
and missed once under the full suite. `watchFiles` now checks every log once
after the caller's synchronous load. A row both loaded and delivered is folded
by `event_id`: skipped by the id set in Turbo, merged by `mergeDuplicateEvent`
in the Explorer.

(2) Mid-flush tail. The watcher read to the end of the file, skipped a trailing
fragment as malformed, and counted its bytes as consumed. The rest of the line
then arrived as a second fragment and failed the same way, so a row appended in
two writes was never delivered and `watchLag` reported `bytes_behind: 0`. The
watcher now consumes through the last newline only, as `readAppended` already
did. Every baseline (arm, re-arm after a replace, rewrite) starts at the last
complete line, so a service that starts while a row is being written reads that
row once it is finished. A torn line left at the end of a log by a crashed
writer now reads as `stale`, with `bytes_behind` equal to its length, where it
read `live` before; none of the five live logs ends in one.

Five tests, all failing against the previous code: two in
`watcher-partial-line.test.js` (one splits a row inside a multi-byte
character), `watcher-first-pass.test.js`, and two in
`watcher-startup-window.test.js` (Turbo end to end, the Explorer in process).
The first-pass test stubs `fs.watch` so no event can arrive, and it fails with
only the first pass removed. With the dedup removed, the startup tests count 8
of 7 events and show one row twice.

### fix(hooks): record commits past char 500 and after a leading `cat`

`log-tool-use.sh` lost real commits in two more ways. Both reproduce with
synthetic payloads through the installed 0.7.9 hook. (1) Git detection read the
command cut to 500 chars. `cat > msg.txt <<'EOF' <1,800-char message> EOF`
followed by `git commit -F msg.txt` logged an edit and no commit. A JS port of
the matcher, replayed over 30 days of Claude Code transcripts (83,302 Bash
commands), found 584 commands that put a real `git commit` past the cut. (2) The noise filter judged only the first command
after any `cd` hops. A leading `cat` dropped the whole line unless it wrote a
path the write filter keeps, and scratch paths are filtered. c29a684 (session
979b81b0) was lost to `cat > <scratchpad>/commit-msg.txt <<EOF … EOF` followed
by `git add … && git commit -F …`.

Git detection now reads the full command with heredoc bodies removed. Reading
the raw 20,000-char copy would have turned 40 body-only mentions in the same 30
days into phantom pushes, or into `Ran:` rows in place of real `cat > notes.md`
edits, and none of those mentions ran git. The noise verdict now judges every
`&&`, `;` and newline segment, and a detected commit or push outranks it, which
covers `cat msg | git commit -F -`. Replayed over the same corpus, the old rule
dropped ~4,400 commands of real work (node, python and npx runs, curl, 552 git
writes) and ~9,900 inspection runs such as `echo "==="; grep …`. All of those
are now logged: at most 22% more Bash rows, since the port ignores the writes
that already kept some of them. The freshness and already-logged
guards are unchanged. Seven tests in `log-tool-use-git-commit.test.js`; six
fail against the previous hook, and three fail if detection reads the raw
command without stripping heredocs.

### fix(hooks): record `git -C <repo> commit` and `git -C <repo> push`

`log-tool-use.sh` detected commits with a literal `grep -q "git commit"`.
`git -C ~/Documents/dev/session-cartographer commit -F -` contains no such
substring, so 9e3d014 (session 49614682, 2026-09-26) was logged as `tool_bash`
and `/wrapup`'s digest printed no commits block. `git -C` is the natural way to
avoid a leading bare `cd`, which already lost commits (68cf1db), so agents were
steered into this form. `git -c k=v commit` had the same gap, and so did
`git -C <repo> push`. Detection now matches `git`, any run of global options
(`-C`, `-c`, `--git-dir`, `--work-tree`, `--no-pager`, …), then the subcommand
in first position, so `git -C r log --grep commit` and `git commit-tree` are
not commits. The repo is resolved from the invocation's own `-C` chain
(`~`, `$HOME` and quotes handled by hand; nothing is evaluated), then
`--work-tree`, or a `--git-dir` ending in `.git`, not from the hook's cwd.
The freshness check, `diff-tree`, the remote URL and `project` all read that
repo. From `~/Documents/dev` the old path found no repo, and from a sibling
repo it found the wrong HEAD. The freshness and already-logged guards are
unchanged. Replaying the original 1,691-char command: the previous hook writes
`tool_bash` under project `dev`, the new one `git_commit` with the right sha
under `session-cartographer`. Eight tests in `log-tool-use-git-commit.test.js`
cover this; six fail against the previous hook, and four fail when only the
matcher is fixed and the repo still comes from the cwd. That file's hook runs
now point Qdrant and the embed server at a dead port: the backgrounded
`index-event.sh` had put 18 `session: testsess` fixture points into the live
collection.

### fix(search): the CLI honours `CARTOGRAPHER_SEMANTIC=0`

Only `explorer/server/search.js` read the variable. `cartographer-search.sh`
ran its semantic leg whenever Qdrant and the embed server answered, so tests
that spawned the CLI with the flag set were not pinned off. On 2026-09-25 a
flag-set, Turbo-off query for `abandonware` returned 30 rows from the live
corpus, all `source: semantic`. `semantic_search_to_tsv` now returns before
its first request when the variable is `0`, the same test `semanticEnabled()`
applies, and `--intent`, which searches only the semantic leg, exits 2 with
the flag set instead of reporting no results. The variable is documented in
the script header. Turbo is unchanged: the recall request carries no semantic
field, so the server's own environment decides, and a flag-set call that
auto-starts the managed server leaves it `disabled` for every caller until it
exits. `tests/unit/cli-semantic-flag.test.js` points Qdrant and the embed URL
at a local recorder: with the flag unset it records the leg's collection
probe, with the flag set it must record nothing. The previous script fails
the second assertion. `docs/TESTING.md` rule 2 now covers spawned CLIs and
Turbo.

### fix(turbo): `status` can report a stale index

`cartographer-turbo.js status` printed `index_freshness: "live"` whenever the
running service answered `/api/recall/health`. That shows the process is up,
not that its watchers still follow the logs. On 2026-09-25 a log replaced by
write-temp-then-rename left the watcher on the unlinked inode (fixed in
9e3d014), and status said "live" while Turbo served 2 of 69 hermes milestones.
`watchFiles` now reports, per log, the path it watches, the bytes it has
consumed and the inode it is bound to. `/api/recall/health` carries that as
`watch`, from the headless service and from the Explorer. `status` stats each
log and reports a `watch` entry per source (`consumed_bytes`, `disk_bytes`,
`bytes_behind`, `inode_mismatch`, `stale`). If any log lags at the first look,
it looks again after one second. A log is stale when the watcher has still not
reached what was on disk at the first look, so appends made during the wait do
not count. `index_freshness` is then `live` or `stale`. A service that does not
report `watch` reads `unverified`, and `startup snapshot` still means there was
no HTTP answer. With nothing lagging, status takes 0.32 s against the live
157k-event service, the same as the previous CLI over five runs each.
`tests/unit/turbo-status-freshness.test.js` serves the positions of a real,
stopped watcher to the real CLI: the previous CLI reports `live` for both an
unread append and a replaced log. The recall and facts contracts are
unchanged. Neither claimed liveness (`index_lag_ms` is `null`).

### fix(search): the CLI keyword engine reads JSON strings past an escaped quote

`bm25-search.awk` cut every string field at its first double quote, escaped or
not, so text after an embedded `\"` was invisible to `/remember` with Turbo off
while the Explorer's JS engine, which parses the JSON, still matched it. On
2026-09-25 that covered 37,711 of 135,315 changelog summaries, 37,074 of
109,489 tool-use summaries (mostly bash commands with quoted arguments), 899
prompts and 109 milestone descriptions. `extract()` now ends a value at the
first unescaped quote and decodes it: `\n`, `\r` and `\t` become a space, and
`\"`, `\\` and `\/` become the character. `\uXXXX` stays as written (51 rows).
The result equals `JSON.parse` on all 276,315 summaries and descriptions
checked. Decoding `\n` also changes tokens: `line\nterm` used to score as
`nterm`. Rows without a backslash take an `index` fast path, which is cheaper
than the old regex `sub`: the scorer run over all five logs in sequence went
from 24.2 s to 23.7 s, and an end-to-end portable CLI query from 11.9 s to
11.7 s. `tests/unit/keyword-json-escapes.test.js` runs the CLI on terms placed
after escapes and asserts that the awk and JS engines return the same rows.
`hermes-source.js` still swaps quotes for apostrophes when it writes; the
workaround is no longer needed and does no harm.

### feat(hermes): Hermes Agent sessions and workspace notes enter the corpus

`scripts/hermes-source.js` is a third source adapter, and the first whose
units are database rows. It reads every Hermes profile's `state.db` read-only
and emits the shared turn document, grouped from one user prompt to the next.
Cron runs contribute their final reply and never their prompt, which can embed
this corpus's own pulse. Configured workspace markdown becomes one row per
content version, with section-level semantic documents. Rows land in
`session-milestones.jsonl` with `provider: "hermes"`, so search, facts, the
pulse, `/standup` and the Explorer (new `hermes` badge, 8.98:1 / 8.36:1) all
see them. Nothing happens without a user policy file. Exclusion drops whole
sessions by project or path and redacts matching lines, reporting both counts.
The SessionStart catch-up runs the adapter when a policy exists.
`--show <session>` is the drill-down, since Hermes has no transcript file.

### fix(ownership): other people's commits no longer count as the owner's session work

Commits imported from cloned repositories were given the owner's session ids by
`enrich-sessions.js`, which matched on time overlap alone, and `ownership.js`
then trusted any commit carrying a session. 203 commits by 8 other authors
(broomy, c9watch, claude-code-session-bridge) were counted as the owner's work
in search, digests, `/standup` and the profile. `isOwnEvent` now trusts a
session only on commits the live hook recorded (they carry `cwd`); imported
commits are judged by author. `enrich-sessions.js` skips non-owner commits.
`scripts/repair-foreign-commit-sessions.js` detached the existing rows: dry run
by default, `--apply` keeps a backup, marks each row with
`session_detached_from`, and carries over rows appended during the rewrite.
The semantic index needed no change; imported commits are embedded without a
session.

### feat(standup): pre-edit collision check

A PreToolUse hook on Edit, Write, MultiEdit, NotebookEdit and Codex
`apply_patch` notes when another session edited or committed the same file in
the last 45 minutes. It is silent otherwise and never blocks: the note goes to
the agent as context and names the case — same checkout, where the peer's
changes may be uncommitted and a commit here would sweep them in, or separate
worktree, where the conflict arrives at merge. A warning repeats only after the
peer touches the file again. Surfaced warnings are recorded in
`.carto/collision-warnings.jsonl` so the check can be judged on whether it
preceded real conflicts.

`/standup`'s file-contention rules (edit-summary parsing, worktree collapse,
tail budget) move to `scripts/contention.js` so the hook and the command cannot
drift; `/standup --json` output is unchanged. The hook reads only the changelog
tail and parses only lines naming the target file: about 0.17 s on an 80 MB
changelog with a 24-hour window. Disable with `CARTOGRAPHER_COLLISION_CHECK=0`.

### feat(remember)!: retire `/focus`; orientation moves into `/remember --project`

Claude Code 2.1.269 ships a built-in `/focus` view, which shadows a skill of
the same name, so typing `/focus` no longer reached this one. Rather than
rename a lightly used command (68 typed invocations, almost all in April;
13 `focus` search calls against 242 `remember`), orientation becomes a mode of
`/remember`: a project and no question runs the recency search plus the
`--related` and `--maneuvers` lenses. `skills/focus` remains as a pointer stub
for one release so older instructions and other agents are redirected rather
than broken. The telemetry purpose stays `focus` so orientation calls remain
comparable across the change, and `CARTOGRAPHER_FOCUS_ON_START` keeps its name;
its hook and the Turbo session-start note now point to `/remember`.

### feat(turbo): default on for 16 GB+ machines via /carto; idle exit below that

`/carto` now runs `cartographer-turbo.js enable --if-recommended`, which turns
Turbo on only with 16 GB+ RAM and a memory estimate within 8% of it, and
otherwise reports the estimate without changing anything. The estimate is
2.6 KB per log row, measured against a live service. On machines under 16 GB a
service exits after 30 idle minutes unless `turbo.idle_minutes` says otherwise;
an open Explorer stream counts as activity. `status` reports the memory plan and
the effective idle window.

## 0.7.9 — 2026-09-23

### feat(registry): ship no aliases; add `bootstrap-project-registry.js --update`

The shipped `project-registry.json` is empty: a project list describes one
person's machine and does nothing for anyone else. Users derive their own with
`bootstrap-project-registry.js`, and `--update` now keeps it current by adding
only project names absent from a recorded `_known` list, so hand edits and
deliberate removals survive. The personal Hermes/FrakBot wrapper left the repo;
`cartographer-pulse.sh` remains the supported entry point for scheduled feeds.
`build-demo-data.js` reads private name replacements from a local
`~/.config/session-cartographer/demo-sanitize.json` instead of listing them.

### docs: remove the maintainer's project names, research tracks, and identity

Examples, fixtures, comments, and specs use synthetic project names. Behavior is
unchanged.

### feat(investigate): recall past diagnoses and close the loop

`/investigate` no longer prescribes a debugging procedure. It recalls earlier
investigations and their outcomes for the symptom or files, records the new
hypothesis, and closes it later as confirmed, refuted, or abandoned. Writes go
through `scripts/record-investigation.sh`, which replaces the inline jq block
that agents paraphrased into incompatible record shapes. Closing events are
`investigation_outcome` records that name the original event id.

### docs: remove maintainer-specific examples from shipped skills

Shipped skills and docs no longer carry a real session digest, a home-network
address, or maintainer anecdotes; synthetic examples replace them.

### docs(readme): lead with Turbo's measured speed; mark the Memory Desk alpha

Turbo's section now opens with the recall latency and its memory cost, and the
Memory Desk has its own section labeled alpha. The grep comparison was
re-measured on the current 16 GB, ~150,000-event corpus with a Turbo column
(mean 0.31 s Turbo, 12.42 s portable, 2.34 s grep) and is reproducible with
`scripts/bench-grep-vs-turbo.sh`. The March claim that the portable path beats
grep no longer holds on this corpus and was removed.

### fix(standup): scope --project files by repository root

`--project` matched any path segment, so a subdirectory sharing a project's
name joined that project's view. It now uses the file's nearest repository root,
the same rule the hooks use to name projects.

### refactor(memory): one definition of the Codex stale-id list

The stale-id path is shared by the importer, profile, and Explorer/Turbo search,
and a test pins the shell search's copy. Turbo caches the list between queries.

## 0.7.8 — 2026-09-23

### docs(landscape): add Michael Albers's claude-memory-context

The related-project survey now includes its write-forward memory structure,
session handoffs, verified savestates, and decision lifecycle as a complementary
reference for Cartographer's native-memory migration.

### feat(memory): import curated Codex memory with revision-aware recall

The native Codex registry, overview, and rollout summaries can now be imported
as versioned events without editing Codex's source files. Repeated imports append
only changed or removed entries. CLI and API search suppress superseded event
IDs before ranking, and the standing profile includes current Codex preference
context. The semantic leg is optional and refreshed explicitly with `--index`;
the importer does not watch source files. A migration guide covers existing
installations and a detached Turbo process.

### fix(standup): scope recent evidence and identify Codex worktrees

Commit attribution now respects `--since`. Project scoping retains file edits
logged from the workspace root, and Codex worktree edits are paired with their
main checkout only when Git verifies the common directory. Unmapped worktrees
are counted rather than guessed. Displayed session IDs expand when eight
characters collide, and the documentation describes logged activity without
claiming process liveness. A separate shared-goal briefing remains a plan.

### fix(turbo): a server cannot outlive its record

Six `turbo-server.js` processes were found on 2026-09-13 reparented to launchd,
each holding a port, up to nine days old, none of them the managed service.
Three came from runs of `turbo-external-reuse.test.js` on 2026-09-08 in the
minute before that test was changed to use an empty corpus, at the moment
loading the live corpus took longer than the controller's 5 s readiness
budget. The chain: `start` spawned the server detached, wrote the pid record,
timed out and threw without signalling the child; the test's cleanup ran
`stop`, which refused because the ownership handshake needs the ready file the
child had not written yet; the test removed the state dir; the child finished
loading, recreated the dir on publish, bound the now-free port, and ran with no
record anywhere. The other three were hand-started scratch servers from the
TESTING.md recipe that nobody killed.

Two layers. The controller now reaps the child it spawned when readiness times
out — SIGTERM, then SIGKILL after two seconds, because a stopped or blocked
child has SIGTERM queued behind it — and removes the pid record before
reporting the failure. The server treats its ready file as a lease: every two
seconds, and on every publish, it checks that its state dir exists and that
`ready.json` is present and names its own pid, and exits otherwise; it no
longer recreates a state dir removed under it. A replacement server writing
its own pid reads the same way as a deletion, which also closes the window
where an old server outlives `stop`'s three-second wait. An HTTP ready update
checks the initial lease before writing, so it cannot recreate a ready file
removed between startup and the listen callback. The TESTING.md scratch recipe
gains its own state dir and a `kill`. The regression test replays the timeout
by freezing a child before its first ready publish.

## 0.7.7 — 2026-09-13

### fix(hooks): catch variable-bound python writes when the command carries an incidental `>`

`bash_written_paths()` harvests write targets from redirects, `sed -i`, `tee`,
and python `open(…, 'w')`, and falls back to the variable-bound shape
(`p='f.md'` … `open(p,'w')`) only when the explicit harvest found nothing. That
gate read the RAW harvest, before filtering. Two incidental things fill the raw
list with junk the filter then discards: a `<project>` placeholder inside the
quoted content, which the redirect harvester reads as `>` plus a bare backtick,
and a `2>/dev/null` anywhere in the compound command, which harvests
`/dev/null`. Either skipped the fallback, the filter emptied the list, and a
real edit logged as `Ran:`. Measured on session 24b90edb, 2026-09-13: two
`p='/Users/andyed/CLAUDE.md' … open(p,'w')` heredocs logged as `Ran:` while a
third of the same shape, with no stray `>`, logged as `Modified:`, so the Memory
Desk file review reported the first two edits as never recorded. The gate now
reads the filtered set, the filter is factored into `bash_filter_paths()`, and a
quoted `scheme://` URL in the content is no longer reported as a path. The
unit test replays both shapes and checks that a genuine `cat > t.test.js`
target still suppresses the content harvest.

### docs(standup): list the peer view everywhere the other skills are listed

`/standup` shipped with a README entry and a paste-in CLAUDE.md snippet, but
the repository's own CLAUDE.md — the architecture tree, the skill bullets, the
scripts inventory, and the plugin skills list — still described a six-skill
plugin, and the manifest description named three skills. A reader orienting on
the repo through its CLAUDE.md, which is what `/focus` and every new session
do, would not learn the peer view exists. All four places now carry it, along
with `cartographer-standup.js` and `non-projects.js`. The skill's reporting
guidance also says to hand the operator a Memory Desk permalink for a peer
session instead of a bare session id, cross-referencing the grammar now in the
`/carto` skill.

### docs(carto): document the Memory Desk permalink grammar for agents

The desk has been permalink-first since 0.7.x, but the only description of the
URL grammar was a prose paragraph and a six-row table in the README, and the
`/carto` skill — the one place an agent reads before opening the Explorer for a
human — said nothing about links at all. So agents described sessions instead of
handing over a URL. The skill now carries the full parameter table transcribed
from `normalizeMemoryRoute()` (values, defaults, what each requires) plus
shell recipes for the four links an agent actually needs: its own thread, a
bounded file review, a compare view, and a replayed window. Two constraints are
spelled out because both fail silently: `file` resolves only inside the corpus
root, and only for edits the hook logged as `Modified:` — a heredoc write logged
as `Ran:` produces "not recorded as edited", not a diff.

### fix(backfill): recognise commits the hook already logged

`backfill-git-history.sh` deduped on its own `git-<short_hash>` event ids, but
`hooks/log-tool-use.sh` mints `evt-<random>`, so the check never matched a
hook-written commit and the documented recovery run duplicated every commit
already in the log. Measured on 2026-09-13: of the five commits a `--limit 5`
run over this repository would have imported, three were already present under
`evt-` ids. It now also keys on the commit hash carried in the summary, which is
writer-independent. Used immediately afterwards to recover `f1f7a5a` and
`db9b934`, the two commits the `cd` defect above had swallowed.

`cartographer-standup.js --commit` renders a backfilled row honestly: git
history carries no session, so it says so rather than printing `undefined`, and
it no longer counts sibling commits by matching one absent session id against
another — which would have gathered every unattributed commit into one phantom.

### fix(hooks): stop dropping commits made after a `cd`, and read the sha from the repo

Two defects in `hooks/log-tool-use.sh` made a real commit invisible to the
corpus, and neither errored.

`bash_is_noise()` stripped `cd X && Y` hops — the 2026-08-28 fix — but only the
`&&` form. `COMMAND` is newline-flattened before the filter runs, so
`cd repo\ngit commit …` arrived as `cd repo git commit …`, matched the bare
`cd\ *` pattern, and the hook exited 0 with the commit inside it. Test runs and
pushes written the same way went the same way. Measured: this repository's own
`f1f7a5a` and `db9b934` were absent from `changelog.jsonl`, so
`cartographer-standup.js --commit db9b934` could not attribute the commit that
shipped it, and the session digest reported 16 bash calls against far more
actually run. Hops separated by a newline or a `;` are now stripped too;
whichever separator appears first wins, or `cd a; b && c` would strip past the
semicolon.

The hash and subject were scraped from the Bash tool's stdout. `git commit -q`
prints nothing, so `COMMIT_MSG` came out empty and the conventional-commit
classifier fell through to `other` — and since `TYPE="git_commit"` is gated on a
non-empty `COMMIT_HASH`, a quiet commit with no hash anywhere in stdout produced
no commit row at all. The hook is `PostToolUse`, so HEAD already carries the
commit: it now reads `rev-parse HEAD` and `log -1 --format=%s` and keeps the
scrape only as a fallback.

Reading HEAD needs a guard, because `git commit` also appears in a command that
failed, or never meant to commit. Freshness alone is not enough — a failed
retry seconds after a real commit leaves HEAD looking equally new — so a commit
is recorded only when HEAD is under two minutes old *and* its sha is not already
in the log. An amend gets a different sha and is correctly recorded again.

Nine tests in `tests/unit/log-tool-use-git-commit.test.js`, each reverted and
verified to fail against the defect it covers. Pre-fix corpus history
under-counts commits for any session that used this command style;
`scripts/backfill-git-history.sh --project <name> --limit N` recovers them.

### feat(standup): report concurrent sessions and the files they contend for

`/focus` answers what happened in a project. Nothing answered who else is in it
right now, which is the question that costs time when three to five sessions run
at once: a commit lands underneath you, or two sessions edit one file and
neither knows. `scripts/cartographer-standup.js` groups the events the hooks
already write by session instead of by project — no new capture — and reports
each session's projects, idle time, span and commits, with subjects recovered
from git for the ones `git commit -q` blanked. `--commit <sha>` names the
session behind a commit, and `--project` scopes the roster and the contention
list alike.

CONTENTION is the load-bearing section and every way it fails is silent, so four
things are asserted rather than assumed. A file's identity is its path, so
`isNonProject()` does not filter the file list — it judges cwd-derived project
*labels*, and applying it there hid every collision between sessions running
from the workspace root, which is how these sessions most often overlap.
Sentinel session ids are counted, never grouped: `"unknown"` is truthy and equal
to itself, so a bare `if (!id)` fused every unattributed event, across
providers, into one phantom session that appeared to collide with everybody. A
worktree edit and a main-checkout edit of one repo file collapse to one entry,
because agent control rooms put a worktree behind every task and path-only
keying made the emerging default collision invisible. Unresolved edit candidates
are reported in a `NOT COUNTED` footer rather than dropped, since a silent miss
and a clean workspace otherwise print identically.

Edit summaries are parsed by `scripts/edit-paths.js` rather than a local regex;
switching to the shared parser doubled detected file contention on the live
corpus, three files to six. Eleven tests, each verified to fail against the
defect it was written for.

### feat(memory): group the artifact trail by document

The Artifacts depth listed every file of every thread in thread order, so the
same TODO.md appeared once per session (13 times in a live 7-day window holding
670 files, 149 of them Markdown across 46 threads). `groupArtifacts()` folds the
desk's scoped threads into one row per path, documents ahead of code and newest
edit first, each carrying the threads that touched it. A row opens the newest
thread's session-bounded review; a multi-thread row's count zooms to those
threads as the selected cohort, the same move the project summary already makes.
`kind=md` is a permalinked Documents toggle. At this depth the find box narrows
files as well as threads, so `.md` no longer lists every file of every thread
that happens to own a document.

### feat(memory): bound file review diffs by the session and add a split view

The file review's diff was HEAD against the working tree, which answered "what
is uncommitted right now" while the panel asked "what did this session change".
Every review now carries a range: base is the last commit at or before the
session's first recorded event, head is the last commit within two minutes of
its final event when that commit changed the file and the session has left the
field, otherwise the working tree. The range is folded over the session's whole
life in the warm corpus, not the desk's window. Both ends are named with commit,
subject and time, and the review lists the ways the range can mislead (file
absent at base, untracked, later commits, uncommitted work past the bounded
head, a working tree standing in for a session that committed nothing).
`sessionBounds()` is exported; the fixture proves a commit after the session
does not leak into its diff.

Split is the default layout, rendered by `@git-diff-view/react` from the
server's git hunks plus both full texts, loaded as its own chunk so the entry
bundle does not carry highlight.js. Syntax colouring stays off; every readable
pairing in the re-skin is computed at or above 8:1 and recorded in
`split-diff.css`. `diff=unified` in the permalink selects the existing
dependency-free table, which is also the fallback if the split chunk fails.

### feat(explorer): surface and contain recoverable failures

The timeline now distinguishes a live EventSource connection from its initial
connection, automatic retry, and closed states. Each heavyweight route has its
own recovery boundary, so a render failure cannot blank the Explorer shell.
Transcript text loads independently from optional analysis, with typed missing,
blocked, empty, and unreadable states plus in-place retry. The `/carto` launch
path now verifies readable entry files, installed packages, and the Vite binary
before starting a background server. Because tabs stay mounted behind a
`hidden` class, each boundary is keyed to the active tab, so returning to a
crashed view gives it a fresh attempt instead of the stale error screen. Readable
text in these new surfaces sits at or above 8:1 against its own background, via a
`muted` theme token carrying the existing `--internals-muted` value.

### feat(explorer): attribute every view to its producing agent

Timeline, search, session, transcript, and working-memory views now share one
provider normalization path. Claude and Codex sessions retain their identities
through transcript enrichment, carry consistent badges, and can be filtered by
agent without turning unresolved provider sentinels into a third agent.

### feat(memory): make the work desk navigable across time and views

Memory now projects explicit windows from 1 hour through 90 days, keeps the
selected duration consistent across state, session, and file endpoints, and
preserves the whole-corpus bounds separately from the selected interval. Wider
windows use bounded transcript enrichment, byte-budgeted caches, and bounded
Field layout/connection work rather than truncating sessions to the daily
transport budget.

Search, work filters, catch-up state, paging, sort order, responsive focus,
primary brushing, camera position, and comparison axes are canonical browser
history. Back, Forward, reload, and Copy link restore the same desk. A transient
secondary brush exposes a selected thread's connected neighbour across Field,
Wake, and Compare without changing the primary selection or permalink. Chart
readouts now overlay the drawing instead of moving marks, and the compact desk
keeps its task-first layout on phone, laptop, and desktop.

### fix(digest): resolve edited files from one parser

Memory and `session-digest.js` now share `scripts/edit-paths.js` for the hook's
single-file and comma-separated `(via bash)` summary forms. Each consumer keeps
its own security boundary: Memory serves only real files inside the corpus,
while the digest may name real files elsewhere. Loose shell-detector candidates
such as `errors.push` are excluded and counted as unresolved instead of becoming
fabricated hottest-file entries.

## 0.7.6 — 2026-09-11

### fix(ci): install Explorer dependencies before the unit suite

The `test` job checked out and ran `node --test` with no install step of any
kind. That was survivable until the API moved into `explorer/server/app.js`:
`watcher-duplicate-events.test.js` imports it, `app.js` imports express, and the
job has no `explorer/node_modules`. The suite went red on every run while
passing for every developer, because a developer has those modules on disk
already — the failure was invisible exactly where it was introduced.

### feat(demo): serve the working-memory field from static fixtures

The memory and Internals tabs were switched off in demo mode, and the reason was
structural: `WorkingMemory` called `window.fetch` directly rather than going
through `apiFetch`, so its five routes never reached `src/demo.js` and would
have 404'd against the GH Pages host with no server there to notice. Memory now
crosses the same boundary as every other view; Internals stays out, since it
reports on a running service.

The field is derived, not snapshotted. `projectMemory()` is a pure fold over an
event array and `demo/sessions.json` already ships 14 sanitized sessions with
nested events, so `scripts/build-demo-memory.mjs` flattens those, pins the
busiest 24-hour window, and runs the real `projectMemory` + `enrichMemory` with a
transcript reader that always declines — the same no-transcript path production
takes. No live API is read and no new scrubbing is introduced, because there is
no new source.

The fixture publishes the comparison axes it can actually plot (`edit`, `commit`,
`events`) and the UI removes the rest. Tokens need transcripts, files need path
resolution, research is zero in that window; all four would have drawn a flat
line at zero, which reads as a measurement rather than as absent data.
Regenerating a denser corpus lights them up without a second edit.

Two defects surfaced. Filtering the axis list made `render()` assign a `state.y`
no option carried, which sets `selectedIndex` to -1 and left the compare readout
dereferencing an empty `selectedOptions` — reachable on the live path from a
permalink alone (`?y=files` against a corpus with no files), so the clamp now
derives the legal set from the surviving options. And landing on `/memory`
autofocused search, whose demo query list opened directly over the field.

`explorer/public/demo/` is gitignored and nothing populated it, so a clean
checkout built a demo with no fixtures at all and exited 0. The builder now
mirrors the tracked `demo/` tree into it. `tests/browser/demo-memory.cjs` covers
the static path that `memory-entry.cjs` deliberately strips: it fails on a blank
instrument rather than only on an error, and treats any `/api/*` request that
reaches the network as a hole in the static layer.

### fix(skills): file worktree sessions under the parent repo

The 0.7 hook fix covered the hooks only. `/wrapup`, `/investigate` and
`/trustmap` each carried their own `basename $(git rev-parse --show-toplevel)`
and kept writing phantom projects into `session-milestones.jsonl` — the log
`/remember` most depends on. On the development corpus `changelog.jsonl` and
`tool-use-log.jsonl` had been clean since August while milestones were still
arriving misattributed in September, one of them carrying project
`confident-yalow-e1cdc6` beside a digest reading `{widget-web: 118}`,
because the digest is built from hook events and the project field was not.

Skills are markdown and cannot source a shell library, so
`scripts/cartographer-project.sh` now exposes `cartographer_project()` on the
command line: one definition, two consumers. Hooks keep sourcing the function
directly — they run on every tool call and a fork per event is not free. The
wrapper exits non-zero with empty stdout when `common.sh` is unreachable, so a
caller falls back deliberately instead of recording a guess.

This matters more as agent control rooms (Tessera, Kangentic) put a git worktree
behind every task. Repair for already-written events remains
`scripts/migrate-project-attribution.js`, and it stays time-sensitive: it
resolves each recorded cwd through git, so a pruned worktree is unrecoverable.

### fix(explorer): keep the whole app available from either UI launch

The UI host now mounts the canonical Explorer APIs for timeline, search,
sessions, transcripts, and live event streaming. Those routes work with Turbo
off or running; they no longer proxy to headless Turbo endpoints that return
404. Both `npm run dev` and `npm run memory` launch the complete web app without
contending for Turbo's API port. Browser regression covers the full navigation
flow, and release bundles include the transcript-analysis modules.

### Release preparation

Git backfill now preserves full author names as single patterns, ignores empty
comma-separated entries, and rejects empty or missing explicit author values.
Regression tests exercise the actual shell ingest path against unrelated authors.
Adoption guidance now matches the owner filter, user-owned registry, and Turbo
service checks.

Release metadata is aligned and checked before packaging. CI and the release
workflow now require the Explorer build and working-memory browser regression on
Node 22 in addition to the unit and package checks.

Explorer's locked dependencies include compatible security updates for Vite,
PostCSS, shell-quote, and other affected packages. The dependency audit reports
no known vulnerabilities for the updated root and Explorer lockfiles.

### feat(explorer): live working memory with session and file permalinks

The memory tab adds Field, Wake, and Compare views over recorded sessions, with
transcript-backed token usage, activity traces, recent observations, and verified
edited files. Missing or partial usage is explicit. File review shows current
workspace contents and the working-tree diff from HEAD.

Session and file links preserve the selected view, comparison axes, review mode,
and replay window. Older session links reopen their last recorded window. The
UI can start or enable the managed Turbo service, and Internals remains available
through the UI host even when headless Turbo is stopped.

## 0.7.5 — 2026-09-08 (development snapshot)

This version was used locally and was not published as a GitHub release. The
changes below are included in the 0.7.6 candidate.

### feat(facts): a second question class on the warm corpus

`/api/recall` answers "which records are relevant to this phrase." The new
`POST /api/facts` answers "what is true of the corpus" — `census`, `tempo` and
`delta`. Conflating the two is not a tuning problem: a ranker handed a census
question has no relevance gradient to work with, so it returns *an* answer with
no way for the caller to know it is not *the* answer. The daily scheduled-agent pulse
surfaced **1 event** from a 24h window that deterministically held **736 events,
22 sessions and 20 commits across four repositories**.

**There are no indexes, and that was a measurement.** Loading 127k events costs
881 ms, which the warm service already pays and holds. Once resident, a full
linear fold costs **12–22 ms** — under 2% of the 1500 ms request budget. So
these are folds: nothing precomputed, nothing to invalidate, and a new fact is a
new function rather than a data structure plus its maintenance path. The
measured exception is extraction-derived facts (file paths out of free-text
summaries, 368 ms), which is also where the extraction heuristic is most likely
to be confidently wrong; those verbs are deliberately absent.

Every bucket carries a bounded sample of the `event_id`s it counted, so any
number can be checked with `--get`. A deterministic answer that is silently
wrong is strictly worse than a slow one.

`delta` is a cursor over per-log byte offsets, never a `since` timestamp. The
corpus is backfilled — `backfill-git-history.sh`, `retro-index.sh` and
`catch-up-transcripts.sh` append events dated months in the past — so
"timestamped after my last run" and "arrived since my last run" are different
sets and only the second means *new*. Arrival order lives in the append-only
logs, not in the resident array. `logPositions()`/`readAppended()` in
`jsonl.js` reuse the existing `boundaryHash`, because a byte offset alone cannot
tell an append from an in-place repair — and a repair that also grows the file
makes the shifted tail read as fresh appends. A rewritten source is reported as
`stale` and contributes nothing rather than yielding a confident wrong diff.

`tempo` never scores the current UTC day: comparing a two-hour day against
complete days reads as a collapse every time. Its z-score regime is labelled
rather than trusted, because daily event counts are Poisson-ish and
zero-inflated — real runs produced z=44.9 against a baseline mean of 2.33 and
z=60.1 against 0.22. Insufficient history and zero variance return `null` with a
stated reason, never `0.0`.

The endpoint writes nothing: `cartographer-search.sh` remains the single writer
of served and access telemetry, and facts are projections of the five logs
rather than events, so no sixth log appears.

`scripts/cartographer-facts.js` is the client, with `--cursor-file` for
scheduled callers; it advances the stored cursor only after a successful render.

### feat(pulse): counted ground truth above the relevance feed

`scripts/cartographer-pulse.sh` keeps the existing search section and puts a
census above it — totals, per-project and per-type tables, every commit in the
window with its `event_id`, and tempo. The halves are labelled because they are
different kinds of claim: the counted section is exhaustive within its window
and scope, the search section is a relevance sample and must never be quoted as
a count. It fails closed on `--projects` like the feed, and reports how many
events fell *outside* the requested scope so the blind spot is visible. With the
facts service unreachable it degrades to the search section and says so, rather
than emitting a zeroed census that reads as a quiet day.

The scheduled agent's project allowlist was widened for the first time against evidence rather
than recall: a 30-day census diffed against the registry-expanded list. The
blind spot went from 232 events across six projects to 93 across two, both
deliberate.

### refactor(search): one definition of project scope

The substring rule that decides whether an event is in scope moves to
`explorer/server/project-filter.js`; `bm25.js` re-exports it. A census and a
recall over the same `--project` that disagreed about scope would each be
defensible with no way to tell which described the corpus the caller asked for.
`resolveProjectValues()` resolves a spec against the project values actually
present, because six of the ten aliases in `project-registry.json` have members
that are not substrings of their key (`devtools` → `session-cartographer`) and
the API expands the registry nowhere — so a caller naming a real alias could
match nothing and be handed a zero that reads as "nothing happened". Responses
now carry `project_scope`, which distinguishes an unresolved scope from a quiet
one.

### fix(turbo): an HTTP status is an answer, not an outage

Both Turbo clients treated a 4xx as a transport failure and retried on the file
spool — which reaches the same process, so it re-ran the rejection and reported
a composite error naming two failures that did not exist. Only an unreachable
service now earns the second attempt. The recall path keeps exit 75, because
`cartographer-search.sh` reads any non-zero exit as "fall back to the portable
CLI" and on a contract rejection that fallback is still correct.


### feat(recall): prompt history becomes a searchable source

`~/.claude/history.jsonl` holds 18,103 prompts — what was asked, not what the
agent did. Sampling showed a meaningful share have no surviving transcript,
because Claude Code expires transcripts after ~30 days while the prompt history
does not expire; the full projection puts that at **2,542 records for which
this log is the only surviving copy**. None of it was reachable: the rows carry
no `event_id`, so both scorers minted a positional key that changed on every
append, and the recall contract rejected them outright.

`scripts/build-prompt-history.js` projects them into
`$CARTOGRAPHER_DEV_DIR/prompt-history.jsonl`, a log we own, with the same
content-derived stable ids as the migration — `explorer/server/stable-event-id.js`
is now shared by both, so the two agree by construction rather than by
convention. It never writes to Claude Code's file. 17,493 rows projected;
568 bare slash commands (`/clear`, `/exit`, `/compact`) are dropped as interface
actions rather than intent, and `/wrapup` with them, since the synthesis it
produces is already in the log at salience 0.9.

Both engines read it as a first-class fused source (`prompts`) with its own RRF
ladder, `--get` resolves its ids, and `--touch` works unchanged. The Explorer's
former `claude-history` entry is removed, so the same prompts are not indexed
twice under two identities; that also deleted a transcript-path derivation that
was measurably dead for the other four logs (15,456 resolutions, all from
claude-history, 0 elsewhere) and ~19k `statSync` calls from startup, cutting
cold load from 913 ms to 770 ms. Net index cost: −51 events, +1.3 MB heap.

**Known limitation.** Default ranking is strongly recency-biased by design
(Ebbinghaus decay at a ~30-day half-life, compounded by promote-on-reuse), so
archival prompts do not surface on an unscoped query even on a near-exact text
match — reach them with `--since`/`--before`, where they rank first. Fixing the
balance is a ranking change that deserves its own measurement rather than a
guess; the evidence is recorded in TODO.md.

### feat(recall): Codex prompt history deliberately not added

Measured before building: 48 of 50 sampled Codex prompts are already
recoverable from archived rollouts and already turn-indexed, and none had a
missing rollout. Codex archives sessions permanently where Claude Code expires
transcripts, so the apparent asymmetry is retention behaviour, not indexing
bias. An ingester for its 888 prompts would have been 96% duplication.


### fix(recall): bound both ladders at the source, and scope them alike

Two follow-ons to the windowing fix below, found by asking why the semantic
ladder was still thin on a 24-hour query after it.

**The window reached the semantic leg too late.** `windowed()` trims the pool
Qdrant *returns*, but the query still asked for the globally-nearest
FUSION_DEPTH points, and a 24h slice of a 109k-point collection matched **0 of
500** before the trim ever ran. The bound is now a `timestamp` range clause in
the query itself. Qdrant 1.12.1 compares RFC3339 payload strings
chronologically rather than lexicographically — an offset stamp
`2026-03-17T21:21:04-07:00` is included by `gte 2026-03-18T00:00:00Z` and
excluded by `lt` on the same boundary, where a string compare does the
opposite — which is load-bearing because ~2% of payloads carry non-UTC offsets.
No payload index is required. A 4xx retries once without the range so a server
without datetime range support degrades to the previous behaviour instead of
losing the leg; a 5xx does not, since a retry only costs latency.

**The portable keyword ladder had the original defect, unfixed.**
`bm25-search.awk` truncates to `max_results` in its `END` block, so the CLI
ranked globally and windowed afterwards exactly as the warm path used to. The
filter now runs in pass 2 only: pass 1 owns `ndocs`, `avgdl` and `df`, and
narrowing it would recompute IDF over a handful of documents and silently
reweight every surviving score. Filtering pass 2 alone leaves in-window scores
byte-identical to an unwindowed run.

**The two ladders disagreed about what `--project` meant.** `semanticSearch`
scoped by Qdrant `match: {value}` — exact equality — while both BM25 scorers
use the case-insensitive substring of `projectMatcher`, and `/api/recall` does
no registry expansion. A bare `--project widget` therefore reached the
keyword ladder as its whole family and the semantic ladder as a literal string
matching nothing: **0 semantic rows against 9,943 indexed points**. The spec now
resolves against the project values actually present and emits a `should` of
exact matches, keeping substring semantics in one query. Post-filtering was
rejected — it reintroduces the truncation starvation. Resolution costs 8–13 ms
over 128k resident docs, under 1% of the warm request budget, so it is computed
per call rather than cached, which would trade that for a staleness bug the
first time a new project appears. The CLI escaped this only because the registry
expands *registered* aliases first; unregistered prefixes (`--project psycho`)
measured 20 keyword rows and 0 semantic.

| Measurement | Before | After |
|---|---:|---:|
| Feed query, 24 h | 1 row | 24 rows |
| `commit fix`, 24 h (API, controlled) | 4 | 37 |
| `test`, 7 d (in-window keyword rows kept) | 74 | 1,096 |
| `--project widget` (semantic rows) | 0 | 104 |
| Semantic stage, 24 h | 180–480 ms | 80–90 ms |

Keyword stage is unchanged at ~27 ms, and unscoped, unwindowed queries are
byte-identical. Eighteen tests across four files; each fixture asserts that it
genuinely exercises the defect — that in-window rows really do fall past rank
500, and that every project the keyword ladder accepts is one the semantic
filter names — so none can pass against the broken code.

### fix(recall): window before truncating, and never serve an id-less result

Time windows were applied after the FUSION_DEPTH truncation. Ranking is global,
so slicing first kept the 500 best matches across all time and only then asked
which fell inside `--since`. On a six-figure corpus a 24-hour window is barely
1% of events, so nearly everything recent was discarded before the filter saw
it: the daily pulse returned 2 results where the portable path returned 15,
against 1,641 changelog rows written in that same window. Windowing the keyword
and semantic pools before truncation takes it to 22.

Separately, `bm25.js` synthesizes a document id for an event that has none, so
id-less rows were indexed and returned with no `event_id` on the event itself.
One of them in a result set failed response validation at the client, which
discarded the entire answer and fell back to the ~11 s portable search. Such a
result also cannot be fetched, touched, or threaded, so it could never complete
the workflow it interrupted. They are dropped at the boundary that owns the
contract and counted in `meta.unidentified_count`.

### feat(migration): stable event_ids for the id-less backfilled records

Two backfills predating the id convention left 2,441 rows in the searched logs
with no `event_id` — 1,630 in research-log, 810 in session-milestones, 1 in
changelog. Both engines papered over it with a positional synthetic key
(`src "-" source_fnr` in the awk, `${_source}-${docs.size}` in bm25.js), so one
record answered to a different id on each engine and to a different id again
after the next append. Nothing can be fetched, touched, or threaded through an
id that moves.

`scripts/backfill-event-ids.js` assigns a sha256 prefix over each record's own
content and timestamp: identical on both engines, stable across appends,
idempotent, and deterministic for byte-identical records. It backs up first,
re-reads at the last moment to carry concurrent appends across, refuses to
proceed if the file changed in a way that is not an append, and verifies the
post-write row count. Applied: 2,441 assigned, 0 rows lost.

## 0.7.4 — 2026-09-05

### fix(hooks): stop writing session-end rows that record nothing

A session end with no reachable transcript AND no logged activity has nothing
recallable behind it — no conversation to open, no events to join to, nothing
indexed — yet it ranked in `/remember` at salience 0.5 and diluted
`.carto/profile.md`. On a 15,000-row log there were **7,646 of them, 51% of the
whole file**, all from `session_end_other`.

The hook no longer writes that row. The activity check is what makes dropping
it safe rather than lossy: 79 rows had a dead transcript over real logged work —
a lost transcript on a genuine session — and those are kept. Only the
intersection of "nothing reachable" and "nothing done" is discarded, and only
for `session_end_*`, which is where the evidence is.

`scripts/prune-contentless-milestones.js` applies the identical predicate to
history. Logs only, deliberately: sampling 60 of the 7,647 removable ids found
0 indexed in Qdrant — the indexer already rejects them as contentless, which is
why they polluted the log and profile but never semantic search. A `--qdrant`
flag would have matched nothing and reported success. Dry run by default;
`--write` takes a dated `.bak` first.
The predicate is exported and unit-tested, and importing the module runs
nothing — an importing process with `--write` in its argv must not delete data
as a side effect of an `import`.

Guarded by `tests/unit/prune-contentless.test.js` — 7 cases, weighted toward
the keep side, since a predicate that widens by one clause silently eats the 79.

### fix(hooks): milestone rows now say whether their transcript is reachable

`log-session-milestones.sh` took `transcript_path` verbatim from the host
payload. That is the path the host *intends* for the session, not a promise the
file was ever written — and sessions ending with reason `other` routinely leave
no transcript at all.

Measured on a 15,000-row log: **7,959 rows (53%) pointed at a nonexistent file**,
and `session_end_other` alone accounted for 7,723 of them — 97% of every broken
link, at a 78% failure rate for that one milestone type. Healthy types by
contrast: `session_wrapup` 2%, `turn_stop` 3%, `compaction_auto` 5%. `/wrapup`
resolves its path with `find` before recording it, which is why it stayed clean.

Each broken row also carried a `claude-history://` deeplink indistinguishable
from a working one until a human clicked it and got nothing.

Rows now carry `transcript_verified: true|false`, and a deeplink is minted only
when the path resolves. The intended path is still recorded when it does not —
it remains evidence of what the host meant — but it no longer masquerades as
something reachable. Existing rows are untouched; the log is append-only, and
absence of the field means "written before this check existed", not "verified".

Guarded by `tests/unit/transcript-verified.test.js` — 4 cases, all 4 failing
against the pre-fix hook.


### fix(turbo): the warm backend was unreachable for the callers that exist

Turbo was measurably fast and quietly unusable for the one caller that ran
every day. The recall contract capped `limit` at 100; `cartographer-feed.sh`
fans out across every active project and clamps its own limit to 200, so every
scheduled-agent daily pulse since Turbo shipped failed the contract and fell back to
the ~11 s portable search. Raising the ceiling exposed a second blocker on the
same path — `project` carries a pipe-delimited alternation of every expanded
alias, and the real allowlist packs to 576 characters against a 512-character
cap.

Neither was visible in telemetry, because `fallback_reason` recorded the class
(`turbo_unavailable`) and discarded the message. It now carries
`fallback_detail` alongside the stable class, which is the only reason the
second blocker was found on the first run rather than the second week.

The warm service also stopped answering from the wrong corpus. It is reached
by a fixed loopback port but indexes exactly one corpus, chosen when it
spawned, so a caller that set `CARTOGRAPHER_DEV_DIR` elsewhere was silently
served the shared one. `/api/recall/health` now reports `corpus_root`,
requests may assert it, and a mismatch is refused instead of answered.

`status` gained a `transport` line, and a sandbox-denied listen is reported as
`blocked` rather than `failed` — the file spool is a complete recall path, not
a broken server.

Measured on the real scheduled-agent feed: 12,386 ms via CLI fallback before,
1,915 ms through Turbo after, with no fallback recorded.

### fix(turbo): warm ranking ignored salience and fused one flat list

The portable fusion weights every RRF contribution by write-time salience
(`score = 1/(60+rank) * sal`) and fuses four independent source ladders. The
warm path did neither: one global deduplicated keyword list, `salience` read
nowhere in `explorer/server/`. Across five targeted queries the portable path
returned 2-6 milestone events each and the warm path returned 0-1 — the
deliberate material `/wrapup` exists to create was the material Turbo dropped.

Both halves were load-bearing. Salience alone recovered milestones on two of
five queries; per-source laddering on three of five. Backend agreement moved
from 2-8 of 15 to 6-12 of 15.

Exact parity remains an explicit non-goal, and some divergence is deliberate —
`jsonl.js` filters `milestone_agent_*` turn-completion noise that the portable
path still returns. A source class disappearing because the ranking never
modelled salience is a different thing: a defect.


### fix(recall): the warm index goes stale when history is rewritten

The Explorer/Turbo watcher tracked byte offsets and only ever read the tail. It
detected truncation, but an in-place rewrite of history was invisible: bytes
before the offset changed while the file also grew, so the shifted tail was read
as fresh appends and every already-indexed record silently kept its stale value.
repair-transcript-paths.js is exactly that shape of write, and a warm server
served pre-repair paths for hours afterwards with nothing to signal it.

`watchFiles` now fingerprints the 4 KB boundary region before the offset and
calls a new `onRewrite` handler when it changes; both the Explorer and
turbo-server reload the corpus and rebuild the index in response. It also takes
a `logFiles` override, matching `readAllEvents`, so the behaviour is testable
without env gymnastics.

### fix(turbo): stop refusing to manage a server from another install

`processLooksManaged` required the recorded `server_script` to equal the control
script's own sibling path, so a Turbo server started by the installed plugin
could not be stopped from the checkout — the operator was told it "is not the
managed Turbo server" when it plainly was, and had to kill the pid by hand. The
instance-token handshake is the authority; path equality only asserted that both
copies lived in the same directory. Matching on the script name keeps the
security property and drops the false negative. The refusal message now names
the recorded script and what to do instead.

### fix(turbo): stop contending with the Explorer for one port

The full Explorer is a strict superset of turbo-server — it serves the entire
recall contract plus every UI endpoint — and both bind the same port. Starting
Turbo headless first won the port and left the Explorer UI unstartable, so
`/carto` rendered a shell that 404'd on every data call. `start` now probes
`/api/recall/health` before spawning and reuses whatever already answers,
reporting `reused: "external"`. The Explorer, for its part, explains the
conflict and names the fix rather than printing a bare EADDRINUSE.

### fix(test): two suites depended on the environment they ran in

`hybridSearch` fuses BM25 over the index it is handed with a semantic leg
against a live Qdrant, so recall tests holding a six-event fixture had real
corpus ids fused into their assertions — passing wherever Qdrant was down and
failing wherever it was up. `CARTOGRAPHER_SEMANTIC=0` now opts the leg out
(read at call time, since ES imports are hoisted past a module-level const).
Separately, the global opt-in test built its env from `process.env` and set only
one provider's session variable per leg, so an inherited session id from the
surrounding agent won the resolution chain, both legs resolved to one session,
and delta serving suppressed the second result. All four session variables are
now stripped.

## 0.7.3 — 2026-09-02

### fix(recall): follow Codex sessions into the archive

Codex does not delete a finished session, it moves it from
`~/.codex/sessions/<y>/<m>/<d>/` into the flat `~/.codex/archived_sessions/`.
Every `transcript_path` the hooks stamp therefore went stale the moment a
session was archived, while the transcript itself stayed fully readable one
directory away. Nothing errored: `/remember` surfaced the event, the agent
stat'd the recorded path, found nothing, and reported the conversation as aged
out. Silent recall failure on data that was never gone.

`hooks/common.sh` already recognised the archive when detecting a provider; no
lookup path did. `CARTOGRAPHER_CODEX_ARCHIVED_DIR` now sits alongside the
sessions dir everywhere transcripts are scanned or served —
`cartographer-search.sh`, `retro-index.sh`, `trust-digest.js`, and the
Explorer's `transcriptRoots()`, whose boundary check had been rejecting every
archived path.

`scripts/resolve-transcript.sh` is the single resolver: recorded path, then
archive basename, then a session-id hunt across every store. The `remember`,
`investigate`, and `wrapup` skills used a bare `find ~/.codex/sessions`, which
missed every archived session; they now go through the resolver or search both
roots.

`--get` self-heals a stale path at display time, adding
`transcript_path_resolved` and `transcript_path_status: "archived"` rather than
rewriting the recorded value — the command promises the complete record, so the
original stays visible as provenance. Genuinely unrecoverable paths are marked
`"missing"` instead of silently resolving to something plausible.

### fix(recall): repair the paths already written

`scripts/repair-transcript-paths.js` rewrites the stale paths in bulk, dry-run
by default. On the development corpus it repaired 60,420 records across the four
event logs, taking resolvable transcript paths from 102,988 to 163,416.

The event logs are only half the corpus. Semantic results are served from Qdrant
payloads, which carry their own copy of `transcript_path`, so repairing the logs
alone left every semantic hit still pointing at the pre-archive path — 6,258
broken points across 253 sessions. `--qdrant` repairs that side under the same
policy: a path is rewritten only when it does not resolve and exactly one file
of that basename exists in the archive. Ambiguity is refused, and Claude paths
are never touched, because Claude Code deletes rather than archives and
rewriting one would be a fabrication.

The log pass re-stats each file before writing and refuses if it grew during the
run. Several concurrent agent sessions append to these logs continuously, and a
read-modify-write would otherwise drop anything written mid-pass.

## 0.7.2 — 2026-08-30

### feat(recall): one Turbo opt-in now covers Claude Code and Codex

Turbo Mode is available as an experimental global opt-in before its planned
0.8 graduation. `cartographer-turbo.js enable` writes one provider-neutral
setting, starts a zero-dependency warm recall service on demand, and makes
ordinary `/remember` queries from both agents use it. A private file transport
keeps that promise inside Codex sandboxes that cannot reach loopback HTTP;
failed warm requests still fall back once to the portable CLI. Exact fetch,
touch, thread, intent-only, and raw-transcript operations remain controls.

The new versioned `/api/recall` contract, backend-attributed served rows, and
`.carto/search-calls.jsonl` make the experiment measurable. `--no-turbo` is the
per-call escape hatch; `cartographer-turbo.js disable` opts out and stops the
managed process.

The new `/turbo` skill in Claude Code and `$session-cartographer:turbo` skill in
Codex expose `enable`, `status`, and `disable` without requiring users to locate
the installed plugin cache. Turbo is also named in both plugin descriptions and
the installation quickstart rather than being discoverable only in reference
documentation.

Enabled sessions now receive a small agent-only startup reminder to use
`remember` or `focus` when prior work matters, while explicitly self-contained
requests remain outside recall. The hook never runs a search and records one
deduplicated exposure receipt per session in `.carto/turbo-awareness.jsonl` for
later utility analysis.

### fix(wrapup): make durable logging and semantic indexing independently true

`index-event.sh` now distinguishes indexed, gate-rejected,
precondition-failed, and retryable service-failed outcomes. Authored wrapups
bypass the generic novelty gate, `record-wrapup.sh` returns separate durable
and semantic receipts, and successful indexing is reported only after exact
Qdrant readback. `wrapup-coverage.js` derives the completed/stale material
session denominator without pretending every short session needs synthesis.

## 0.7.1 — 2026-08-29

### fix(migration): events recorded in a worktree SUBDIRECTORY were not repaired

`migrate-project-attribution.js` only repointed a record when `project` equalled
`basename(cwd)`. But the hook it repairs derived the project from
`--show-toplevel`, which returns the worktree **root** however deep the working
directory was — so an event recorded in, say,
`…/worktrees/confident-yalow-e1cdc6/apps/capacitor/android` carried the worktree
name as its project and a much deeper `cwd`, and was silently skipped.

The signature check now also accepts a `project` matching the basename of the
cwd's own toplevel. Measured on the development corpus, the 0.7.0 migration left
18 recoverable events behind across 2 phantom projects.

The docstring already described the intended behaviour ("or of that cwd's own
toplevel"); only the implementation was narrower. Re-running the migration is
safe and idempotent — it picks up exactly the records the previous pass missed.

## 0.7.0 — 2026-08-29

### fix(hooks): sessions run in a worktree were filed under a throwaway name

Every hook derived the project the same way:

```
GIT_REPO=$(cd "$CWD" && git rev-parse --show-toplevel)
PROJECT=$(basename "$GIT_REPO")
```

Inside a git worktree `--show-toplevel` is the *worktree* directory, not the repo.
A session run in `pointbreak/.claude/worktrees/agent-a4b1610b7457c11fa` was therefore
filed under the project `agent-a4b1610b7457c11fa`. Claude Code creates those
worktrees automatically, so every one of them became a phantom project that owned
real history — history that never surfaced under a `/remember` scoped to the actual
repo, and that pointed at a dead path once the worktree was pruned.

`--git-common-dir` resolves to the main repo's `.git` from inside a worktree and
from the main tree alike, so its parent is the real project root. The new
`cartographer_project()` in `hooks/common.sh` — which every hook already sources —
replaces all seven derivation sites across five hooks, including the two `FILE_REPO`
variants in `log-tool-use.sh`.

Three guards, each of which a naive version gets wrong: git before 2.31 has no
`--path-format`, so there is a relative-path fallback; a bare repo (`repo.git`)
would resolve to the name of its *parent* directory, so only a common dir literally
named `.git` is trusted; and outside a repo it falls back to the cwd basename as
before.

### feat(migration): repoint events already filed under a worktree name

The fix above is write-time only. `scripts/migrate-project-attribution.js` repairs
what is already recorded, asking git to resolve each stored `cwd` back to its parent
repo and rewriting `project` in place with a `project_repointed_from` key so the edit
is visible. `cwd` and `git_branch` are accurate history and are left alone.

**Run it before any `git worktree prune`.** Resolution only answers while the
worktree directory still exists. On the development corpus this recovered 5,026
events across 36 phantom projects, while 670 more referenced worktrees that had
already been pruned and are unrecoverable.

```bash
node scripts/migrate-project-attribution.js            # dry run — reports, changes nothing
node scripts/migrate-project-attribution.js --apply
```

It backs up unconditionally before writing, carries across anything appended by a
concurrent session during the pass, and verifies by event-id *set* comparison rather
than line counts — a concurrent append can otherwise mask a loss that a count check
would pass. If any id goes missing it restores from the backup and exits nonzero.

It repoints only when `project` equals the basename of the recorded `cwd`, so events
whose project came from `log-tool-use`'s `FILE_REPO` branch are not collateral
damage. It is idempotent, and unparseable lines survive verbatim.

### perf(search): pass 1 gathered statistics for the whole corpus, not the query

`bm25-search.awk` populated `df[]` for every token in the corpus on every search,
so query cost scaled with corpus size rather than query size. Pass 1 now gathers
document frequencies only for the query's own tokens, and a byte-level grep pass
narrows pass 2 to rows containing at least one normalized query token before any
scoring or tokenization runs.

Guardrail tests were added for both this path and the Explorer's JSONL read, so a
future change that reintroduces a whole-corpus pass fails rather than merely
getting slower.

### feat(explorer): Internals, a system-observation surface

Where the Timeline explains the chronology and concurrency of human work, Internals
explains how the system itself behaved. The server side splits into `internals.js`,
a worker, and an aggregator so the read never blocks the API; the client gets a
`useStaleResource` hook so a slow aggregate degrades to stale data rather than to a
spinner. `docs/INTERNALS.md` describes the surface, and `docs/TURBO_MODE_SPEC.md`
is a draft spec for utility-first recall.

## 0.6.1 — 2026-08-29

### fix(indexing): hooks indexed whichever event landed last, not their own

Every hook wrote its event and then re-read the file to index it:

```
jq -n -c ... >> "$CHANGELOG"
tail -1 "$CHANGELOG" | "$INDEXER" &
```

With several agent sessions running against one workspace they all append to the
same `changelog.jsonl`, so the re-read is a race. Under a bounded reproduction —
60 writes against a concurrent writer — only 15 of the 60 `tail -1` reads
returned the writer's own event; the rest indexed a neighbouring session's event
and silently dropped their own.

The loss was invisible because `index-event.sh` also exits 0 when its novelty
gate rejects an event as too similar to an existing one. A dropped event and a
deliberately skipped duplicate are indistinguishable from outside, so nothing
ever surfaced.

Hooks, backfills, and the `/wrapup`, `/investigate`, and `/trustmap` skills now
pipe the event they just built. `docs/CUSTOM_HOOKS.md` is updated so the pattern
stops propagating into user-authored hooks. The same reproduction scores 20/20
after the change.

### fix(indexing): unify the Qdrant point ID and widen it past 32 bits

`index-event.sh` and `embed-events.js` derived point IDs with *different* hash
functions, despite a comment in the former claiming parity:

- `index-event.sh` — POSIX `cksum`, a 32-bit CRC
- `embed-events.js` — a djb2 variant truncated to 31 bits

Across 4,000 event IDs the two agreed zero times, so a collection written by both
paths was split across two incompatible key spaces: 89,646 points on one, 6,820
on the other. The same event indexed by different paths landed at different
points, and any ID-based lookup silently missed whichever half it was not built
for.

Both spaces were also too small. At 96k points a 32-bit space expects roughly one
birthday collision and a 31-bit space about two, and a collision is not an error —
Qdrant upserts, so one event silently overwrites an unrelated one. The corpus had
got there on luck: a sweep of all 87,949 distinct event IDs found zero actual
collisions against 0.90 expected.

Both writers now use the first 13 hex characters of SHA-256, a 52-bit value that
stays an exact JavaScript `Number` and is byte-identical between the shell and
Node implementations.

`scripts/migrate-point-ids.js` moves an existing collection onto the unified
scheme. Vectors are read back from Qdrant, so nothing is re-embedded. It defaults
to a dry run, reports the scheme breakdown and any collision in the new space, and
leaves points it cannot classify untouched. Run the upgrade before the migration
so new events land on the new scheme and are never orphaned.


### fix(metrics): record result-access order explicitly

Multi-result `--get` and `--touch` operations previously stamped every access
with the same second, and the fetch path grouped rows by event ID before writing
them. Any first- or last-access metric therefore depended on lexical or append
order rather than observed access order.

New access rows carry an `access_batch_id` and 1-based `access_ordinal` in the
caller's requested order. The explicit-use report now treats first-access MRR as
the primary compatibility `mrr` value and reports last-access MRR separately.
Historical same-time multi-result batches without ordinals are counted as
order-unknown instead of receiving an invented order. First and last MRR use
the same jointly ordered cohort so the values remain comparable; no-use calls
still contribute zero.

## 0.6.0 — 2026-08-29

### fix(hooks): the noise filter matched a compound command by its first token

`log-tool-use.sh` skipped noise with a prefix match:

```
case "$COMMAND" in
  ls*|cat\ *|echo\ *|pwd|cd\ *|which\ *|wc\ *|head\ *|tail\ *) exit 0 ;;
esac
```

In a multi-repo workspace nearly every command is `cd <repo> && <real work>`, and
that matches `cd\ *`. So the hook was dropping — not misclassifying, **dropping**
— the majority of a session's activity, keeping only the commands that happened
to start with a verb it did not recognise.

Three classes of loss, all silent:

- **Edits.** Under auto mode the harness prefers Bash over Edit/Write, so real
  edits arrive as `cd <repo> && python3 - <<PY …`, `sed -i`, or
  `cat > f <<EOF`. Measured on session `7c9b94b3`: ~1,050 lines changed across 11
  files, of which the log captured 4 file edits — all four of them Write-tool
  calls. `session-digest`'s `files` panel reported that fraction as the session.
- **Commits and pushes.** `cd <repo> && git commit` and `cd <repo> && git push`
  matched the same `cd\ *` arm and never reached the git-detection branch below
  it. The 3,398 `git_commit` events in the changelog are only those issued
  without a `cd` prefix.
- **`lsof`, `lsblk`, `lsattr`.** The `ls*` arm was unanchored.

Fixed on both axes:

- **Noise is now judged by what actually runs.** Leading `cd … &&` hops are
  stripped before the noise test, so `cd repo && ls` is still noise while
  `cd repo && python3 …` is not. `ls*` is anchored to `ls|ls *`.
- **Bash-as-editor is detected.** `>`/`>>` redirects (including heredoc writes),
  `sed -i`, `tee`, and python `open(path,'w'|'a')` now emit `tool_file_edit` with
  the resolved path, at the same 0.4 salience as an Edit/Write call, with the
  project re-resolved from the written file's repo. Devices (`/dev/*`), scratch
  (`/tmp`, `/private/tmp`), fd dups (`2>&1`), lockfiles and `node_modules` are
  excluded, so `npm test 2>&1 | tail -5` and `node build.js > /dev/null` stay
  `tool_bash`.

Ordering matters and is asserted: a write outranks the noise filter, because
`cat > src/f.js <<EOF` is both a real edit and a `cat `.

Known limitation: a command that writes a file whose *content* contains
write-shaped code (this fix's own test file, for instance) may list a secondary
path harvested from that content. The primary path — and therefore the project
attribution — is still the real target. Shell/JSON metacharacters and
extensionless tokens are filtered, so the earlier `Modified: {",{,src/app.js`
and `Modified: path` shapes no longer occur.

**Historical data is not recoverable** — dropped events were never written. The
corpus under-represents bash-driven work and `cd`-prefixed commits for every
session before this fix.

Detection reads the FULL command; only the summary is truncated to 500 chars. A
long heredoc puts its `open(p,'w')` well past that cap, so detecting against the
truncated copy missed precisely the largest edits — a real CHANGELOG.md rewrite
logged as `tool_bash` while a two-line one was caught.

Regression test: `tests/unit/log-tool-use-bash-edits.test.js` (9 cases; 4 fail
against the pre-fix hook, including the git-commit case).

The source and checked-in plugin runtime carry the same fix, and the release
smoke test installs from the generated archive rather than the checkout.

### feat(feed): add bounded machine-readable recall

`cartographer-search.sh --format jsonl` exposes the ranked result set without
human display chrome. `cartographer-feed.sh` builds on it to create a compact
Markdown pulse for another local agent or scheduled job, but only after the
caller supplies an explicit project allowlist. An unscoped whole-corpus feed
fails closed.

Feed searches are summary-only, bounded by time and result count, and disable
served-result and access-ledger writes so automated reads do not distort human
`/remember` telemetry. Event IDs and transcript pointers preserve the path back
to exact evidence when a summary materially affects downstream work.

### feat(web): ship a canonical social preview card

The Explorer now declares complete Open Graph and Twitter card metadata and
ships a 1200x630 preview showing keyword and semantic retrieval converging at
RRF. The deterministic generator, SVG source, deployable PNG, and checked-in
plugin mirror travel together; smoke tests assert dimensions, metadata, and
source/plugin parity. The older GitHub-only social bitmap is removed.

### feat(trustmap): derive auto mode's `autoMode.environment` from the corpus

Auto mode's classifier trusts the working directory and the current repo's
remotes, and blocks everything else as a potential exfiltration target until
`autoMode.environment` names it. Claude Code drafts that block by rescanning the
machine on acceptance — walking transcripts under a byte cap, taking the leading
word of each shell-history line, and enumerating git repos under `$HOME`, which
its own output labels "CANDIDATES, not vetted context."

Cartographer already extracted that corpus, so `/trustmap` answers the same
question from events instead. Three differences follow from that: proposals are
usage-weighted (a repo pushed to 27 times outranks one that merely exists under
`$HOME`), Codex sessions and backfilled git history are in scope, and every
proposal is diffed against current settings so an update proposes only the
delta rather than a fresh draft.

This is the *update* path, not a replacement for the built-in wizard. On a fresh
install the wizard is strictly better — it reads the machine, this reads a
corpus that doesn't exist yet — and the digest now says so rather than serving a
confident-looking panel built from forty events. When two of three signals trip
— under ~200 shell events, fewer than two repos with remotes, under 500 events
total — it prints a `COLD START` block naming which ones are missing and points
at the wizard, with `trust-digest.js --template` as the fill-in fallback for
answering the slots directly.

Usage and the slot-by-slot walkthrough are in `docs/AUTO_MODE.md`.

`scripts/trust-digest.js` emits identifiers, never arguments — commands reduce
to their leading word, URLs to their host — so the panel is pasteable into a
settings file without a secret review. Two heuristics there were wrong on the
first pass and both were replaced with facts rather than stoplists:

- Splitting compound lines on shell separators also splits the inside of inline
  `node -e` and `python -c` payloads, so language keywords surfaced as
  executables: `const` (1,528 hits) and `then` (374) outranked `adb` (966) and
  `xcodebuild` (436). Tokens now resolve against `PATH`.
- Event summaries clip at ~200 characters, so a URL near the end yields a
  fragment. `huggingfa`, `static-user-manual-h5`, and a bare `127` all read as
  single-label internal hostnames, and were the entire content of the internal
  hosts section. Hostnames are now shape-checked, and 51 loopback endpoints
  collapse to one context line instead of proposing 38 dev-server ports as
  trusted domains.

Sensitive-data locations are derived rather than hardcoded. Naming only
cartographer's own event logs would have named the lesser store while implying
the greater one was considered: on the reference corpus the top result is a
7.8 GB per-participant eye-tracking dataset. Each store is reported with its
git-ignore state, since a data directory that is not ignored is the finding,
and paths the corpus references but that no longer exist on disk are marked and
excluded — naming a missing directory grants trust to whatever recreates it.

### feat(trustmap): verify repository visibility with `gh`, for every repo you write to

The classifier assumes a repository is private unless told otherwise, and that
assumption fails in the unsafe direction: confidential material is acceptable in
a private repo and publishing it to a public one is not. Visibility is not
recoverable from the corpus — a log records what happened, not what a repo's
settings are now — and this file was treating that as a reason not to check.

That was a line drawn in the wrong place. The digest already leaves the corpus
to read git remotes and `check-ignore` state from disk; one more live probe is
the same class of operation. It now runs `gh repo view` for each repo you write
to, capped at 12 (`--gh-cap`, `--no-gh` to skip), and degrades to `unknown` with
a warning when `gh` is missing or unauthenticated rather than failing.

The scope difference is the point: the wizard checks the repo you are standing
in. This checks every repo the corpus shows you committing to. On the reference
machine that surfaced five public repos among twelve, one of them holding paper
drafts.

### fix(trustmap): a project's repo was resolved from its most recent `cwd`

Sessions `cd` into other repositories to read things, and those events keep the
session's own `project` while carrying the other repo's `cwd`. Taking the latest
one attributed `session-cartographer`'s rows to `another-repo`'s remote —
so the tool proposed trusting a repo on the strength of activity that happened
somewhere else, and paid a `gh` call to confirm the wrong answer.

Resolution is now by frequency, preferring a directory whose basename matches
the project name, and repos are de-duplicated by resolved root so one repository
reached from two project names is listed and probed once.

### feat(trustmap): provenance-stamped entries, so two tools can share one array

`autoMode.environment` has more than one author — Claude Code's setup wizard
writes it, `/trustmap` writes it, and you edit it by hand. The first cut assigned
the array wholesale, so whoever ran last silently discarded the others. Pure
appending would have been no better in the other direction: nothing could then
correct its own stale entry, and the block would grow monotonically until it
contradicted itself.

Entries this skill authors now carry a dated marker — `[trustmap 2026-08-15]` —
and the merge rebuilds the array as `$defaults` + foreign entries verbatim +
this run's stamped set. Entries are free-form prose, so the marker is legal and
the classifier reads past it. Running the wizard and `/trustmap` in either order
now converges rather than clobbering, and a re-run corrects its own entries
instead of duplicating them.

This also makes removal possible for the first time. Nothing in this pipeline
had ever retired an entry, so a host you stopped using kept granting trust
indefinitely. The digest flags entries it wrote whose identifiers no longer
appear anywhere in the corpus, and the skill asks before dropping one — absence
from a 365-day window is not proof the thing is gone. Context entries that name
no identifiers are never proposed for retirement, since absence of an identifier
is not evidence against a description.

### fix(release): the plugin runtime copy is what installed skills actually run

Skills resolve their scripts against `CLAUDE_PLUGIN_ROOT`, which points at
`plugins/session-cartographer/` — a directory carrying its own copy of the
runtime assembled by `copy-plugin-runtime.sh`. A new script added only at the
repository root is invisible there. `/trustmap` worked from a checkout and
would have failed at step 0 for anyone who installed the plugin, which is
everyone who isn't developing it.

Caught while cutting this release rather than by a test: nothing verifies that
every script a skill references exists under the plugin root. Worth adding
before the next skill lands.

### fix(gitignore): `.carto/` was committable

Cartographer's event logs are agent-session transcripts, which auto mode's
classifier treats as sensitive data belonging in no repo — this one included.
The directory was empty here, so nothing had leaked and `git status` stayed
clean, but any event written to it would have landed as untracked repo content.
A project that wants its history versioned deliberately un-ignores its own path;
the default for a repo that merely runs cartographer stays "don't commit the
logs."

## 0.5.1 — 2026-08-14

### fix(profile): "Durable decisions" drew from two records while 508 went unread

The profile harvested `session_end_strategic` events carrying a `decisions`
array. Exactly two such records exist in the reference corpus, both from one
project on one day — and those five decisions were presented as the standing
set. `/wrapup` meanwhile had written 508 `session_wrapup` milestones, to
`session-milestones.jsonl`, a file `build-profile.js` never opened.

Both halves are fixed: the profile now reads the milestones log (de-duplicated
against the few the changelog mirrors) and accepts the `session_wrapup` shape
alongside the legacy one, and `/wrapup` now emits `decisions[]`, `unresolved[]`,
and `key_insight` alongside the prose description.

The prose is deliberately **not** mined for decisions. Measured across all 508
descriptions, explicit decision markers appear in about 4%, while the one
frequent marker — "hard problem", 29.5% — is a problem, not a decision.
Harvesting it would fill the section with mislabeled content, which is worse
than showing less. The section will be thin until new wrapups accumulate.

Existing syntheses are unaffected; nothing is rewritten. Run
`node scripts/build-profile.js` after a few wrapups to see the section fill.

### fix(profile): report gaps instead of rendering them as short sections

Derived output hides its own failures — a harvester matching zero events looks
identical to a quiet corpus. `build-profile.js` now warns on stderr when a
harvester finds nothing, and when a section is drawn from an unrepresentative
slice (the original bug was *non-zero*: 1 record of 509, which a zero-check
would have passed). Sections dropped for having too little content are now
reported as such rather than as "omitted for budget", which sent you looking at
the wrong cause.

### fix(investigate): hypotheses were written to a path nothing reads

`/investigate` logged its root-cause diagnoses to `.carto/events/YYYY-MM.jsonl`.
Search reads `changelog.jsonl`, `research-log.jsonl`, `session-milestones.jsonl`,
and `tool-use-log.jsonl` — that directory is not in the set — and the skill never
called `index-event.sh`, so nothing reached Qdrant either. Its own description
promised "logs it to the event log for later recall"; recall was impossible on
every path.

Three independent breaks: the wrong file, `id`/`ts` instead of
`event_id`/`timestamp`, and the text living in `symptom`/`hypothesis` rather than
`summary`, which is first in the extraction chain. The skill's jq block had also
been paraphrased rather than run, producing four record shapes across 64 records.

`scripts/backfill-investigations.js` normalizes all four shapes into the searched
log — idempotent, dry-run by default. The skill now writes the correct schema
directly to `changelog.jsonl` and indexes it, so no further backfill is needed.

Recovered on the reference corpus: 64 diagnoses, 42 with a session (18 already
attributed, 24 matched), 31 with a verified transcript, 6 refused as ambiguous.
Matching policy is now shared with the orphan repair via `scripts/session-match.js`
rather than reimplemented.

## 0.5.0 — 2026-08-14

### fix(attribution): read the session id Claude Code actually exports

Every consumer resolved the active session from `CLAUDE_SESSION_ID`. Claude Code
has never set that variable — the name it exports to tool calls is
`CLAUDE_CODE_SESSION_ID`. Nothing crashed and nothing was logged, so the failure
went unnoticed for the life of the feature.

Two consequences, both silent:

**Delta serving never ran.** It suppresses event_ids already returned earlier in
a session so repeat `/remember` calls surface fresh material. It gates on the
session id, so it has been dormant since it shipped: 4,361 of 4,361 served rows
carried an empty `session_id`. If you wondered why calling `/remember` twice
returned much the same thing, this is why. It works now — expect repeat calls in
one session to return genuinely different results.

**Milestones lost their transcripts.** `/wrapup` and `/investigate` build their
records with inline bash that read the same broken chain, so they stamped
`session_id: "unknown"`, which then defeated the transcript lookup and wrote an
empty `transcript_path`. On the reference corpus 437 of 507 wrapup milestones
(86%) were affected. They still ranked at the top of `/remember` results —
wrapups carry the highest salience in the corpus — while being dead ends.

The resolution chain is now `CARTOGRAPHER_SESSION_ID → CLAUDE_SESSION_ID →
CLAUDE_CODE_SESSION_ID → CODEX_SESSION_ID` in every consumer, with provider
derived from whichever entry resolved rather than re-testing the legacy name
independently (the same defect had left 369 records with no provider).
`/wrapup` and `/investigate` now warn on stderr when the session will not
resolve, so a silent `"unknown"` can never accumulate unnoticed again.
`tests/unit/session-id-chain.test.js` asserts on the written log row, since that
is the only place the original failure was visible.

Test harnesses now unset the session variables. With delta serving actually
working, a harness that inherits a live session id loses repeat results and
fails tests that are fine.

### feat(search): `--get` for exact, untruncated fetch by event_id

Search output is lossy by construction — summaries are single-line and
truncated for display. `--get evt-a,evt-b` returns the complete records,
including `transcript_path`, `files_changed`, and `diff_shape`, so a shortlist
can be verified before committing to reading a 100MB transcript. Ids that
resolve to nothing are reported as missing rather than silently dropped;
returning four records for five ids is how an agent ends up confidently
answering from a gap.

### feat(profile): standing corpus summary at `.carto/profile.md`

`scripts/build-profile.js` derives a length-budgeted summary of active
projects, standing preferences, durable decisions, work shape, and cadence, so
recall can start from the top of the pyramid rather than always from a record
lookup. Fully derived — delete it and it rebuilds. Commits count toward the
profile only when the author matches the owner set or the commit carries a
`session_id`, so backfilled history from cloned repos cannot describe a
composite of every author whose repo was ever cloned.

### fix(scripts): one definition of an unresolved field

The event pipeline spells absence three ways — `""`, `"unknown"`, and `null` —
and `/wrapup` alone has written all three across different eras of the skill.
Readers each re-derived the set inline and diverged.

This never surfaces as an error. `"unknown"` is truthy and equal to itself, so
`if (sid)` passes and grouping by it silently merges every unattributed record
into one phantom entity. During this release's orphan repair that phantom built
a session window spanning the entire corpus, "matched" 148 orphans, and
overstated the recovery rate by 54% before it was caught.

`scripts/sentinels.js` now holds the single definition (`isResolved`,
`firstResolved`), and the session-window builder, digest, and repair tool all
use it. A unit test asserts no window can ever be keyed by a sentinel.

### feat(scripts): recover orphaned sessions from before this release

`scripts/repair-orphan-sessions.js` walks milestone records stamped
`session_id: "unknown"` back to their session by project and nearest-event
proximity. Existing users should run it once — see "Recovering Orphaned
Sessions" in `docs/SETUP.md`. Dry run by default; `--write` takes a `.bak` and
rewrites only repaired lines.

The matching policy is deliberately stricter than `enrich-sessions.js`: a
project match is required, ambiguity is refused rather than guessed at, and the
transcript is verified to exist and to cover the timestamp before it is
written. A wrong session id is worse than a missing one — it points `/remember`
at an unrelated conversation and presents it as the real thing.

On the reference corpus (439 orphans) this recovered 145 with a verified
transcript and 10 whose transcript had expired, refused 101 as ambiguous, and
found 183 unrecoverable. Wrapup milestones with a working transcript went from
65 to 210. Concurrent sessions in one project are the limiting factor.

Window construction is now shared with `enrich-sessions.js` through
`scripts/session-windows.js`; behavior of the existing tool is unchanged.

### feat(wrapup): render a session digest before writing the synthesis

`/wrapup` now opens with `scripts/session-digest.js`, a compact panel covering
span and tempo, commits with type and diff-shape mix, hottest files, research
hosts, `/remember` served-vs-used, and the live uncommitted/unpushed state of
every repo the session touched. Every line traces to a logged event or to
`git`, so a wrong claim is visible rather than merely plausible.

The panel is shown to you, and the agent writes its synthesis against it rather
than from its own recollection of the conversation. Digest scalars are attached
to the milestone under `digest`, so a session stays checkable after its
transcript passes Claude Code's ~30-day TTL.

## 0.4.1 — 2026-07-24

### fix(release): self-contained repository marketplace installs

Direct installs from a cloned checkout previously copied
`plugins/session-cartographer` without the search runtime, project registry, or
Explorer that `scripts/build-release.sh` added only to release archives. The
installed skills resolved their plugin root correctly and then failed because
`scripts/cartographer-search.sh` was absent.

The checked-in marketplace source now carries the same assembled runtime as the
release archive. `scripts/copy-plugin-runtime.sh` is the shared assembly path,
`tests/source-marketplace-smoke.sh` exercises real isolated Codex and Claude
managed-cache installs when their CLIs are available, and CI guards the checkout
marketplace independently of tagged release builds.

### feat(indexing): derived PostCompact summaries and transcript refresh

The lifecycle bridge records redacted, provenance-marked compact summaries as
derived evidence without replacing canonical transcripts. Session start also
runs checkpointed transcript catch-up, while project inference and Qdrant
payloads retain cross-provider provenance.

### feat(search): exact recall-use telemetry

Search calls and `--touch` reuse events now share stable call identifiers,
purpose, provider, and session metadata. `hit-rate-report.js` computes explicit
result-use hit rate and MRR without crediting later searches that happened to
serve the same event.

### docs: cross-provider assessment and event-lifecycle roadmap

The release includes the July cross-provider recall assessment and redesigns
the knowledge-update backlog around validity intervals plus
`active`/`deprecated`/`contested` lifecycle states, with the NuggetIndex
citation verified against arXiv and CrossRef.

## 0.4.0 — 2026-07-13

Promoted after the release candidate passed clean managed-cache installs in
both plugin layouts, the full search suite, Explorer build, and published-asset
checksum verification.

### feat(providers): shared Claude Code and Codex history

Hooks now detect provider provenance per event instead of relying on a global
mode, so Claude Code and Codex can run concurrently and consume each other's
history. Codex JSONL gets its own turn adapter, transcript search scans both
provider stores, Qdrant payloads retain provider and transcript path, and the
Explorer normalizes both formats behind one secure transcript endpoint.

### feat(release): self-contained cross-provider plugin bundle

The plugin no longer depends on the developer checkout after installation.
Release builds place search/index scripts, the project registry, and Explorer
inside the plugin, while hook and skill runtime resolution prefers that bundled
copy. `scripts/build-release.sh` creates a version-checked local-marketplace
archive plus SHA-256 checksum; `tests/release-smoke.sh` extracts it and proves
bundled hook resolution and keyword recall. Tags matching `v*` now run unit and
release smoke tests before GitHub publishes the archive.

## 0.3.0 — 2026-06-23

### feat(graph): significance-weighted co-occurrence graph + maneuver map

Two orientation lenses search can't provide, from one Dunning-G² engine over the **structured** fields of the event logs (project, detected tech-signals) — never tokenized prose (a prose term-graph just rebuilt machinery cliques and duplicated the Qdrant path). **Project co-activity** (`--related <project>`) uses the calendar *day* as the document — 97% of sessions are single-project, so the cross-thread signal lives in same-day concurrency, not same-session — surfacing research threads like `paper-a ↔ paper-b`. **Maneuver map** (`--maneuvers <project>`) detects tech-signals (`gh-release`, `cloudflare-pages`, `overleaf-sync`, …) from a signature catalog over `summary + files_changed`, in two views: *composition* (signal × signal, doc = session — `gh-release + version-tag + lfs` = a desktop app's DMG release) and *transfer* (project × project, doc = signal — which projects share a procedure).

Edges rank by **Dunning's log-likelihood ratio (G², 1993)**, not lume's z-score+tanh: for a perfectly-correlated pair the z-score collapses to `√N` regardless of count, so a 3-session fluke ties a 30-session pattern — it saturates. A temporal-holdout eval confirmed G² beats z-tanh in every split, and also that *prediction is the wrong yardstick* (raw count dominates both — forecasting recurrence rewards the base rate significance is designed to remove); `/focus` wants distinctive threads, not predictable ones. The artifact is an **index, not a store** (~46 KB; maneuver layer 3.3 KB): it records which `(project, signal)` cells are non-empty, never the commands — those stay in the changelog and are recovered on demand, so no secrets (CF tokens / zone IDs) are indexed. Inspired by DeepBlueDynamics/lume's Semantic Knowledge Graph layer.

**Files:**
- `scripts/cooccurrence-graph.js` *(new)* — the G² engine + `--related` / `--maneuvers` / `--signal` query modes; writes `cooccurrence-graph.json`.
- `scripts/eval-cooccurrence.js` *(new)* — temporal-holdout predictive eval (the diagnostic that demoted prediction as the success metric).
- `plugins/session-cartographer/skills/focus/SKILL.md` — Step 3 surfaces related threads + maneuvers.
- `plugins/session-cartographer/skills/remember/SKILL.md` — `--signal` procedural recall ("how do I deploy X").
- `docs/COOCCURRENCE.md` *(new)*, `docs/COOCCURRENCE_EVAL.md` *(new)* — method + evaluation plan.
- `README.md` — *Co-occurrence graph* section + lume inspiration.

### feat(hook): auto-focus on session start — experimental, opt-in

`SessionStart` hook that injects the graph's related-threads + maneuver lenses as session context on entering a project, so cross-thread connections surface without a manual `/focus`. **Dormant by default** — enable with `CARTOGRAPHER_FOCUS_ON_START=1`. Abstains on home-dir / non-project launches (early-exit, no graph build) and surfaces at most **once per project per day** — the same banner on every launch is wallpaper. Logs every fire to `focus-on-start-trial.jsonl` (`fired` = had signal, `shown` = actually injected) so hit-rate and follow-through are measurable. Trial finding (155 fires): home-dir noise and repetition dominated until both were suppressed; the maneuver half is reliably useful, and the related-threads half is now gated by a cheap G² stability heuristic (significant *and* not a two-day fluke) that cuts solo-project coincidence — full Tier-2 bootstrap stability remains the principled version.

**Files:**
- `plugins/session-cartographer/hooks/surface-focus-on-start.sh` *(new)* — env-gated, silent-fail, skips compaction.
- `plugins/session-cartographer/hooks/hooks.json` — `SessionStart` registration (inert until the env var is set).

### feat(search): promote-on-reuse — access ledger + activation scoring

Write-time salience was a static prior; this makes it a learned posterior. When `/remember` actually reads the transcript behind a result, it records the access via a new `--touch EVENT_IDS` flag into an append-only `access-ledger.jsonl`. At query time, rank fusion folds the ledger in as an activation layer: reuse refreshes the event's recency (time decay runs from the most recent access, not the event timestamp) and compounds an ACT-R-style frequency boost `1 + w·Σ 1/sqrt(days_since_access)`, capped at 2× so reuse breaks ties without overpowering relevance. Reused results show a `(used xN)` tag. Searching is free; using is vouching — only transcript reads record accesses, never mere serving.

Inspired by mindmap-mcp-server's promote-on-reuse lifecycle ("reusing it = vouching for it"), implemented continuously in the scoring layer instead of as discrete hot/warm/cold tiers. Untouched events score exactly as before; `CARTOGRAPHER_REUSE_WEIGHT=0` disables (default 0.3).

**Files:**
- `scripts/cartographer-search.sh` — `--touch` verb, ledger aggregation in the fusion awk BEGIN block, decay block generalized to an activation block (now uses the existing `ts_to_epoch` helper), `(used xN)` display tag
- `explorer/server/search.js` — same activation layer for the API path (`applyTimeDecay` → `applyActivation`), `_reuseCount` on results
- `plugins/session-cartographer/skills/remember/SKILL.md` — Step 3 now records reuse after reading a transcript; touch only what was used, not everything served
- `docs/SCORING.md` — new "Score modifiers" section documenting salience, decay, and reuse as one post-fusion layer

### feat(backfill): app-session metadata import — titles + Cowork prompts

New `scripts/backfill-app-sessions.js` walks the Claude desktop app's session-metadata stores (`~/Library/Application Support/Claude/{claude-code-sessions,local-agent-mode-sessions}`) and imports what the transcript pipeline never sees: human-readable session titles ("SPF trilogy") keyed to CLI session ids, and Cowork sessions — which run in VMs and never write transcripts to `~/.claude/projects` — whose title + initialMessage is the only locally recoverable record. Recon found 318 desktop sessions (13 with TTL'd transcripts where only the title survives) and 20 Cowork sessions that were entirely invisible to `/remember`.

Events land in `changelog.jsonl` as type `app_session` with deterministic ids (`app-<uuid>`), so re-runs are no-ops. Salience graded by uniqueness of the record: Cowork 0.7, orphaned desktop 0.6, transcript-backed desktop 0.5. `transcript_path` attached when the CLI transcript still exists. Store paths catalogued from mindmap-mcp-server's `import.ts`.

### feat(skill): /investigate — root-cause diagnosis gate

New skill that enforces diagnosis before bug-fix code. `/investigate <bug summary>` runs a five-step contract: reproduce the failure, read the failing path end-to-end, classify the root-cause layer (logic / state / boundary / validation-gap / config-build), write a hypothesis with **cause + mechanism + disproof**, then log it to the event log and stop — no fix code until the diagnosis is confirmed.

Built to break the "plausible fix shipped before the failure mode was understood" cycle. Includes a skip clause: obvious bugs (cause in the error message, one-line fixes) bypass the ~5–10K token overhead.

**Files:**
- `plugins/session-cartographer/skills/investigate/SKILL.md` *(new)* — the skill. `Bash/Read/Grep/Glob` only; by design it cannot write fix code. Logs an `investigation`-type event so `/remember` can later surface the hypothesis.

### feat(retro-index): resumable backfill

`retro-index.sh` now checkpoints each session — by id + transcript mtime — to `$CARTOGRAPHER_DEV_DIR/.carto/retro-index-progress` as soon as it finishes. A run killed partway through (a multi-hour full-history backfill rarely survives in one sitting) skips the completed sessions on restart; only the interrupted session onward is reprocessed, so no embedding work is repeated. A transcript that has grown since it was indexed (changed mtime) is reprocessed automatically — the overlap dedupes via the deterministic `turn-<sid>-<idx>` point IDs.

**Files:**
- `scripts/retro-index.sh` — per-session checkpoint + skip-on-resume; `--fresh` flag clears the checkpoint for a full reindex; portable `file_mtime` (BSD/GNU `stat`).

## 0.2.1 — 2026-06-12

### fix(events): single-line summaries everywhere — malformed top-ranked results eliminated

Multi-line bash commands (heredocs, `python -c`) flowed into event summaries with newlines intact. The JSONL stayed valid (escaped `\n`), but Qdrant payloads hold the parsed string, and the semantic TSV emitter printed it raw — one result row split into many, fragments mis-parsed as rank/key/timestamp, rank coerced to 0, and the garbage aggregate (`[]`/`[0.5]` timestamps, `+`-joined command fragments) outranked every real result on every query. Separately, a hand-written pretty-printed wrapup record sat as 41 invalid lines in both `changelog.jsonl` and `session-milestones.jsonl`, and `grep -c … || echo 0` in the milestones hook produced `"0\n0"` counts — corrupting summaries and silently failing the milestones-log write via `--argjson`.

Writers now flatten at the source; the search pipeline sanitizes and guards at every layer; historical data cleaned in place (backups kept) including 261 Qdrant payloads.

**Files:**
- `plugins/session-cartographer/hooks/log-tool-use.sh` — flatten `\n`/`\t` in commands; read `tool_response.stdout` (object form) so commit parsing stops leaking raw JSON escapes into summaries
- `plugins/session-cartographer/hooks/log-session-milestones.sh` — `grep -c | head -1` + numeric guard for the session event count
- `scripts/cartographer-search.sh` — semantic TSV emitter strips control chars from summaries; fusion awk drops rows with an empty key or non-numeric rank (the backstop)
- `scripts/bm25-search.awk` — flatten `\n`/`\\n` escape sequences in event-log summaries before TSV emit (display-only; scoring unchanged)
- `scripts/index-event.sh` — embed request built with jq instead of string interpolation (summaries with quotes were silently never indexed); text flattened before embedding

## 0.2.0 — 2026-05-20

### feat(intent): prompt-intent classification for transcript turns

Every transcript turn opened by a human prompt is now classified into one of 17 intent categories (bug-fixes, research, planning-strategy, deploy-release, …). The intent is stored on the Qdrant turn payload and is searchable as both a filter and a facet.

The classifier is a zero-dependency rule cascade ported from [crispierry/codex-log-viewer](https://github.com/crispierry/codex-log-viewer) (`packages/analytics/src/prompt-intents.ts`), then retuned against this corpus: a noise gate routes injected `user` turns (task notifications, slash-command wrappers, skill preambles, compaction summaries) to `other`, pasted-image markers are stripped during normalization, and question/bug-report phrasings were widened.

**Files:**
- `scripts/classify-prompt-intent.js` *(new)* — the classifier. Exports `classifyPromptIntent()` + `promptIntentCategories`; also runnable as a CLI for spot-checks.
- `scripts/backfill-prompt-intents.js` *(new)* — patches `prompt_intent` onto already-indexed turn points via Qdrant set-payload. Payload-only — no re-embedding, no embedding server required. Idempotent, supports `--dry-run`.
- `scripts/prompt-intent-report.js` *(new)* — corpus-wide intent distribution plus de-duplicated per-bucket sampling. The tool for re-tuning the predicates as prompting style evolves.
- `scripts/reconstruct-history.js` — tags each turn with `prompt_intent` as it indexes (the human prompt only; tool-result turn fragments stay untagged).
- `scripts/index-event.sh` — threads an optional `prompt_intent` field from the event payload through to the Qdrant point payload.
- `scripts/cartographer-search.sh` — new `--intent KEY` filter (semantic-only; the keyword event logs carry no intent) and an `intents:` line in the facet summary.

**Backfill for existing users:** `node scripts/backfill-prompt-intents.js` tags turns that were indexed before this landed. Only turns opened by a real human prompt receive an intent — tool-result turn fragments do not.

### feat(transcripts): turn-based chunking replaces per-line indexing

Transcripts are now indexed **one document per conversation turn** instead of one document per JSONL line. A turn = a user prompt plus every assistant message up to the next user prompt. This keeps questions and their resolutions in the same document, which is how BM25 and semantic retrieval both want to see them.

Inspired by Dropbox's [witchcraft/pickbrain](https://github.com/dropbox/witchcraft) — same chunking unit, but the implementation stays in awk and keeps the existing Qdrant + event-log architecture.

**Files:**
- `scripts/transcript-to-turns.awk` *(new)* — zero-dep JSONL preprocessor. Walks each transcript, emits one turn per `user`→next-`user` boundary. Harvests text/content/file_path/command/url/query/name values cleanly (no more JSON scaffolding in summaries). Deterministic `turn-<sid>-<idx>` IDs so reruns dedupe.
- `scripts/cartographer-search.sh` — `grep_transcripts_to_tsv()` now preprocesses each matched transcript through the turn grouper before BM25 scoring. Uses `src=transcript-turn` label to bypass the legacy per-line transcript branch cleanly.
- `scripts/retro-index.sh` — replaced per-message jq extraction with turn grouping. One Qdrant event per turn.
- `scripts/reconstruct-history.js` — accumulator pattern, one Qdrant event per turn. Preserves synthesized `synth-*` tool-invocation events alongside turns for per-action retrieval.
- `scripts/bm25-search.awk` — **unchanged.** Turn documents flow through the event-log field extraction path via the new source label.

**Migration for existing users:** see [docs/MIGRATION_TURNS.md](docs/MIGRATION_TURNS.md). CLI users need nothing. Qdrant users run three commands: delete legacy `hist-*` points, re-run `retro-index.sh` with `PE_GATE_REJECT=2.0`, optionally refresh `reconstruct-history.js`.

### feat(devtools-adapted): import session parsing, token attribution, and compaction detection from claude-devtools

Raided [claude-devtools by matt1398](https://github.com/matt1398/claude-devtools) (MIT) for
three production-quality modules. Adapted TypeScript → plain ESM JavaScript, stripped Electron
IPC and React/Redux coupling, kept the pure parsing logic.

**New files under `src/lib/devtools-adapted/`:**

#### `session-parser.js` — Priority 1
Full `~/.claude/projects/` JSONL parser. Replaces the bare `readline` loop in
`reconstruct-history.js` when `DEVTOOLS_PARSER=true`.

- `parseJsonlFile(filePath)` — streaming line-by-line parse, skips malformed lines
- `parseJsonlLine(line)` — single-entry hydration with content blocks, timestamps, metadata
- `extractToolCalls(content)` / `extractToolResults(content)` — tool_use / tool_result extraction
- `deduplicateByRequestId(messages)` — drops duplicate streaming assistant entries; prevents
  output_token overcounting (Claude Code emits multiple entries per API response during streaming)
- `calculateMetrics(messages)` — session-level token + timing metrics post-dedup
- `isParsedUserChunkMessage()`, `isParsedHardNoiseMessage()`, `isParsedCompactMessage()` — type guards
- `enumerateSessions()` — scan all of `~/.claude/projects/`, sorted newest-first
- `parseSession(filePath)` — full parse with byType grouping, taskCalls, sidechain split
- `extractTextContent(msg)` — text extraction for indexing

#### `token-attribution.js` — Priority 2
6-category token breakdown per session. Intended as session-level metadata for the
cartographer index and future activation scoring.

Categories: `claudeMd` · `mentionedFiles` · `toolOutputs` · `thinkingText` ·
`taskCoordination` · `userMessages`

- Uses chars/4 heuristic (matches claude-devtools for consistency)
- Extracts system-reminder / CLAUDE.md injection blocks from user messages
- Separates Task/SendMessage/TeamCreate overhead from generic tool outputs
- `attributionFractions()` — normalized [0,1] breakdown for scoring

#### `compaction-detector.js` — Priority 3
Detects context compaction events (information-loss markers) and computes per-phase
token contributions.

- `checkMessagesOngoing(messages)` — activity-state machine: ongoing if AI activities
  (thinking, tool_use, tool_result) follow the last text output or interruption
- `detectCompactionPhases(messages)` — tracks pre/post compaction token levels;
  `contextConsumption` is the compaction-aware total (sum of per-phase contributions),
  more meaningful than raw final input_tokens

**`index.js`** — barrel export + `DEVTOOLS_PARSER_ENABLED` feature flag
**`analyzeSession(filePath)`** — convenience wrapper combining all three modules in one call

**`reconstruct-history.js`** — wired via `DEVTOOLS_PARSER=true` env flag
When active, `processTranscript()` calls `analyzeSession()` after its existing readline loop
and appends enriched fields to the `session_milestone` Qdrant payload:
`attribution`, `compaction_count`, `context_consumption`, `is_ongoing`, `total_tokens`.
Non-fatal: degraded gracefully to the existing basic milestone on any error.

**Tests:** `tests/unit/devtools-adapted.test.js` — 36 tests, 15 suites, Node built-in test runner.
Covers synthetic fixtures + a live smoke test against the most recent real session file.

**Attribution:** `THIRD_PARTY_NOTICES.md` added; `LICENSE` updated.

**What was NOT taken from claude-devtools:**
- Electron shell / window management
- React/Redux UI components and styling
- Alert / notification system
- SSH / remote features
- Subagent tree building or cross-session search
