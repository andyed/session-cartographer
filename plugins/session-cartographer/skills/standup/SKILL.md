---
name: standup
description: Brief on concurrent sessions — who else is working, in which repos, on which files, and what landed underneath you. Use when a commit appears that you did not make, before touching a shared file, or when orienting mid-task in a busy workspace.
allowed-tools:
  - Bash
  - Read
---

# Standup

`/remember --project` answers *what has happened in this project*. `/standup` answers *who
else is in it with me right now* — the peer view.

Every changelog event already carries `session_id`, `project`, `cwd` and a
summary naming the file or the commit, so this needs no new capture. It groups
what the hooks wrote by session instead of by project.

The file-level check also runs on its own: a PreToolUse hook
(`hooks/check-edit-collision.sh`) adds a note before an edit when a peer touched
the same file within 45 minutes. Its note is a prompt to run this skill for the
wider view, not a replacement for it; both share `scripts/contention.js`.

Before running, resolve `ROOT` to the Session Cartographer plugin root. Prefer
`CARTOGRAPHER_ROOT`, then `CLAUDE_PLUGIN_ROOT` or `PLUGIN_ROOT`. Otherwise
derive it from this skill's base directory (`../..` from `skills/standup`), with
the conventional checkout as a legacy fallback.

## The roster

```bash
node "$ROOT/scripts/cartographer-standup.js" --since 6h
```

Reports every session with logged activity in the window: provider, projects, idle time, span,
event count, and its last commits (subjects recovered from git when the corpus
blanked them). `●` means an event was logged inside the last 20 minutes; `○`
means the last logged event is older. Neither proves process liveness. Your own session is marked `(you)` when a session environment variable or
the freshly logged invocation identifies it. Use `--me <full-session-id>` if a
standalone shell did not log this invocation. Displayed ids expand beyond eight
characters whenever two sessions share the same prefix.

Scope it when the workspace is loud:

```bash
node "$ROOT/scripts/cartographer-standup.js" --project widget-web --since 12h
```

## The part that matters

Read **CONTENTION** first; the roster is ambient. Two sessions awake is normal
and ignorable. Two sessions editing the same file is the thing that quietly
costs an hour, and it is the only line in the output that should change what you
do next.

- **Project contention** is the weak signal — expected in a repo under active
  work. Note it, do not act on it.
- **File contention** is the strong signal. Before you edit a file listed there,
  re-read it from disk rather than trusting anything you read earlier in the
  session. For separate worktrees, inspect the peer's changes as well as your
  own file; the copies can diverge without changing one another.

Three things shape that list:

- **Workspace-root and worktree directory *names*** are filtered out of the
  *project* line via `scripts/non-projects.js` — five sessions "sharing" `dev`
  is the filesystem, not a collision. That filter never touches the *file* list:
  a file's identity is its path, and two sessions running from the workspace
  root collide on a file just as hard as two in a named repo.
- **A worktree edit and a main-checkout edit of one repo file are one file.**
  Claude's `repo/.claude/worktrees/<name>/js/x.js` layout collapses directly.
  Codex's `~/.codex/worktrees/<id>/<repo>/js/x.js` layout is matched through
  Git's common directory, cached per worktree. The output flags the result as
  `[same file, separate worktrees]`. A Codex worktree that Git cannot verify is
  counted in `NOT COUNTED`; matching directory names alone are insufficient.
- **`--project` scopes contention as well as the roster.** A session logged
  under the workspace-root label `dev` stays in scope when a resolved file path
  belongs to the requested project. The roster marks that match `(file)`.

## What it could not count

A silent miss and a clean workspace print the same thing, so the footer says
what fell out:

```
NOT COUNTED — 187 edit candidates did not resolve to a file on disk
(mostly the hook's non-paths; a since-deleted file also lands here);
2 events carry no resolvable session id and were counted, not grouped.
```

The edit hook reads shell source text and is loose by construction — roughly
56% of what it emits is not a path (`r.max`, `n.name`), which is expected. But a
real file deleted or renamed after the edit lands in the same bucket, and its
collision is simply absent from the list above. A large count next to a
suspiciously empty contention section is worth a second look.

