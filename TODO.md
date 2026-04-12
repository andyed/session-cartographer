# Session Cartographer — TODO

## Explorer UI
- [ ] Facet brushing — hover pill → non-matching results collapse to colored pixel bars
- [ ] Contrast audit — enforce minimum gray-300 for readable text, gray-400 for info
- [ ] Loading skeletons instead of text spinners
- [ ] Infinite scroll (auto-load on scroll vs. manual "show more")
- [ ] Error boundary — catch React crashes, show recovery UI
- [ ] **Transcript match display** — transcript search results show raw JSONL (`{"parentUuid":"...","isSidechain":false,...}`) instead of the conversation text. Need to extract the human-readable content from the message payload and display it as a summary, same as event log results.

## Search
- [ ] Stemming / lemmatization — collapse word variants in autocomplete (refactor/refactored/refactoring → one entry). Two approaches: (a) Porter stemmer at index time, classical NLP. (b) Embed top-N suggestions via mxbai-embed-large (already on :8890), cluster by cosine similarity, show one representative per cluster. Option b handles domain terms (psychodeli/psychodeliplus) that stemmers can't.
- [ ] Stopword model refinement — co-terms flyout still surfaces noise. Consider TF-IDF distinctiveness scoring or a learned stopword list from the index.
- [ ] `--list-types` — auto-discover event types from JSONL files
- [ ] Wildcard expansion feedback — show "expanded to N terms" in results meta
- [ ] **Phrase matching** — The #1 precision gap. "diff shape" returns P@5=0.0 because BM25 tokenizes to `diff OR shape`, matching every `git diff` command and vision research mention of "shape" independently.
  - **Tried and reverted: SDM-lite ordered bigrams.** Implemented in `bm25-search.awk` + `explorer/server/bm25.js` + shell quote pre-parser, validated by fixture tests showing correct adjacent-in-order ranking. But measured zero P@5 delta on 9 truth queries (bm25 P@5=0.44 pre, 0.44 post; hybrid 0.60 pre, 0.60 post) with a 33% indexing-cost regression (1509ms → 2024ms avg). Root cause: the `diff shape` target event (`Commit 57ee5c2`) has `diff-shape.sh` and `enrich-diff-shapes.sh` in its summary's files list, so filename tokenization already ranks it #1 on unigrams alone — bigrams add score but don't change the top-5 ordering. Other eval queries have too few adjacent-phrase docs to shift P@5 either way.
  - **Revised plan.** The bigram mechanism is correct but the *cost/benefit* is wrong for the current corpus+truth combo. Before trying again:
    1. Add truth queries where adjacency actually discriminates — two-word queries where neither word appears in commit filenames and there are ≥5 relevant events.
    2. Measure on that expanded truth set, not the current 9.
    3. Or: skip bigrams and invest in a tokenizer change that DOESN'T expand filenames into independent tokens (which is what inflates the false positives in the first place).
  - **Alternative considered:** Post-filter (score normally, then filter results missing the literal phrase). Simpler but doesn't boost proximity — just removes non-matches.
- [x] **Eval matcher fix (shipped)** — `scripts/eval-search.js` `matchTruth()` now falls back to session-level matching when no explicit truth-event overlap is found. Previously scored P@5=0 despite 100% session recall on 5 of 9 queries because commit event summaries (`Commit abc123: feat: ... | files: ...`) don't lexically overlap with human-written truth event summaries. Session-role grading (primary=3, secondary=2, other=1) preserves the truth file's primary/secondary distinction. Post-fix summary: bm25 P@5 0.18→0.44, hybrid P@5 0.31→0.60 (transcripts-off run).
- [ ] **Eval harness followups**:
  - **120s execSync timeout** in `scripts/eval-search.js` gets hit by every query that lands in the transcript BM25 path — 5 of 9 queries time out with transcripts enabled, all reporting 0/0/0. Either bump to 600s or split transcript scoring into its own harness.
- [ ] Query rewrite — synonym expansion (builds on phrase matching above)
- [ ] **Transcript BM25 speed vs recall tradeoff** — Transcript search is the recall backstop: queries like "facets" that never appear in event logs only surface through raw transcript grep. But BM25-scoring full transcript files is slow (2-3s per file × N files). With `LC_ALL=C`, macOS grep silently drops files with multibyte (finds 0). Without it, grep takes 10s+ for file identification alone. `rg` solves the file-finding (0.5s, unicode-safe) but the per-file awk BM25 scoring is the real bottleneck. Current mitigation: cap at 20 transcript files. Proper fix needs a truth dataset to evaluate recall/speed tradeoffs — build this as part of the GH Pages demo with sample data (see backlog). Options: (a) pre-index transcript text into the event log at ingest time, (b) tiered search — fast path first, transcript fallback only on zero results, (c) transcript-level IDF precomputation.

