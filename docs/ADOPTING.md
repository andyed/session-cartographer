# Adopting Session Cartographer

What you inherit, what you must configure, and what leaves your machine.

Session Cartographer was built and tuned on one person's machine. Most of that
is invisible and harmless — hooks, scorers, contracts. Some of it is not: the
project registry ships with someone else's project names, the corpus root
defaults to one particular directory, and git backfill depends on your configured
corpus owners. Review those settings before importing history or querying a
project family.

This page is the list of those things. Read it once after installing. The rest
of the docs assume the defaults are yours.

Related: [SETUP.md](SETUP.md) for install and environment variables,
[BRIEFINGS.md](BRIEFINGS.md) for the project registry, [FACTS.md](FACTS.md) for
the aggregate endpoint, [TURBO_MODE_SPEC.md](TURBO_MODE_SPEC.md) for the warm
service.

---

## Three different things get called "the git opt-in"

They have different defaults and different failure modes. Getting them confused
is the most likely way an adopter loses or leaks something.

| | Question | Default | How you change it |
|---|---|---|---|
| 1 | Do my event logs get committed to a repo? | **No** — `.carto/` is gitignored | Un-ignore your own project's path; do not delete the rule |
| 2 | Do my repos' git commits enter the corpus? | **Only if you run the backfill** — filtered to configured corpus owners | `CARTOGRAPHER_PROFILE_AUTHORS`, `--author`, or `--all-authors`; narrow further with `--project`, `--since`, `--limit` |
| 3 | Which projects can a pulse or feed see? | **None** — `--projects` is required | Pass an explicit allowlist |

### 1. Whether your event logs get versioned

`.gitignore` in this repo carries `.carto/` with a comment that says why, and
the comment is the policy:

> Cartographer's own event logs. These are agent-session transcripts, which auto
> mode's classifier treats as sensitive data that belongs in no repo — public or
> private, this one included.
>
> If a project ever wants its chat history versioned deliberately, un-ignore that
> project's own path rather than removing this rule.

Two things follow that are not obvious:

- **This rule protects *this* repo, not yours.** The runtime state directory is
  `$CARTOGRAPHER_DEV_DIR/.carto` (`scripts/index-event.sh`), which sits at your
  workspace root, not inside each project. If your workspace root is itself a
  git repo, add `.carto/` to its `.gitignore` yourself.
- **The five searched logs are not under `.carto/` at all.** They are
  `changelog.jsonl`, `research-log.jsonl`, `session-milestones.jsonl`,
  `tool-use-log.jsonl`, and `prompt-history.jsonl`, written directly into
  `$CARTOGRAPHER_DEV_DIR`. If that directory is a repo, ignore those five names
  too.

Opting *in* means un-ignoring one project's path. It does not mean deleting the
rule for everything.

### 2. Whether other people's commits become your session memory

`scripts/backfill-git-history.sh` walks every directory under
`$CARTOGRAPHER_DEV_DIR` that contains a `.git`. It filters commits to the corpus
owner list **before writing events**, using the shared definition in
`scripts/ownership.js`:

- The default is `git config --global user.name`, plus `Claude` and `claude`.
- `CARTOGRAPHER_PROFILE_AUTHORS="Name One,Name Two"` replaces the human names;
  the agent names remain included.
- `--author "Name One,Name Two"` overrides the entire list for one backfill run.
- `--all-authors` deliberately disables the ingest filter and includes every
  contributor, even in a cloned repository.

Without Node, the script falls back to `git config --global user.name` unless
you supply `--author`. It refuses a backfill when it cannot resolve an owner;
`--all-authors` is the explicit alternative. Git's `--author` matches patterns
against both name and email, rather than enforcing exact identity. Review the
preview if names overlap or contain regular-expression characters.

```bash
# Preview the configured owners' recent commits in one repository.
bash scripts/backfill-git-history.sh --project my-project --since 2026-01-01 --dry-run

# Override the owner list for this run, keeping full names quoted.
bash scripts/backfill-git-history.sh --project my-project --author "Ada Lovelace,Grace Hopper" --dry-run
```

Each imported `git_commit` event records its author. Two consumers also apply
an owner check at read time; the others operate on the history you admitted:

