---
name: trustmap
description: Derive or update the auto mode `autoMode.environment` block from the event corpus — which repos, hosts, buckets, and CLIs your work actually touches.
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
---

# Trustmap

Auto mode routes every tool call through a classifier that blocks anything aimed
outside your environment. By default it trusts exactly two things: the working
directory, and the current repo's configured remotes. Everything else — your
other GitHub org, the LAN device you flash builds to, your internal API — reads
as a potential exfiltration target and gets blocked. `autoMode.environment` is
the prose block that tells the classifier what's actually yours.

Claude Code ships a wizard that drafts that block by scanning your machine when
you accept it. **On a fresh install that wizard is the better tool** — it reads
the machine directly and needs no history, while this skill has nothing to read.
Once a corpus exists the trade reverses, and answering from extracted events
differs in three ways that matter:

- **Usage weighting.** A repo under `$HOME` is a candidate; a repo you pushed to
  twenty-seven times is infrastructure. The wizard's own output labels its repo
  list "CANDIDATES, not vetted context." Here the hit counts do that work.
- **Reach.** Codex sessions and backfilled git history are in this corpus and
  outside a Claude-Code-only scan.
- **Re-runnability.** Every proposal is diffed against what's already in your
  settings, so the second run proposes only the delta. The wizard is one-shot;
  it won't notice the internal host you started using last month.

Run it on first setup, and again when a project stops being routine — a new org,
a new deploy target, or a run of classifier denials for the same destination.

## Step 0: Render the digest — do this first

```bash
ROOT="${CARTOGRAPHER_ROOT:-${CLAUDE_PLUGIN_ROOT:-${PLUGIN_ROOT:-$HOME/Documents/dev/session-cartographer}}}"
node "$ROOT/scripts/trust-digest.js"
```

**Show the panel to the user verbatim.** Do not paraphrase it or retype its
counts — the hit counts are the entire basis for deciding what belongs in the
trust boundary, and retyping is where they drift.

Then read it before drafting anything. Every entry you propose must trace to a
row in this panel. If you believe something belongs in the environment that the
digest doesn't show, say it's unlogged rather than asserting it — an environment
entry is a standing grant, and a hallucinated one widens the boundary silently.

Useful flags: `--window 90d` to narrow, `--cap 80` if a warning says projects
ranked below the probe cap, `--min 1` to see low-frequency CLIs, `--json` for
the structured form.

## Step 0.5: If the digest says COLD START, stop and hand over the template

A thin corpus doesn't produce a thin answer — it produces a confident-looking
panel built from forty events, which is worse, because the gaps are invisible.
The digest detects this and prints a `⚠ COLD START` block naming which signals
are missing.

When it does, **do not draft entries from the panel.** Say plainly that there
isn't enough history to derive a trust boundary yet, then offer both paths:

1. **Claude Code's own setup wizard**, which scans this machine directly and
   needs no corpus. It offers itself once auto mode has been active for a few
   startups; that dialog is the fastest path on a fresh install. Recommend this
   one first — deriving from an empty corpus is strictly worse than scanning.
2. **The fill-in template**, if they'd rather answer directly:

   ```bash
   ROOT="${CARTOGRAPHER_ROOT:-${CLAUDE_PLUGIN_ROOT:-${PLUGIN_ROOT:-$HOME/Documents/dev/session-cartographer}}}"
   node "$ROOT/scripts/trust-digest.js" --template
   ```

   Walk them through it in conversation and write the answers up as entries.
   Everything from Step 2 onward applies unchanged.

Either way, tell them to re-run `/trustmap` once a few weeks of sessions have
accumulated. The value here is the *update* path — diffing what they set today
against what their work turns out to touch — not the first draft.

## Step 1: Draft the entries

Entries are **prose, not patterns** — the classifier reads them as natural
language. Write them the way you'd describe your infrastructure to a new
engineer. Group related facts into one entry rather than emitting one line per
host.

Map digest sections to entries like this:

| Digest section | Entry |
|---|---|
| Source control orgs | `Source control: {host}/{org} and all repos under it` |
| Internal / LAN hosts | `Trusted internal domains: {hosts}` — say what each one *is* |
| Cloud buckets | `Trusted cloud buckets: {uris}` |
| Package registries | `Internal package registry: {host}` |
| k8s namespaces | `Protected deployment namespaces: {names}` |
| Non-standard CLIs | `Org-specific CLIs: {names}` — say what each one drives |
| Sensitive data locations | `Sensitive data locations & audiences: {paths}` |

Three rules that decide most of the judgment calls:

1. **Skip the loopback ports.** The digest lists them for context. Local dev
   servers are already inside the working directory's boundary; naming
   thirty-eight of them adds no permission and buries the real entries.
2. **Skip public hosts.** `github.com`, `arxiv.org`, and documentation sites
   need no entry. The environment block exists to name what the classifier
   *can't* infer, and a public host being reachable isn't the question.
