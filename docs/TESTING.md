# Testing

Written for the break-in period after the 0.7.5 line — facts, the pulse census,
and the recall scope fixes all landed within days of each other, and the bugs
they fixed share one shape.

## The failure mode this codebase actually has

Nothing errors. Every real defect found in the recall path returned a
confident, well-formed, wrong answer while every stage reported success:

| Defect | What it returned | What was there |
|---|---|---|
| Window applied after truncation | 1 event | 736 events, 22 sessions, 20 commits |
| Semantic window trimmed client-side | 0 of 500 in-window | a full 24h of matches |
| Project scoped by exact equality | 0 semantic rows | 9,943 indexed points |
| Commits from a worktree | no event | five pushed commits |

So the two instincts that feel like testing are the two that do not work here:

- **"It didn't error"** is not a signal. None of the above errored.
- **"It returned results"** is not a signal. Every one of them returned results,
  just from fewer sources than it should have.

What *is* a signal is **composition**: which ladders contributed, whether a
count matches an independent scan, whether an id can be fetched back. Assert on
those.

## Running the suite

```bash
env -u CLAUDE_SESSION_ID -u CLAUDE_CODE_SESSION_ID -u CODEX_SESSION_ID -u CARTOGRAPHER_SESSION_ID \
  node --test "tests/unit/*.test.js"
```

37 files, ~289 tests, a few seconds. Quote the glob — the shell must not expand
it into a directory argument, which `node --test` rejects. One file:

```bash
node --test tests/unit/project-scope-parity.test.js
```

Two smoke scripts exist for packaging: `tests/release-smoke.sh` and
`tests/source-marketplace-smoke.sh`.

> **Note.** CLAUDE.md's Testing section lists `tests/private/run-tests.sh`,
> `run-fixture-tests.sh`, `benchmark.sh` and `head-to-head.sh`. That directory is
> gitignored and is not present in a fresh checkout, so those commands do not run
> for anyone who clones. Use the `node --test` line above as the real entry point.

## Three things that make a test lie

1. **A live session id.** Delta serving is real: a harness that inherits
   `CLAUDE_CODE_SESSION_ID` silently loses repeat results, so a passing test
   fails on the second run for reasons that have nothing to do with the code.
   Unset all four (`CARTOGRAPHER_SESSION_ID`, `CLAUDE_SESSION_ID`,
   `CLAUDE_CODE_SESSION_ID`, `CODEX_SESSION_ID`).

2. **A live semantic leg.** `hybridSearch` reaches a real Qdrant, so a fixture
   index leaks real corpus ids into assertions — the suite then passes wherever
   the service is down and fails wherever it is up. Pin it off at the top of the
   file, before any import, since ES imports are hoisted:

   ```js
   process.env.CARTOGRAPHER_SEMANTIC = '0';
   ```

3. **Telemetry writes.** A search run from a test or a shell pollutes the served
   and access logs, which then change ranking through promote-on-reuse. Send
   both to `/dev/null` for any exploratory query:

   ```bash
   CARTOGRAPHER_SERVED_LOG=/dev/null CARTOGRAPHER_ACCESS_LEDGER=/dev/null
   ```

## Writing a test that can fail

**A fixture must prove it exercises the defect.** The bugs here are absences, so
a test that merely asserts "results came back" passes against the broken code.
Each test should carry a second assertion establishing that the fixture is hard
enough to matter:

```js
// Without this, the test below passes against the unfixed code.
const inWindowRank = unwindowed.items.findIndex((it) => it.id.startsWith('new-'));
assert.ok(inWindowRank >= 500,
  `the fixture must put in-window rows past FUSION_DEPTH (got rank ${inWindowRank})`);
```

Two traps found while writing exactly these fixtures:

- **BM25 clamps a term whose `df` exceeds about half the corpus** — idf goes
  negative and is clamped to zero. A fixture where *every* document contains the
  query term scores zero across the board and asserts nothing. Pad with
  non-matching documents.
- **An empty index with a project scope is not neutral.** It now correctly
  resolves to "nothing in scope", so a fixture handing `hybridSearch` an empty
  index and a project filter short-circuits before Qdrant is called. Give the
  index the project it claims to search.

The parity assertion worth copying: whatever the keyword ladder accepts, the
semantic filter must be able to name. If those diverge, one ladder is searching
a corpus the other cannot see.

## Break-in smoke checks

Run these after touching recall, scoping, or the logs. **Read the source mix,
not the row count.**