| Consumer | Additional owner check? | Mechanism |
|---|---|---|
| `scripts/build-profile.js` | Yes | Shared `isOwnEvent()`: keep a commit if `session_id` is set, or `author` is in the owner list |
| `scripts/trust-digest.js` | Yes | Same shared rule |
| `cartographer-search.sh` / `/remember` | No | — |
| `POST /api/facts` census, tempo, delta | No | — |
| `cartographer-pulse.sh`, `cartographer-feed.sh` | No | — |
| Explorer UI | No | — |

The ingest filter does not remove commits already imported by an older version
or a previous `--all-authors` run. Those events remain visible to search, facts,
pulse, feeds, and Explorer.

**Practical guidance:**

- Use `--project <name>` to review one repository at a time, and `--since` or
  `--limit` to bound the import.
- Run `--dry-run` first. It prints what it would write and touches nothing.
- Set `CARTOGRAPHER_PROFILE_AUTHORS` before backfilling if your commits use
  additional names. The same setting is used by profile and trust reports.
- To review an earlier broad import, inspect `changelog.jsonl` entries with
  `"type":"git_commit"`, their `author`, and their `git-<short-hash>` event IDs.
  Back up the log before any cleanup, and account for copies in the semantic
  index as well.

### 3. Which projects a pulse or a feed may see

Both `scripts/cartographer-pulse.sh` and `scripts/cartographer-feed.sh` refuse
to run without an explicit allowlist:

```
cartographer-pulse: --projects is required; refusing an unscoped corpus census
cartographer-feed: --projects is required; refusing an unscoped corpus search
```

This is fail-closed on purpose. These scripts exist to feed another agent or a
scheduled job, and an unscoped run would be complete, correct, and inappropriate
— it would sweep in whatever else lives in your corpus and look authoritative
doing it.

The allowlist is **admission, not discovery**: a project absent from it is
invisible to both halves of the pulse. The pulse reports the size of that blind
spot in an "Outside the requested scope" section, by running the same census
unscoped and diffing the counts. That section is the allowlist working as
configured, not a defect.

---

## Configuration you inherit from the maintainer

### `project-registry.json` — someone else's projects

The file that ships is the maintainer's, with 10 aliases:

```
scrutinizer  psychodeli  tvapps  interests  sciprogfi
websites     iblipper    devtools  frakbot   wyrdforge
```

Each maps to a list of directory basenames as they appear in the maintainer's
event logs (`psychodeli-webgl-port`, `oled-fireworks-tvos`, and so on).

It is an **expansion table**, consumed by `cartographer-search.sh --project`,
`/focus`, `cartographer-feed.sh`, `cartographer-pulse.sh`, `build-profile.js`,
and other registry-aware callers. A name that is *not* an alias passes
through as a literal project name, so an unedited registry does not break
anything — but a name that *is* an alias expands to repositories that do not
exist on your machine, and you get zero results for a scope you thought you had
set. `frakbot`, for instance, expands to `nanobot`, `openclaw`, and a
deprecated OpenClaw path.

Create your own registry at
`~/.config/session-cartographer/project-registry.json`, or beside the file named
by `CARTOGRAPHER_CONFIG`. Set `CARTOGRAPHER_PROJECT_REGISTRY` to select an explicit
path. The first available layer wins: explicit path, user registry, then shipped
registry. **Layers do not merge**: your registry replaces the shipped aliases.
A selected file that is invalid is an error, rather than a silent fallback.

Bootstrap from your event logs, then review the inferred groups:

```bash
node scripts/bootstrap-project-registry.js --dry-run
node scripts/bootstrap-project-registry.js
bash scripts/project-registry.sh --path
```

