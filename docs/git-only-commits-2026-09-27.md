# Git-only commits, 2026-09-26 and 2026-09-27

Written 2026-09-27. **Fix 1 is implemented and committed, not yet
installed** (see "Status of fix 1" below). Fixes 2 to 5 are not. Private
repositories are named repo-a, repo-b and repo-c.

`session-digest.js --day` listed 46 git-only commits: 43 on 09-26 and 3 on 09-27.
All 46 trace back to exactly one tool call each: 38 distinct calls, 37 from 10
Claude Code sessions and 1 from Codex (`01a0df72`). No git-only commit came from
a worktree subagent, a human terminal or a script. None of the 46 has a
`git_commit` row under any project; the one row that names a git-only sha
(`c59c766`) is its cherry-pick original.

## Method

1. **Match.** Each sha's committer time was bracketed by a tool call's
   `[tool_use ts, tool_result ts]` across `~/.claude/projects/**` (subagents
   included) and `~/.codex/sessions` + `archived_sessions`. Every sha matched a
   call whose command runs `git` and whose text or output carries the sha or the
   subject.
2. **What was written.** The rows the hook wrote for that session inside the same
   window were pulled from `changelog.jsonl` and `tool-use-log.jsonl`.
3. **Replay.** Each call was replayed through three hook builds: installed 0.7.9,
   installed 0.8.0 (`d955ef7`), and checkout HEAD (`ea691b7`, committed blob).
   The replay ran in a sandboxed `HOME` with scratch repos holding fresh
   commits that stand in for the ones the call made, real shas mapped to scratch
   shas in stdout, the post-command cwd as the payload cwd, and Qdrant pointed at
   a dead port. **The replay reproduced the logged outcome for all 38 calls**
   (row type, and which sha), which is what identifies the build that actually
   ran.

## Which hook ran: the installed one, but not in every session

The 0.8.0 install finished at **2026-09-26 22:56:07Z (15:56 PDT)**
(`installed_plugins.json`, cache mtime). Six 0.7.x cache directories
(0.7.2–0.7.9) are still on disk.

- **A Claude Code session keeps the hook version it started with.** Sessions
  that started before 22:56Z (`084b29bc`, `631be865`, `345f9ef0`, `3f765c61`,
  `9ade7750`; `631be865` and `9ade7750` each ran about 11 h) logged exactly what 0.7.9 logs.
  After the install, two calls in those sessions give different results under
  0.7.9 and 0.8.0, and both match 0.7.9. One is `be70d73` at 23:00Z, which got
  no row at all. Of the calls in sessions that started after the install, 26
  of 28 match 0.8.0, and both exceptions have an explanation. `cc8dfa64`'s
  first transcript line comes one second after the install finished, so it
  loaded its hooks just before. `e7d21149`'s call exited 1, and Claude Code fires
  no `PostToolUse` for a failed call, so no build would have logged it.
- **Codex re-reads its hook on every call, but has its own copy, and that copy
  lagged.** `~/.codex/plugins/cache/.../0.8.0` appeared at 17:51 PDT, about 2 h
  after Claude's. Codex session `01a0df72` (started 13:39 PDT) missed `0e5861d`
  at 16:09. From 18:53 on, the same session logged commits sitting past char 500
  (at chars 670, 1094 and 1006), which only 0.8.0 catches.
- **The checkout's post-0.8.0 commits change nothing here.** 41022db (cd-hop
  repo) and ea691b7 (root commit files) fix attribution, not detection. HEAD's
  replay equals 0.8.0's on 37 of 38 calls, and on the 38th HEAD is **worse**
  (see "Regression at HEAD" below). The "33 before 41022db / 10 after" split does
  not line up with any cause. The boundary that matters is each session's start
  time against 22:56Z.

## Causes

| # | Cause | Commits | 0.7.9 | 0.8.0 (installed) | HEAD |
|---|---|---|---|---|---|
| A | Session running 0.7.9 after 0.8.0 was installed (5 Claude sessions + Codex before 17:51) | **23** | miss | logs it | logs it |
| B | One Bash call made several commits; the hook logs one per call (the HEAD of one repo) | **21** | miss | miss | miss |
| C | `git merge` made a merge commit; merge is not a detected verb | **1** | miss | miss | miss |
| D | `git cherry-pick` copy of a commit that was logged in a worktree session | **1** | miss | miss | miss |

