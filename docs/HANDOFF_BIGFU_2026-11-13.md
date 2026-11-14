# Handoff to BIGFU, 2026-11-13

For a session on BIGFU (the Windows box) that pulls `main` and verifies it there.
Written from the Mac after the session work map landed.

## What to pull

`andyed/session-cartographer`, `main`. This note was written at `64c9ad9`.
`main` may have moved since: another session was still working on reading
zstd-compressed Codex rollouts when this was written, and nothing from it was
pushed yet. Pull again before drawing conclusions.

## What is new since `c676ed8`

| Commit | Change | Tests |
|---|---|---|
| `97eda91` | `/map` in the Explorer: one recorded session as a work map, read from the transcript, for Claude Code and Codex. Server in `explorer/server/workmap.js` and `workmap-detail.js`; drawing forked from lot-map (MIT) under `explorer/shared/workmap/`; page in `explorer/src/components/SessionMap.jsx`. | `tests/unit/workmap.test.js` |
| `3fad57a` | A "Work map" link in the session panel, beside "Read conversation". | same file |
| `eed2f5c` | Recall calls made through the MCP server with no session are attributed from the Codex rollout that names their call id. See `docs/MCP_CALL_ATTRIBUTION.md`. | `tests/unit/codex-call-attribution.test.js` |
| `74c08cb` | `plugins/session-cartographer/` re-synced with source. The copy had been stale since 2026-10-17, so `tests/source-marketplace-smoke.sh` was failing on `main` before this. | both packaging smokes |
| `64c9ad9` | The `remember` skill sends "what happened in this window" questions to a count (facts census, day digest, pulse) before a search. | none of its own |

## What passed on the Mac

At `74c08cb`, run from a clean worktree:

- `npm run build --prefix explorer`
- `bash tests/source-marketplace-smoke.sh` and `bash tests/release-smoke.sh`
- `node tests/browser/memory-entry.cjs`
- the full unit suite: 1,052 tests, 1,049 pass, 3 skipped, 0 fail

`64c9ad9` changes one skill file. The tests that read skills and both smokes
were re-run on it and pass; the full suite was not re-run.

## The unit suite is not green on Windows

This is the thing most likely to waste time. Two runs on BIGFU on 2026-11-13,
through `bigfu-run` from the Mac:

| Tree | Tests | Pass | Fail | Skipped |
|---|---|---|---|---|
| `fb9886c`, before any of the changes above | 1,024 | 788 | 229 | 7 |
| the same commit plus the first version of the work map | 1,017 | 783 | 228 | 6 |

The failures are in tests that run shell scripts, hooks and git: the
`log-tool-use-*`, `index-event-outcomes`, `recall-attribution`,
`file-history-on-edit`, `jsonl-lock` and `start-note-hook` files, among others.
They fail with or without these changes.

So do not read a red suite as a regression. Run it at `c676ed8` and at the
current `main`, and compare the two lists of failing test names. Only a test
that fails on `main` and passes at `c676ed8` is a finding.

```bash
env -u CLAUDE_SESSION_ID -u CLAUDE_CODE_SESSION_ID -u CODEX_SESSION_ID -u CARTOGRAPHER_SESSION_ID node --test tests/unit/*.test.js
```

Known to pass on BIGFU: the 11 tests in `tests/unit/workmap.test.js`, in the
version from before the rows gained their second line. Not yet run on BIGFU:
the current `workmap.test.js`, and `codex-call-attribution.test.js`.

## Setup

Run `npm ci` in `explorer/` before the suite. On 2026-11-13 one runner slot had
no `explorer/node_modules/wunderkammer` (a GitHub dependency pinned by tag), and
`tests/unit/image-wall.test.js` failed there at import. The other slot had it
and the file passed.

## A run that does not end

Each full-suite run started from the Mac wrote its exit record on BIGFU (130 to
200 s of wall time) and then never closed its ssh session; the Mac side had to
be stopped by hand. A child process left behind by the turbo tests, which fail
on Windows, is the suspected cause. That is not confirmed. After a full run,
check for `node` processes that outlived it.

## If you change anything

- The marketplace smoke compares `explorer/server`, `explorer/src`,
  `explorer/shared` and every file in `scripts/` byte for byte with the copy
  under `plugins/session-cartographer/`. Copy your own changed files across.
- Do not run `scripts/copy-plugin-runtime.sh` in a tree that holds uncommitted
  work: it copies the whole working tree, committed or not.
- Conventional commits. No pushes on weekdays between 10:00 and 15:00 Pacific.

## Not on origin

The Mac's main checkout held 31 uncommitted paths from other sessions when
this was written: a recall-presentation experiment, evidence replay, project
guidance, and their tests and docs. None of it is in what you pull.
