# Spec: session-id attribution + 0.5.0 release

Status: code + data work complete; release prepared and on hold · 2026-08-14 · Target: 0.5.0

## Problem

Session Cartographer resolves the active session from an environment variable
chain that reads `CLAUDE_SESSION_ID`. **Claude Code has never set that
variable.** The name it actually exports to tool calls is
`CLAUDE_CODE_SESSION_ID`.

Every consumer that read only the legacy name has been running unattributed for
the life of the feature. Measured on the live corpus (2026-08-14):

| Symptom | Measured |
|---|---|
| Served rows with an empty `session_id` | 4,361 / 4,361 (100%) |
| Delta serving activations | 0 — dormant since it shipped |
| `session_wrapup` milestones with no session | 437 / 507 (86%) |
| …of those, reachable transcripts | 0 |

The last row is the expensive one. `/wrapup` milestones carry the highest
salience in the corpus (0.9), so they rank at the top of `/remember` results —
and 437 of them are dead ends. The skill's Step 3 says *"the search result is
the map, the transcript is the territory"*, then hands over a map with no
territory attached. The synthesis paragraph survives; everything behind it is
gone.

Two distinct failures share the one cause:

1. **Attribution** — events written by skills/hooks that read the env chain
   (`/wrapup`, `/investigate`, `log-knowledge-gap.sh`) recorded
   `session_id: "unknown"`, which then defeated the transcript lookup, which
   then wrote `transcript_path: ""`.
2. **Delta serving** — `cartographer-search.sh` gates its per-session
   suppression list on the same chain, so every `/remember` in a session
   re-served the top-K it had already shown.