The log reports recent activity, not a live process or a shared objective. Two
sessions in one project may be working toward different goals. The proposed
goal-linked briefing and explicit handoff records are not yet part of this
command.

Sentinel session ids (`unknown`, `""`) are counted here and never grouped: they
are truthy and equal to each other, so keying on them would fuse every
unattributed event — across providers — into one phantom session that appears to
collide with everybody.

## What the log never saw: SILENT and UNCLAIMED

Everything above reads the event log, so a session whose hooks never fire is
not idle here, it is absent. Two sections read around the log:

```
SILENT — activity the event log did not record
  codex  01a107bc  transcript written 1m ago · 0 events logged
  Codex hooks untrusted: hooks/codex-hooks.json (0.8.1) has no trust record (trust is recorded for hooks/hooks.json). Codex skips untrusted hooks silently — approve with /hooks in the Codex CLI.

UNCLAIMED — tracked files changed in the window that no logged session edited
  js/config/flag-registry.js   changed 18m ago · mentioned by codex 01a107bc (no events logged) (189×, transcript 1m ago)
```

- **SILENT** lists Codex transcripts written in the window whose session has no
  events, and checks that `~/.codex/config.toml` trusts the hook file the
  installed Codex plugin declares. An untrusted hook file is the usual cause:
  Codex records trust per hook file and definition hash and skips the rest
  without a word. The fix belongs to the person: `/hooks` in an interactive
  Codex CLI (docs/SETUP.md § Codex hook trust). Never write trust records
  yourself.
- **UNCLAIMED** lists tracked files in the project's repo (`--project`, else
  the cwd's repo) changed inside the window with no logged edit. Evidence, best
  first: a logged command that named the file just before it changed (an edit
  through `sed -i` or a Python heredoc logs only `Ran: …`); else the transcript
  that names it most, ranking sessions with no logged events first, since a
  logging session would have claimed the file. A mention is evidence, not
  authorship — report it as "mentioned by".

Lead with SILENT when it appears: it is usually why UNCLAIMED is not empty, and
while it lasts every other section undercounts that provider.

## Attributing a commit you did not make

When a sha shows up under you — the common trigger for this skill — name its
session directly:

```bash
node "$ROOT/scripts/cartographer-standup.js" --commit c61e0e83 --since 24h
```

Prints the owning session, project, timestamp, files, and how many commits that
session landed in the window. The commit itself must be inside `--since`.
Match on sha or on any substring of the commit
subject. A miss means the window is too short (`--since 3d`) or the commit
predates hook coverage — say which, do not guess at authorship.

## Reporting it

Lead with the collision, not the census. Someone running several concurrent
sessions by design already knows the list; it is not news. Useful:

> `a1986975` landed `c61e0e83` (jukebox chip colours) 50m ago in the same repo.
> No file overlap with your work — `311a6cf7` and `7ca82aba` are both in
> `docs/TUNING.md` though.

Not useful: "there are 9 active sessions."

When a peer session is worth the operator's attention, hand over its Memory
Desk link rather than its id: `http://127.0.0.1:2527/memory?session=<id>`
opens that thread (span, edited files, observations, resume command), and
`&file=<url-encoded abs path>&review=changes` opens the contested file on that
session's bounded diff. The full permalink grammar is in the `/carto` skill
under "Deep links into Memory". Check the host answers 200 first; a link to a
stopped Explorer is worse than an id.

Never claim a session is *currently* running. The log shows last activity, not
liveness — `●` means it was active recently, which is a different claim. Say
"active 6m ago," not "is running."

## Flags

| flag | default | |
|---|---|---|
| `--since` | `6h` | window; `30m`, `12h`, `3d` |
| `--project` | all | restrict roster to sessions labeled with or editing files in this project |
| `--commit` | — | attribute a sha or subject substring to its session |
| `--live` | `20m` | idle threshold for the `●` marker |
| `--me` | inferred | override self-identification |
| `--all` | off | keep your own session in the peer roster |
| `--json` | off | machine-readable; adds `unattributed_events`, `worktrees_unmapped`, per-session `edits_unresolved`, and `worktree_split`/`paths` on each contested file |

Read-only. Writes nothing to the changelog and emits no retrieval telemetry.
