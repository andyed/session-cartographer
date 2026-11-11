# Work ledger — declared work, checked against the record

Status: draft proposal · 2026-11-11. Nothing here is implemented, measured or
approved. It is input to the decision-capture architecture review in
[TODO.md](../TODO.md), not a commitment to build.

## Proposal

Add a third kind of question to Session Cartographer.

- `/api/recall` answers "which records are relevant to this phrase."
- `/api/facts` answers "what is true of the corpus."
- The ledger answers "what is intended, and does the record agree."

A **work item** is something a person or an agent has said should happen: a
feature, a fix, a paper revision, a release, a post. Items are declared in
append-only events. The current state of every item is a fold over those events.
Two things are shown side by side for each item: the status someone **stated**,
and what the corpus **observed**.

The ledger is not limited to code. An item may belong to several projects or to
none, and a commit is only one of the things that can close it.

## Why now

- **Every surveyed tracker stores declared status.** The
  [landscape survey](landscape-survey.md#6-declared-work-trackers-and-specs)
  covers 21 trackers and spec tools for coding agents. In the READMEs read, an
  agent or a person writes each item's status, and none describes checking it
  against commits or session events. That evidence is already in SC's logs.
- **This repository's own plan is prose.** Measured 2026-11-11 on the committed
  files: `docs/` has 50 Markdown files, of which 8 have a `Status:` line, each
  in free text. `TODO.md` is 396 lines with 61 open checkboxes, and priority and
  dates live in headings. One entry still describes a problem as open after its
  first fix merged.
- **The plan is the record that changes most.** Scope, priority and target move
  more often than code facts do, and today the previous statement is overwritten
  by each change. "What was the plan on a given date" has no answer.
- **Projects start their own.** One project in the maintainer's workspace built
  a release ledger in JSONL on the day this was drafted.

These are reasons to review the idea. They do not show that agents or people
would use it; see [Open questions](#open-questions-and-what-is-not-proven).

## What work beyond code changes

The item model was run by hand against four kinds of real work: a paper
revision driven by itemized reviews, an app release train, a queue of posts to
write, and an entry in this repository's `TODO.md`. Four requirements came from
the kinds that are not code.

- **Evidence cannot mean commits.** A revision closes with an edited document
  and a submission receipt. A release closes with a status held by a store.
  Receipts need kinds, and a person's attestation has to be one of them.
- **Waiting is a blocker of its own.** Work stalls on a person or a date: a
  coauthor, a review decision, an embargo. That cannot be written as a
  dependency between two items.
- **Items often have no repository.** The store is central. A link to a spec
  document is optional.
- **The words stay neutral:** "item" with a kind, and no "issue", "bug", "PR"
  or "sprint".

## Model

### Item

| Field | Meaning |
|---|---|
| `id` | Stable identifier. Survives a rename of the title or the project. |
| `kind` | Free short word: `feature`, `fix`, `paper`, `release`, `post`, `milestone`, `deadline`, `goal`. Not an enum the fold depends on, except `milestone`. |
| `title` | One sentence naming the outcome. |
| `projects` | Zero or more project names, resolved through `cartographer_project()`. Empty is valid. |
| `parent` | The item this one is part of. |
| `target` | A `milestone` item this one is meant to land in, such as a release. Separate from `parent`, because one item belongs to a feature and to a release at once. |
| `bucket` | `inbox`, `now`, `next`, `later` or `parked`. `parked` requires a reason. |
| `stated` | `open`, `active`, `closed` or `unknown`. |
| `resolution` | Required when `stated` is `closed`: `done`, `dropped`, `duplicate`, `superseded`, `moot`, `conceded` or `reverted`. |
| `scope` | Three lists: `in`, `out`, and `keep` (what must survive the work unchanged). |
| `done_when` | Ordered list of criteria. A criterion closes only through a receipt. |
| `waiting_on` | Who or what the item waits for (`user`, a named person, or an event), since when, and the question if there is one. |
| `not_before`, `due` | Dates. A deadline with stages is several child items. |
| `visibility` | `open` or `restricted`, with an optional end date. See [Visibility](#visibility). |
| `spec` | Path or URL of the document that describes the item, when one exists. |

"Blocked" is not a field. An item is blocked when a `blocks` link points at it
from an item that is not closed, when `waiting_on` is set, or when `not_before`
is in the future.

### Events

Ledger events are rows in `session-milestones.jsonl`, one of the five searched
logs, so no sixth log is added and the rows are recallable through `/remember`.
There are already 21 milestone kinds in that log, some written by adapters
rather than session hooks. Each row has the common envelope (`event_id`,
`timestamp`, `session_id`, `provider`, `project`, `cwd`, a single-line
`summary`) and a `work` object:

| `milestone` | Fields in `work` | Meaning |
|---|---|---|
| `work_open` | `items: [id]`, initial fields | Declares an item. |
| `work_set` | `items`, changed fields, `reason` | Changes title, bucket, target, parent, scope, dates, waiting or visibility. |
| `work_status` | `items`, `stated`, `resolution`, `reason` | States a status. |
| `work_link` | `from`, `to`, `type` | `blocks`, `supersedes`, `duplicates` or `relates`. |
| `work_receipt` | `items`, `receipt`, optional `criterion` | Attaches evidence. |

Rules that hold for every event:

- **`items` is a list.** One decision can resolve several items, and it is
  recorded once with every item it touches.
- **Nothing is rewritten.** An earlier value of a field is superseded by a later
  event for the same field. The earlier event stays in the log.
- **Each field value has an interval:** from the event that set it to the next
  event that sets the same field. The plan as of a date is the fold of events up
  to that date.
- **Provenance is recorded.** Whether a person or an agent stated it is on every
  event, with the source message or event when there is one.
- **A proposal is an event, not a state change.** A `work_set` with
  `proposal: true` has no effect on the fold until a later event accepts it by
  `event_id`. See [Authority](#authority).

### Stated and observed

`stated` is what someone wrote, and it is never changed by the fold. These
labels are derived beside it:

| Derived label | Rule |
|---|---|
| `stated only` | Closed as `done` with no receipt. |
| `contested` | Closed as `done` while a `done_when` criterion has no receipt, or `open`/`active` while every criterion has one. |
| `needs confirmation` | No ledger event has named the item for longer than the bucket's interval. |
| `blocked` | As defined above, with the reason: an item, a person, or a date. |

Activity that fits neither `contested` rule is reported as an observation and
nothing more. Commits against a parked item are common when work lands switched
off, and they do not contradict the plan.

### Receipts

A receipt is a typed pointer. Each kind is listed with how far SC can check it.

| Kind | Points at | What SC can check |
|---|---|---|
| `commit` | Repository and sha | Against git, the way the day digest does: landed, moved, rewritten or missing. |
| `event` | An `event_id` in the corpus | That `--get` returns it. |
| `document` | A path, with a revision when known | That the path exists (`lstat` only; see the constraint on opening corpus-named files). |
| `artifact` | A path to an image, PDF or build | The same. |
| `measurement` | A result file, the number, and the producer | That the file exists and holds the number. |
| `ledger` | A row in a project's own ledger file | That the row exists. |
| `url` | A published page | Nothing. Labelled unverified. |
| `external` | A system and an identifier, such as a store status or a submission id | Nothing. Labelled unverified. |
| `attestation` | Who said so, and the source message | Nothing. Labelled unverified. |

A receipt is a link and not a proof that a criterion is met. A document receipt
says the document changed, and whether the change satisfies the criterion is a
reader's judgment.

### Visibility

Some work must not surface outside its own context: an embargoed result, a
private draft. A `restricted` item is left out of cross-project views, of
`.carto/profile.md`, of start notes outside its own project, and of any export.
It appears when a query names the item or its project.

This is audience control for one user's own agents and documents. Accounts and
permissions are out of scope.

## Views

Each view is a fold, and every row comes with the `event_id`s that produced it,
so any line can be checked with `--get`. Views span all projects unless `--project`
narrows them, through the same `projectMatcher` as recall.

| View | Returns |
|---|---|
| `ready` | Open items in `now` with no blocker. |
| `blocked` | Blocked items, with the reason and how long. |
| `waiting` | Items waiting on the user. |
| `review` | `contested`, `stated only` and `needs confirmation` items. |
| `changed` | Ledger events since a cursor or a date. |
| `as_of` | The item table as it stood on a date. |
| `item` | One item with its full history and receipts. |

Ledger rows are a small part of the log, so a portable reader can filter them
in one pass and fold in memory with no warm service. That is an expectation and
has not been measured.

## Capture

- **One writer.** A single script validates the event, appends through
  `appendJsonl`, calls `index-event.sh`, and returns a receipt the way
  `record-wrapup.sh` does. Skills and any later MCP tool call it.
- **Promotion from `/wrapup`.** A wrapup's `unresolved[]` line can be promoted
  to an item by an explicit step that records the wrapup's `event_id` as the
  source. Promotion is not automatic.
- **Import.** A one-way reader turns `TODO.md` checkboxes and spec `Status:`
  lines into items in `inbox`. Every imported item starts as
  `needs confirmation`, with its source path and line, because almost no
  existing entry says when it is done.
- **Capture sits where the agent is prompted.** Measured 2026-10-16, about 21%
  of Claude sessions outside this repository made a recall, nearly all on the
  first turn, where the prompt to do so sat. A ledger that depends on agents
  choosing to load a skill will stay empty.

### Authority

| Field | An agent may |
|---|---|
| `stated`, receipts, `waiting_on`, links, new items in `inbox` | Write directly. |
| `bucket`, `target`, `scope`, `resolution` of `dropped` | Propose. The change takes effect when accepted. |

SC records who stated what. It cannot authenticate a person, so an acceptance is
an event an agent writes on the user's instruction, with the source message
named. Authority is recorded and auditable, and it is not enforced.

## How this fits existing designs

- **[Facts](FACTS.md).** Its rules are kept: folds over the log, `event_id`s
  with every number or row, and readers that write no telemetry.
- **[Shared-goal briefing](STANDUP_SHARED_GOAL_PLAN.md).** A goal there is an
  item here, and `goal_id` is the item's `id`. Its claim, progress, blocked and
  handoff events are session-scoped statements about an item and should use the
  same envelope. That plan's split between stated status and observed evidence
  is the one used here.
- **[Event lifecycle](INDEXING_BACKLOG.md).** In item 4 there, events get
  validity intervals from a sidecar. The ledger needs no sidecar, because its
  intervals come from the order of its own events. The two share the word
  `contested` for different conditions; see the open questions.
- **Decision capture ([TODO.md](../TODO.md)).** A decision that changes items is
  a ledger event. The review's questions about ownership, correction,
  provenance and memory preferences apply here unchanged.
- **[Work desk](WORK_DESK.md).** "Park a thread", "Revisit a decision", "Review
  what shipped" and "Prepare a weekly review" in its adjacent-use table are
  ledger views.
- **Topic tracks ([TODO.md](../TODO.md)).** A derived narrative can read the
  ledger. Nothing here depends on tracks.

## Out of scope

- **Running or assigning agents.** Launching sessions, budgets and autopilots
  belong to the platforms and to category 5 tools.
- **Enforcing gates.** SC observes sessions and does not control them. A "done"
  with open criteria is shown as `contested` and is not refused.
- **Multi-user features.** Accounts, permissions, comments, notifications and
  two-way sync with a hosted tracker.
- **Time-boxing and estimation.** Sprints, cycles, story points, capacity
  planning, burndown and scoring formulas.
- **Spec authoring.** Templates, generators and prescribed phases. SC links to a
  spec document and does not say how to write one.
- **Calendars and reminders.** `due` and `not_before` are data for views.
- **Operating rules.** "Check the version before archiving" is guidance for an
  agent and belongs in memory or project instructions.

Later, and not part of a first slice: deeper nesting and critical path, rank
within a target, an Explorer board, a weekly-review view, claims and handoffs,
automatic `contested` detection beyond commits and files, and a one-way export.

## Delivery sequence

1. **Fold prototype.** A pure function over fixture events, with fixtures
   written from the four kinds of work above. No writer and no storage.
2. **Writer and reader.** The one writer, a portable reader with the seven
   views, and verification for `commit` and `event` receipts.
3. **Capture at cue points.** Wrapup promotion, then a start-note line for
   `ready` and `waiting` inside the note's existing cost.
4. **Import.** `TODO.md` and `Status:` lines into `inbox`.
5. **Evaluation.** Whether a fresh agent picks the right next item and avoids a
   superseded plan, compared with search alone.

## Acceptance evidence

Each case needs a control that fails without the behaviour, as
[TESTING.md](TESTING.md) requires.

- One event that closes two items as `conceded` and `moot` appears in both
  histories with the same `event_id`.
- An item whose `target` moved twice returns each target from `as_of` on the
  matching dates.
- A commit receipt on a `parked` item produces an observation and leaves the
  item out of `review`.
- An item closed as `done` with one unreceipted criterion is `contested`. The
  same item with no criteria and no receipt is `stated only`.
- An item with no project appears in the cross-project `ready` view and under
  no project.
- A `restricted` item is absent from a cross-project view and from the profile,
  and present when the query names it.
- An imported row starts as `needs confirmation` and names its source path and
  line.
- An agent's proposed `bucket` change does not alter `ready` until an
  acceptance event names it.

## Open questions and what is not proven

- **Use.** Whether agents would write ledger events, or people would read the
  views, has not been measured. The evaluation in step 5 is the test.
- **The log.** `session-milestones.jsonl` is named in 27 files under `scripts/`,
  `explorer/` and the hooks. Each reader has to be checked for the assumption
  that a milestone row describes a session's lifecycle before ledger rows land
  there.
- **Visibility and recall.** Recall has no notion of audience. A restricted
  item's rows would be indexed and returned to any agent that searches. Either
  those rows skip the semantic index or recall learns to filter them.
- **`contested` is used twice.** In the event-lifecycle design it means two
  facts in conflict. Here it means stated status and receipts in conflict. One
  should be renamed before either ships.
- **The name.** "Ledger" is already the name of `access-ledger.jsonl`.
- **Identifiers.** Concurrent sessions create items, so ids cannot be a counter.
  They also have to be short enough to say and type.
- **`TODO.md`.** Whether it stays prose that links to items, is generated from
  the ledger, or is replaced. Two hand-edited sources would drift.
- **Project-local ledgers.** In this draft they are read through the `ledger`
  receipt kind and are not replaced.
- **Staleness intervals.** The interval after which an item `needs
  confirmation`, per bucket.
- **Acceptance without authentication.** Whether recorded authority is enough,
  or whether proposals need a surface where the user accepts them directly.
