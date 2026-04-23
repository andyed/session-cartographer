# Deploy — session-cartographer

**Live URL:** https://andyed.github.io/session-cartographer/
**Source branch:** `gh-pages`, path `/`
**Deploy trigger:** **Manual** (no GH Actions workflow in repo; no `npm run
deploy` script detected as of 2026-04-23).
**Build command:** ⚠️ **TODO — not yet documented.** Verify whether the explorer
app has a build step, or whether `explorer/` is served directly.
**Deploy command:** ⚠️ **TODO — not yet documented.** Likely `gh-pages -d <dir>`
against the explorer output, but the exact invocation should be filled in by
the repo owner.

## Minimal-change protocol

⚠️ **TODO — verify before relying on this.** Based on the `gh-pages` branch
pattern (which holds the deployed artifact directly), text-only patches should
be applicable via `sed` on the `gh-pages` branch, same as the attentional-
foraging pattern. See `attentional-foraging/DEPLOY.md` for the worktree + sed
workflow.

## Verification

```bash
curl -s https://andyed.github.io/session-cartographer/ | grep -o "phc_[A-Za-z0-9]*" | head
# expect phc_pHADEc...  (cartographer project 363226)
```

## PostHog

Writes to **cartographer project (363226)**. Not conflated.

## For the repo owner

This file was seeded by the 2026-04-23 per-project DEPLOY.md sweep with
**incomplete** information — the cartographer repo didn't expose a clear deploy
command. Please fill in the TODOs above with the actual commands so future
touches can follow the minimal-change protocol without guessing.
