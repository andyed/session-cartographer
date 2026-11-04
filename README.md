# Session Cartographer

**Reinstate context and work across sessions.** Return to a line of thought,
recover why a decision was made, or bring an insight from another conversation
into the task at hand.

Context accumulates through the work itself. Cartographer makes captured activity
and retained conversations searchable, so you can recover the context a question
calls for, whenever it arises. Follow an idea across sessions, revisit an earlier
investigation, and connect work whose relationship only becomes apparent later.
You can work organically without preparing a starting context for every future
session.

Claude Code and Codex contribute to the same local history and can recall each
other's work; a read-only adapter brings Hermes history into the corpus too.
Use `/remember` to find the earlier reasoning and follow it back to its source
conversation, or browse the Explorer to reconnect with a thread of work.

[Download a release](https://github.com/andyed/session-cartographer/releases) ·
[Setup guide](docs/SETUP.md) · [Changelog](CHANGELOG.md) ·
[Related projects](docs/landscape-survey.md)

<!-- The "Try the Explorer demo" link is out of the opening until gh-pages is
     rebuilt: the live build predates the Memory Desk and serves real March
     activity. Restore it here after the rebuild. -->

![One day of concurrent agent sessions, one column per project](docs/screenshots/timeline-concurrent.webp)

*One day of recorded work: 31 tasks and 3,301 records across nine projects.
Private project names are replaced for these screenshots.*

Capture requires no LLM, and keyword recall needs no server. Semantic search and
the Explorer are optional. The default setup keeps your history on your machine.

## What you can do

| Task | Skill | Result |
| --- | --- | --- |
| Reinstate context | `/remember <question>` | Earlier reasoning from across sessions, with links to the source conversations |
| Return to a project | `/remember --project <name>` | Recent work, related projects, and recurring procedures to help pick up the thread |
| Explore a thread of work | `/carto` | Search, timelines, and transcripts for moving between session contexts |
| Preserve what emerged | `/wrapup` | Decisions, discoveries, and unfinished questions made easier to return to |
| Revisit an investigation | `/investigate <bug>` | Earlier diagnoses brought into the current investigation, with hypotheses tracked through verification |
| Check concurrent work | `/standup` | Recent peer activity, shared-file edits, and commit attribution |
| Speed up recall | `/turbo` | Enable, inspect, or disable the shared warm search service |

These are Claude Code command names. In Codex, invoke the corresponding skill,
for example `$session-cartographer:remember` or `$session-cartographer:turbo`,
and describe the query or action. Project orientation replaces the retired
Cartographer `/focus` skill.

Additional skills: Codex's `$session-cartographer:setup` diagnoses local semantic
service access; `/trustmap` proposes Claude Code auto-mode environment settings
from recorded usage. See [auto-mode guidance](docs/AUTO_MODE.md).

## The Explorer

`/carto` opens the Explorer, a local web app over the same history `/remember`
searches. Each view below shows the same day of real work.

<table>
<tr>
<td colspan="2">
<a href="docs/screenshots/timeline-feed.webp"><img src="docs/screenshots/timeline-feed.webp" alt="Timeline event feed with a strip of images written during the day"></a>
<br><b>See what a day produced.</b> 78 images written in 16 bursts across 7
sessions, above the events that wrote them.
</td>
</tr>
<tr>
<td width="50%" valign="top">
<a href="docs/screenshots/timeline-burst.webp"><img src="docs/screenshots/timeline-burst.webp" alt="One burst of renders opened in the event feed"></a>
<br><b>Open a burst.</b> 17 images one session wrote between 5:15 and 5:50 AM,
linked to the conversation that produced them.
</td>
<td width="50%" valign="top">
<a href="docs/screenshots/memory-tasks.webp"><img src="docs/screenshots/memory-tasks.webp" alt="Memory Desk task list"></a>
<br><b>Pick a task back up.</b> 31 tasks in the day, latest first, each with its
project, agent, and last activity.
</td>
</tr>
<tr>
<td width="50%" valign="top">
<a href="docs/screenshots/memory-day.webp"><img src="docs/screenshots/memory-day.webp" alt="Day view grouping commits by project"></a>
<br><b>Check a day against Git.</b> 75 commits from 30 sessions across 18
projects, with a Markdown receipt to copy.
</td>
<td width="50%" valign="top">
<a href="docs/screenshots/session-review.webp"><img src="docs/screenshots/session-review.webp" alt="Split diff of one file, bounded by a session's activity"></a>
<br><b>Review what a session changed.</b> The diff starts at the last commit
before the session began: +46 −2 in <code>Timeline.jsx</code>.
</td>
</tr>
<tr>
<td width="50%" valign="top">
<a href="docs/screenshots/transcript.webp"><img src="docs/screenshots/transcript.webp" alt="Transcript reader with session evidence alongside"></a>
<br><b>Read the conversation behind it.</b> 858 messages with tool calls folded,
beside the documents and commits the session produced.
</td>
<td width="50%" valign="top">
<a href="docs/screenshots/search.webp"><img src="docs/screenshots/search.webp" alt="Search results with project, event type, and agent facets"></a>
<br><b>Search every agent at once.</b> 416 results from keyword and semantic
ranking in 209 ms, faceted by project, event type, and agent.
</td>
</tr>
<tr>
<td colspan="2">
<a href="docs/screenshots/image-wall.webp"><img src="docs/screenshots/image-wall.webp" alt="Image wall grouped by project"></a>
<br><b>Browse every image sessions wrote.</b> 728 from the last 7 days, read
from 90 transcripts in 0.8 s and grouped by project.
</td>
</tr>
</table>

*Public repositories keep their names. Other project, file, and session names
are replaced, and home directories read `/home/demo`.*

## Install

**Requirements:** Node.js 22 or newer, bash, and jq. Node runs the hook launcher;
Git for Windows supplies bash on Windows. Every hook reads its payload with jq, and
without it the plugin installs cleanly but captures nothing. Install jq with
`winget install jqlang.jq` (Windows), `brew install jq` (macOS), or
`apt install jq` (Debian/Ubuntu). On Windows, Git Bash supplies bash. A
session started without jq prints a notice saying so.

Download and extract `session-cartographer-<version>.tar.gz` from
[Releases](https://github.com/andyed/session-cartographer/releases), keeping the
extracted directory in a stable location. One bundle supports both agents.
Run the commands for your agent from that directory:

```bash
# Codex
codex plugin marketplace add "$PWD"
codex plugin add session-cartographer@session-cartographer

# Claude Code
claude plugin marketplace add "$PWD"
claude plugin install session-cartographer@session-cartographer
```

A source checkout can be registered with the same commands.

**Codex hook approval:** launch the Codex CLI, run `/hooks`, select Session
Cartographer, and approve its hook definitions. Repeat when an update changes
those definitions. Start a fresh task/session after installation or approval.

**Choose your history location.** The corpus defaults to `~/Documents/dev`.
Set `CARTOGRAPHER_DEV_DIR` in the environment used by your agent if your workspace
lives elsewhere. File edits, commands, and Git commit capture require the opt-in
`CARTOGRAPHER_LOG_TOOL_USE=true`. Logs can contain verbatim prompts and command
lines; keep them out of version control.

Read [Adopting Cartographer](docs/ADOPTING.md) for corpus ownership, project
aliases, privacy, and resource use. [Release installation](docs/RELEASE_INSTALL.md)
covers bundle verification and upgrades.

### Optional semantic search

Keyword search works immediately against captured events. Add local Qdrant and
an embedding server to search by meaning and recall indexed conversation turns.
Follow [Setup](docs/SETUP.md); no Docker is required. In Codex, use
`$session-cartographer:setup` to diagnose access and request the necessary
loopback permissions. A sandbox-denied request does not establish that a service
is down.

### Optional Explorer

From a source checkout:

```bash
npm ci --prefix explorer
npm run dev --prefix explorer
```

In a release bundle, the Explorer directory is
`plugins/session-cartographer/explorer`; use that path instead. Open
[127.0.0.1:2527](http://127.0.0.1:2527/), or use `/carto` after installing its
dependencies. The UI binds to loopback only.

Timeline, search, sessions, and transcripts work without Turbo. The Memory Desk
uses the managed Turbo backend and offers **Start**, **Enable**, or **Refresh
Turbo** when needed. Opening the page directly does not start that backend.

## Everyday use

Start with the context you need now: a decision to revisit, an investigation to
resume, or an idea you remember exploring elsewhere. Ask `/remember` a concrete
question, then narrow by project or date when useful:

```text
/remember why did we change the retry policy
/remember --project my-app
/remember deployment --project my-app --since 7d
```

Search summaries are intentionally short. Follow the transcript to recover the
conversation, or fetch complete event records from a checkout:

```bash
bash scripts/cartographer-search.sh "retry policy" --project my-app
bash scripts/cartographer-search.sh "lookup" --get evt-abc,evt-def
```

Repeated searches in one session suppress previously served IDs; `--all` includes
them again. `--transcript` adds a raw-text fallback for conversations that have
not been semantically indexed. For older material, scope the date window rather
than treating an absent top result as proof that the history is missing.

For standing questions about the overall work, `.carto/profile.md` is a derived
corpus summary. Rebuild it with `node scripts/build-profile.js`. Project aliases,
bounded feeds for other agents, and briefings are described in
[Project Registry & Briefings](docs/BRIEFINGS.md).

### Memory Desk and digests

![Explorer activity: session field, activity traces, and token comparison](docs/screenshots/memory-activity.webp)

*Real recorded activity, with project and file names replaced for these screenshots.*

The Explorer's **Memory Desk** is an evolving workspace for returning to tasks
and inspecting their evidence. It includes:

- A shared time range, project and text filters, and saved return points.
- Task and file browsing, linked activity charts, and transcript navigation.
- Current-file previews and Git diffs bounded by a session's recorded activity.
- **Recall**, showing searches, ranked results, and explicitly marked uses.
- **Day**, grouping a local calendar day's work by project and checking commits
  against Git, with a copyable Markdown receipt.

Session and file links preserve the selected context. File content is current;
diff boundaries use commit times and can include other sessions' changes.
Recent activity is evidence of an event, not proof that an agent is still running.
See [the work desk](docs/WORK_DESK.md) and
[Memory link reference](plugins/session-cartographer/skills/carto/SKILL.md#deep-links-into-memory-share-with-the-operator).

The same digests are available without the UI:

```bash
node scripts/session-digest.js --session <session-id>
node scripts/session-digest.js --day yesterday --md
```

`/wrapup` adds the reasoning hooks cannot capture: decisions, discoveries, and
open questions. It is useful for material sessions; ordinary sessions already
have their automatic history. `/standup` reports recent activity and file overlap;
[shared-goal briefings and handoff records](docs/STANDUP_SHARED_GOAL_PLAN.md)
remain planned.

### Turbo Mode

Turbo keeps the search index in memory so each recall avoids rereading the corpus.
One setting covers both agents, in `~/.config/session-cartographer/config.json`.
Use `/turbo enable`, `/turbo status`, or `/turbo disable` in Claude Code; in Codex,
invoke `$session-cartographer:turbo` and request the action.

Turbo starts disabled. The `/carto` skill enables it automatically on machines
with at least 16 GB RAM when the estimated index fits within 8% of RAM; otherwise
it leaves the choice to you. On machines below 16 GB, an enabled service defaults
to exiting after 30 idle minutes. Status reports the local memory estimate.

Ordinary recall uses the warm service through loopback HTTP or a private file
transport for restricted sandboxes. An unavailable or incompatible service falls
back to the portable CLI; `--no-turbo` forces that path. Exact record operations
such as `--get` stay on the portable path. The two backends can rank differently.
See [Turbo Mode](docs/TURBO_MODE_SPEC.md) for behavior and evaluation.

## Bring existing history

Hooks capture future activity. To seed a new corpus, run these from a checkout
(or the release bundle's `plugins/session-cartographer` directory):

```bash
# Preview your configured authors' commits before importing; remove --dry-run to write.
bash scripts/backfill-git-history.sh --project my-app --since 2026-01-01 --dry-run

# Import native Claude Code and Codex memory into the event logs.
bash scripts/backfill-memories.sh

# Index historical conversation turns; requires Qdrant and the embedding server.
bash scripts/retro-index.sh --limit-days 30
```

Native memory files remain authoritative; import does not edit them.
[Codex memory migration](docs/MIGRATION_CODEX_MEMORY.md) covers semantic indexing
and refresh. [Setup](docs/SETUP.md) covers deeper reconstruction and older-data
repairs; [turn migration](docs/MIGRATION_TURNS.md) explains transcript indexing.

## How it works

```text
Claude Code / Codex hooks → shared JSONL event logs
                            ├── /remember: keyword + optional semantic recall
                            ├── Explorer: browse sessions and inspect work
                            ├── digests and /wrapup: activity and judgment
                            └── Qdrant indexer: semantic event and turn search
```

The portable keyword scorer is bash + awk. The API has a separate JavaScript
scorer. Both combine BM25 keyword ranking with optional Qdrant results through
Reciprocal Rank Fusion. Transcript turns are grouped at indexing time; the
original transcripts remain the source for full context.

The default configuration keeps capture, storage, search, and embeddings local.
Hooks preserve provider provenance while both agents search the shared corpus.
The [co-occurrence graph](docs/COOCCURRENCE.md) uses structured project and
procedure signals to support orientation and procedural recall.

Coverage depends on enabled hooks, retained transcripts, and completed imports.
Keyword search has no exact phrase matching or stemming, and its tokenizer is
focused on Latin scripts. Semantic search broadens matching but does not guarantee
that every relevant session will rank. See [scoring](docs/SCORING.md),
[rank fusion](docs/RANK_FUSION.md), and [archival recall](docs/ARCHIVAL_RECALL.md).

## Evaluation

Cartographer records which results it serves and which agents explicitly use,
and checks activity against source history. Evaluation covers retrieval,
capture coverage, and adoption; these are separate measures.

<details>
<summary>Measurement history, findings, and fixes</summary>

Measured on the author's own corpus: one person's Claude Code and Codex work,
March to October 2026.

| Result | How it was measured |
| --- | --- |
| **736 events, not 1.** A scheduled agent asked ranked search what happened in a 24-hour window and got 1 event back. | A deterministic count over the same window found 736 events, 22 sessions, and 20 commits and pushes across four repositories. Counting is now its own API, and every count ships sample event ids so it can be checked with `--get`. See [Facts](docs/FACTS.md#why-now). |
| **43 of 125 landed commits** were missing from the session logs on 2026-09-26. | The day digest checks every logged commit against git; its 125 matched an independent `git log` count, repository by repository. Over 26–27 September, 23 of the 46 missing commits traced to a bug in the commit hook itself, which logged at most one commit per call; fixed in 0.8.1. See the [changelog](CHANGELOG.md#featdigest-a-day-digest-checked-against-git). |
| **287 of 1,350 Claude Code sessions (21%)** called recall at all in the 30 days to 2026-10-15. Codex recalled in 1 of 59 sessions that saw the startup nudge. | Counted from Cartographer's retrieval telemetry, which records the session and call id behind every result it serves. Recall already answered quickly (p90 377 ms), so the gap was reach, not speed; recall now also ships as MCP tools. See [MCP](docs/MCP.md#why). |
| **9 of 60 records older than 90 days** reached the top 10 when looked up by their own words; time decay let recent material outrank them. After the fix, 60 of 60. | `scripts/age-curve.js` on the live corpus on 2026-10-16: 204,341 events, 240 known items in four age buckets, 40 recency cases, semantic leg off. For the 90-day-plus bucket, the warm engine's top-10 hit rate went from 0.15 to 1.00, and recency stayed at 0.65. On a paired subsample of 30 cases, the portable CLI went from 0.23 to 1.00. A CI gate on a synthetic corpus now holds the curve. See [Scoring](docs/SCORING.md#the-age-curve-the-gate). |

</details>

## Development and reference

Use Node 22 for development and CI parity. The public unit suite is:

```bash
env -u CLAUDE_SESSION_ID -u CLAUDE_CODE_SESSION_ID -u CODEX_SESSION_ID -u CARTOGRAPHER_SESSION_ID \
  node --test tests/unit/*.test.js
```

Read [Testing](docs/TESTING.md) for dependency setup, isolated browser tests,
packaging checks, and safeguards against writing test data into a live corpus.
`tests/private/` is optional and is not needed by fresh clones or public CI.

To capture the Explorer with randomized names over your own activity, use the
[JavaScript screenshot tool](tools/screenshots/README.md).

- [Provider architecture](docs/PROVIDERS.md), [log schemas](docs/LOG_SCHEMAS.md),
  and [custom hooks](docs/CUSTOM_HOOKS.md)
- [Explorer architecture](docs/EXPLORER_SPEC.md) and [Internals](docs/INTERNALS.md)
- [Demo and evaluation](docs/GHPAGES_DEMO_SPEC.md) and
  [related projects](docs/landscape-survey.md)

## Credits and license

Search originated in a fork of Shreyas Patil's
[claude-code-session-bridge](https://github.com/PatilShreyas/claude-code-session-bridge).
The co-occurrence graph was inspired by DeepBlueDynamics'
[lume](https://github.com/DeepBlueDynamics/lume) and the Semantic Knowledge Graph
work of Trey Grainger and Erik Hatcher; Cartographer ranks structured session
entities with Dunning's log-likelihood ratio (G²).

[MIT](LICENSE). Notices for the adapted third-party code are in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
