# Session Cartographer — TODO

## Trustmap follow-ups (added 2026-08-15)

`/trustmap` derives `autoMode.environment` from the corpus and ships without a
way to tell whether the entries it proposed actually helped. The items below
close that gap and the ones a 2026-08-16 head-to-head with the built-in wizard
exposed in the merge.

- **[ ] Log classifier denials, and make `/trustmap` self-correcting.** Right now the skill proposes trust for everything you *touched*, which is a superset of what you were *blocked on* — most entries buy nothing. Claude Code ships a [`PermissionDenied` hook](https://code.claude.com/docs/en/hooks#permissiondenied) and records denials under `/permissions` → **Recently denied**; the built-in wizard reads a "Recent auto-mode denial reasons" section that cartographer has no equivalent of. Adding a hook that appends denials to the event log would let the second run propose entries for destinations that actually got blocked, and would give the first honest answer to "did applying this reduce denials." That measurement is the whole argument for the tool, and nothing currently makes it.
- **[ ] Validate against a second corpus.** Every heuristic in `trust-digest.js` is tuned on one machine: the coreutils stoplist, the `DATA_NOISE` filter, the data-directory regex, the cold-start thresholds. Two bugs surfaced only because it ran against 73k real shell events (`const` outranking `adb`; truncated URLs reading as internal hostnames), so a different tree will surface a third. Needs a run on someone else's corpus before the numbers in the README are claimed as general.
- **[ ] Recommend skills and plugins from the same corpus.** `trust-digest.js` already derives a frequency-ranked inventory of what you actually run — `adb` 966, `ffmpeg` 958, `xcodebuild` 436, `netlify` 96 — and then uses it for exactly one purpose. That inventory is also the best available answer to "which skills would earn their context cost here," which is currently guessed at install time and never revisited. A `--suggest` mode could join the CLI/host/project distribution against the installed skill set and the marketplace, and report both directions: tools used heavily with no skill covering them, and skills installed that nothing in 100k events ever exercised. The second half matters more — an unused skill is a permanent tax on every prompt, and nothing today measures it. Shares the retrieval-telemetry problem with the access ledger: recommending is easy, knowing whether the recommendation was taken and helped is the part that needs a feedback loop.
- **[ ] Audit `permissions.allow` for classifier-bypassing rules.** Auto mode suspends broad rules that grant arbitrary execution (`Bash(*)`, wildcarded interpreters) but carries *narrow* ones through, resolving them before the classifier ever runs. A head-to-head against the built-in wizard on 2026-08-15 found it flags these and proposes removals — it caught `Bash(python3 -c ":*)` in live user settings, a wildcarded interpreter that is arbitrary Python execution with no classifier review. `/trustmap` has no equivalent and should: the check is a scan of `permissions.allow` for `*`-terminated interpreter prefixes, and it protects the same boundary the environment block does. See `docs/AUTO_MODE.md` for the full comparison. **Do not scope it to `settings.json`.** A 2026-08-16 re-run showed the wizard's version has two gaps worth not inheriting: it re-proposed the `python3 -c` removal against settings that no longer contained it (receipt: `permissionsAllowNotFound` — a no-op reported as a finding, so match the literal rule text rather than a normalized shape), and it reads `settings.json` only, while `settings.local.json` carries `permissions.allow` too and held the rules that actually bypassed the classifier on the reference machine — wildcarded `curl`, `printenv`, `echo`, `security find-generic-password`, and one rule with a literal API key in its text. A secret embedded in an allow rule is its own finding and should be reported as one; the scan already has the string in hand.
- **[ ] Classify foreign environment entries by slot, and flag collisions.** The merge preserves foreign entries verbatim, which is correct against clobbering and useless against a foreign entry that is *wrong*: `/trustmap` appends the org it found next to the wizard's "no additional orgs configured" and the classifier reads a contradiction. `SKILL.md` now tells the agent to check three slots by hand (`Trusted repo`, `Primary use of Claude Code`, `Source control`), but hand-checking prose is exactly what the digest should be doing. Entries are `**Slot**: value`-shaped in practice, so parsing the slot name is cheap; emit a `provenance.conflicts` array pairing each proposal with the foreign entry claiming the same slot. Two cases deserve their own flag rather than a generic collision: a `Trusted repo` whose value is a literal path (the built-in default is dynamic, so pinning it at user scope narrows every other project), and any entry asserting `None configured` for a slot the digest has rows for.
- **[ ] Fold worktree cwds into their parent project.** A git worktree gets its own `~/.claude/projects/…--claude-worktrees-<name>` transcript directory, and cartographer's `project` field is cwd-derived, so sessions run from a worktree attribute to a separate project from the repo they're editing. That splits the corpus for `/focus` and `/remember`, and it is what let the built-in wizard report "only 1 transcript available" for a project holding nine. `git rev-parse --git-common-dir` resolves a worktree to its parent; the same normalization belongs wherever `project` is derived. Related to the 23 "last recorded cwd no longer exists" skips the digest already warns about — a deleted worktree looks identical to a deleted project.
- **[ ] Test that every script a skill references exists under the plugin root.** `trust-digest.js` shipped to the repo root only and was invisible to the installed plugin, where skills resolve against `CLAUDE_PLUGIN_ROOT`. `/trustmap` worked in a checkout and would have failed at step 0 for every installed user. Caught by hand while cutting 0.6.0, not by a test. A cheap check — grep skill bodies for `$ROOT/scripts/…` and assert each path exists under `plugins/session-cartographer/` — closes a whole class of "works on my checkout" bugs.
- **[ ] Reconsider the `git.overleaf.com` org grouping.** Remotes are grouped as `host/first-path-segment`, which is right for GitHub and wrong for Overleaf, where the first segment is a per-document id. Harmless today (they surface at 1 hit each and the skill is told to question low counts), but the grouping rule is host-agnostic and will be wrong for any host that isn't org-first.

## Memory research — borrowable ideas + benchmark context (added 2026-04-24)

### Adjacent projects to track

- **[CC Switch](https://github.com/farion1231/cc-switch)** — Cross-platform desktop manager for Claude Code, Codex, OpenCode, OpenClaw, Hermes, and other coding agents. Broader than Cartographer (provider/configuration, MCP, skills, prompts, proxying, and usage), but its **Session Manager** overlaps directly: cross-source conversation-history browsing, search, and restore. Track its session/workspace information architecture and multi-agent normalization choices; treat it as an adjacent orchestration shell, not a direct memory/retrieval engine.
- **[Claude HUD](https://github.com/jarrodwatts/claude-hud)** — Claude Code statusline plugin that derives live context health, tool activity, running-agent state, todo progress, compactions, and session timing from native statusline data plus transcript JSONL. Relevant prior art for Cartographer's live/ongoing-work lens: track its transcript-to-status state model, information compression, and stale/running-state handling. It observes the current session rather than providing Cartographer-style historical search or cross-session recall.
- **[Codex plugin for Claude Code](https://github.com/openai/codex-plugin-cc)** — OpenAI-maintained bridge that invokes the machine's existing Codex CLI/app-server runtime from Claude Code for reviews, background delegation, job status/results, and cancellation. Its `/codex:transfer` path imports a Claude transcript into a persistent, resumable Codex thread, making it particularly relevant to Cartographer's cross-provider identity, provenance, and continuation model. Track how it maps repositories, source transcripts, background jobs, and Codex session IDs; it bridges runtimes rather than providing a shared history index.

### Industry benchmark: LongMemEval (ICLR 2025)

[arxiv 2410.10813](https://arxiv.org/abs/2410.10813) is the standard eval for long-term memory in chat assistants. 500 questions across **5 ability categories** embedded in scalable chat histories. Headline finding: commercial assistants + long-context LLMs drop **30% accuracy** at sustained-interaction length — empirical justification for purpose-built memory tooling.

**Categories (and SC's current alignment):**
- **Information extraction** — single-shot recall of an earlier fact. SC's hybrid BM25+semantic addresses this directly. Probably scores fine.
- **Multi-session reasoning** — synthesizing across multiple past conversations. SC has no explicit cross-session join; relies on the LLM to stitch returned events. Gap.
- **Knowledge updates** — handling facts that changed (user said X, then later said Y). SC's jsonl is append-only; "last write wins" is implicit but invisible to retrieval. Gap.
- **Temporal reasoning** — "when did I tell you about Z?" SC has timestamps but no time-aware ranking, no `--since`/`--before` filters, no "what did I know on date X" as a first-class operation. **Highest-leverage gap for SC's actual use cases.**
- **Abstention** — knowing not to answer when info isn't there. SC always returns top-K regardless of confidence floor. Gap.

SC has never been benchmarked against LongMemEval. It probably shouldn't be the primary target since SC is *human-driven session search*, not *agent memory substrate* — but the benchmark categories are still the right diagnostic frame for where retrieval underperforms.

### Borrowable ideas from MenteDB ([nambok/mentedb](https://github.com/nambok/mentedb))

MenteDB is a Rust-native cognition-aware DB engine for AI agent memory. Different consumer (LLMs in a single forward pass, not humans browsing history), but several architectural choices map cleanly to SC's gaps. Each design choice below targets a specific LongMemEval failure mode.

- **[ ] Temporal reasoning — `--since` / `--before` filters + recency-aware ranking.** *Andy's first pick (2026-04-24).* Time-window filtering as a first-class CLI + Explorer concept. Recency boost in RRF formula (small weight, time-decayed score). Time-aware query rewriting in `/remember` ("last week" → `--since 7d`). Targets the LongMemEval temporal-reasoning category.
- **[ ] Delta serving — track what `/remember` already returned in this session, only send what's new on subsequent calls.** MenteDB claims ~90% retrieval-token reduction across multi-turn conversations. For SC: maintain a per-session bloom filter or LRU of returned event_ids; default `/remember` filters those out unless `--all` requested. Targets multi-session reasoning + token economy.
- **[ ] U-curve context assembly — when `/remember` returns N results, place highest-confidence at start AND end of the returned block, supporting context in middle.** Research-backed: that's how transformer attention actually works (Liu et al. "Lost in the Middle"). Cheap reorder, no new data, real comprehension delta.
- **[ ] Phantom detection — when a `/remember` query mentions an entity SC has zero info on, flag the gap rather than return weak top-K matches.** Auto-memory hooks could emit these as "knowledge to capture next session" signals. Targets LongMemEval abstention category — answers "is the gap because the question is bad, or because we genuinely don't know?"
- **[ ] Pain signals + emotional valence on auto-memory feedback entries.** Existing `feedback_*.md` memories already encode "this approach failed" lessons. Extending with explicit decay (exponential, recent pain weighted higher) and surfacing them via spreading activation would be a small change with big "last time you tried X, here's what broke" payoff. SC adjacent — most relevant in Andy's auto-memory layer.
- **[ ] Knowledge-update edges — when a memory is contradicted or superseded, mark it (Supersedes / Contradicts edge equivalent) so retrieval can suppress stale beliefs without losing them.** Jsonl is append-only, so "edges" are virtual. Could be implemented as a sidecar `event_relations.jsonl` consumed at query time. Targets knowledge-update category. Larger scope.

### Vision-stage MenteDB ideas (track, don't build)

Aspirational research targets in MenteDB's `VISION.md`. None are shipping; worth knowing as adjacent design space:

- **Dream Engine** — background analogical recombination across memory clusters; "your deployment pattern is structurally identical to your migration pattern."
- **Emergent Identity** — periodic full-corpus analysis to extract "this agent prefers X / strongest in A / weakest in B" statements.
- **Reconstructive Memory** — same underlying memories produce different context for debugging vs. planning vs. reflecting modes.
- **Spreading Activation** — accessing one memory temporarily boosts related memories in the graph (Python → Django → web framework → deployment). Closest of the four to something SC could prototype on its existing event graph.
- **Cognitive mode awareness** — query mode biases retrieval (debug mode surfaces errors aggressively; creative surfaces analogies; review surfaces contradictions).

### Open question for SC's strategic scope

If SC's role expands from "human session search" to "Claude's primary memory while in a long conversation," LongMemEval becomes the actual benchmark. Worth a sandbox test against a single project (Psychodeli or muriel) where MenteDB's ingestion/retrieval is compared to `/remember`'s on the same questions, to size the gap.

## Topic tracks — the missing pyramid layer (added 2026-08-14)

Reference: **NapMem** ([arxiv 2607.05794](https://arxiv.org/html/2607.05794v1)), Qwen team. Organizes user history as a four-layer "memory pyramid" — raw conversations → memory records → topic tracks → user profile — and gives the agent tools to navigate it rather than pre-selecting context for it.

SC already instantiates most of that thesis, and converged independently on the same retrieval mechanics (hybrid keyword + vector, RRF at k=60). Shipped 2026-08-14: `--get` exact-fetch (their `get_records`) and `scripts/build-profile.js` → `.carto/profile.md` (their layer 4). **Topic tracks are the one layer with nothing standing in for them.**

The ablation is the reason to care. Removing the upper layers and running records-only drops their average from 62.74 → 44.93 — a bigger delta than removing RL training (→ 48.39) or removing the navigation interface entirely (→ 54.08). Multi-granularity is doing more work than either of the headline contributions.

**Andy's framing (2026-08-14): topic tracks are a dreaming outcome, not a write path.** That resolves the tension that has blocked this. Tracks are consolidated, evolving, *rewritten* narratives — which reads as a direct violation of SC's append-only discipline until you notice they aren't a log at all. They're the output of a background consolidation pass over the log. The JSONL stays immutable; dreaming produces derived, fully regenerable track files. Delete them and the next dream rebuilds them. Same relationship `profile.md` already has to the corpus, one granularity down.

This also connects three things already on this list that have been circling the same idea:
- **Dream Engine** (MenteDB vision, above) — background analogical recombination across memory clusters. Tracks are the concrete, buildable version: not "your deployment pattern is structurally identical to your migration pattern," just "here is the running narrative of the psychodeli audio work, with links down to the events."
- **Topics facet** (mindmap-mcp section, below) — its cohesion filter (`cosineExcluding`, candidates surviving only if members are similar *after* removing the shared term) is the natural selector for *which* topics deserve a track. Don't dream 200 tracks; dream the ~20 that cohere.
- **Knowledge-update edges** — supersession has no home in an append-only log. It has an obvious home in a track: the consolidation pass is exactly where "he said X in March, then Y in June" gets resolved into one current narrative, without mutating either event.

Sketch, when it gets built:
- [ ] **`.carto/tracks/<slug>.md`, capped at ~20 files.** Each with a metadata header, a length budget (same treatment as `profile.md`), a running narrative, and explicit `event_id` links down to the record layer. Regenerable from scratch — never hand-edited.
- [ ] **Topic selection via the cohesion filter**, not raw term frequency. Reuse the TF-IDF machinery already in `explorer/server/bm25.js`.
- [ ] **A dream pass that runs on a cadence, not on every session end.** Consolidation is expensive and its value is cumulative; nightly or weekly is the right granularity, and it composes with Claude Code's own Auto Dream rather than competing with it.
- [ ] **Supersession resolution inside the pass** — when two events make contradictory claims about the same thing, the track states the current one and links both.
- [ ] **A `read_file`-shaped entry point** so `/remember` can open a track by name, the way it now reads `profile.md`.

Open question worth settling before building: whether tracks are per-project (cheap, obvious, mostly redundant with `/focus`) or per-*topic-across-projects* (the actual gap — "the AOI work" spans approach-retreat, allserp-paper, and cikm-leakycursor, and no current lens holds that together). The co-occurrence graph's `--related` already knows those cross-project threads exist; it just has nowhere to write the narrative down.

---

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
  - **Re-diagnosed 2026-08-14 — the premise above is wrong, and bigrams are probably aimed at the wrong layer.** Three measurements, in order of how much they change the picture:
    1. **Bag-of-words was never flat.** Measured IDF on the live corpus (61,020 docs): `backfill` df=6 → idf 9.15; `git` df=5,797 → idf 2.25. BM25 already weights the discriminative term 4x heavier. The claim in `demo/truth/backfill-git-history.json` that the query is "severely degraded by bag-of-words: 'git' matches every git command" does not survive contact with the numbers — IDF is doing exactly the discrimination phrase matching was proposed to add.
    2. **The failing queries are recall failures, not precision failures.** `backfill` appears in 6 event-log documents. `shape` in 25. `facets` in 2. There is no ranking contest to win — there is almost nothing in the event log to rank. This is the same finding as the standing note that "facets" only ever surfaces through raw transcript grep, arrived at from the other direction. Ordered bigrams improve precision *among documents containing both terms*; they cannot help when the rare term appears in six documents.
    3. **The zero-delta measurement was taken with a broken instrument.** `eval-search.js` inherited the default time decay (~30-day half-life), which demotes every truth-labeled event as it ages. Same corpus, same queries, decay on vs off: bm25 P@5 0.11 → 0.40 (recall 22% → 56%), hybrid 0.13 → 0.42 (15% → 65%). The harness was scoring label age. Fixed — `eval-search.js` now forces `CARTOGRAPHER_DECAY_LAMBDA=0`, alongside the session-var unset that guards the same class of artifact.

    Revised order: (a) confirm the coverage story by counting event-log support for each truth query's discriminative term; (b) fix filename tokenization, which is what let `diff-shape.sh` rank the target #1 on unigrams and mask the original experiment; (c) expand the truth set, deliberately including queries whose rare terms have real document support; (d) only then re-test bigrams. If (a) holds, they may never justify the 33% indexing regression.

  - **Superseded plan (kept for the reasoning).** The bigram mechanism is correct but the *cost/benefit* is wrong for the current corpus+truth combo. Before trying again:
    1. Add truth queries where adjacency actually discriminates — two-word queries where neither word appears in commit filenames and there are ≥5 relevant events.
    2. Measure on that expanded truth set, not the current 9.
    3. Or: skip bigrams and invest in a tokenizer change that DOESN'T expand filenames into independent tokens (which is what inflates the false positives in the first place).
  - **Alternative considered:** Post-filter (score normally, then filter results missing the literal phrase). Simpler but doesn't boost proximity — just removes non-matches.
- [x] **Eval matcher fix (shipped)** — `scripts/eval-search.js` `matchTruth()` now falls back to session-level matching when no explicit truth-event overlap is found. Previously scored P@5=0 despite 100% session recall on 5 of 9 queries because commit event summaries (`Commit abc123: feat: ... | files: ...`) don't lexically overlap with human-written truth event summaries. Session-role grading (primary=3, secondary=2, other=1) preserves the truth file's primary/secondary distinction. Post-fix summary: bm25 P@5 0.18→0.44, hybrid P@5 0.31→0.60 (transcripts-off run).
- [ ] **Eval harness followups**:
  - **120s execSync timeout** in `scripts/eval-search.js` gets hit by every query that lands in the transcript BM25 path — 5 of 9 queries time out with transcripts enabled, all reporting 0/0/0. Either bump to 600s or split transcript scoring into its own harness.
- [ ] Query rewrite — synonym expansion (builds on phrase matching above)
- [ ] **Transcript BM25 speed vs recall tradeoff** — Transcript search is the recall backstop: queries like "facets" that never appear in event logs only surface through raw transcript grep. But BM25-scoring full transcript files is slow (2-3s per file × N files). With `LC_ALL=C`, macOS grep silently drops files with multibyte (finds 0). Without it, grep takes 10s+ for file identification alone. `rg` solves the file-finding (0.5s, unicode-safe) but the per-file awk BM25 scoring is the real bottleneck. Current mitigation: cap at 20 transcript files. Proper fix needs a truth dataset to evaluate recall/speed tradeoffs — build this as part of the GH Pages demo with sample data (see backlog). Options: (a) pre-index transcript text into the event log at ingest time, (b) tiered search — fast path first, transcript fallback only on zero results, (c) transcript-level IDF precomputation.
- [ ] **Live `/remember` precision pass from explicit-use evidence.** Baseline from 2026-07-26: 25/1,317 served rows had an explicit `--touch`, MRR was 0.113 across 56 attributed calls, and 42 calls recorded no used result. Treat that as a conservative instrumentation baseline—not a 1.9% effectiveness claim—because older consumers did not reliably touch results. The qualitative failure is nevertheless clear: exact hashes (`26815f9 703c6d7`) returned the two right commits immediately, while “another agent checked in my changes” repeatedly filled the result set with generic agent milestones, research, and weak lexical matches. Turn that incident into a regression pack and address it as one coherent pass:
  1. Route commit/ownership queries toward `git_commit` and tool-use evidence while down-ranking research and generic agent-completion milestones; keep procedural queries on the maneuver map.
  2. Collapse duplicate event provenance and repeated source labels before presentation so one event occupies one result slot.
  3. Exclude the active query turn from raw-transcript fallback and automatically resolve transcript paths that moved from `sessions/` to `archived_sessions/`.
  4. Score time-to-first-used-result, P@k, MRR, result count, and abstention on the vague query plus exact project/hash controls.
  5. Report touch coverage separately from retrieval quality so incomplete consumer instrumentation cannot masquerade as search failure.
- [ ] **Skill-outcome telemetry, starting with Muriel deltas.** Invocation count does not establish that a skill helped. Define a compact `skill_outcome` record that can be extracted from structured handoffs with `skill`, `disposition` (`consulted`, `changed`, `caught`, `proved`), project, integration/files, and proof references. Index it through the existing event pipeline, preserve the human-readable handoff, and add a report that separates “mentioned” from “materially changed and verified.” Coordinate the first schema with Muriel rather than hard-coding Muriel-specific fields into the generic event model.

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

## Topics Facet (mindmap-mcp-inspired)

Reference: https://github.com/ravi-labs/mindmap-mcp-server (`src/graph.ts`), reviewed 2026-06-12. Cross-tool memory MCP server; weak search but a good zero-dependency topic-graph engine. The *storage and capture model* doesn't fit (LLM-written summaries, JSON-file-per-thread, capture discipline required — passive hooks are SC's moat), but the topic extraction maps cleanly onto SC's corpus.

- [ ] **Topics facet in Explorer.** *Andy's pick (2026-06-12).* Auto-derive recurring topic labels across events/sessions and surface them as a facet pill row (and eventually a graph lens). Algorithm to port from `graph.ts`:
  1. Per doc: TF-IDF top-10 terms, field-weighted (title ×3, tags ×2, body ×1). SC already has the TF-IDF machinery in `explorer/server/bm25.js`.
  2. Category candidates: terms appearing in ≥3 docs and ≤60% of corpus, shortlist top-40 by document frequency.
  3. **Cohesion filter — the part worth stealing:** a candidate survives only if its member docs are cosine-similar to each other *after excluding the shared term* (`cosineExcluding`, threshold ~0.012). Kills spurious categories whose members share nothing else. This directly addresses the existing "Stopword model refinement" TODO — cohesion scoring is the principled version of a learned stopword list.
  4. Edges (graph view, later): inverted-index candidate pairs only, cosine ≥0.12, keep top-6 neighbors per node. Scales without pairwise N².
  - Docs unit question to settle first: events are too granular (single commits), sessions probably right, turn-groups possible via Qdrant payloads.
- [ ] **Trace-on-decay — distill before transcript TTL.** mindmap's cold tier collapses memories to a one-line searchable `trace` instead of deleting ("recall never hard-fails"). SC's equivalent gap is documented in the /remember skill: transcripts vanish at Claude Code's ~30d TTL and the read-the-transcript step hard-fails. Maintenance pass: find events whose transcripts are near TTL, distill a compact trace into the event log (turn text already survives in Qdrant payloads — the event-log fallback is what's thin).
- [ ] **Transcript-expiry countdown.** mindmap's audit ledger forecasts decay per memory ("→ cold trace in 20d"). SC version: show "transcript expires in Nd" on Explorer sessions and /remember results, from file mtime vs. TTL. Surfaces what's about to become unreadable while you can still act.

**Explicitly NOT taking from mindmap-mcp:**
- Token-overlap search (strictly weaker than BM25+semantic+RRF)
- JSON-file-per-thread storage (coarser than the event log)
- Capture-discipline model (hooks already capture passively; their system fails if the LLM forgets to call capture)
- Gamified cleanliness score (SC's store is a log, not a garden)

## Co-occurrence Graph / Maneuver Map (lume-inspired)

Reference: [DeepBlueDynamics/lume](https://github.com/DeepBlueDynamics/lume) — Rust hybrid search with a Semantic Knowledge Graph layer (entity co-occurrence + significance weighting). Built `scripts/cooccurrence-graph.js` (2026-06-19): one G² engine, two graphs over **structured entities** (never tokenized prose). Zero external deps (fs/path/os only), ~46 KB artifact, the whole maneuver layer is **3.3 KB**.

**Shipped (wired into `/focus` + `/remember`; documented in `docs/COOCCURRENCE.md`):**
- [x] **Project co-activity graph** — document = calendar DAY, entity = project. `--related <project>` surfaces cross-project research threads (approach-retreat ↔ allserp-paper ↔ ettac-paper). Day-grain is load-bearing: 97% of sessions are single-project, so same-session co-occurrence is dead — the cross-thread signal lives in same-DAY co-activity (Andy's 3-5 concurrent sessions/day).
- [x] **Maneuver map** — entities = tech-signals from a signature catalog (ff-merge, gh-release, cloudflare-pages, netlify, overleaf-sync…) matched against `summary + files_changed`. Two views: *composition* (signal×signal, doc=session — which markers compose one maneuver; e.g. gh-release+version-tag+lfs = the Psychodeli DMG release) and *transfer* (project×project, doc=signal — which projects share a procedure; the two mindbendingpixels sites share the CF-deploy; cikm ↔ ettac share the overleaf dance). `--maneuvers <project>` = a project's profile + transfer peers.
- [x] **Dunning G² over lume's z-score+tanh.** Key finding from prototyping on the real corpus: lume's significance formula *saturates* — for a perfectly-correlated pair (a=b=k) the z-score collapses to √N regardless of count, so a 3-session fluke and a 30-session pattern score identically. G² ("surprise and coincidence," Dunning 1993) scales with evidence.

**Deferred:**
- [ ] **Actual-command recipe reconstruction.** *Parked 2026-06-19 ("todo the actual commands; see how efficient we can be without it").* Reconstruct the canonical command SEQUENCE per maneuver (the replayable playbook), not just the co-occurrence map. Deferred deliberately: (a) **secrets** — sampled commands embed CF account/zone IDs and an OAuth-token `awk` extraction; storing them = indexing secrets; (b) **redundant** — the commands already live in `changelog.jsonl` (`tool_bash` summaries). The signal map is a 3.3 KB index of which `(project, signal)` cells are non-empty; the actual command is one on-demand query away (`jq 'select(.project==X and (.summary|test(SIGNAL)))'`), verified working. Revisit only if on-demand recovery is too slow or a guided `/playbook` UX is wanted — and scrub secrets at reconstruction time.

**Next:**
- [x] **Wire `--related` + `--maneuvers` into `/focus`** — both are orientation lenses; /focus is their natural home (SKILL.md edit calling the builder's query modes). Maps densify on their own as sessions land.
- [x] **Method doc** `docs/COOCCURRENCE.md` — grain decisions, the G²-vs-z saturation finding, signature catalog, the index-not-store architecture. *(done)*
- [ ] **Sequence/order edges (only if revisited)** — composition is co-membership; timestamps allow directed edges (tag→release→deploy) for a maneuver-shape map. Drifts toward the recipe view, so low priority.

**Findings worth keeping:**
- Entities must be STRUCTURED fields (project, files_changed, detected signals), **never tokenized summary prose** — the prose term-graph attempt produced machinery cliques (agent/explore/completed) and was redundant with the existing Qdrant semantic path. ("We already had entities.")
- Maneuver map is intrinsically thin (~29 maneuver-sessions) — maneuvers are punctual events. High-precision; grows with corpus depth, not with more modeling.

## Infrastructure
- [ ] `npm install` pre-flight check in `/carto` skill
- [ ] Connection status indicator for EventSource (SSE reconnect feedback)
- [x] ~~Briefings system~~ — replaced with project registry + /focus skill + enriched milestones
