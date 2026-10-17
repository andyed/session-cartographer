# Session Cartographer

Hooks are the foundation — they produce JSONL event logs. Everything else is an independent lens on that data.

```
Hooks (produce JSONL)
  ├── /remember (CLI search, bash + awk)
  ├── /carto (web UI, Node + React)
  ├── /wrapup (strategic session-end preservation)
  └── Qdrant indexer (semantic search)
```

- **`/remember`** — Codex uses this to recover context from past sessions. Agent's primary history tool.
- **`/remember --project <name>`** (no query) — Orient on a project or family before diving in. Replaced `/focus`, now a Claude Code built-in; `skills/focus` is a retirement stub.
- **`/carto`** — Opens the Explorer web app for the human. Not an agent tool.
- **`/wrapup`** — End-of-session synthesis. Captures decisions, discoveries, and unfinished threads as a milestone event. Agent-initiated.
- **CLI** (`cartographer-search.sh`) — Standalone search, no install needed. Used by all skills.

## Project Structure

```
scripts/
  cartographer-search.sh        — CLI search: BM25 (awk) + semantic + RRF fusion
  bm25-search.awk               — BM25 scorer (two-pass TF-IDF, pure awk)
  transcript-to-turns.awk       — Turn-group transcripts (user→next-user boundary) before BM25
  embed-events.js               — Batch index JSONL events into Qdrant
  semantic-search.js             — Query Qdrant by vector similarity
  index-event.sh                — Real-time single-event indexing (called by hooks)
  record-wrapup.sh              — Durable wrapup write + verified index receipt
  wrapup-coverage.js            — Derived material-session coverage + pending queue
  cartographer-standup.js       — Peer-session roster + project/file contention (/standup)
  backfill-git-history.sh       — Import git commits into event logs
  backfill-memories.sh          — Index Codex memory files
  backfill-app-sessions.js      — Import desktop-app/Cowork session metadata (titles + VM-session prompts)
  retro-index.sh                — Backfill historical transcripts into Qdrant (turn-grouped)
  catch-up-transcripts.sh       — Checkpointed/cooldown transcript refresh used by SessionStart
  infer-codex-project.js        — Derive Codex repo attribution from tool workdirs when cwd is generic
  reconstruct-history.js        — Deep transcript analysis for backfill (turn-grouped)
  classify-prompt-intent.js     — Rule-based prompt-intent classifier (17 categories, zero-dep)
  backfill-prompt-intents.js    — Tag already-indexed turns with prompt_intent (payload-only, no re-embed)
  prompt-intent-report.js       — Corpus-wide intent distribution + per-bucket sampling (retuning tool)
  hit-rate-report.js            — Joins served-log.jsonl + access-ledger.jsonl: search hit rate by rank/source/project
project-registry.json             — Project aliases for multi-repo families (used by search + orientation)
plugins/session-cartographer/
  skills/remember/SKILL.md      — /remember skill (Codex's context recovery tool)
  skills/focus/SKILL.md         — retirement stub pointing to /remember orientation
  skills/carto/SKILL.md         — /carto skill (launches Explorer web app for humans)
  skills/wrapup/SKILL.md        — /wrapup skill (strategic session-end preservation)
  scripts/remember-search.sh    — Legacy keyword-only search (superseded by cartographer-search.sh)
  hooks/
    hooks.json                  — Hook registrations, including background transcript catch-up
    log-research.sh             — WebFetch/WebSearch → research-log.jsonl + changelog.jsonl
    log-session-milestones.sh   — Compactions, session ends, agent stops (with git context)
    log-tool-use.sh             — Edit/Write/Bash + git commits with classification (opt-in)
explorer/
  server/
    index.js                    — Express API (:2526), SSE stream, search proxy
    bm25.js                     — BM25 scorer (JS port for API path)
    search.js                   — Hybrid search: BM25 + Qdrant proxy + RRF
    jsonl.js                    — Resilient JSONL reader with fs.watch
  src/                          — React 19 + Vite + Tailwind UI (:2527)
docs/
  RANK_FUSION.md                — BM25 + RRF scoring architecture
  SCORING.md                    — Score interpretation guide
  SETUP.md                      — Install, Qdrant, cold start backfill, disk usage
  MIGRATION_TURNS.md            — Existing-user guide for turn-based transcript migration
  CUSTOM_HOOKS.md               — How to log your own events
  EXPLORER_SPEC.md              — Explorer implementation spec
  companion_explorer_spec.md    — Explorer product spec
  CHANGELOG_SPEC.md             — Event log format
  landscape-survey.md           — 30+ Codex memory projects compared
tests/private/                  — Gitignored: test cases, fixtures, benchmarks
```

## Implementation Constraints — READ THESE