```bash
CLI() { env -u CLAUDE_SESSION_ID -u CLAUDE_CODE_SESSION_ID -u CODEX_SESSION_ID -u CARTOGRAPHER_SESSION_ID \
  CARTOGRAPHER_SERVED_LOG=/dev/null CARTOGRAPHER_ACCESS_LEDGER=/dev/null \
  bash scripts/cartographer-search.sh "$@" --limit 30 --format jsonl --all --no-turbo 2>/dev/null; }

# 1. A short window must still reach every ladder.
CLI 'commit fix' --project psychodeli-webgl-port --since 24h | jq -r '.source' | sort | uniq -c

# 2. A family prefix must reach BOTH ladders — registered or not.
for p in psychodeli psycho webgl; do
  printf '%-12s %s semantic\n' "$p" "$(CLI 'shader palette' --project $p | jq -r '.source' | grep -c semantic)"
done

# 3. Unscoped, unwindowed results must be unchanged by any window/scope work.
CLI 'shader palette' | wc -l
```

A zero in check 1 or 2 for a ladder that should be present is the bug this
codebase keeps having. It will not announce itself.

**Counted answers must be checkable.** Every facts bucket ships the `event_id`s
behind it; fetch them back rather than trusting the number. The query argument
is positional and required, so pass a placeholder:

```bash
bash scripts/cartographer-search.sh "verify" --get evt-abc123,evt-def456
```

## Reconcile before you conclude

Two cheap habits that each caught something this cycle.

**Against a deterministic scan.** Ranking is not exhaustive; counting is. When a
window looks thin, count it independently before blaming the ranker:

```bash
CUT=$(date -u -r $(( $(date +%s) - 86400 )) +%Y-%m-%dT%H:%M:%SZ)
jq -r --arg c "$CUT" 'select((.timestamp//"")>=$c) | select((.project//"")=="<proj>") | .type' \
  ~/Documents/dev/changelog.jsonl | sort | uniq -c
```

**Against the previous implementation.** Before calling something a regression,
run the identical query against the old script and diff the output. A suspected
break in the prompts ladder turned out to be byte-identical to upstream — it was
the documented recency bias, not new damage. That check cost one command and
prevented a wrong fix.

## Know which server you are testing

Several turbo servers run at once from different checkouts and worktrees, and
they all look alike. A "verified" result from the wrong one is worse than no
result — this is the single most expensive mistake available here.

```bash
PID=$(lsof -tnP -iTCP:2526 -sTCP:LISTEN | head -1)
lsof -a -p "$PID" -d cwd -Fn | tail -1     # which checkout is it serving?
```

To test your own build without disturbing anyone, bind a port you have confirmed
is free — a busy port silently leaves the *other* server answering your probes:

```bash
CARTOGRAPHER_TURBO_URL=http://127.0.0.1:2611 node scripts/turbo-server.js &
sleep 9
lsof -tnP -iTCP:2611 -sTCP:LISTEN     # confirm the owner is your PID
```

The warm service holds its index resident, so **a code change needs a restart**
before any probe means anything.

## Known blind spots right now

- **Commits made from a `.claude/worktrees/` session write no event** — not
  `git_commit`, not even `tool_bash`. `/wrapup`'s digest shows an empty commits
  panel and the work is invisible to recall. Check `git log` and say so.
- **The digest's file list contains fragments** — `value.trim`, `console.log`
  and similar leak out of heredocs via the path extractor. Not files.
- **Archival recall is buried by recency.** A near-exact match on an old record
  ranks first in its own ladder and still misses an unscoped result set. Reach it
  with `--since` / `--before`; do not read its absence as an indexing failure.
- **The access ledger is thin**, so hit-rate reports have little to join and new
  lenses have no utility signal yet.

## Triage

| Symptom | First check |
|---|---|
| A ladder missing from the source mix | Is the filter bound before truncation, or applied to the ranking? |
| Semantic returns 0, keyword returns rows | Project scope — is Qdrant being asked for exact equality? |
| A number looks too small | Count the window independently before blaming the ranker |
| Test passes locally, fails elsewhere | A live session id, or the semantic leg not pinned off |
| Test passes against known-broken code | The fixture does not exercise the defect — add the rank/parity assertion |
| API probe disagrees with the CLI | You are almost certainly talking to another checkout's server |
| Old material never surfaces | Recency weighting; scope with `--since` before assuming loss |
| Work missing from a digest | Committed from a worktree — verify with `git log` |

## Ground rules

- The plugin mirror must stay byte-identical: after editing
  `scripts/cartographer-search.sh` or `scripts/bm25-search.awk`, copy both to
  `plugins/session-cartographer/scripts/`. A guardrail test enforces it.
- The Explorer UI is tested by hand. No MCP-based browser automation.
- Never let a "verified" claim rest on a run you did not confirm reached your own
  code — the right server, the right branch, the restart actually done.