3. **A low hit count is a question, not an entry.** One or two hits usually
   means a one-off, or a truncation artifact that survived the shape check. Ask
   before promoting it.

For the CLI list, name what the tool *does*, because the classifier is judging
consequences, not commands: "`adb` drives a Fire TV device on the LAN for app
installs" tells it something "adb" alone does not.

The sensitive-data entry deserves its own care. The classifier's built-in rules
already name agent-session transcripts and conversation logs as sensitive data
that belongs in no repo — and cartographer's event logs are exactly that. Naming
their paths makes the protection specific to where they actually live instead of
depending on the classifier inferring it from a filename.

## Step 2: Show the diff and get approval before writing

Print the exact entries you intend to add, then ask. Writing to
`~/.claude/settings.json` changes how every future session's permissions resolve
— it is not a change to make on inference.

**`"$defaults"` must be the first element.** Omitting it does not merge with the
built-in entries — it *replaces* them, discarding the working-repo and
source-control defaults the classifier relies on. The same applies to `allow`,
`soft_deny`, and `hard_deny`; this skill touches only `environment`.

Note the scope: the classifier reads `autoMode` from `~/.claude/settings.json`
and managed settings **only**. It deliberately ignores `.claude/settings.json`
and `.claude/settings.local.json` in the repo, so a checked-in file can't inject
its own trust. Don't write project-scoped entries and expect them to apply.

## Step 3: Merge — augment, never replace

The environment block has more than one author. Claude Code's setup wizard
writes it, this skill writes it, and the user edits it by hand. So **stamp every
entry you write, preserve every entry you didn't, and rewrite only your own.**

Each entry you author ends with the dated marker the digest prints as
`provenance.stamp`, e.g. `[trustmap 2026-08-15]`. Entries are free-form prose,
so the marker is legal and the classifier reads past it — but it is what lets a
re-run correct a stale entry without touching the wizard's work.

The merge is then mechanical: `$defaults`, then foreign entries verbatim, then
yours. The digest hands you the foreign list, so you never have to re-derive it.

```bash
SETTINGS="$HOME/.claude/settings.json"
ROOT="${CARTOGRAPHER_ROOT:-${CLAUDE_PLUGIN_ROOT:-${PLUGIN_ROOT:-$HOME/Documents/dev/session-cartographer}}}"
cp "$SETTINGS" "$SETTINGS.bak-$(date +%Y%m%d%H%M%S)"

DIGEST=$(node "$ROOT/scripts/trust-digest.js" --json)
STAMP=$(printf '%s' "$DIGEST" | jq -r '.provenance.stamp')
FOREIGN=$(printf '%s' "$DIGEST" | jq -c '.provenance.foreign')

# One entry per argument, WITHOUT the stamp — it is appended below, so the same
# text can never end up double-stamped on a re-run.
MINE=$(printf '%s\n' \
  "ENTRY_ONE" \
  "ENTRY_TWO" \
  | jq -R . | jq -s --arg s "$STAMP" 'map(select(length > 0) | . + " " + $s)')

jq --argjson foreign "$FOREIGN" --argjson mine "$MINE" \
  '.autoMode = ((.autoMode // {}) | .environment = (["$defaults"] + $foreign + $mine))' \
  "$SETTINGS" > "$SETTINGS.tmp" && mv "$SETTINGS.tmp" "$SETTINGS"
```

Three properties this buys, none of which the old wholesale assignment had:

- **The wizard's entries survive.** They land in `foreign` and are copied
  through untouched. Running both tools in either order converges.
- **Your own entries are corrected, not duplicated.** Old `[trustmap …]` entries
  are dropped and replaced by this run's set, so a host whose description
  changed gets one accurate entry rather than two contradictory ones.
- **`$defaults` is re-asserted every time**, so it can't be lost by an edit.

### When a foreign entry contradicts your proposal

Preserving foreign entries verbatim is right when you merely lack evidence about
one. It is wrong when the foreign entry is *false*, and appending next to it
leaves the classifier reading a contradiction instead of a correction.

Before writing, read `provenance.foreign` and check each entry you're about to
add against it. Three slots are worth checking every run, because the built-in
wizard writes all three and a narrow scan gets all three wrong in the same
direction:

- **`Trusted repo`** — the built-in default is dynamic ("the git repository the
  agent started in"). A wizard run pins it to whatever repo it scanned. Pinned
  to one path at user scope, it is a downgrade for every other project.
- **`Primary use of Claude Code`** — same shape: "software development" narrowed
  to one project's subject matter.
- **`Source control`** — a scan of a checkout with no remote can write "no
  additional orgs configured" as a positive claim, which your digest's org rows
  directly contradict.

When you find a collision, **show both texts and ask which survives.** Don't
rewrite a foreign entry silently — that's the clobbering this merge exists to
prevent. If the user replaces it, drop it from the `FOREIGN` array you pass to
`jq` and write your own stamped entry in its place; if they keep it, carry it
forward and say plainly that the contradiction is still there.

### Retiring stale entries

Nothing else in this pipeline ever removes an entry, so a host you stopped using
keeps granting trust indefinitely. The digest flags entries it wrote whose
identifiers no longer appear anywhere in the corpus:

```
  Stale — written by /trustmap, no longer supported by the corpus
    −        Trusted internal domains: 10.9.9.9:1234, a decommissioned build box…
```

**Always ask before dropping one.** Absence from a 365-day window is not proof
the thing is gone — it may be a service used seasonally, or from a machine whose
history isn't in this corpus. Retire by omitting it from `MINE`; keep it by
carrying its text forward.

## Step 4: Verify

```bash
claude auto-mode config | jq -r '.environment[]' | tail -20
```

This prints what the classifier actually uses, with `"$defaults"` expanded in
place. If your entries aren't in the output, the write didn't take effect —
check that you edited `~/.claude/settings.json` and not a project settings file.

Then confirm the JSON is intact, since a botched merge silently disables hooks
and permissions:

```bash
jq -e '.permissions and .enabledPlugins' "$HOME/.claude/settings.json" > /dev/null \
  && echo "settings intact" || echo "SETTINGS DAMAGED — restore from the .bak file"
```

## Step 5: Log it

The environment block is a decision about trust boundaries, and the reasoning
behind each entry is exactly the kind of thing that's expensive to re-derive.
Log it so `/remember` can recall why a host was trusted.

```bash
DEV="${CARTOGRAPHER_DEV_DIR:-$HOME/Documents/dev}"
ROOT="${CARTOGRAPHER_ROOT:-${CLAUDE_PLUGIN_ROOT:-${PLUGIN_ROOT:-$HOME/Documents/dev/session-cartographer}}}"
CLAUDE_SID="${CLAUDE_SESSION_ID:-${CLAUDE_CODE_SESSION_ID:-}}"
SESSION_ID="${CARTOGRAPHER_SESSION_ID:-${CLAUDE_SID:-${CODEX_SESSION_ID:-unknown}}}"
PROVIDER="${CARTOGRAPHER_PROVIDER:-unknown}"
[ "$PROVIDER" = "unknown" ] && [ -n "$CLAUDE_SID" ] && PROVIDER="claude"
[ "$SESSION_ID" = "unknown" ] && echo "warning: session id unresolved — this milestone will not link to a transcript" >&2

jq -n -c \
  --arg eid "evt-$(LC_ALL=C tr -dc 'a-z0-9' < /dev/urandom | head -c 12)" \
  --arg ts "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" \
  --arg session "$SESSION_ID" \
  --arg provider "$PROVIDER" \
  --arg project "$(basename "$(git rev-parse --show-toplevel 2>/dev/null || pwd)")" \
  --arg cwd "$(pwd)" \
  --arg description "TRUSTMAP_SYNTHESIS_HERE" \
  '{event_id: $eid, timestamp: $ts, milestone: "trustmap_update", event: "Trustmap",
    provider: $provider, description: $description, summary: $description,
    session_id: $session, project: $project, cwd: $cwd}' \
  >> "$DEV/session-milestones.jsonl"

tail -1 "$DEV/session-milestones.jsonl" | bash "$ROOT/scripts/index-event.sh"
```

Replace `TRUSTMAP_SYNTHESIS_HERE` with one line naming what you added and why —
it must be a **single line**, since the pipeline is TSV/line-based and a literal
newline splits the row.

## What NOT to do

- Don't propose an entry the digest doesn't support
- Don't write to settings without showing the diff and getting a yes
- Don't omit `"$defaults"` — it replaces the built-ins rather than extending them
- Don't add public documentation hosts; they need no grant
- Don't add loopback ports
- Don't duplicate what CLAUDE.md already says. The classifier reads CLAUDE.md
  too, so a fact stated there is already reaching it — restating it here creates
  a second copy that drifts
- Don't touch `allow`, `soft_deny`, or `hard_deny`. Those change what gets
  blocked, not what's trusted, and they belong to a deliberate decision rather
  than a derived one

## Example

Digest row → entry:

```
    +   966  adb
    +     4  192.168.1.42:8769
```

> "Org-specific CLIs: `adb` for installing and debugging builds on Fire TV
> devices over the LAN; `xcodebuild`, `xcrun`, and `codesign` for tvOS and macOS
> builds; `ffmpeg`/`ffprobe` for video render pipelines."
>
> "Trusted internal domains: 192.168.1.42:8769, a LAN service on the home
> network used during development."

Bad entry — a pattern, not prose, and it grants far more than the evidence:

> "Trusted: 192.168.*, *.local, all github.com repos"