- **BM25 in awk is intentional.** `bm25-search.awk` is the CLI search scorer. Zero dependencies (no Node, no jq). Do not port to Python. The JS port in `explorer/server/bm25.js` exists separately for the API path.
- **Turn-grouping is an indexing-layer concern, not a query-layer concern.** `transcript-to-turns.awk` preprocesses transcripts into one document per turn (user prompt + assistant responses up to the next user prompt) and is used by `retro-index.sh` + hooks when ingesting into Qdrant. Event IDs are deterministic (`turn-<sid>-<idx>`). Do not run it per-query — the CLI keyword `--transcript` fallback is plain per-line grep by design; semantic search (Qdrant) owns turn-coherent transcript recall. See `docs/MIGRATION_TURNS.md` for historical context.
- **Field extraction uses a fallback chain** (`summary → description → prompt → url → query → event_id → milestone`) across diverse JSONL schemas. Do not hardcode a single field.
- **Event summaries are single-line.** Writers flatten `\n`/`\t` at the source (`tr` in hooks, gsub in the semantic TSV emitter, `index-event.sh`). The pipeline is TSV/line-based: a multi-line summary splits a TSV row, and the fragments mis-parse as rank/key/timestamp — rank coerces to 0 and outranks every real result. The fusion awk drops rows with an empty key or non-numeric rank as a backstop. Pretty-printed JSON must never be appended to the JSONL logs.
- **Transcripts are first-class citizens in RRF.** They compete equally with event log results. Do not append them at the bottom.
- **`LC_ALL=C` on grep and awk** prevents multibyte errors on unicode in JSONL.
- **Transcript search uses `find -exec grep {} +`** to batch file matching in one process. Do not revert to per-file subprocess loops (1,839 files = 40x slower).
- **Hooks call `index-event.sh` for real-time Qdrant indexing.** Qdrant remains optional, but failures are recorded in `.carto/index-errors.jsonl` and return nonzero so backfills do not checkpoint incomplete sessions. Novelty rejects are recorded separately in `.carto/index-rejects.jsonl`; synchronous callers opt into a JSON receipt with `CARTOGRAPHER_INDEX_RECEIPT=1`.
- **Turbo opt-in is user-global and provider-neutral.** Claude Code and Codex read the same `~/.config/session-cartographer/config.json`; do not add separate agent settings as competing sources of truth. Ordinary recall may use HTTP or the sandbox-safe private file transport, while control operations retain the portable CLI path.
- **Turbo awareness is guidance, not automatic retrieval.** When the shared preference is active, SessionStart may remind the agent to use `remember` for tasks that depend on prior work. Do not turn that into unconditional startup search; measure deduplicated session exposures against explicit result use.
- **Explorer binds to 127.0.0.1 only.** Never 0.0.0.0. Binding does not stop DNS rebinding, so every listener (the API, headless Turbo, the UI host) also refuses a non-loopback `Host`, a foreign `Origin` and `Sec-Fetch-Site: cross-site` through `explorer/server/loopback-guard.js`; `api-loopback-guard.test.js` and `turbo-loopback-guard.test.js` send a forged Host to each port. Path traversal protection on transcript endpoints. Rendered content is never parsed as HTML, with no HTML sanitizer needed: markdown is emitted as React elements, nothing uses `dangerouslySetInnerHTML`, and every corpus URL that becomes an `href` (Memory Desk markdown links, `EventCard`'s event `url`) passes `safeArtifactLink` (`http(s)`, `mailto`, `#` only); a refused one renders as text. React 19 rewrites only a `javascript:` href, so it is not the guard; `event-card-links.test.js` fails if an `EventCard` href skips the allowlist. A render path that emits raw HTML must bring its own sanitizer. No browser code calls Qdrant (the API proxies it), so `start-services.sh` runs it with CORS off, because Qdrant's default reflects any `Origin`. CORS off stops a web page reading :6333, not writing to it — Qdrant 1.12.1 parses a preflight-free `text/plain` POST as JSON, so only an API key closes that, and the launcher provisions one: generated on first start into `$CARTOGRAPHER_QDRANT_STORAGE/api-key` (mode 600), written into its mode-600 config as `service.api_key`, and sent as the `api-key` header by every client through `scripts/qdrant-auth.js` or `qdrant-auth.sh`, which read that file (loopback URLs only) or `CARTOGRAPHER_QDRANT_API_KEY`. A new Qdrant client goes through one of the two, or it fails against a keyed Qdrant without erroring; `qdrant-api-key.test.js` lists every client and checks the header arrives, and `qdrant-start-services-key.test.js` sends the blind write to a launcher-started Qdrant and expects 401.
- **Ports:** 2526 (API), 2527 (UI), 6333 (Qdrant), 8890 (embeddings).
- **`project-families.json` is gitignored.** Run `generate-families.sh` to bootstrap from event logs.
- **Enrichment scripts modify `changelog.jsonl` in place.** Back up before running on large datasets.
- **Retrieval telemetry is exact for new calls.** Served rows and `--touch` records share `call_id`; purpose, session, and provider are carried alongside it. `access-ledger.jsonl` is append-only. Do not rewrite it in place, and keep the CLI/API activation implementations in sync. Legacy inference is report-only and opt-in.
- **The noise trim runs on relevance, and decay is a switch, not a curve.** Both engines trim at 10% of the top RRF × salience score *before* any age weighting. Run after decay, as the API did until 2026-10-16, the trim cut old records for their age: 55 of 240 known items were absent from the pool, not merely ranked low. The CLI had no trim, so the engines also disagreed about the pool. Fusion is rank-based: rank 1 scores 1/61, rank 10 scores 1/70, and a rank-1 partial match in another ladder also scores 1/61. An old known item therefore survives the page only if its age factor stays within a few percent of 1. Measured on 204k events (240 known items, 40 recency cases, semantic off), known-item S@10 by age <7d/7-30d/30-90d/90d+ was exp λ=0.001 0.98/0.85/0.62/0.15; power-law t^-0.5 0.98/0.77/0.62/0.30; ACT-R base-level d=0.05 0.80/0.53/0.60/0.72, trading the week for the archive. So when ≤ `CARTOGRAPHER_DECAY_LOOKUP_MAX` (10) candidates hold every query token, those candidates skip decay: 0.98/1.00/0.98/1.00 on the API, with recency unchanged. On the CLI, measured on paired cases, past 90 days went 0.23 → 1.00. Everything else decays as before. Skipping decay keeps a named record on the page, not first: a recent 0.7–0.8-salience record sharing part of the query outranks a 0.25–0.5 one holding all of it. So the named candidates are also multiplied by `CARTOGRAPHER_DECAY_LOOKUP_LIFT` (3) after decay, as a score change so `--min-score` still cuts a sorted list. Live known S@1 went 148 → 221 of 240, S@10 234 → 240, no case lower, recency and topical identical (docs/SCORING.md, "Lifting named records"). "Holds every token" is presence-only (`full` on `scoreBM25` results, column 10 of `bm25-search.awk`), so the engines agree although their idf differs. `tests/unit/age-curve-gate.test.js` proves its fixture reproduces the loss before gating, and `scripts/age-curve.js` runs the same curve on the live corpus. Change λ, the trim, salience, the exemption or the lift only with both. A different browse curve also has to pass the topical kind (`age-curve.js --truth`, on the live corpus and `--as-of` the labels' date), because both gate metrics reward steeper decay. On 2026-10-17 every power-law form tested, ACT-R base-level included, lost topical P@10 there (0.40-0.42 against exp's 0.48), so exp stays (docs/SCORING.md). The truth scorer is `scripts/truth-score.js`, shared with `eval-search.js`; its word-overlap match needs two shared words, because at one it credited any recent row sharing a word with a short label, which is exactly what a steeper curve puts on the page.
- **Diff-shape quadrant labels:** bootstrap, construct, surgical, rework. Not "dangerous."

## Two Search Paths

1. **CLI** (`cartographer-search.sh`): bash + awk BM25. Used by `/remember` skill. No server needed.
2. **API** (`explorer/server/`): JS BM25 + Express. In-memory index, but `scoreBM25` scans every document: 20–31 ms median per query over ~203k events (measured 2026-10-16). Used by the Explorer UI (`/carto`) and Turbo. Proxies Qdrant for semantic search.

Both use BM25 (k1=1.2, b=0.75) and RRF (k=60), but they are not one ranker. The CLI computes IDF per log file, and the API over the deduplicated corpus. The CLI sums RRF credit for both copies of a dual-written event, and the API credits one. Both trim under 10% of the top score before decay. The awk timestamp parser ignores UTC offsets, and the API's does not. CLAUDE.md lists each difference.

## How Codex should use this

When a user says "remember X" or needs context from a past session, use `/remember`. The skill runs the search, returns ranked results with transcript paths. **Read the transcript** to recover full context — the search result is the map, the transcript is the territory.

When a user says "explore" or wants to browse history visually, use `/carto` to start the web app and open the browser. That's a human tool — don't try to scrape it.

At the end of a productive session — or when a user says "wrap up" — use `/wrapup` to synthesize decisions, discoveries, and open threads into a milestone event. The milestone gets indexed and becomes searchable via `/remember`.

## Testing

Read [docs/TESTING.md](docs/TESTING.md) before writing tests. Assert on result
composition and provenance, not merely successful responses.

- `env -u CLAUDE_SESSION_ID -u CLAUDE_CODE_SESSION_ID -u CODEX_SESSION_ID -u CARTOGRAPHER_SESSION_ID node --test tests/unit/*.test.js` — portable unit suite; use Node 22 to match CI.
- `npm run build --prefix explorer` and `node tests/browser/memory-entry.cjs` — Explorer build and isolated headless Chromium regression; install locked root/Explorer dependencies and Chromium first as documented in the testing guide.
- `bash tests/release-smoke.sh`, `bash tests/source-marketplace-smoke.sh` — packaging and available CLI installation checks.
- `tests/private/` is gitignored and optional, not a fresh-clone prerequisite.
- **No MCP-based browser testing.** Use the checked-in headless browser harness and manual visual review; don't puppet Chrome via desktop-control MCP.
