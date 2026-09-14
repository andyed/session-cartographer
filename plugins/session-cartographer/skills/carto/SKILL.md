---
name: carto
description: Open the Session Cartographer Explorer web UI for visual browsing of Claude Code and Codex session history.
allowed-tools:
  - Bash
---

# Carto

Launch the Explorer web app for the human to browse session history visually.

The Explorer reads the same shared corpus as `/remember`, so it shows **both
Claude Code and Codex** sessions — roughly half this corpus is Codex. Sessions,
search results and timeline cards carry an agent badge, and the facet bar has an
agent dimension (`?fa=codex` in the URL) for narrowing to one producer. This
skill runs from either agent; nothing about it is Claude-specific.

Resolve `ROOT` from `CARTOGRAPHER_ROOT`, `CLAUDE_PLUGIN_ROOT`, or
`PLUGIN_ROOT`. If none is set, derive the plugin root from this skill's
reported base directory (`../..` from `skills/carto`); use the conventional
checkout only as a legacy fallback.

## Usage

```bash
ROOT="${CARTOGRAPHER_ROOT:-${CLAUDE_PLUGIN_ROOT:-${PLUGIN_ROOT:-$HOME/Documents/dev/session-cartographer}}}"
cd "$ROOT/explorer" && npm run dev &
sleep 3
open "http://127.0.0.1:2527/"
```

If the user provides a query, open with it pre-filled:
```bash
ROOT="${CARTOGRAPHER_ROOT:-${CLAUDE_PLUGIN_ROOT:-${PLUGIN_ROOT:-$HOME/Documents/dev/session-cartographer}}}"
cd "$ROOT/explorer" && npm run dev &
sleep 3
open "http://127.0.0.1:2527/?q=<query>"
```

The Explorer is a tool for the human, not the agent. Start it, open the browser, and tell the user it's ready.

`open` is macOS. On Linux use `xdg-open`, or just print the URL and let the user
click it — never block on the browser launching.

Transcripts resolve across both providers. Codex *archives* a finished session
(`~/.codex/sessions/...` → `~/.codex/archived_sessions/`), so a recorded path
goes stale while the data is still on disk; the transcript endpoints run the
`scripts/resolve-transcript.sh` ladder before reporting anything missing. If the
UI still says a transcript is unavailable, that is a real absence, not an
archive move.

The UI host serves timeline, search, sessions, and transcripts directly. It does
not need a second API process or require stopping Turbo. Verify a normal Explorer
endpoint as well as the memory status before reporting that the whole app works.

For the working-memory visual or Turbo entry point, start only the UI host:

```bash
cd "$ROOT/explorer" && npm run memory &
sleep 3
open "http://127.0.0.1:2527/memory"
```

All tabs remain reachable while Turbo is off. The memory page's explicit start/enable
action uses the shared managed controller. A running backend with the memory
API opens directly; an owned older backend offers Refresh Turbo. Do not start
another Explorer API process on Turbo's occupied port for this view.

## Deep links into Memory (share with the operator)

The Memory Desk is permalink-first: every state is a URL, the page's **Copy
link** button emits the canonical form, and reload / Back / Forward restore the
same level. An agent that wants a human to look at a session, a file review, or
a comparison should hand over a URL, not a description. The grammar below is
`normalizeMemoryRoute()` in `explorer/src/components/memory-route.js`; the
builder is `memoryHref()`. Defaults are omitted from canonical links, unknown
values fall back to the default rather than erroring, so a bad link opens the
live field silently. Check the value list before trusting a link.

Base: `http://127.0.0.1:2527/memory` (loopback, no auth; only meaningful on the
machine running the Explorer).

| Parameter | Values | Notes |
| --- | --- | --- |
| `session` | session id, `[\w-]{1,256}` | Opens the thread: span, observed-active time, edited files, observations, **Read conversation**, **Copy resume command**. The agent's own id is `CLAUDE_CODE_SESSION_ID` (chain: `CARTOGRAPHER_SESSION_ID` → `CLAUDE_SESSION_ID` → `CLAUDE_CODE_SESSION_ID` → `CODEX_SESSION_ID`). |
| `file` | URL-encoded absolute path | Requires `session`. Resolves only to an existing file **inside the corpus root** — `$CARTOGRAPHER_DEV_DIR`, the directory holding the five JSONL logs (default `~/Documents/dev`; see docs/SETUP.md) — that the session has recorded edit evidence for. A file outside the root, or an edit the hook logged as `Ran:` rather than `Modified:`, renders "not recorded as edited" instead of a diff. |
| `review` | `file`, `changes` | Only with `file`. `changes` is the Git diff bounded by the session's commits (never `HEAD`); omitted shows the file inside its session. |
| `diff` | `unified` | Split is the default and is omitted. |
| `view` | `field`, `wake`, `compare` | Which panel is primary. |
| `x`, `y` | `x`: `spanMs`, `activeMs`; `y`: `output`, `total`, `edit`, `files`, `research`, `commit`, `events` | Compare axes. |
| `hours` | integer 1–2160; the UI offers 1, 6, 24, 72, 168, 720, 2160 | Window length. Default 24. |
| `at`, `end` | ISO-8601 `Z` timestamp or 13-digit epoch ms | `at` is the replay cursor, `end` the window end (defaults to `at`). `at` is clamped into `[end − hours, end]`. Omit both for Live. |
| `q` | text ≤ 500 chars | The desk's local find. |
| `filter` | `all`, `flight`, `changed`, `landed` | Thread list filter. |
| `catchup` | `hour`, `day`, `return` | Catch-up scope. `checkpoint=<time>` pins the return point. |
| `focus` | `charts` | Overview is the default. |
| `kind` | `md` | Artifacts depth: documents only. |
| `panels` | comma list from `field,wake,compare` | Which panels are shown; all three is the default and is omitted. |
| `brush` | comma list of session ids, ≤ 100 | Highlighted sessions in the field. |
| `cam` | `x,y,scale`, scale 0.4–8 | Field camera. Identity is omitted. |
| `offset`, `sort` | integers | Thread-list paging. |

Recipes:

```bash
BASE="http://127.0.0.1:2527/memory"
SID="${CARTOGRAPHER_SESSION_ID:-${CLAUDE_SESSION_ID:-${CLAUDE_CODE_SESSION_ID:-$CODEX_SESSION_ID}}}"
# This session's thread
echo "$BASE?session=$SID"
# A file this session edited, opened on its bounded diff
FILE=$(python3 -c 'import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1],safe=""))' "${CARTOGRAPHER_DEV_DIR:-$HOME/Documents/dev}/repo/file.js")
echo "$BASE?session=$SID&file=$FILE&review=changes"
# Compare active time against commits, this session selected
echo "$BASE?view=compare&x=activeMs&y=commit&session=$SID"
# A 6-hour window ending at a moment, replayed rather than live
echo "$BASE?hours=6&at=2026-09-13T22:00:00Z"
```

Before handing a link to the operator, confirm the host is up
(`curl -s -o /dev/null -w '%{http_code}' "$BASE"` → `200`); if it is not,
start it with the `npm run memory` block above. Older session links reopen the
session's last recorded 24-hour window after leaving the live field. File links
show the current local file, not a historical snapshot.

## Examples

```
/carto
/carto shader
```