**Fixed in the checkout but not installed: none.** 23 are fixed by code that
is installed but was not loaded. 23 are unhandled in every build.

### A — stale 0.7.9 in a running session (23)

0.7.9 detected `git commit` only inside the first 500 characters (memory,
section 5), and judged noise by the first token.

- **18 logged as `tool_file_edit`.** A `python3 - <<'EOF'` or `cat >> doc
  <<'EOF'` edit, followed by `git add … && git commit -q …` at char 571–4717. The
  write won, and the commit was never seen. Examples: `4560f17` (commit at char
  1918), `203e45c` (4717), `6946385`, `3fa32b6`.
- **4 logged as `tool_bash`.** Commit past 500 with no write detected: `bf1044e`
  (long `git add` list, commit at 1090), `45674df`, `c7462c4`, and Codex `0e5861d`
  (722).
- **1 got no row.** `be70d73`: `echo "…"; git add … && git commit -q -F - <<'EOF'`.
  The leading `echo` made the whole command noise.

Five of these calls also made a second commit. 0.8.0 recovers only the last
commit of each (`2d585f1`, `48ecfff`, `58e828d`, `c7462c4`, `5704b37`), so their
partners (`8f78ebc`, `9509bb0`, `1eb00af`, `907472c`, `f6a43aa`) count under B.

### B — several commits in one call (21: 17 in one repo, 4 across repos)

`git_invocation` takes the first match (`head -1`, log-tool-use.sh:211). The
commit branch then reads one repo's `HEAD` (:463) and writes one `git_commit`
row, so every commit before the last is dropped. Examples:

```sh
# 2b5f4cc6, 22:42 PDT: 4 commits, 1 row (2e639a8); 56d0d09, 0cca4b9, 36a4fc2 lost
git add src/a.js … && git commit -q -m "feat: …" && git add src/b.js && git commit -q -m "feat: …" && git add … && git commit -q -m "fix: …" && …

# 084b29bc, fix + audit-doc pair (the pattern behind 9 of the 17)
git add <code files> && git commit -q -F - <<'EOF' … EOF
python3 - <<'EOF' …(edit audit doc)… EOF
git add docs/audits/… && git commit -q -F - <<'EOF' … EOF

# e7d21149: rebuilding history, messages read from files; a1714b8 lost, 49eef27 logged
git log -1 --format=%B 8425414 > msg1.txt && git commit -q -F msg1.txt && … && git commit -q -F msg2.txt
```

**Across repos (4).** The hook reads the repo from the post-command cwd, so a
commit made in the *starting* directory before a `cd` elsewhere is lost:

```sh
# 2b5f4cc6: cwd repo-a; 486eb62 lost, repo-b's 12c206f logged
git add tools/c.mjs && git commit -q -m "…" && cd ~/dev/repo-b && git add … && git commit -q -m "…"
```

The same happened to `12e208e` and `ed59b4c` (repo-b, then `cd` to repo-a)
and to `cfd3d67` (`cd allserp-paper … commit; cd attentional-foraging … commit;
cd allserp-paper`). HEAD's `bash_cd_base` does not help: with no hop before the
first `git commit`, it falls back to the payload cwd, which Claude reports
*after* the command.

30-day scale: **251 Claude calls ran `git commit` two or more times** (5,056
ran a commit-creating git verb), and 33 of those also `cd` to two targets.

### C — merge (1)

`3534016`, from `git merge --no-edit claude/feature-branch 2>&1 | tail -15`,
logged as `tool_bash`. Only `commit` and `push` are detected. In 30 days, 316 Claude
calls ran `git merge`; many are fast-forwards that make no commit.

### D — cherry-pick copy (1), and why the digest counts it

`03a01ff`, from `M=~/dev/repo-a && git -C $M
cherry-pick c59c766b`, logged as `tool_bash`. Its original `c59c766` *was* logged
by the worktree session. The digest pairs a git-only commit with a logged one
only when the logged sha is unreachable (`status === 'rewritten'`,
day-digest.js:233). The worktree branch still holds `c59c766`, so both shas
stand. `32dfcfa` (B) is the mirror case: a worktree commit whose cherry-pick copy
`772e72c` was logged. Both pairs share author time and subject exactly.

