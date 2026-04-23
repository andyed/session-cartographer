# Deploy — session-cartographer

**Live URL:** https://andyed.github.io/session-cartographer/
**Source branch:** `gh-pages`, path `/`
**Deploy trigger:** **Manual.** No GH Actions workflow in repo; no `deploy`
script in any `package.json`. Recent `gh-pages` commits are authored by Andy
directly (not `github-actions[bot]`) with generic messages ("Updates") — which
is what the default `gh-pages` npm tool produces.

## What's on `gh-pages` (observed 2026-04-23)

```
.claude-plugin/   assets/   demo/   favicon.ico   index.html   js/   plugins/
```

That's the landing page + demo site assets — NOT a Vite build output. The
`explorer/` React app (source in `explorer/`, dev on ports 2526/2527) is a
separate dev-only tool; it's not what gh-pages serves.

## Deploy command — ⚠️ owner to confirm

Best guess based on the `gh-pages` branch contents + generic commit messages:

```bash
# One of these, run from the repo root:
npx gh-pages -d .            # push the whole working-tree root
# or
git subtree push --prefix=<subdir> origin gh-pages
```

**Andy: fill in the actual command you use so future touches don't guess.**

## Minimal-change protocol (text-only patches)

For analytics-key changes, copy edits, small fixes in the demo / landing site:

Since `gh-pages` holds the deployed artifact directly, prefer `sed` on the
`gh-pages` branch via the worktree pattern (same as attentional-foraging):

```bash
cd ~/Documents/dev/session-cartographer
git fetch origin gh-pages
git worktree add /tmp/sc-gh-pages gh-pages
cd /tmp/sc-gh-pages
git rebase origin/gh-pages
find . -name '*.html' -exec sed -i '' 's|OLD|NEW|g' {} +
git add -A && git commit -m "…" && git push origin gh-pages
cd ~/Documents/dev/session-cartographer
git worktree remove /tmp/sc-gh-pages
```

Also apply the same edit on `main` so the next regular deploy doesn't regress.

## Verification

```bash
curl -s https://andyed.github.io/session-cartographer/ | grep -o "phc_[A-Za-z0-9]*" | head
# expect phc_pHADEc...  (cartographer project 363226)
```

## PostHog

Writes to **cartographer project (363226)**. Not conflated.