This also invalidates the retrieval baseline in `TODO.md` ("25/1,317 served rows
touched, MRR 0.113"). That was measured with attribution broken. It is not a
verdict on search quality and must be re-baselined, not carried forward.

## Scope

**In:**
- Fix the env chain in every consumer.
- Regression test that fails if the chain regresses.
- Assess and, if it clears the bar, run a one-time repair of the 437 orphan
  wrapup milestones.
- Ship the session digest (`/wrapup` Step 0), which is what surfaced this.
- Release 0.5.0.

**Out (deliberately deferred):**
- `--arc` renderer for `--thread`.
- Shared presentation contract across `/remember` and `/focus`.
- Re-baselining retrieval precision. Blocked on accumulating attributed
  telemetry — needs weeks of real use, not a release.

## The canonical chain

One order, everywhere. Most specific wins; provider-neutral names first.

```
CARTOGRAPHER_SESSION_ID → CLAUDE_SESSION_ID → CLAUDE_CODE_SESSION_ID → CODEX_SESSION_ID
```

`CLAUDE_SESSION_ID` stays in the chain ahead of the real one: it costs nothing,
and it preserves the override for anyone who set it manually to work around
this. Provider detection derives from whichever entry resolved — it must not
re-test `CLAUDE_SESSION_ID` independently, which is the second half of the same
bug and silently produced `provider: unknown` on 369 wrapup records.

### Work item 1 — fix every consumer

| File | Defect |
|---|---|
| `scripts/cartographer-search.sh:94` | ✅ fixed — `CLAUDE_SID` helper, chain + provider |
| `scripts/session-digest.js:41` | ✅ new, full chain |
| `plugins/…/skills/wrapup/SKILL.md:54` | session + provider chain |
| `plugins/…/skills/investigate/SKILL.md:72` | session + provider chain |
| `plugins/…/hooks/log-knowledge-gap.sh:36` | session + provider chain |
| `plugins/…/skills/remember/SKILL.md:113` | doc text names only the legacy var |
| `scripts/cartographer-search.sh:41` | usage text names only the legacy var |

Skills and hooks live canonically under `plugins/session-cartographer/`; the CLI
lives at the repo root and is mirrored by `copy-plugin-runtime.sh`. Fix each at
its canonical location, then re-run the assembly script.

**Acceptance:** `grep -rn 'CLAUDE_SESSION_ID' --include='*.sh' --include='*.js'`
returns no site that reads it *without* `CLAUDE_CODE_SESSION_ID` alongside.

### Work item 2 — regression test

`tests/unit/session-id-chain.test.js`, run by CI's existing
`node --test tests/unit/*.test.js`.

Spawn `cartographer-search.sh` and `session-digest.js --json` under each of four
environments — only `CARTOGRAPHER_SESSION_ID`, only `CLAUDE_CODE_SESSION_ID`,
only `CLAUDE_SESSION_ID`, none — and assert the resolved session and provider.
Point `CARTOGRAPHER_SERVED_LOG` at a temp file and assert the written row
carries the id; that is the assertion that would have caught this originally,
because the failure was silent everywhere except in the log rows nobody read.

**Acceptance:** test fails when the `CLAUDE_CODE_SESSION_ID` branch is reverted.

### Work item 3 — test hermeticity

Delta serving is real now, so a harness inheriting a live session id loses
repeat results and fails passing tests. Both private harnesses now `unset` the
four vars. ✅ done — 15/15 fixture, 11/11 live, verified inside a live session.

Any new harness must do the same. Recorded in `CLAUDE.md`.

### Work item 4 — orphan repair ✅ done

**Result on the reference corpus (439 orphans, 2026-08-14):**

| Outcome | Count | Rate |
|---|---:|---:|
| Recovered, transcript verified on disk | **145** | 33.0% |
| Recovered, transcript expired past TTL | 10 | 2.3% |
| Ambiguous — refused | 101 | 23.0% |
| Unrecoverable | 183 | 41.7% |

Wrapup milestones with a working transcript went **65 → 210**. Line count and
JSON validity unchanged (12,963 in, 12,963 out, 0 unparseable); all 155 repaired
events reindexed into Qdrant.

Two findings worth keeping, both of which changed the design:

1. **Window coverage alone is far too blunt.** First pass scored 50.8%
   ambiguous. A session resumed over five days has a five-day window, and with
   3–5 concurrent sessions those windows blanket everything. Adding a
   *proximity* discriminator — distance to the session's nearest actual event in
   the same project — cut ambiguity to 23% and doubled recovery. Most matches
   land at a gap of 0 seconds, because the wrapup's own hook-logged bash call
   sits in the same second; that is near-ground-truth, not a guess.
2. **`"unknown"` was being admitted as a session id**, building a phantom window
   spanning the corpus. It was "matching" 148 orphans and writing `unknown` back
   onto records that already said `unknown` — a no-op the report counted as a
   win. Excluding the sentinel dropped apparent recovery from 239 to 155. The
   lower number is the true one.

Verification before writing: five sampled matches were checked against transcript
content. Four contained the literal `/wrapup` invocation within 90 seconds of the
milestone timestamp; the fifth showed on-topic conversation matching the
milestone description.

The remaining 101 ambiguous records stay unattributed on purpose. A wrong
session id is worse than a missing one.

**Historical detail — how the original 437 arose:**

A skill's inline bash reads the env chain, so it wrote `session_id: "unknown"`.
The *hooks* read session from the hook payload on stdin, so they were never
affected — which is why the same session's `tool_bash` events are correctly
attributed while its wrapup milestone is not. That asymmetry is what makes
proximity matching work so well: the sibling event the repair matches against is
usually the wrapup's own bash call.

**Implementation:** `scripts/repair-orphan-sessions.js`, sharing window
construction with `enrich-sessions.js` via `scripts/session-windows.js` but
applying a deliberately stricter policy — project match required, ambiguity
refused, transcript verified on disk and confirmed to cover the timestamp before
it is written. Dry run by default; `--write` takes a `.bak` first; only repaired
lines are reserialized so the diff is exactly the repair.

### Work item 5 — session digest

✅ built. `scripts/session-digest.js` renders one panel per session: span,
tempo, commits with type and diff-shape mix, hottest files, research hosts,
`/remember` served-vs-used, and live dirty/unpushed state per repo touched.
`/wrapup` runs it as Step 0 and writes its synthesis against it rather than from
conversational recollection. Digest scalars are attached to the milestone under
`digest`, guarded to `null`, so the record stays checkable after the transcript
TTL expires.

Remaining before release: confirm the digest degrades cleanly when
`CARTOGRAPHER_LOG_TOOL_USE` is unset (edits and bash are then unlogged, so the
panel is thin — it must stay honest, not misreport zero as inactivity).

## Release 0.5.0 — PREPARED, ON HOLD

Everything below is done except the commit. **Nothing is committed or tagged.**

Held on 2026-08-14 because concurrent sessions had in-flight work in the tree:
`--get EVENT_IDS` uncommitted in `cartographer-search.sh`, and an untracked,
actively-being-written `scripts/build-profile.js`. Committing would have swept
another session's unfinished work into a tagged release, and
`tests/source-marketplace-smoke.sh` iterates every file in `scripts/` demanding
a matching plugin copy, so CI fails on `build-profile.js` regardless.

**Resume checklist:**

1. Confirm the tree holds only this work — `git status` should show no
   unexplained additions in `scripts/`. Decide separately whether `--get` and
   `build-profile.js` belong in this release; if `--get` ships, it needs its own
   CHANGELOG section.
2. `bash scripts/copy-plugin-runtime.sh plugins/session-cartographer`
3. Green: `node --test tests/unit/*.test.js`,
   `bash tests/source-marketplace-smoke.sh`, both private harnesses.
4. `bash scripts/build-release.sh` → verify `dist/release/`.
5. Commit, tag `v0.5.0`, push. `release.yml` fires on `v*`.

**State as of the hold:** version bumped to 0.5.0 in all four manifests,
CHANGELOG written, user-facing recovery documented in `docs/SETUP.md`, orphan
repair already run against the live corpus. Tests: 60/60 unit, 15/15 fixture,
11/11 live; marketplace smoke fails only on the concurrent `build-profile.js`.

**Minor, not patch.** Delta serving switching from dormant to active is a
user-visible behavior change — repeat `/remember` calls in one session will
start returning different results. That warrants a minor bump on its own, before
counting the new digest.

Version is declared in four places and `build-release.sh` hard-fails on any
mismatch:

- `package.json`
- `plugins/session-cartographer/.claude-plugin/plugin.json`
- `plugins/session-cartographer/.codex-plugin/plugin.json`
- `.claude-plugin/marketplace.json`

Steps:

1. Fix work items 1–2; re-run `copy-plugin-runtime.sh`.
2. Green: `node --test tests/unit/*.test.js`, `tests/source-marketplace-smoke.sh`,
   both private harnesses.
3. Bump all four manifests to `0.5.0`.
4. Write the `## 0.5.0` CHANGELOG entry under `## Unreleased`. Lead with the
   attribution fix and say plainly that delta serving was inert until now —
   users who wondered why `/remember` repeated itself deserve the explanation.
5. `bash scripts/build-release.sh` → verify `dist/release/`.
6. Commit, tag `v0.5.0`, push. `release.yml` fires on `v*`.

**Timing:** no GitHub pushes weekdays 10:00–15:00 PT.

## Decisions taken

1. **Version 0.5.0**, not 0.4.2 — delta serving going from dormant to active is
   a user-visible behavior change.
2. **Orphan repair did not wait for the release.** It ran against the live
   corpus on 2026-08-14; the code fix stops new orphans accruing.
3. **`/wrapup` and `/investigate` now warn** on an unresolved session. A silent
   `"unknown"` is how 437 records accumulated unnoticed.

## Still open

- **Do `--get` and `build-profile.js` ship in 0.5.0?** Both are concurrent-session
  work, not part of this spec. `--get` is functional and tested; if it ships it
  needs a CHANGELOG section. `build-profile.js` has no plugin twin and currently
  fails the marketplace smoke gate.
- **Re-baseline retrieval precision.** The `TODO.md` figures (25/1,317 touched,
  MRR 0.113) were measured with attribution broken. Needs weeks of attributed
  telemetry before it means anything.
- **The 101 ambiguous orphans.** A transcript-content tiebreaker — scanning
  candidate transcripts for the `/wrapup` invocation near the timestamp — would
  likely resolve many, at the cost of reading large files. Deferred; refusing is
  the correct conservative default.