## Documentation
- [ ] **Cold start data coverage guide** — Document what each backfill script recovers vs what requires live hooks. New users need to understand the tradeoff: backfill gets git commits (no session_id, no transcript link) + transcript text (Qdrant only). Live hooks get session_id, transcript_path, diff shape, commit classification, research URLs. `enrich-sessions.js` bridges the gap by inferring session_id from timestamp+project overlap — but only for commits that happened during a Claude Code session. Commits from outside CC (terminal, IDE) will never have sessions. This matters for the sessions view and for `/remember` recall quality.
- [ ] Doc-sync agent — manifest-driven drift detection between code and docs
- [ ] CHANGELOG_SPEC — keep type table in sync with actual hook output
- [ ] Uninstall script (`scripts/uninstall.sh`)

## Project Registry
- [ ] **`/registry` skill** — Conversational skill that maintains `project-registry.json`. Scans `$CARTOGRAPHER_DEV_DIR` for git repos, diffs against current registry, asks user about unregistered projects (which family? skip? new family?), flags stale entries pointing to dirs that no longer exist, writes updated JSON. Interactive — not a batch script.
- [ ] **Setup docs for registry** — SETUP.md has no section on `project-registry.json`. New users need: what it does, how to populate it (manually or via `/registry`), what happens if it's empty (search/focus still work but can't expand aliases).

## Board View (tend-cli-inspired)

Reference: https://github.com/metalaureate/tend-cli — pull-based status board for multi-project agent work. The *data model* doesn't fit (per-repo `.tend/events`, manual `tend emit` protocol, relay for remote machines), but the *view* maps cleanly onto data cartographer already collects. Reimplement as a new Explorer lens, not a dependency.

- [ ] **Board view in Explorer** — Aggregate existing event logs into one glanceable row per project, sorted by last activity. Layout (stealing directly from tend):
  ```
  1. scrutinizer2025       ◐ working   shader: foveation ramp fix      (4m ago)
  2. psychodeli-webgl      ◌ idle      7 files changed                 (46m ago)
  3. session-cartographer  ◉ done      feat: concurrent timeline       (1d ago)
  ```
  Data sources already exist: `project-registry.json` for the project list, `isOngoingFromActivities()` in compaction-detector for state, last event/commit for the summary line.
- [ ] **Five-state vocabulary: working / done / stuck / waiting / idle.** Currently cartographer only distinguishes ongoing vs. not. `stuck` is the most valuable addition — signals a session that hit a blocker and needs human input. Derive heuristically: `working` + no activity > N minutes + last message contains question marks or blocker keywords. `waiting` = explicit plan-mode or AskUserQuestion outstanding. Worth prototyping before committing to the vocabulary.
- [ ] **Stale-threshold detection** — tend marks `working` events older than 30 min as `unknown`. Useful safety net; maps to existing compaction/ongoing logic but surfaces it explicitly in the board.
- [ ] **Aggregate counters footer** — "24/24h active · 55 done today · 58 this week · 1 open TODO". All derivable from existing event log. The active-hours metric is novel and genuinely useful for understanding total-work patterns across concurrent sessions.
- [ ] **Hint line** — tend shows "💡 6 idle + 1 open TODO — queue overnight work?" Light rule-based nudge, not an LLM. Good pattern for surfacing opportunities without nagging. Keep it optional and suppressible.
- [ ] **`td add` equivalent — cross-project TODO aggregation** — tend's `.tend/TODO` is per-repo plain text; cartographer could read existing `TODO.md` files across registered projects and surface them in the board. No new file format, no new commands — just aggregate what's already there. Adds "1 open TODO" counter without inventing a task system.
- [ ] **Live `watch` mode** — tend has `td watch` that refreshes every minute. Explorer already has SSE for live updates; the board view should subscribe to it so it updates when new events land. This is the "glance when you're ready" affordance — pull-based, not notification-based.

**Explicitly NOT taking from tend-cli:**
- `.tend/events` per-repo append-only logs (conflicts with cartographer's central event pipeline)
- Manual `tend emit working/done/stuck` protocol in AGENTS.md (hooks already infer this)
- `relay.tend.cx` hosted service (Andy's sessions all run on one Mac; no remote agents)
- `tend init` scaffolding per repo (cartographer uses a single registry)

## Infrastructure
- [ ] `npm install` pre-flight check in `/carto` skill
- [ ] Connection status indicator for EventSource (SSE reconnect feedback)
- [x] ~~Briefings system~~ — replaced with project registry + /focus skill + enriched milestones
