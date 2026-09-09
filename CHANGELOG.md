# Changelog

## 0.7.6 — Unreleased

### Release preparation

Git backfill now preserves full author names as single patterns, ignores empty
comma-separated entries, and rejects empty or missing explicit author values.
Regression tests exercise the actual shell ingest path against unrelated authors.
Adoption guidance now matches the owner filter, user-owned registry, and Turbo
service checks.

Release metadata is aligned and checked before packaging. CI and the release
workflow now require the Explorer build and working-memory browser regression on
Node 22 in addition to the unit and package checks.

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
no way for the caller to know it is not *the* answer. The daily FrakBot pulse
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

The FrakBot allowlist was widened for the first time against evidence rather
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
no registry expansion. A bare `--project psychodeli` therefore reached the
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
| `--project psychodeli` (semantic rows) | 0 | 104 |
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
FrakBot daily pulse since Turbo shipped failed the contract and fell back to
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

Measured on the real FrakBot feed: 12,386 ms via CLI fallback before,
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
one attributed `session-cartographer`'s rows to `attentional-foraging`'s remote —
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

Two orientation lenses search can't provide, from one Dunning-G² engine over the **structured** fields of the event logs (project, detected tech-signals) — never tokenized prose (a prose term-graph just rebuilt machinery cliques and duplicated the Qdrant path). **Project co-activity** (`--related <project>`) uses the calendar *day* as the document — 97% of sessions are single-project, so the cross-thread signal lives in same-day concurrency, not same-session — surfacing research threads like `allserp-paper ↔ ettac-paper`. **Maneuver map** (`--maneuvers <project>`) detects tech-signals (`gh-release`, `cloudflare-pages`, `overleaf-sync`, …) from a signature catalog over `summary + files_changed`, in two views: *composition* (signal × signal, doc = session — `gh-release + version-tag + lfs` = the Psychodeli DMG release) and *transfer* (project × project, doc = signal — which projects share a procedure).

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
