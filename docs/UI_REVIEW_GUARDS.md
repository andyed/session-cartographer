# Reviewing work without making people reconstruct the log

2026-10-29. Local implementation and mechanical checks; human usefulness remains
subject to the user's review.

The [interaction style guide](INTERACTION_STYLE_GUIDE.md) defines action targets,
navigation, focus, recovery and shared context. The
[interaction audit](INTERACTION_AUDIT_2026-10-29.md) records defects that survive
the mechanical copy and glyph checks below. Use both gates.
The [implementation follow-up](INTERACTION_FIXES_2026-10-29.md) records the
whole-row, navigation, recovery and live-update repairs and their verification.
The [regrouping follow-up](REVIEW_REGROUPING_2026-10-29.md) records recoverable
search bundles, preview-cap reveals, file/operation review and compact reading views.

## Decision and integration

Muriel Direct: group evidence by the object being reviewed when relationships
are explicit and reversible. The original transcript owns source IDs and search;
derived bundles own presentation only. Use the existing reader, artifact lists,
inspector and navigation rather than a second evidence store.

Current applications:

- A search result owns its titled links, and a link owns subsequent fetch attempts
  with the same URL in the same agent's stream. Match the most recent preceding
  search; retain retries, errors, timestamps and source references. Never attach
  by topic similarity or move a fetch before its search. Query parameters remain
  part of URL identity; fragments do not. Unmatched fetches stay in chronology.
- An artifact owns its available preview/download plus the calls/results that
  establish its provenance. A reference does not establish creation.
- Comparative metrics use shared table headers instead of repeating metric cards.
- File collections show their common directory once and use relative paths for
  rows. Remove only complete shared directory components; retain differing
  worktrees and nested folders so equal basenames stay distinguishable. Full
  paths remain in keyboard-accessible disclosures and hover titles; canonical
  identity, routing, downloads and authored document content are unchanged.
  File review puts the exact path under Location instead of repeating it below
  the filename.
- A compact evidence glyph may carry a count, but expanding it reveals named
  sources (for example, Commit record and Git output), never anonymous indexes.
  Output evidence expands across the row, outside the narrow action column.
  Check two adjacent disclosures open at once on desktop and mobile, and follow
  both source types. Exact event links open the containing timeline group.

Pattern for future review units: **named object → related actions/results →
source trail**. Preserve a way to inspect exact original records. Do not infer
user goals or success merely because the grouping is plausible.

## Summary and rendering contract

The user's product gospel is recorded in AGENTS.md: **if it's worth showing,
it's worth rendering**. A plain session URL now opens Summary, with the last
main-agent response clearly attributed, produced/edited artifacts, grouped
research, the original request, and historical failures under disclosure.
Conversation is secondary; exact source links and search still open it.
Neither a recorded response nor a failed attempt establishes current completion
or an unresolved issue. This first projection does not infer those states.

Typed evidence unwraps Codex execution envelopes and Promise settlements, renders
structured fields as definitions, and extracts literal commands without running
recorded code. Unknown/clipped transport and orchestration bodies are omitted
from the visible review; canonical source blocks remain searchable and available
through the existing transcript API. Embedded JSON also passes through the
structured renderer. Search results render titled links, not serialized arrays.

The artifact browser fixture checks a real-shaped Codex wrapper, preserves its
actual output, verifies named structured fields, and rejects visible transport
keys, orchestration and call IDs. It also checks mixed Markdown, summary-to-source
navigation, absent optional categories, and the 390px layout. The real graphics
session is a separate read-only check. These are mechanical checks; human
acceptance of the summary remains open.

## Repeated-copy audit

`tests/browser/helpers/repeated-copy.cjs` captures rendered text, including
scrollable content, excluding hidden/collapsed and screen-reader-only text.
Sibling text nodes are joined so React interpolation does not turn half a label
into an apparent repeated phrase.

The v1 penalty is **100 × excess repeated interface words / interface words**.
A repeated phrase is an exact, case-insensitive, whitespace-normalized text unit
of at least two words. For n occurrences of a w-word phrase, excess is (n−1)×w.
Target: at most 5% in each tested page state. Reports name offending phrases and
DOM locations; a low aggregate cannot offset a failing page.

Source text, titles, paths, numeric values, timestamps and chart ticks are
classified separately; the report retains their repetition counts. These do not
inflate the interface denominator. `data-copy-content` is for actual data,
never a waiver for status text, instructions or buttons. Accessible names and
hover titles are not visible boilerplate. A glyph legitimately removes visible
word repetition, but must still have an accessible name, recognizable meaning,
focus indication and a 44px target. Do not replace copy with unexplained icons
merely to pass the score.

Limits: v1 does not detect paraphrased/template repetition, measure comprehension,
or penalize single-word labels. A threshold is a project review gate, not a
research-validated usability score. Content duplication is reported separately;
retain useful repeated reference points and compare rendered states manually.

Run `npm run build --prefix explorer`, then
`node tests/browser/memory-entry.cjs --preview`. The isolated fixture reports
`repeated-copy.json` in the temporary `carto-memory-browser-artifacts` directory.
It covers timeline events, sessions, concurrent view, search results/empty,
transcript, Memory entry/tasks/field/file review/Recall/Day, and Internals.
The same report separately lists icon-only controls, their accessible names and
target dimensions; those must pass independently of the copy score.
The artifact harness also measures the supplied real transcript without changing
its corpus. CPU unit checks for scoring, grouping and navigation run on BIGFU.

## Research and discovery grounding

Hilbert & Redmiles, *Extracting Usability Information from User Interface Events*,
ACM Computing Surveys 32(4), pp. 384–421 (December 2000),
[author copy](https://ics.uci.edu/~dfredmil/publications/J006-HR00.pdf).
Read the user-supplied `~/Downloads/371578.371593.pdf`, especially §§3.3–3.4,
4.2 and 5–6. Context can span events; selection, abstraction and recoding can
make a raw event stream interpretable. Our bundle is an application of that
framework, not an empirical result from the paper. The paper does not validate
our repeated-copy metric or its 5% threshold. Keep raw evidence because selecting
or abstracting too early can discard useful information.

Initial product grounding, not a completed evaluation:

- [Claudoscope](https://claudoscope.com/) documents conversation focus, file diffs,
  trace-to-chat navigation, and folding idle stretches. These are useful leads
  for separating task review from trace inspection; runtime behavior untested.
- [Willison's viewer](https://tools.simonwillison.net/claude-code-timeline) exposes
  content/role filtering, prompt access and exact raw records. Preserve that
  inspectability while raising the default unit above a JSON event.
- [DEV comparison](https://dev.to/gonewx/i-tested-4-tools-for-browsing-claude-code-session-history-17ie)
  supplies discovery leads only. Verify its claims against products before use.

The full task-based competitive review is queued in TODO.md.
