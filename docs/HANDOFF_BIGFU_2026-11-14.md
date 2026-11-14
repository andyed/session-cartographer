# Handoff to BIGFU, 2026-11-14

For a session on BIGFU (the Windows box) that pulls `main` and tests it there.
Written from the Mac after the session work map's second round landed. The
note from the day before, `docs/HANDOFF_BIGFU_2026-11-13.md`, still holds for
setup and for runs that do not end.

## What to pull

`andyed/session-cartographer`, `main`, at `e920305` or later (this note
is the commit after it). Before this push `origin/main` was at `6a10f05`, the
last of the Windows fixes merged from `fix/windows-unit-suite`.

## What is new since `6a10f05`

| Commit | Change | Tests |
|---|---|---|
| `e7b9d02`, `8cacc75`, `481252c` | From other Mac sessions, pushed here for the first time: Codex rollouts that have been zstd-compressed or archived are read and indexed. See `docs/COMPRESSED_ROLLOUTS.md`. | `compressed-rollouts.test.js`, `retro-index-compressed.test.js`, `transcript-keyword-compressed.test.js` |
| `3d4d856` | The work map keeps its route at every size; a board layout and a tape of the last calls. `explorer/shared/workmap/flow.js`. | `workmap-flow.test.js`, `workmap-portrait.test.js` |
| `3da59d1` | You is split from what the agent reports; the context ring is drawn from recorded token usage; `mods/carto-map/` is a fork of lot-map's sidebar pane. | `workmap.test.js` |
| `0c5148f` | The Hub view of `/map` draws `shared/workmap/hub.js`: route first, a two-way You, one colour per family of work (`kinds.js`), a ribbon of recent calls. `/map?look=directions` holds the comparisons. | `workmap-directions.test.js`, `tests/browser/session-map.cjs` |
| `3de5ef7` | The sidebar pane draws the same hub from byte-identical copies under `mods/carto-map/hooks/workmap/`, and its ribbon filters the feed by station. | `carto-map-workmap-sync.test.js`; the mod's own 80 tests |
| `190c422` | Merge of `origin/main` (the Windows fixes) under the work map line. No conflicts. | |
| `e920305` | `plugins/session-cartographer/` re-synced with source. | both packaging smokes |

## What passed on the Mac

At `e920305`, in a clean worktree:

- `npx vite build` in `explorer/`
- `bash tests/source-marketplace-smoke.sh` and `bash tests/release-smoke.sh`
- the full unit suite: 1,131 tests, 1,127 pass, 4 skipped, 0 fail
- the pane mod: 80 tests, 0 fail, run with the desktop app's engine (2.1.325)

Not run on the Mac for this landing: `tests/browser/session-map.cjs` and
`tests/browser/memory-entry.cjs`.

## What to look at on Windows

Nothing in the work map has been run on Windows since the first version on
2026-11-13. These are the parts most likely to differ there:

- **`tests/unit/carto-map-workmap-sync.test.js`** compares the pane's copies
  with `explorer/shared/workmap/` byte for byte. Both sides are checked out by
  the same git, so line endings should match; if this test fails on BIGFU and
  passes on the Mac, look at `core.autocrlf` before looking at the files.
- **`scripts/sync-carto-map-workmap.sh`** is bash, and `.gitattributes` keeps
  `*.sh` at LF. The unit test reads the script as text and does not run it.
- **The server code that reads real transcripts**
  (`explorer/server/workmap.js`, `workmap-detail.js`) has only been fed
  sessions recorded on the Mac. Its tests use made-up transcripts and say
  nothing about Windows paths: a file row's review link and the shell-command
  classifier are the places to check with a Claude Code session recorded on
  BIGFU.
- **`tests/browser/session-map.cjs`** launches Playwright's headless shell
  (`chromium.launch({ headless: true })`), which is safe for the runner
  account. It is not in CI's list.
- **The pane mod's tests** (`claude plugin test mods/carto-map`) need the
  desktop app's engine. The terminal `claude` 2.1.277 on the Mac refuses the
  mod; a BIGFU without the desktop app cannot run them, and that is not a
  finding.

The unit suite's Windows baseline moved with `fix/windows-unit-suite`, and the
Mac has no record of the new one. Compare failing test names at `6a10f05` and
at the pulled `main`; only a test that fails on `main` and passes at `6a10f05`
is a finding from this landing.

```bash
env -u CLAUDE_SESSION_ID -u CLAUDE_CODE_SESSION_ID -u CODEX_SESSION_ID -u CARTOGRAPHER_SESSION_ID node --test tests/unit/*.test.js
```

## After this note: the pane moved into the plugin

The commit after `f079c0c` moves `mods/carto-map/` to
`plugins/session-cartographer/hooks/carto-map/` and names its module in the plugin's
`hooks/hooks.json` beside the command hooks. Read every `mods/carto-map` path
above as that folder, and the test command as
`claude plugin test plugins/session-cartographer`. A Claude Code older than the
desktop app's engine refuses the module and keeps the command hooks: checked on
the Mac's terminal `claude` 2.1.277, not on Windows. If capture stops on BIGFU
after pulling, look there first.

## Seeing it

`/map` in the Explorer, then a session. `Hub` is the new drawing;
`/map?look=directions` is the side-by-side page it was chosen from.

## Not on origin

The Mac's main checkout still holds about 31 uncommitted paths from other
sessions (a recall-presentation experiment, evidence replay, project guidance).
Three of them overlap files in this landing (`TODO.md` and both copies of
`scripts/cartographer-search.sh`), so the Mac's local `main` was not moved; the
push went from the worktree.
