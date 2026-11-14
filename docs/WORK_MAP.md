# The work map

The work map shows where a session's calls go, in order: a model step, a file
read, a command, a page fetched, a message to you. It has two faces drawn by the
same code.

- **The pane** sits beside the chat in Claude Code and follows the session you
  are in, live.
- **The map page** is the Explorer's `/map`. It replays any recorded session,
  Claude Code or Codex, from its transcript.

The pane is also the way into the Explorer from a session: while the Explorer is
running, the pane links to this session's map there.

> **Status: unreleased.** Added 2026-11-13 and 2026-11-14 and not yet in a
> tagged release. This page is a stub: it says what exists and what is known
> not to work. Open work is under "Session work map" in [TODO.md](../TODO.md).

## Stations

A station is one of the eleven places on the ring around the centre of the map.
Every call is filed at exactly one, and the number by a station is how many
calls have landed there in this session. The circle in the middle is the agent
itself and says which model is at work.

| Station | What is filed there |
| --- | --- |
| You | Your messages coming in, and what the agent tells you going out |
| Your screen | Calls that read or act in what you have open: your own Chrome, tabs, terminal, desktop |
| Model | Each step the model takes |
| Memory | Recall, memory tools and memory files |
| Files | Reads and edits of files |
| Shell | Commands |
| Network | Web fetches and searches |
| Browser | The agent's own built-in browser |
| Agents | Subagents and other sessions |
| Skills | Skills and tool loading |
| Hooks | What a hook adds or stops, and a background task reporting back |

You is two-way. A line into the centre is you speaking, a line out is the agent
telling you something, and the two are counted apart ("5 said", "19 told").
Only what you typed counts as you: a background task reporting back, or a
reminder the harness adds, is filed at Hooks.

Each station has one colour for its kind of work, the same in every drawing:
white for your side, grey for the agent's own (Model, Skills, Hooks), ochre for
Files, green for Shell, blue for Network and Browser, teal for Memory, violet
for Agents. Red means a call failed and nothing else.

## The pane

From top to bottom:

1. **The ribbon.** The recent calls in order, newest at the right, in the
   stations' colours. It is drawn in slots of one width: ten in a pane 40 cells
   or more across, five in a narrower one. A slot is a run of calls that
   followed one another at one station, with up to eight of them side by side.
   A full-height white mark is a message from you, a narrow grey one is
   something else waking the agent, a full-height red one is a failed call,
   and an outline is a call still running.
2. **A control under each slot** (△). Pressing it narrows the feed to that
   slot's station. Pressing a slot of the held station gives the whole feed
   back. The held station shows ▲ under each of its runs, a bar under them on
   the ribbon and a ring on the hub. Held, Network, Browser and Your screen
   list the pages visited there, newest first.
3. **The hub.** The ring of stations with their names and counts, and the route
   the session took between them, the newest leg widest, each leg with an
   arrowhead. A ring round the centre shows how full the context window is; it
   stays quiet until 70% and says "N% full" from there. Names are drawn from
   400 px of width, counts alone from 280 px.
4. **What runs now**, with the context figure and the model.
5. **The feed.** The last rows, newest first, at most sixteen. Finished calls
   that follow one another at one station fold into one row.
6. **↗ Explorer**, at the bottom edge.

### Links

All of these appear only while the Explorer answers on port 2527.

- The station's name at the head of a feed row opens that station on this
  session's map in the Explorer.
- A row that changed a file opens the Explorer's review of that file in this
  session.
- ↗ Explorer opens the session's map whole.

A row that went to a web page links to the page whether or not the Explorer is
running.

The pane asks the Explorer for its health (`/api/health` on `127.0.0.1:2527`)
at session start, at the start of a turn and on a call, at most once a minute,
and never while drawing. After the Explorer starts or stops, the pane follows
within a minute of the next call.

### What the pane keeps