### Regression at HEAD (1 call, 50 commands in 30 days)

```sh
# 7dcb7bba, 20:52 PDT
W=~/dev/repo-a/.claude/worktrees/wt-1 && git -C $W add … && git -C $W commit -q -F - <<'EOF' … EOF
SHA=$(git -C $W rev-parse HEAD) && git -C ~/dev/repo-a cherry-pick $SHA … && git -C … log --oneline -2
```

0.8.0 logged `772e72c` because its stdout fallback took the first hex run, which
`git log --oneline` happened to print. At HEAD, `$W` resolves to `?`
(log-tool-use.sh:282), and 41022db accepts only a `[branch sha] subject` line,
which `-q` suppresses. The call gets `tool_bash` and both commits are lost. In
30 days, 50 commands ran `git -C $VAR … commit`, mostly `R=<abs path>` followed
by `git -C "$R" commit -q`. **Decide this before HEAD ships** (see fix 2: the
behaviour is intended and tested).

## Proposed fixes

1. **Log every commit a call made, read from the reflog rather than `HEAD`**
   (fixes B, C and D on the hook side). Trigger on commit, merge, cherry-pick,
   revert, am and pull. Candidate repos:
   - the pre-command cwd (new: the hook would store each session's last
     payload cwd in `.carto/`)
   - the payload cwd
   - every literal `cd`, `pushd` or `-C` target, each through its worktree's git
     dir

   From each, read `git reflog --date=unix --format='%H%x09%gd%x09%gs' HEAD` and
   keep the `commit*`, `merge`, `cherry-pick`, `revert` and `pull` entries newer
   than the session's previous hook call. Skip shas already in the changelog
   (the existing `Commit <sha>` check), and write one row per sha, oldest first,
   with the reflog action as a field. Race guard: two sessions committed to
   repo-a 2–3 min apart that day, so accept an entry when its
   subject appears in the raw command, and otherwise take only as many entries
   as the command has commit-creating invocations. The reflog was checked by
   hand and holds every commit B, C and D lost, with its action (`commit:`,
   `merge claude/feature-branch:`, `cherry-pick:`), including `32dfcfa` in
   `.git/worktrees/wt-1/logs/HEAD`. Acceptance: the replay here
   recovers 46 of 46 across the 38 calls, and the 30-day replay of the 251 multi-commit calls writes
   one row per commit.
   One more gap: the plugin registers only `PostToolUse`, and Claude Code
   sends a failed Bash call to `PostToolUseFailure` instead, so a commit in a
   call that later exits non-zero is never seen (`git commit … && npm test`
   with a failing test). None of the 46 was this, but the reflog read should
   also run on `PostToolUseFailure`.
2. **Resolve literal assignments made earlier in the same command**
   (`NAME=/abs`, `NAME=~/x`, then `$NAME`, `"$NAME"`, `${NAME}`) in
   `bash_cd_base`'s `resolve()` and `git_path`. This closes the HEAD regression.
   **This reverses a deliberate 41022db decision, so it is yours to make.** The
   test "a hop to a variable path is left unresolved, not guessed" asserts that
   `W=<repo>; cd "$W" && git commit -q` writes *no* commit row: "a guessed
   directory files a commit under the wrong repo, which is worse than filing it
   under none." The case for changing it: an assignment in the same command is
   text the command carries, just like a literal `cd` path, and the
   already-logged check and freshness guard still apply. With fix 1, the reflog
   entry's own time and subject would confirm the commit. The case against:
   `W=` can be reassigned, and it can be set inside a subshell or a branch. Either
   way, the current rule cost `32dfcfa` and `772e72c`, and it covers 50 commands
   in 30 days. Until this is decided, keep a fallback for an unresolved `-C`.
3. **Stale hooks (A).**
   - Stamp `hook_version` on every row, read from the plugin's own
     `plugin.json`. A digest can then say "rows written by 0.7.9 after 0.8.0 was
     installed" without a replay.
   - From the next release on, have each hook `exec` the installed copy when
     `installed_plugins.json` names a different installPath, so later updates
     reach running sessions. Sessions already on 0.8.0 or older still need a
     restart.
   - Release checklist: update Codex's copy in the same step, and say "restart
     running Claude sessions" after install.
