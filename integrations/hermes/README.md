# Hermes / FrakBot session feed

`frakbot-carto-feed.sh` is the personal policy wrapper for FrakBot's bounded
cross-agent session pulse. It calls the canonical
`scripts/cartographer-pulse.sh`; it does not maintain another index.

Install the wrapper under Hermes:

```bash
cp integrations/hermes/frakbot-carto-feed.sh \
  /Users/andyed/.hermes/scripts/frakbot-carto-feed.sh
chmod +x /Users/andyed/.hermes/scripts/frakbot-carto-feed.sh
```

Attach it as the pre-script on the `frakbot-dream-molt` job. Hermes runs the
script immediately before the agent and injects stdout into that run's prompt.
The existing signal-pulse `context_from` dependency remains unchanged.

## The pulse has two parts

The wrapper previously called `scripts/cartographer-feed.sh` directly, which
runs one relevance search with a fixed generic query and reports what ranks.
That is the right instrument for "what here is worth reading" and the wrong one
for "what happened": a census question has no relevance gradient, so every event
in the window is equally on-topic and the ranker returns *an* answer with no way
for the caller to know it is not *the* answer. Measured on 2026-09-08, the feed
returned one result — a Lemon Squeezy refund-policy fetch — from a 24h window
holding hundreds of events and more than a dozen commits, including
`fix(recorder): release the 4K capture pin` and
`fix(lights): apply Room brightness once`.

`cartographer-pulse.sh` therefore counts first and ranks second:

1. **What happened (counted)** — a deterministic census from the facts endpoint:
   totals, sessions, by-project and by-type tables, and the unattributed counts
   reported separately rather than folded into a bucket. Exhaustive within its
   window and scope. Every bucket cites `event_id`s so any number can be checked
   with `scripts/cartographer-search.sh --get`.
2. **Commits** — every `git_commit` / `git_push` in the window, grouped by
   project. The highest-confidence rows in the corpus, and the ones relevance
   ranking is worst at surfacing, since a commit summary shares no vocabulary
   with a phrase like "what happened yesterday".
3. **Tempo** — per-project daily volume with a trailing baseline and z-score.
   The partial current UTC day is shown and never scored.
4. **What the search surfaced** — the existing `cartographer-feed.sh` output,
   invoked unchanged as a subprocess, with only its heading levels demoted so it
   nests. It finds meaning; the census establishes ground truth.

If the facts service is unreachable the pulse still emits the search section and
says plainly that the counted section is unavailable. It never prints a zeroed
census: "0 events" is indistinguishable from "nothing happened", and an outage
read as a quiet day is the failure this whole split exists to prevent.

## Who owns what

**The wrapper owns the allowlist. The builder owns the mechanics.**

The wrapper searches only named independent-project aliases and repositories. It
deliberately omits generic `dev`/unknown projects, the deprecated FrakBot alias
that maps to OpenClaw history, and employer systems. Override the list for a
one-off dry run with `FRAKBOT_CARTO_PROJECTS`; do not broaden the scheduled
default without reviewing the source-policy boundary.

The list was widened on 2026-09-08, the first time that boundary could be
reviewed against evidence rather than memory. The census made the blind spot
measurable — 232 events in one 24h window belonged to active projects the
wrapper could not see, including commits landing that same day in
`attentional-foraging`, `crforager`, and `allserp-paper`. The additions were
chosen by diffing a 30-day census against the registry-expanded list, so the
question answered was "what is actually running that FrakBot cannot see",
not "what do I remember owning". The blind spot went from 232 events across six
projects to 93 across two.

Both remaining exclusions are deliberate, and the reasoning matters more than
the list:

| Excluded | Why |
|---|---|
| `dev` | The workspace root, not a project — 15,270 events in 30 days. The same trap `build-profile.js` documents: without the filter, the directory everything lives under is the busiest "project" you own. |
| `psychodeli-private` | The name is an explicit signal from the operator. Admit it deliberately or not at all. |
| auto-named worktrees | `brave-thompson-40e495` and siblings are checkouts of projects already listed; admitting them double-counts the work under a name that means nothing to a reader. |
| `WarnerBros` | Job-search material — interviewer dossiers, employer research. Personal and sensitive, and not something to place in a scheduled agent's daily prompt. |
| `andyed`, `repo`, `dist`, `spec`, `Documents-dev`, `/` | cwd-derived artifacts, not projects. |

Matching is case-insensitive substring, so a family name admits its
repositories: `antheia` covers `antheia-firetv`. That is convenient and it is
also how an over-broad entry quietly admits more than intended — check what a
new name matches before adding it.

`cartographer-pulse.sh` fails closed on `--projects` for the same reason
`cartographer-feed.sh` does: an unscoped census would be complete, correct, and
completely inappropriate — it would count exactly the sources this allowlist
exists to exclude, and look authoritative doing it.

Because the scope is a policy boundary rather than a search bug, the pulse also
reports how many events in the same window fell *outside* it, and which
projects. That makes the blind spot visible instead of invisible. It is a
prompt to review the boundary deliberately, not a defect to fix by widening the
list.

## Configuration

The facts half talks to the warm Turbo/Explorer service on loopback
(`CARTOGRAPHER_TURBO_URL`, default `http://127.0.0.1:2526`), preferring
`scripts/cartographer-facts.js` — which owns the HTTP-then-spool transport a
sandboxed caller needs — and falling back to a direct HTTP POST only when that
client is not present in the runtime. Neither path writes:
`scripts/cartographer-search.sh` remains the single writer of `served-log.jsonl`
and `access-ledger.jsonl`, and the search half continues to route its telemetry
to `/dev/null`.