The writer refuses to overwrite an existing registry without `--force`. Edit
the user-owned file; plugin updates can overwrite the shipped copy. Direct
`/api/recall` calls do not expand registry aliases, so pass project names or an
appropriate substring there. Format and worked examples:
[BRIEFINGS.md](BRIEFINGS.md#project-registry).

### `integrations/hermes/` — a worked example, not a supported entry point

`integrations/hermes/frakbot-carto-feed.sh` is a personal policy wrapper. It:

- hardcodes `CARTO_ROOT` to `/Users/andyed/Documents/dev/session-cartographer`
  (overridable with `CARTOGRAPHER_ROOT`);
- carries a 35-name personal project allowlist (overridable with
  `FRAKBOT_CARTO_PROJECTS`);
- appends a consumer instruction paragraph aimed at one specific scheduled agent.

Read it for the shape of a policy wrapper — in particular its comment block on
what it deliberately excludes and why, which is the reusable part. Do not
install it as-is.

**`scripts/cartographer-pulse.sh` is the supported generic entry point.** Write
your own thin wrapper around it with your own allowlist.

### Corpus root — and the 409 that catches you getting it wrong

Everything reads from one directory:

| Variable | Default |
|---|---|
| `CARTOGRAPHER_DEV_DIR` | `~/Documents/dev` |

If your projects live elsewhere, set it in your shell profile *before* the first
hook fires — otherwise you get two corpora and neither is complete.

The subtle failure is not a missing directory; it is a **wrong** one. The warm
Turbo service indexes one corpus, fixed when it spawned, and is reached over a
fixed loopback port. A client that had `CARTOGRAPHER_DEV_DIR` set to a different
corpus used to be answered, silently, from the shared one.

Both `explorer/server/recall-contract.js` and `explorer/server/facts-contract.js`
therefore accept an optional `corpus_root` assertion, and
`explorer/server/recall.js` / `facts.js` reject a mismatch with **HTTP 409**:

```
this service indexes /Users/you/Documents/dev, not /Users/you/work
```

Treat that 409 as the feature it is. A wrong-corpus result is worse than a slow
one or an error, because it looks authoritative — the request validates, the
response validates, and the numbers describe a different machine. Callers that
know which corpus they mean should say so; callers that omit the field keep
working.

The same reasoning is why a `delta` cursor carries `corpus_root` (see below).

### Ports are fixed defaults, and a busy machine is a live trap

| Port | Service | Override |
|---|---|---|
| 2526 | Explorer API / Turbo recall + facts | `CARTOGRAPHER_API_PORT`, `CARTOGRAPHER_TURBO_URL` |
| 2527 | Explorer UI (Vite) | `explorer/vite.config.js` |
| 6333 | Qdrant | `CARTOGRAPHER_QDRANT_URL` |
| 8890 | Embedding server | `CARTOGRAPHER_EMBED_URL` |

Turbo state lives in `$CARTOGRAPHER_DEV_DIR/.carto/turbo` unless
`CARTOGRAPHER_TURBO_STATE_DIR` says otherwise.

Port 2526 is shared by design: `scripts/turbo-server.js` (headless) and
`explorer/server/index.js` (the Express Explorer) mount the same
`/api/recall` and `/api/facts` on it, so whichever is running is the one a
client reaches. `cartographer-turbo.js` handles that by probing
`/api/recall/health` before spawning and reusing a compatible service.

**The probe validates both `backend: "explorer"` and the current recall contract
version.** An unrelated process returning HTTP 200 is rejected. A compatible
Cartographer from another checkout can still pass, however: the probe validates
the API contract, not which branch or source tree serves it. Confirm the corpus
and checkout before treating a reused service as your current build.

```bash
node scripts/cartographer-turbo.js status
curl -s http://127.0.0.1:2526/api/recall/health
# expect backend "explorer" and a compatible contract_version
curl -s http://127.0.0.1:2526/api/facts/health
# expect: {"status":"ok","backend":...,"corpus_root":"...","verbs":[...],...}
carto_pid=$(lsof -tnP -iTCP:2526 -sTCP:LISTEN | head -1)
lsof -a -p "$carto_pid" -d cwd -Fn   # which checkout is that process serving?
```

Use your configured URL and port when they differ from the defaults above.
After changing runtime code, refresh the managed service with
`node scripts/cartographer-turbo.js stop` followed by `start`; a running process
still holds the previously loaded code. An externally managed Explorer must be
restarted through its own launch process. See
[TESTING.md](TESTING.md#know-which-server-you-are-testing) for isolated testing
without disturbing another checkout's service.

If 2526 is genuinely taken, `turbo-server.js` reports `port_in_use` and keeps
serving over its file transport rather than failing — check
`node scripts/cartographer-turbo.js status` and look at the `transport` field.

---

## What leaves your machine

**Nothing.**

- The Explorer API binds `127.0.0.1` explicitly (`explorer/server/index.js`), as
  does the Vite dev server (`explorer/vite.config.js`). Never `0.0.0.0`.
- Qdrant and the embedding server are local binaries on loopback ports. No
  hosted vector database, no embedding API.
- Turbo recall and facts are loopback-only; where a sandbox denies the loopback
  connect, the fallback is a **file** spool under `.carto/turbo`, not a network
  call.
- `scripts/cartographer-facts.js` writes nothing at all.

What crosses a boundary is what *you* pipe somewhere — a pulse into a scheduled
agent's prompt, a profile into a chat. That makes the contents of the logs your
business.

### What is actually in the logs

| Log | Contains |
|---|---|
| `changelog.jsonl` | Commit subjects, changed file paths, diff shape, session milestones |
| `research-log.jsonl` | URLs fetched and search queries issued |
| `session-milestones.jsonl` | Lifecycle events, transcript paths, `/wrapup` synthesis |
| `tool-use-log.jsonl` | File paths written, **bash command lines** (opt-in) |
| `prompt-history.jsonl` | **Your prompts, verbatim**, projected from `~/.claude/history.jsonl` |

Bash command logging is opt-in (`CARTOGRAPHER_LOG_TOOL_USE=true`, default off).
Prompt history is derived by `scripts/build-prompt-history.js` and is on if you
run it.

### The pulse's privacy line is narrower than it sounds

Both `cartographer-pulse.sh` and `cartographer-feed.sh` print:

```
- Privacy: summaries only; no raw transcript content is included
```

That is true and it is not the whole story. **The summary field is where the
sensitive text lives.** Specifically:

- `log-tool-use.sh` writes `SUMMARY="Ran: $COMMAND"` for a bash event — the
  command line, truncated to 200 characters. Git pushes get
  `SUMMARY="Pushed: $COMMAND"`.
- `build-prompt-history.js` writes the user's prompt verbatim as the summary of
  a `prompt` event.
- The feed prints `.summary` at up to 500 characters per result.

The default `--exclude-event-types` regex is `^tool_(bash|file_edit)$`, which
keeps ordinary bash and edit events out of the *relevance* half. It does **not**
exclude `git_push` (whose summary is a command line) or `prompt` (whose summary
is your prompt), and it is a default a caller can override. The counted half
reports types and counts with sample `event_id`s, and prints summaries only in
its Commits section.

So before piping a pulse into a scheduled agent, read one run yourself.

For contrast, `scripts/trust-digest.js` makes the stronger promise the pulse
does not: it emits **identifiers, never arguments** — commands reduce to their
leading word (resolved against `PATH`), URLs to their host (shape-checked). Its
output is meant to be pasteable into a settings file without a secret review.
The pulse makes no such claim.

---

## The cheapest on-ramp: `POST /api/facts`

If you want a signal from Cartographer on day one, before installing anything
beyond the plugin, use the facts endpoint.

**It needs neither Qdrant nor the embedding server.** The three verbs —
`census`, `tempo`, `delta` — are pure linear folds over the JSONL logs
(`explorer/server/facts.js` imports the log reader, the time parser, the project
filter, and the sentinel helpers; nothing vector-related). Semantic search is a
separate, optional path. Nothing about the facts verbs touches it.

```bash
# start the Explorer API (or the headless Turbo service)
cd explorer && npm install && npm run dev

# what happened in the last 24 hours, counted
node scripts/cartographer-facts.js --verb census --since 24h
```

Every count ships with a bounded sample of the `event_id`s behind it, so you can
check it rather than trust it:

```bash
# ids are comma-separated; the query argument is ignored, so any placeholder works
bash scripts/cartographer-search.sh x --get chg-1f2a,tul-04c1
```

Full request/response contract, bounds, and error table:
[FACTS.md](FACTS.md). Do not read this section as a substitute for it.

### `delta` cursors are machine-local — by design

A `delta` cursor is base64url of `{ v, corpus, pos }`, where `pos` is a per-log
`{ offset, boundary }` map: a byte offset plus a SHA-1 of up to 4096 bytes of
file content immediately before that offset.

Carry a cursor to another machine and the boundary hash will not match the bytes
there. The response reports that source in `stale` with reason `rewritten`,
contributes no events for it, and re-baselines to the current end of file.

**That is expected behaviour, not a bug.** The alternative — emitting a diff
computed against bytes that no longer mean what they meant — would be a wrong
answer that validates. The cursor also carries `corpus_root` for the same
reason: offsets are meaningless against a different corpus, and a wrong-corpus
delta would resolve, validate, and describe someone else's machine.

Corollaries for a multi-machine setup:

- Keep one cursor per (machine, corpus) pair. Do not sync cursors between
  machines, and do not put them in a shared dotfiles repo.
- A first call with no cursor is a **baseline**: it records a position, returns
  zero events, and claims nothing is new. That is the correct answer, not an
  empty result.
- A malformed cursor throws. It is never quietly downgraded to "start from now."

---

## Footprint

Cartographer's own source is ~2 MB. The two things that scale with use are the
JSONL logs on disk and the warm service's resident set.

**Memory.** Measured on the maintainer's corpus, and recorded in
[TURBO_MODE_SPEC.md](TURBO_MODE_SPEC.md):

| Measurement | Value |
|---|---|
| Explorer process (2026-08-29, ~108k events) | ~583 MB RSS, ~283 MB JavaScript heap |
| Event load (2026-08-29) | 1.00 s for ~108k events |
| Event load (2026-09-08, [FACTS.md](FACTS.md)) | 881 ms for 127,129 events |

For rough planning, treat the whole resident set as per-event: **~5.5 KB RSS and
~2.7 KB JS heap per event.** These are single-point measurements that do not
separate fixed cost from marginal cost, so the per-event figure is an upper
bound — but it is the right direction for extrapolation. A corpus five times the
size should be budgeted at multiple gigabytes, and that is a reason to run the
warm service deliberately rather than leave it running by default. Turbo Mode is
opt-in for exactly this reason; the portable CLI has no resident cost.

**Disk.** The five searched logs on the maintainer's machine, measured today:

| Log | Lines |
|---|---:|
| `changelog.jsonl` | 107,027 |
| `tool-use-log.jsonl` | 82,479 |
| `prompt-history.jsonl` | 17,493 |
| `session-milestones.jsonl` | 7,526 |
| `research-log.jsonl` | 4,752 |
| **Total** | **219,277 lines / 127 MB** |

That is roughly **600 bytes per log line**. Note that `tool-use-log.jsonl` is
39% of the lines and is the opt-in one — leaving `CARTOGRAPHER_LOG_TOOL_USE`
off roughly halves the growth rate.

The [Footprint](../README.md#footprint) figure in the README (1.5 MB of event
logs) predates both tool-use logging and prompt history. Plan against the table
above.

---

## Adoption checklist

```
[ ] Set CARTOGRAPHER_DEV_DIR if your projects are not under ~/Documents/dev,
    before the first hook fires.
[ ] If that directory is a git repo, gitignore .carto/ and the five *.jsonl logs.
[ ] Create a user-owned project registry and verify it with
    `bash scripts/project-registry.sh --path`; it replaces the shipped aliases.
[ ] Set CARTOGRAPHER_PROFILE_AUTHORS if you commit under a name other than
    `git config --global user.name`.
[ ] Backfill git history per-repo with --project, after a --dry-run.
    Review the owner list; use --all-authors only for a deliberate broad import.
[ ] Confirm ports 2526/2527/6333/8890 are free, or override them. Verify what
    corpus and checkout answer on 2526 before trusting a reused service.
[ ] Try `cartographer-facts.js --verb census --since 24h` before installing
    Qdrant. It needs neither Qdrant nor the embedder.
[ ] Read one full pulse output yourself before piping it into any scheduled
    agent. Summaries carry bash command lines and verbatim prompts.
[ ] Write your own wrapper around scripts/cartographer-pulse.sh. Do not install
    integrations/hermes/frakbot-carto-feed.sh as-is.
```