4. **Digest (`day-digest.js`).**
   - Pair a git-only commit with a logged one by (author time, subject) even
     when both are reachable, and report it as copied. That folds both `03a01ff` and
     `32dfcfa` today, since `772e72c` is already logged.
   - List merge commits apart from git-only.
   - Check logged shas across all projects (:246), so "git-only" means no
     `git_commit` row anywhere, as the contract says. This was not a factor for
     these 46.
5. **Recover the 46** with a transcript-matched backfill: the same bracketing
   used here, writing `git_commit` rows that carry `session_id`, `provider` and
   `transcript_path`. `backfill-git-history.sh` restores the subject only, with
   `session_id: null`.

Coordination: session `1585a7a8` began editing `log-tool-use.sh` at 13:24Z on
09-27, making `git_invocation` and `bash_cd_base` skip quoted text. Fixes 1 and
2 restructure the same two functions.

## Status of fix 1 (2026-09-27, committed, not installed)

Implemented in `plugins/session-cartographer/hooks/log-tool-use.sh`
(`git_invocations`, `call_commits`, `call_start_cwd`, `commit_fields`,
`emit_row`) and `hooks.json` (`PostToolUseFailure` for Bash). It differs
from the proposal above in three ways:

- **The window is the call's own.** It runs `now − duration_ms`, from Claude
  Code's payload, rather than "since the session's previous hook call". A
  payload without `duration_ms` (Codex, older clients) keeps the HEAD path
  unchanged.
- **A commit's committer time must also fall in the window,** not only the
  reflog entry. Otherwise a HEAD moved onto an older commit would count.
- **The subject rule covers cherry-picks.** A cherry-pick matches on the
  subject of the sha it names, which recovers `03a01ff`. The worktree scan
  for an unreadable `-C` accepts subject matches only, and does not evaluate
  `$W`, so fix 2 remains open.

Evidence:

- **Replay.** The 38 calls were replayed through the working-tree hook with
  what Claude Code sends: each commit recreated with its real reflog action
  and worktree, the starting cwd in a transcript line, and `duration_ms` set
  to at least 60 s. Result: **46 of 46** git-only commits logged, and **0**
  rows for a commit the call did not make. `0e5861d` (Codex) comes through
  the HEAD path, as it did on 0.8.0.
- **Unit tests.** `log-tool-use-git-commit.test.js` has 46 tests, 8 of them
  new. Each new test first shows that the HEAD path gets the same fixture
  wrong. Removing the window, the cap or the subject match fails at least one
  test (mutation check). Full suite: 667 of 668 pass, 1 skipped, on Node 26.8.2.
- **Cost.** A two-commit call goes from 0.43 s to 0.63 s. Reading the
  starting cwd from the largest transcript on disk (112 MB) takes 0.12 s.
- **Packaging smoke.** `tests/release-smoke.sh` stops on
  `scripts/cartographer-pulse.sh`, which is day-digest WIP with an unmirrored
  plugin copy, before it reaches anything this change touches.

## Appendix: all 46

Hook-that-ran is the build whose replay matches the row written. Cause letters
are as in the table above; `Bx` means across repos, `B+A` means a multi-commit
call that also ran under 0.7.9.

