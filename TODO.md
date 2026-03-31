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
- [ ] **Phrase matching** — The #1 precision gap. "diff shape" returns P@5=0.0 because BM25 tokenizes to `diff OR shape`, matching every `git diff` command and vision research mention of "shape" independently. Eval baseline: hybrid P@5=0.45 overall, but 0.0 on multi-word queries.
  - **Approach: SDM-lite with ordered bigrams.** At tokenization time (both query and document), generate ordered bigrams from adjacent words. `"diff shape backfill"` → `[diff, shape, backfill, diff_shape, shape_backfill]`. BM25's IDF handles weighting naturally — bigrams are rare (high IDF), so `diff_shape` scores much higher than `diff` alone. No special weighting needed beyond what BM25 already does. This is a simplified version of Metzler & Croft 2005 Sequential Dependence Model.
  - **Where it matters:** Both paths. Qdrant *understands* "diff shape" as a concept, but its results get drowned by keyword noise in RRF fusion — 50+ `git diff` command matches outscore Qdrant's handful of relevant hits. Two fixes work together: (a) bigrams reduce keyword noise (require `diff_shape` adjacency), (b) boost semantic weight for multi-word queries where bag-of-words is less reliable.
  - **Implementation:** ~20 lines in `bm25-search.awk` tokenizer + same change in `explorer/server/bm25.js`. Generate bigrams in the tokenize function, everything else stays the same.
  - **Eval plan:** Run `node scripts/eval-search.js` before and after. Target: "diff shape" P@5 from 0.0 → 0.4+, "concurrent timeline" P@5 from 0.8 → 0.9+.
  - **Alternative considered:** Post-filter (score normally, then filter results missing the literal phrase). Simpler but doesn't boost proximity — just removes non-matches. Bigrams are more robust because they improve ranking, not just filtering.
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

## Infrastructure
- [ ] `npm install` pre-flight check in `/carto` skill
- [ ] Connection status indicator for EventSource (SSE reconnect feedback)
- [x] ~~Briefings system~~ — replaced with project registry + /focus skill + enriched milestones
