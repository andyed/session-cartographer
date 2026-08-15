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

**Use `/trustmap` once you have a corpus.** Cartographer has already extracted
the same substrate the wizard re-reads on acceptance, which changes three
things:

| | Built-in wizard | `/trustmap` |
|---|---|---|
| Source | Rescans the machine on acceptance | Events already extracted |
| Ranking | Repos under `$HOME`, self-labeled "CANDIDATES, not vetted context" | Usage-weighted — commits and pushes per repo |
| Providers | Claude Code sessions | Claude Code + Codex + backfilled git history |
| Coverage | Transcripts under a byte cap; "a recent session in a project past the cap may be missing" | Whole corpus |
| Re-run | One-shot draft | Diffs against current settings, proposes only the delta |

The delta behavior is the real reason this exists. A one-shot draft goes stale
the first time you add an internal host; a re-runnable derivation doesn't.

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
    +     4  192.168.1.74:8769

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
    +   230  ~/dev/cikm-leakycursor-replicate/data/llm_judge  (gitignored)
    +    84  ~/dev/attentional-foraging/AdSERP/data           (gitignored)
    +    38  ~/dev/mbp-dash/data                              ← not gitignored
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

On update, rebuild the whole array including entries you'd already approved.
The merge assigns `environment` wholesale, so a partial list silently drops
them.

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