| sha | PDT | project | session | hook that ran | row written | command shape | cause |
|---|---|---|---|---|---|---|---|
| `3534016` | 09-26 07:23 | repo-a | claude `084b29bc` | 0.7.9 | tool_bash | `git merge` | C |
| `6946385` | 09-26 07:29 | session-cartographer | claude `345f9ef0` | 0.7.9 | tool_file_edit | `git commit` at char 834, `-F -` heredoc, `cd` hop | A |
| `42d562f` | 09-26 07:35 | repo-a | claude `084b29bc` | 0.7.9 | git_commit `280fcf3` | `-q`, `-F -` heredoc, 2 commits in call | B |
| `4560f17` | 09-26 07:59 | repo-a | claude `631be865` | 0.7.9 | tool_file_edit | `git commit` at char 1918, `-q`, `cd` hop | A |
| `55c82d4` | 09-26 08:02 | repo-a | claude `084b29bc` | 0.7.9 | git_commit `985bee8` | `-q`, `-F -` heredoc, 2 commits in call | B |
| `8f78ebc` | 09-26 08:20 | repo-a | claude `084b29bc` | 0.7.9 | tool_file_edit | `git commit` at char 2360, `-q`, `-F -` heredoc, 2 commits in call | B+A |
| `2d585f1` | 09-26 08:20 | repo-a | claude `084b29bc` | 0.7.9 | tool_file_edit | `git commit` at char 2360, `-q`, `-F -` heredoc, 2 commits in call | A |
| `45674df` | 09-26 08:36 | repo-a | claude `631be865` | 0.7.9 | tool_bash | `git commit` at char 1489, `-q` | A |
| `bf1044e` | 09-26 08:36 | session-cartographer | claude `3f765c61` | 0.7.9 | tool_bash | `git commit` at char 1090, `-F -` heredoc, `cd` hop | A |
| `203e45c` | 09-26 08:59 | repo-a | claude `631be865` | 0.7.9 | tool_file_edit | `git commit` at char 4717, `-q` | A |
| `48ecfff` | 09-26 09:00 | repo-a | claude `084b29bc` | 0.7.9 | tool_file_edit | `git commit` at char 4280, `-q`, `-F -` heredoc, 2 commits in call | A |
| `9509bb0` | 09-26 09:00 | repo-a | claude `084b29bc` | 0.7.9 | tool_file_edit | `git commit` at char 4280, `-q`, `-F -` heredoc, 2 commits in call | B+A |
| `8c5ac41` | 09-26 09:04 | repo-a | claude `084b29bc` | 0.7.9 | git_commit `40a8ca7` | `-q`, `-F -` heredoc, 2 commits in call | B |
| `718bea7` | 09-26 09:06 | repo-a | claude `084b29bc` | 0.7.9 | git_commit `d715799` | `-q`, `-F -` heredoc, 2 commits in call | B |
| `1eb00af` | 09-26 09:12 | repo-a | claude `084b29bc` | 0.7.9 | tool_file_edit | `git commit` at char 1286, `-q`, `-F -` heredoc, 2 commits in call | B+A |
| `58e828d` | 09-26 09:12 | repo-a | claude `084b29bc` | 0.7.9 | tool_file_edit | `git commit` at char 1286, `-q`, `-F -` heredoc, 2 commits in call | A |
| `907472c` | 09-26 09:20 | repo-a | claude `084b29bc` | 0.7.9 | tool_bash | `git commit` at char 687, `-q`, `-F -` heredoc, 2 commits in call | B+A |
| `c7462c4` | 09-26 09:20 | repo-a | claude `084b29bc` | 0.7.9 | tool_bash | `git commit` at char 687, `-q`, `-F -` heredoc, 2 commits in call | A |
| `5704b37` | 09-26 09:23 | repo-a | claude `084b29bc` | 0.7.9 | tool_file_edit | `git commit` at char 4367, `-q`, `-F -` heredoc, 2 commits in call | A |
| `f6a43aa` | 09-26 09:23 | repo-a | claude `084b29bc` | 0.7.9 | tool_file_edit | `git commit` at char 4367, `-q`, `-F -` heredoc, 2 commits in call | B+A |
| `dd5f836` | 09-26 09:36 | repo-a | claude `631be865` | 0.7.9 | tool_file_edit | `git commit` at char 1582, `-q`, `-F <file>` | A |
| `d6574e4` | 09-26 09:48 | repo-a | claude `631be865` | 0.7.9 | tool_file_edit | `git commit` at char 1740, `-q` | A |
| `1cd6d19` | 09-26 10:04 | repo-a | claude `631be865` | 0.7.9 | tool_file_edit | `git commit` at char 2643, `-q` | A |
| `e26468d` | 09-26 10:32 | repo-a | claude `631be865` | 0.7.9 | tool_file_edit | `git commit` at char 1636, `-q` | A |
| `b404bf1` | 09-26 10:37 | repo-a | claude `631be865` | 0.7.9 | tool_file_edit | `git commit` at char 2796, `-q` | A |
| `a0949d1` | 09-26 10:37 | repo-a | claude `631be865` | 0.7.9 | tool_file_edit | `git commit` at char 1814, `-q` | A |
| `39dbeb6` | 09-26 10:44 | repo-a | claude `631be865` | 0.7.9 | tool_file_edit | `git commit` at char 571, `-q` | A |
| `10d16c2` | 09-26 10:49 | repo-a | claude `631be865` | 0.7.9 | tool_file_edit | `git commit` at char 1070, `-q` | A |
| `975cce9` | 09-26 14:55 | repo-a | claude `631be865` | 0.7.9 | tool_file_edit | `git commit` at char 1359, `-q` | A |
| `3fa32b6` | 09-26 15:00 | session-cartographer | claude `9ade7750` | 0.7.9 | tool_file_edit | `git commit` at char 1237, `-F -` heredoc, `cd` hop | A |
| `b3a1363` | 09-26 15:54 | repo-a | claude `631be865` | 0.7.9 | tool_file_edit | `git commit` at char 965, `-q` | A |
| `be70d73` | 09-26 16:00 | repo-a | claude `631be865` | 0.7.9 | no row | leads with `echo`, `-q`, `-F -` heredoc | A |
| `0e5861d` | 09-26 16:09 | repo-a | codex `01a0df72` | <0.8.0 (Codex copy) | tool_bash | `git commit` at char 722 | A |
| `7800381` | 09-26 18:22 | attentional-foraging | claude `651d6ee4` | 0.8.0 | git_commit `33e486f` | `-q`, `-F -` heredoc, `cd` hop, 2 commits in call | B |
| `03a01ff` | 09-26 19:59 | repo-a | claude `7dcb7bba` | 0.8.0 | tool_bash | `git -C $VAR`, cherry-pick | D |
| `cfd3d67` | 09-26 20:00 | attentional-foraging | claude `651d6ee4` | 0.8.0 | git_commit `904e663` (allserp-paper) | `git commit` at char 1290, `-q`, `-F -` heredoc, `cd` hop, 2 commits in call across 2 repos | Bx |
| `7cbe782` | 09-26 20:30 | repo-a | claude `eb7579bb` | 0.8.0 | git_commit `9cdca70` | `-q`, `-F -` heredoc, 2 commits in call | B |
| `7b8b6c2` | 09-26 20:39 | repo-a | claude `eb7579bb` | 0.8.0 | git_commit `4109899` | `-q`, `-F -` heredoc, 2 commits in call | B |
| `32dfcfa` | 09-26 20:52 | repo-a | claude `7dcb7bba` | 0.8.0 | git_commit `772e72c` | `git -C $VAR`, cherry-pick, 2 commits in call | B |
| `486eb62` | 09-26 21:17 | repo-a | claude `2b5f4cc6` | 0.8.0 | git_commit `12c206f` (repo-b) | `-q`, `cd` hop, 2 commits in call across 2 repos | Bx |
| `0cca4b9` | 09-26 22:42 | repo-a | claude `2b5f4cc6` | 0.8.0 | git_commit `2e639a8` | `-q`, 4 commits in call | B |
| `36a4fc2` | 09-26 22:42 | repo-a | claude `2b5f4cc6` | 0.8.0 | git_commit `2e639a8` | `-q`, 4 commits in call | B |
| `56d0d09` | 09-26 22:42 | repo-a | claude `2b5f4cc6` | 0.8.0 | git_commit `2e639a8` | `-q`, 4 commits in call | B |
| `12e208e` | 09-27 04:30 | repo-b | claude `2b5f4cc6` | 0.8.0 | git_commit `b4e79f6` (repo-a) | `-q`, `cd` hop, 3 commits in call across 2 repos | Bx |
| `ed59b4c` | 09-27 04:30 | repo-b | claude `2b5f4cc6` | 0.8.0 | git_commit `b4e79f6` (repo-a) | `-q`, `cd` hop, 3 commits in call across 2 repos | Bx |
| `a1714b8` | 09-27 05:02 | repo-c | claude `e7d21149` | 0.8.0 | git_commit `49eef27` | `-q`, `-F <file>`, 2 commits in call | B |
