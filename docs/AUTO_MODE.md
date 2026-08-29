# Building an auto mode config from your session history

Auto mode runs Claude Code without routine permission prompts by routing each
tool call through a classifier. The classifier blocks anything irreversible,
destructive, or aimed outside your environment — and by default "your
environment" means two things only: the working directory, and the current
repo's configured remotes. Your other GitHub org, the LAN device you flash
builds to, your internal package index: all external, all blocked.

`autoMode.environment` is the prose block that fixes that. This doc covers
deriving it from your session history with `/trustmap`.

## Which tool to use

**Use Claude Code's built-in setup wizard if you're starting fresh.** It scans
this machine directly — the repo, your recent sessions, optionally shell history
and other checkouts — and needs no history from cartographer. It offers itself
once auto mode has been active for a few startups ("Set up auto mode for your
environment?"). Nothing here replaces it.

**Then use `/trustmap` as well.** These are complementary, not competing, and
running both beats either. They're authoritative about different things:

| | Built-in wizard | `/trustmap` |
|---|---|---|
| Reads | The machine, right now | Events already extracted |
| Authoritative on | Live state you must *check* | Usage accumulated over *time* |
| Repo visibility | Verified via authenticated `gh` | Verified via `gh`, for every repo you write to |
| Branch protection, rulesets | Queried via `gh` | No equivalent |
| CI/CD targets | Scans `.github/workflows` | No equivalent |
| Classifier-bypassing allow rules | Audits `permissions.allow` in `settings.json` — but see the caveat below | No equivalent |
| CLI coverage | What its scope saw | Frequency-ranked across the whole corpus |
| Repos and orgs | Candidates under `$HOME`, self-labeled "CANDIDATES, not vetted context" | Usage-weighted by commits and pushes |
| Providers | Claude Code sessions | Claude Code + Codex + backfilled git history |
| Re-run | One-shot draft | Diffs against current settings, proposes only the delta |

### A measured comparison

Run on the same machine, wizard at `scope=project depth=both`:

**The wizard found, and `/trustmap` did not:** no branch rulesets are
configured; GitHub Actions and a Pages deploy target exist; and one entry in
`permissions.allow` — `Bash(python3 -c ":*)` — is a wildcarded interpreter that
resolves *before* the classifier, which it proposed removing. That last one is a
genuine security finding, and nothing in cartographer looks for it yet.

It also verified the repo is public rather than guessing. That one prompted a
change here: the digest already left the corpus to read git remotes and
`check-ignore` from disk, so refusing a `gh` call was a line drawn in the wrong
place. `/trustmap` now checks visibility for every repo you write to — not just
the one you're standing in, which is the wizard's scope. On the reference
machine that surfaced **five public repos among the twelve checked**, including
one holding paper drafts. The classifier assumes private unless told otherwise,
and that assumption fails in the unsafe direction.

**`/trustmap` found, and the wizard reported as `None configured`:** 24 CLIs it
never saw, including `adb` (966 hits), `ffmpeg` (958), `xcodebuild` (436),
`hermes` (296), and `netlify` (96) — against the wizard's own note that "only
claude, npx, pwd" appeared in its evidence. Also a LAN host, two additional
source-control remotes, and 11 data stores outside the project, four of them not
gitignored.

The gap is scope, and the wizard is explicit about it: *"Cross-project
transcript mining NOT GATHERED."* At `scope=project` it saw 13 transcripts.
Cartographer's corpus held 103,683 events across every project.

The lesson isn't that one tool wins. It's that the wizard's scope prompt
silently decides whether your config knows about 3 CLIs or 25, and the narrower
option is the one that sounds safer. Run the wizard for live state, `/trustmap`
for accumulated usage, and merge the two.

### A second run, and what a narrow scope actually costs (2026-08-16)

The first comparison measured what each tool *found*. A later run measured what
a narrow scope *writes*, which is the more expensive half.

The wizard was run at `scope=project` from inside a git worktree, and wrote to
`~/.claude/settings.json`. Two entries that are dynamic in the built-in defaults
came back pinned to that one project:

| slot | built-in default | what the run wrote |
|---|---|---|
| `Trusted repo` | "The git repository the agent started in and its remotes" | a literal path to one project's worktree |
| `Primary use of Claude Code` | "software development" | that project's specific subject matter |

Both are user-global. On a machine running several projects at once, every other
session now reads a trust boundary drawn around a repo it isn't in. A third
entry went further and asserted a negative — `Source control: … (no additional
orgs configured)` — derived from standing in a checkout with no remote, against
a corpus holding 30 repos under one GitHub org and two Overleaf remotes.

**A git worktree gets its own transcript directory.** That is the mechanism
behind most of it. The run's own note read *"Only 1 transcript with 148 Bash
commands was available for this project"*:

```
9 transcripts  ~/.claude/projects/-Users-…-<project>
1 transcript   ~/.claude/projects/-Users-…-<project>--claude-worktrees-<name>
```

The parent project had nine. Scanning from a worktree is a narrower scope than
`scope=project` sounds, and nothing in the prompt says so. Against that
1-transcript sample the run reported `None configured` for internal domains
(the corpus has a LAN host at 4 hits) and for org-specific CLIs (the corpus has
15 above the threshold, led by `curl` 1868, `ffmpeg` 1072, `adb` 966).

**The allow audit did not hold on the re-run.** It proposed removing
`Bash(python3 -c ":*)` — the finding quoted above from 2026-08-15 — and the
receipt came back `permissionsAllowNotFound`: no such rule existed any more. A
no-op removal, reported as a finding. It also reads `settings.json` only, while
`settings.local.json` carries `permissions.allow` too and, on the reference
machine, was where the rules that actually bypass the classifier lived —
wildcarded `curl`, `printenv`, `echo`, a Keychain read, and one rule with a
literal API key embedded in its text. Treat the table row above as "checks one
file," not "audits your allow rules."

**This is the counterpart to `COLD START`.** `/trustmap` refuses to draft from a
thin corpus because the gaps would be invisible. The wizard has no equivalent
refusal: given a thin scan it writes confident `None configured` entries and
narrows the dynamic slots, at global scope. Same failure, opposite tool, and the
only defense is checking its scope before accepting the write — verify it saw
the parent project rather than a worktree, and re-read the `Trusted repo` and
`Primary use` entries specifically, since those two are worse pinned than left
alone.

If your corpus is thin, `/trustmap` says so — it prints a `COLD START` block
naming which signal is missing and sends you to the wizard. Deriving a trust
boundary from forty events produces a confident-looking panel with invisible
gaps, which is worse than declining.

## The flow

```bash
/trustmap
```

The skill runs five steps. What each one is for:

**0 — Render the digest.** `scripts/trust-digest.js` mines the four event logs
and prints one panel. Every later step traces to a row in it.

```
━━ trust map · what your work actually touches ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  corpus    103,683 own events · 73,778 shell · 4,106 fetches · last 365d
  settings  ~/.claude/settings.json · 0 existing environment entries
  proposed  51 not yet covered  (+ = new, blank = already covered)

  Source control orgs (from remotes of repos you commit to)
    +    27  github.com/andyed

  Internal / LAN hosts contacted
    +     4  192.168.1.42:8769

  Non-standard CLIs by frequency
    +   966  adb          +   436  xcodebuild
    +   910  ffmpeg       +   296  hermes
```

**1 — Draft prose entries.** Entries are natural language, not patterns. The
digest gives identifiers; you supply what each one *is*, because the classifier
judges consequences rather than command names.

**2 — Review the diff.** Nothing is written before you approve it.

**3 — Merge** into `~/.claude/settings.json`, with a timestamped backup.

**4 — Verify** with `claude auto-mode config`.

**5 — Log it** as a searchable milestone, so `/remember` can recover *why* a
host was trusted.

## What the digest reads, and what it refuses to emit

Sources: `changelog.jsonl`, `tool-use-log.jsonl`, `research-log.jsonl`,
`session-milestones.jsonl`, plus git remotes read from disk for the top-ranked
repos.

**It emits identifiers, never arguments.** Commands reduce to their leading
word; URLs reduce to their host. The panel is meant to be pasteable into a
settings file without a secret review, and a full command line out of
`tool-use-log.jsonl` can't make that promise.

Two filters exist because the naive version was wrong on real data:

- **Commands resolve against `PATH`.** Splitting compound shell lines on `;` and
  `|` also splits the inside of inline `node -e` and `python -c` payloads, so
  language keywords surface as executables. On the reference corpus `const`
  (1,528) and `then` (374) outranked `adb` (966) and `xcodebuild` (436). A
  token that isn't executable on this machine isn't a CLI worth naming.
- **Hostnames are shape-checked.** Event summaries clip at ~200 characters, so a
  URL near the end yields a fragment. `huggingfa`, `static-user-manual-h5`, and
  a bare `127` all parse as single-label internal hostnames — and were the
  entire content of the internal-hosts section before the check.

Loopback endpoints collapse to one context line. A dev server on `127.0.0.1` is
already inside the working directory's boundary; listing thirty-eight ports as
"trusted domains" grants nothing and buries the hosts that matter.

## Sensitive data locations

This slot is worth more care than the rest, and it's the one the digest derives
rather than assumes.

Session transcripts are the store cartographer knows about a priori — its own
event logs, `~/.claude/projects`, `~/.codex/sessions`. They're rarely the *most*
sensitive thing on the machine. On the reference corpus the top data store is a
7.8 GB per-participant eye-tracking dataset; naming only the transcript logs
would have named the lesser store while implying the greater one was considered.

So the digest derives data stores from the corpus and reports each with its
git-ignore state:

```
  Data stores you work in (derived — review before naming)
    +   230  ~/dev/<project-a>/data/judge-runs  (gitignored)
    +    84  ~/dev/<project-b>/corpus/data           (gitignored)
    +    38  ~/dev/<project-c>/data                              ← not gitignored
```

**`← not gitignored` is the finding.** A data directory git already ignores is
contained; one it doesn't is committable today. Paths the corpus references but
that no longer exist on disk are marked `(no longer on disk — do not name)` and
excluded — naming a missing directory grants trust to whatever recreates it.

When you write the entry, name the audience, not just the path. The classifier's
rule is that personal and entrusted data has a permitted audience set by its
subjects or owners, and repo visibility never clears it: making a repo private
does not make participant data acceptable to commit there.

## Rules that decide most judgment calls

- **`"$defaults"` must be the first element.** Omitting it doesn't merge with
  the built-in entries — it *replaces* them. The same applies to `allow`,
  `soft_deny`, and `hard_deny`.
- **Scope is user settings only.** The classifier reads `autoMode` from
  `~/.claude/settings.json` and managed settings. It deliberately ignores
  `.claude/settings.json` and `.claude/settings.local.json`, so a checked-in
  repo can't inject its own trust.
- **Skip public hosts.** `github.com` and documentation sites need no entry.
  The block names what the classifier can't infer.
- **A low hit count is a question, not an entry.** One or two hits is usually a
  one-off or a surviving truncation artifact.
- **Don't restate CLAUDE.md.** The classifier reads it too, so a fact stated
  there already reaches it; a second copy just drifts.

## Keeping it current

Re-run `/trustmap` when a project stops being routine — a new org, a new deploy
target, or repeated denials for the same destination. The digest marks entries
already covered with a blank instead of `+`, so an update run shows only what
changed.

### Provenance: how two tools share one array

The environment block has more than one author — the wizard, `/trustmap`, and
you. Wholesale assignment means whoever ran last wins and silently discards the
rest. Pure appending never discards anything, but then nothing can correct its
own stale entry, so the block grows monotonically until it contradicts itself.

`/trustmap` stamps each entry it writes with a dated marker:

```
Source control: github.com/andyed and all repos under it [trustmap 2026-08-15]
```

Entries are free-form prose, so the marker is legal and the classifier reads
past it. On merge the array is rebuilt as `$defaults` + foreign entries verbatim
+ this run's stamped entries. That gives three properties:

- **The wizard's entries survive**, so running both tools in either order
  converges instead of clobbering.
- **Stamped entries are corrected, not duplicated** — a host whose description
  changed ends up with one accurate entry, not two contradictory ones.
- **`$defaults` is re-asserted every run**, so an edit can't drop it.

**What it does not do is resolve a conflict.** Foreign entries are preserved
verbatim, which is the right default for an entry `/trustmap` merely lacks
evidence about — but it is the wrong answer for a foreign entry that is *wrong*.
A wizard run that wrote `Source control: … (no additional orgs configured)` at
global scope will still say that after a `/trustmap` run appends the org it
found; the array then holds both, and the classifier reads a contradiction
rather than a correction.

So the merge has to detect collisions, not just avoid clobbering. When a
proposed entry addresses a slot a foreign entry already claims, name both and
ask which survives. Rewriting a foreign entry without asking is the clobbering
this design exists to prevent; leaving it silently is how a stale global
boundary outlives the tool that wrote it.

### Retiring entries

Nothing else here ever removes anything, so a host you stopped using keeps
granting trust indefinitely. The digest flags its own entries whose identifiers
no longer appear anywhere in the corpus:

```
  Stale — written by /trustmap, no longer supported by the corpus
    −        Trusted internal domains: 10.9.9.9:1234, a decommissioned build box…
```

It flags rather than acts, and the skill asks first: absence from a 365-day
window isn't proof the thing is gone. It may be seasonal, or used from a machine
whose history isn't in this corpus. Context entries that name no identifiers
("Organization: …") are never proposed for retirement — absence of an identifier
is not evidence against a description.

To review what got blocked in the meantime, open `/permissions` → **Recently
denied**. Cartographer doesn't yet log those denials, which means nothing
currently measures whether your entries reduced them — see `TODO.md`.

## Flags

| Flag | Effect |
|---|---|
| `--json` | Structured output, including `cold_start` and per-proposal `covered` |
| `--template` | Print the fill-in template and exit (cold-start path) |
| `--window 90d` | Narrow the corpus window (default `365d`) |
| `--min N` | Minimum hits for a CLI to appear (default `3`) |
| `--cap N` | Repos probed for remotes (default `40`) |
| `--no-git` | Skip on-disk remote and git-ignore probing |

## See also

- [Configure auto mode](https://code.claude.com/docs/en/auto-mode-config) — the
  settings reference, including every slot name
- [How we built auto mode](https://www.anthropic.com/engineering/claude-code-auto-mode)
  — why the classifier is reasoning-blind by design
- `claude auto-mode defaults` — the built-in rules, as JSON
- `claude auto-mode critique` — AI review of custom rules
- `claude auto-mode reset` — remove the `autoMode` section from user settings