The pane keeps the last 80 rows of the session and the last 300 page addresses,
in the session's own state. A row carries a name, not content: a tool's name, a
host, the last two parts of a file's path, a command's description. A login
inside an address is dropped. The text of a memory, of a page or of a file never
reaches it, and a hook's refusal shows only with `hookReasons` on.

### Switching it off

Set the plugin's `workMap` option to off. The plugin then opens no pane and adds
no `/carto-map` command; recall, capture and the Explorer are unaffected.

### Options

| Option | Default | What it does |
| --- | --- | --- |
| `workMap` | on | Opens the pane |
| `language` | `en` | Language of the labels |
| `coreName` | `CLAUDE` | What the centre says under the model, up to ten characters |
| `motion` | `full` | `reduced` stops everything that moves |
| `textSize` | `footnote` | Size of the rows under the map |
| `memoryServers`, `memoryCommands`, `memorySubcommands`, `memoryPaths`, `memoryLabels` | Cartographer's own | Which tools, commands and paths count as Memory |
| `hookRecords` | off | Show numbered records a hook adds to memory, by number only |
| `hookReasons` | off | Show the first line of a hook's refusal |

`theme`, `background`, `colors`, `layout`, `terminalView` and `cellShape` are
inherited from lot-map. They act only on lot-map's own drawing, which a light
theme and a terminal still get (see below).

## The map page

`/map?session=<id>` in the Explorer. The same hub, with the ribbon under it, a
tape (one lane a station, time left to right) and the list of calls beside it.
A station on the hub is a control there: pressing it lists that station's calls.

| Parameter | Meaning |
| --- | --- |
| `session` | The session's id |
| `station` | The station whose calls are listed |
| `at` | A moment in the session, in ms since the epoch; the map is drawn as of then |
| `layout=board` | The board layout in place of the hub |
| `look=sizes` or `look=directions` | The design comparison pages |

## Known limits

- **A terminal gets no pane.** The terminal's `claude` (2.1.277 when checked)
  refuses the pane's module; the app's engine (2.1.325) loads it. The plugin's
  other hooks keep running in a terminal session.
- **A light theme gets lot-map's drawing**, which has no Your screen and whose
  text is under this project's contrast and size floors. The new hub has no
  light colours yet.
- **Nothing in the pictures can be pressed.** The desktop draws a picture as an
  image and a button as its plain label, so the ribbon's controls stand under
  it and the links into the Explorer are in the feed's text.
- **"Your screen" and "background task reported" are English only.**
- **The slot ribbon and its controls have not been checked in the app** as of
  2026-11-14. The hub, the feed's links and the bottom link have.
- **A folded row links to its newest call only**, and a review link for a file
  outside the Explorer's root opens an empty review.

## Where the code is

| What | Where |
| --- | --- |
| The drawing shared by both faces | `explorer/shared/workmap/` (`hub.js`, `ribbon.js`, `kinds.js`, `flow.js`) |
| The map page | `explorer/src/components/SessionMap.jsx`, `explorer/server/workmap.js` |
| The pane | `plugins/session-cartographer/hooks/carto-map/` (`register.tsx`, `hubview.ts`) |
| The pane's state contract | `plugins/session-cartographer/types/index.d.ts` |

A hooks module can import only its own files, so the pane holds byte-identical
copies of the shared drawing in `hooks/carto-map/workmap/`. Run
`scripts/sync-carto-map-workmap.sh` after changing a shared file;
`tests/unit/carto-map-workmap-sync.test.js` fails when a copy drifts. How to
run the pane's own tests and the page's browser check is in
[TESTING.md](TESTING.md).

## Credits

The pane is forked from [lot-map](https://github.com/alexeyw/lot-map) 0.6.0 by
Aleksei Volodin, MIT licensed: the ring of stations, their glyphs, the feed and
the terminal picture are its design. See
`plugins/session-cartographer/hooks/carto-map/NOTICE.md`.
