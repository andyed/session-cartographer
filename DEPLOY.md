# Deploy — session-cartographer

**Live URL:** https://andyed.github.io/session-cartographer/
**Source branch:** `gh-pages`, path `/`
**Deploy trigger:** **Manual.** No GH Actions workflow in repo; no `deploy`
script in any `package.json`. Recent `gh-pages` commits are authored by Andy
directly (not `github-actions[bot]`) with generic messages ("Updates") — which
is what the default `gh-pages` npm tool produces.

## What's on `gh-pages` (re-observed 2026-09-10)

```
.claude-plugin/   assets/   demo/   favicon.ico   index.html   js/   plugins/
```

**This IS the Vite build.** The earlier note here ("NOT a Vite build output")
is wrong and cost an investigation: `index.html` on `gh-pages` is a 2.8 KB
shell that mounts `assets/index-*.js` into `#root`, which is `explorer/` built
with `VITE_DEMO=true` (base `/session-cartographer/`). The demo runs the real
Explorer against static JSON — `explorer/src/demo.js` intercepts every
`/api/*` call and answers it from `demo/` fixtures.

`demo/demo/…` on the deployed tree is real, not a typo: `demo.js` fetches
`${BASE}demo/demo/…`, and `explorer/public/demo/demo/` is the copy a browser
actually loads. The flat `explorer/public/demo/` beside it is a stale older
snapshot that nothing reads — do not "fix" a fixture by editing that one.

## Building the demo

```bash
node scripts/build-demo-memory.mjs --write     # working-memory field fixture
VITE_DEMO=true npm run build --prefix explorer # bundle → explorer/dist
node tests/browser/demo-memory.cjs             # verify the built demo
```

`build-demo-data.js` regenerates the search/timeline fixtures from a running
Explorer and scrubs real names out of them. `build-demo-memory.mjs` needs no
server: it derives the memory field from `demo/sessions.json`, which is already
sanitized, so the demo stays off the sanitization critical path.

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
