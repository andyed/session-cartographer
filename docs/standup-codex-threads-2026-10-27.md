# Short Codex sessions in the standup roster, 2026-10-27

Written 2026-10-27. The fix is on `fix/standup-codex-threads`
(`scripts/cartographer-standup.js`, `scripts/standup-silence.js`,
`tests/unit/standup-fold.test.js`). Numbers are from the 2-day window ending
2026-10-27 20:13 PDT on the reference corpus: `changelog.jsonl` and
`~/.codex/sessions/2026/10/{26,27}`.

## What standup showed

`cartographer-standup.js --since 2d` printed 171 sessions over 535 lines. 137
of them were Codex rows with 1 or 2 events and a 0-minute span, most under
project `dev`, with displayed ids such as `01a17fe5-7` and `01a17fde-6`. The
`psychodeli-webgl-port` contention line named 28 sessions. SILENT listed 6 Codex
transcripts with no events and "… 85 more". The 34 sessions that had done work
were spread through the list.

## What the rows are

Two populations, and they are not the same threads.

**The one-row roster sessions (137).** Each is one `milestone_turn_stop`
("Codex turn completed [0 events]"), or in 4 cases a `milestone_session_end_other`.
110 are filed under `dev`, 23 under `psychodeli-webgl-port`. Their UUIDv7 ids
decode to a creation time a median 6 s (p90 11 s) before the Stop row, and 130 of
137 fire within 60 s of an event from one of the long Codex sessions (median gap
8 s). 135 of 137 have no rollout file anywhere: not under `~/.codex/sessions`, not
under `archived_sessions`; `history.jsonl`, `logs_2.sqlite`, `memories_v2` and
`ambient-suggestions` do not name them either. The Stop payload the hook reads
carries `session_id`, `transcript_path` (empty for these), `cwd`, `turn_id` and
`model`, and no parent. So they are ephemeral Codex Desktop threads that fire one
Stop hook and persist nothing. Nothing on disk identifies a parent for them, and
time adjacency is not identity, so they can only be collapsed. The two with a
rollout are long-lived parent threads (one started 2026-09-03, 217 MB) that
happened to log one row in the window.

**The SILENT transcripts (78).** 73 carry `thread_source: "guardian_review"` and
`source: {subagent: {other: "guardian"}}`, originator `Codex Desktop`, with
`parent_thread_id` set in `session_meta`. The smallest are three records
(`session_meta`, one `compaction` response item, `thread_settings_applied`) and
none has a `user_message`. 4 carry
`source: {subagent: {thread_spawn: {parent_thread_id, agent_path, …}}}`: agents a
parent spawned. 1 is a `vscode`/`user` thread (26 MB) whose hooks really did not
fire. The parents are the long sessions in the roster: `01a17ae0` ×15, `01a1694f`
×13, `01a17f5d` ×13, `01a17ada` ×8, and so on; all but two logged dozens to
hundreds of events in the window. No sub-thread logged an event of its own.

**The suffix is not a parent marker.** `short()` widens a displayed id past eight
characters while another roster id shares the prefix. UUIDv7 ids minted in the
same hour share their first eight hex characters: 139 distinct prefixes among 166
Codex ids in the window, at most 3 per prefix. Taking the one-row sessions out of
the roster before `short()` runs removes the suffixes from the real ids.

## What changed

- **Short sessions fold.** A session with fewer than 3 events inside 2 minutes
  and no edit candidate, commit or push is counted on one line per provider
  (`● 142 short codex sessions (207 events) — folded`), leaves `sessions[]`, and
  leaves contention. A one-commit or one-edit session stays a peer however short,
  because a sha or a file is something another session can collide with. Your own
  session is never folded. `--no-fold` restores the full list; `--json` carries
  `short_sessions` with the rule, the count, the live count and the folded ids.
- **SILENT counts sub-threads under their parent.** `codexThreadMeta()` in
  `standup-silence.js` reads a rollout's first line once (bounded at 256 KB; the
  `session_meta` line embeds the base instructions and runs to ~30 KB). A rollout
  whose parent id resolves (`isResolved`, never a sentinel) is a sub-thread:
  `93 Codex Desktop sub-threads (guardian_review 88, subagent 5) of 17 parent
  sessions: 01a1694f ×20, 01a17ae0 ×15, …`. Threads of their own show the three
  newest and a count. `--json` adds `parent`, `thread_source` and `subagent` to
  each entry and a `codex_subthreads` summary; the full list stays.
- The same window now prints 129 lines; the `psychodeli-webgl-port` line names 5
  sessions; the real ids read `01a1694f` and `01a17f5d`.

`tests/unit/standup-fold.test.js` runs a fixture of 2 real and 30 short sessions
with and without the short ones and requires the real rows, their commit lines and
the CONTENTION section to be byte-identical; a `--no-fold` run proves the fixture
reproduces the widened id and the padded contention line.

## Not done here

- UNCLAIMED still ranks a guardian sub-thread's transcript as "mentioned by codex
  … (no events logged)", which outranks the logged parent that made the edit. It
  should attribute to the parent, or at least say "sub-thread of".
- The 110 one-row sessions under `dev` are a separate attribution question (Codex
  work started at the workspace root filed under `dev`); the fold does not depend
  on it and the counts here will move when it lands.

## Looking again

```bash
node scripts/cartographer-standup.js --since 2d            # folded
node scripts/cartographer-standup.js --since 2d --no-fold  # every row
node scripts/cartographer-standup.js --since 2d --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const d=JSON.parse(s);console.log(d.short_sessions.count, d.silent.codex_subthreads)})'
```

The first line of any Codex rollout says who started it:

```bash
head -c 65536 ~/.codex/sessions/2026/10/27/rollout-*.jsonl | head -1 | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const p=JSON.parse(s.split("\n")[0]).payload;console.log(p.thread_source,p.source,p.parent_thread_id)})'
```
