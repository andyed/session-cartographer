# Coding-Agent Memory: Landscape Survey

*Refreshed 2026-10-16. Star counts and push dates were read with `gh api` at
2026-10-17 03:23 UTC (the evening of 2026-10-16 Pacific). Sources: a
three-analyst competitive review dated 2026-10-16, which read GitHub and the web
and ran no third-party code, plus the public
[Claude Code changelog](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md).
[Method and limits](#method-and-limits) says which claims were re-checked. First
written 2026-03-26; the March positioning is kept at the end and
[marked superseded](#march-2026-positioning-superseded).*

## Summary

- **Session Cartographer (SC) sits in the crowded category:** passive recall over
  what agent sessions did. claude-mem (101k stars) and agentmemory (29.6k) lead on
  distribution. deja-vu (1.2k stars since July) is the closest match in scope.
- **Four of the seven features SC described as its own now exist elsewhere:**
  `/standup`'s file contention and commit attribution, session-bounded diffs,
  `/trustmap` (Claude Code ships `/auto-mode-setup`), and worktree attribution.
- **What remains SC's own is measurement.** Counts carry the event ids behind
  them, with a delta that follows log arrival order rather than timestamps.
  Recall served is joined exactly to recall used. Day digests check each logged
  commit against git. The questions are not new; deja-vu also asks whether served
  recall gets used. The mechanisms were not found elsewhere.
- **The platforms are absorbing the rest.** Anthropic shipped agent view,
  cross-session messaging, `/insights`, `/auto-mode-setup` and memory stores this
  year; OpenAI replaced Chronicle with Computer History. Least likely to be
  absorbed: cross-provider capture (neither vendor indexes the other's
  transcripts) and measurement of whether memory gets used.
- **Position:** measured memory for multi-agent work. SC counts what happened,
  checks it against git, and measures whether recall gets used, locally, across
  Claude Code, Codex and Hermes, with no LLM at capture.

## The five categories

| # | Category | What it does | Examples | Crowding |
|---|---|---|---|---|
| 1 | Agent-written or LLM-distilled memory | The agent, or an LLM, decides what to keep and writes notes | Claude Code and Codex memories, mem0, Letta, Zep/Graphiti, basic-memory | Most crowded; the platforms own it |
| 2 | Passive transcript recall | Index what sessions did without asking the agent to save anything, then search it | claude-mem, agentmemory, deja-vu, cass, Funes, episodic-memory, **SC** | Crowded and growing fast |
| 3 | Viewers, analytics, observability | Show people what sessions did and what they cost | claude-code-history-viewer, agenttrail, agentacct, `/insights` | Moderate |
| 4 | Code provenance | Link commits and lines to the sessions that wrote them | Entire, git-ai, brain0, deja-vu `blame` | Few players; Entire is funded |
| 5 | Live multi-agent operations | Run, watch and coordinate concurrent sessions | Claude Code agent view, `SendMessage`/`ListAgents`, vibe-kanban, claude-squad | Led by the platforms |

SC's core is category 2. `/standup` and the day digest reach into 4 and 5 without
writing to either. The least crowded ground is auditing memory itself: counted
facts, git-checked digests, and recall-use telemetry. Only deja-vu is nearby.

The March survey's seven categories fold into these five. Every March entry is
kept below, with its March star count in parentheses.

## 1. Agent-written or LLM-distilled memory

Platform memory (Claude Code auto memory and memory stores, Codex memories,
Cursor) is covered under [Platform features](#platform-features).

| Project | Stars (March) | Store | Notes |
|---|---|---|---|
| [mem0](https://github.com/mem0ai/mem0) | 67,321 | LLM extraction; semantic + BM25 + entity retrieval | Now ships hook plugins for Codex, Cursor, Kimi and Antigravity. OpenMemory was removed from the repo on 2026-07-29 ([#6530](https://github.com/mem0ai/mem0/issues/6530)). Has an explicit feedback API. |
| [Graphiti](https://github.com/getzep/graphiti) / [Zep](https://github.com/getzep/zep) | 31,826 / 4,963 | LLM-built temporal knowledge graph | Graphiti ships an MCP server; Zep is the hosted product. |
| [basic-memory](https://github.com/basicmachines-co/basic-memory) | 4,253 | Markdown knowledge graph over MCP | Claude, Codex, Cursor; optional paid cloud. |
| [tigerless-labs/agent-memory](https://github.com/tigerless-labs/agent-memory) | 3,951 (new, created 2026-09-01) | Plain Markdown | One store shared by Claude Code and Codex. |
| [Letta Code](https://github.com/letta-ai/letta-code) | 3,635 | Self-edited memory blocks; git-tracked MemFS | Its own harness, with `/search` across agents. |
| [memmy-agent](https://github.com/MemTensor/memmy-agent) | 2,108 (new, created 2026-07-16) | Local memory hub | One shared memory for several agents. |

Carried from March: write-forward memory, knowledge graphs and cognitive
architectures.

| Project | Stars (March) | Last push | Notes |
|---|---|---|---|
| [Continuous-Claude-v3](https://github.com/parcadei/Continuous-Claude-v3) | 3,945 (3.6k) | 2026-01-26 | Hooks keep state through ledgers and handoffs; AST and call-graph analysis. |
| [claude-supermemory](https://github.com/supermemoryai/claude-supermemory) | 2,789 (2.4k) | 2026-10-16 | Supermemory SaaS; team memory. |
| [memsearch](https://github.com/zilliztech/memsearch) | 2,756 (~1k) | 2026-10-09 | Markdown as the source of truth; hybrid BM25 + semantic on Milvus; now pitched for several agents. |
| [mcp-memory-service](https://github.com/doobidoo/mcp-memory-service) | 2,020 (1.6k) | 2026-10-16 | MCP + REST, typed knowledge graph, web dashboard. |
| [mcp-knowledge-graph](https://github.com/shaneholloman/mcp-knowledge-graph) | 885 (818) | 2026-05-29 | Entities, relations and observations in JSONL. |
| [claude-cognitive](https://github.com/GMaN1911/claude-cognitive) | 450 (443) | 2026-01-17 | HOT/WARM/COLD attention tiers with decay and co-activation. |
| [claude-diary](https://github.com/rlancemartin/claude-diary) | 383 (346) | 2025-12-17 | PreCompact hook; observe → reflect → retrieve into CLAUDE.md. |
| [cog](https://github.com/marciopuga/cog) | 377 (134) | 2026-09-06 | Plain-text conventions; no code. |
| [joseairosa/recall](https://github.com/joseairosa/recall) | 176 (162) | 2026-10-04 | MCP memory store on Redis/Valkey, or SaaS. March listed it under recall; it is a store agents write to. |
| [cortex](https://github.com/hjertefolger/cortex) | 173 (167) | 2026-03-14 | MCP server; SQLite + Nomic embeddings; auto-save at context intervals. |
| [claude-code-auto-memory](https://github.com/severity1/claude-code-auto-memory) | 159 (low) | 2026-04-18 | Keeps CLAUDE.md files updated. |
| [flashbacker](https://github.com/agentsea/flashbacker) | 57 (55) | 2026-01-14 | REMEMBER.md and WORKING_PLAN.md, with persona sub-agents. |
| [Tree Ring Memory](https://github.com/TerminallyLazy/Tree-Ring-Memory) | 20 (low) | 2026-09-17 | Curated lifecycle: evidence records, audits, explicit forgetting. Deliberately no transcript capture. |
| [context-keeper](https://github.com/sreedhargs89/context-keeper) | 14 (low) | 2026-03-27 | Restores context at session start. |
| [memory-store-plugin](https://github.com/julep-ai/memory-store-plugin) | 9 (7) | archived | Team CLAUDE.md sync. |
| [git-notes-memory](https://github.com/zircote/git-notes-memory) | 4 (low) | archived | Git notes as the store. |
| [claude-memory-context](https://github.com/malbers/claude-memory-context) | 3 (n/a) | 2026-09-19 | Michael Albers's `current.md` handoffs, typed memory files, `/savestate`, decision statuses. |
| [claude-code-memory](https://github.com/gajakannan/claude-code-memory) | 2 (2) | 2026-06-29 | Tree-sitter + Qdrant code index. |

## 2. Passive transcript recall (SC's category)

| Project | Stars (March) | Capture | Retrieval | Agents | Leaves the machine by default |
|---|---|---|---|---|---|
| [claude-mem](https://github.com/thedotmack/claude-mem) | 101,251 (~40k) | Hooks send each tool call to an LLM "observer" (Claude Haiku 4.5 by default). Its summary is the canonical record; raw tool I/O has been kept only since 2026-09 | Chroma semantic search; FTS5 only fills gaps; no fusion. Semantic search with no date covers the last 90 days by default ([#4770](https://github.com/thedotmack/claude-mem/issues/4770)) | ~15 hosts | Tool I/O goes to the observer's provider. Secret redaction is off by default |
| [agentmemory](https://github.com/rohitg00/agentmemory) | 29,598 (new, created 2026-02-25) | Raw tool I/O, truncated: 12 Claude Code, 6 Codex and 7 Cursor hooks, ~20 connectors | Weighted RRF over BM25, vectors and a graph. No since/before; the project filter runs after ranking | ~20 | Nothing without API keys. Keys already in the shell switch on cloud embeddings and LLM consolidation |
| [deja-vu](https://github.com/vshulcz/deja-vu) | 1,220 (new, created 2026-07-14) | Passive indexing of session history | MCP and hooks; `blame` (line → commit → session), `wip`, `friction`, `stats --impact` | 42 harnesses | Not checked |
| [cass](https://github.com/Dicklesworthstone/coding_agent_session_search) | 1,181 (not in March) | Transcript connectors; multi-machine sync | Lexical, optional local semantic; `timeline` and `--aggregate`; JSON output for agents | 11+ | No |
| [Funes](https://github.com/huggingface/funes) | 568 (90) | Transcript ingest and a per-turn hook; no LLM | Vector + BM25 with RRF, cross-encoder rerank; MCP `recall`/`get` | Claude, Codex, pi, Hermes, Parquet | No; optional Hugging Face Hub sync |
| [claude-history](https://github.com/raine/claude-history) | 515 (109) | Reads transcripts directly | Rust TUI, fuzzy matching | Claude | No |
| [episodic-memory](https://github.com/obra/episodic-memory) | 491 (313) | Hooks and transcript sync; Haiku summaries | sqlite-vec | Claude, Codex, Cursor, opencode, OMP | Summaries call the API |
| [arjunkmrm/recall](https://github.com/arjunkmrm/recall) | 144 (not in March) | Transcript ingest, incremental by mtime | SQLite FTS5: BM25 plus a 30-day recency boost | Claude, Codex, pi, Grok | No |
| [termem](https://github.com/leox255/termem) | 11 (new) | Cross-agent session manager for the terminal | Recall, search, resume | Several | Not checked |
| [claude-sessions](https://github.com/tradchenko/claude-sessions) | gone (0) | | | | The repository returned 404 on 2026-10-17 |
| **Session Cartographer** | 8 | Hooks append raw events to JSONL; no LLM at capture | BM25 + semantic with RRF; the time window and project scope are applied at the source in every leg | Claude Code, Codex; Hermes through a read-only adapter | No |

Notes on this category:

- **Benchmarks.** agentmemory's README headline is 95.2% on LongMemEval-S, which
  is `recall_any@5`: a question counts if any gold session reaches the top 5.
  LongMemEval's
  [official script](https://github.com/xiaowu0162/LongMemEval/blob/main/src/evaluation/print_retrieval_metrics.py)
  reports `recall_all@k` and excludes the 30 abstention questions, and 324 of the
  500 questions have more than one gold session. Recomputed from agentmemory's own
  [committed per-question results](https://github.com/rohitg00/agentmemory/blob/main/benchmark/data/longmemeval_results_hybrid.json)
  (at `6a182c4`), `recall_all@5` is 82.1% and `recall_all@10` is 93.4%.
  agentmemory's
  [2026-10-09 baseline document](https://github.com/rohitg00/agentmemory/blob/main/docs/benchmarks/2026-10-09-evaluation-baseline.md)
  is more careful than its README and makes no competitive claims. deja-vu
  reports 97.2% R@5 on the same split (not checked). claude-mem publishes no
  retrieval evaluation. LongMemEval is chat history, with no tool events,
  commits, project scopes or counting questions; [LONGMEMEVAL.md](LONGMEMEVAL.md)
  covers what a run would and would not show for SC.
- **Silent failures.** The category's worst defects return a confident wrong
  answer rather than an error. Examples: claude-mem's 90-day window above, and a
  capture stall that ran for 20+ hours with every health check green
  ([#4807](https://github.com/thedotmack/claude-mem/issues/4807)). SC has had
  the same class of defect; see [SC's own gaps](#scs-own-gaps).
- **Decay.** claude-mem added opt-in ACT-R base-level ranking on 2026-09-30
  ([`rank.ts`](https://github.com/thedotmack/claude-mem/blob/main/src/services/reinforcement/rank.ts)),
  with the frequency term off by default and no published validation.

## 3. Viewers, analytics, observability

| Project | Stars (March) | Notes |
|---|---|---|
| [claude-code-history-viewer](https://github.com/jhlee0409/claude-code-history-viewer) | 2,261 (726) | Desktop app and web server, now for several providers. Has grouped worktrees since 2026-01-25. |
| [agenttrail](https://github.com/sodiumsun/agenttrail) | 906 (new) | Local observability for coding agents. |
| [agentacct](https://github.com/mikehasa/agentacct) | 766 (new) | Per-task "work receipts": files changed and cost. |
| [claude-code-otel](https://github.com/ColeMurray/claude-code-otel) | 512 (low) | OTel → Prometheus, Loki, Grafana. No push since 2025-06. |
| [tracecrate](https://github.com/FankChen/tracecrate) | 256 (new) | Local trace workbench for Claude Code, Codex and OTLP logs. |
| [loongsuite-pilot](https://github.com/alibaba/loongsuite-pilot) | 208 (new) | OpenTelemetry collector for Claude Code, Codex and Cursor. |
| [claudelytics](https://github.com/nwiizo/claudelytics) | 89 (low) | Usage and cost CLI. |
| [claude-history-explorer](https://github.com/adewale/claude-history-explorer) | 18 (18) | Python CLI; yearly "Wrapped" stats; detects concurrent instances. |
| [ccstat](https://github.com/ktny/ccstat) | 17 (16) | Timeline CLI. |
| [claude-code-analytics](https://github.com/spences10/claude-code-analytics) | 11 (low) | Local analytics and a statusline. |
| Claude Code `/insights` | platform | LLM-written analysis of recent sessions. |

## 4. Code provenance

| Project | Stars | Notes |
|---|---|---|
| [Entire CLI](https://github.com/entireio/cli) | 5,186 (new, created 2026-01-02) | Captures sessions as checkpoints tied to commits: `entire search`, `checkpoint explain <commit>`. Warns when a second session starts on uncommitted work. A $60M seed was [reported in the press](https://rcpmag.com/articles/2026/02/12/ex-github-ceo-thomas-dohmke-unveils-entire.aspx) (not verified). |
| [git-ai](https://github.com/git-ai-project/git-ai) | 2,844 (new) | Git extension that tracks AI-written code; attribution survives rebase and squash. |
| [brain0](https://github.com/Brain0-ai/brain0) | 322 (new) | Passively links each commit to the prompts behind it, for Claude and Codex. A `today` triage and a drift check of declared against actual changes. |
| deja-vu `blame` | | Line → commit → session. |
| agentmemory `memory_commit_lookup` | | Commit ↔ session links; the session id comes from stdin or the environment. |
| SC | | `/standup --commit` names the session behind a commit from the recorded events. The day digest checks each logged commit against git. |

## 5. Live multi-agent operations

| Project | Stars (March) | Notes |
|---|---|---|
| Claude Code agent view | platform | One list of every session: running, blocked, or done. See [Platform features](#platform-features). |
| Claude Code `SendMessage` / `ListAgents` | platform | Sessions find and message each other, across machines. |
| [vibe-kanban](https://github.com/BloopAI/vibe-kanban) | 28,378 | Kanban board that runs Claude Code, Codex and other agents. |
| [claude-squad](https://github.com/smtg-ai/claude-squad) | 8,615 | Manages several terminal agents. |
| [mcp_agent_mail](https://github.com/Dicklesworthstone/mcp_agent_mail) | 2,209 | Agent identities, inboxes, and file leases with a pre-commit guard. |
| [sno-station](https://github.com/sno-ai/sno-station) | 759 | Groups existing agents (Codex, Claude Code, Cursor, Hermes) into one squad. |
| [agentglass](https://github.com/SirAllap/agentglass) | 335 | Every agent on the machine on one screen, with live cost and tokens. |
| [Tessera](https://github.com/horang-labs/tessera) | 315 | Workspace for sessions across projects; worktree diffs. |
| [Kangentic](https://github.com/Kangentic/kangentic) | 129 | Agentic development environment; a worktree behind each task. |
| [claude-code-session-bridge](https://github.com/PatilShreyas/claude-code-session-bridge) | 67 (18) | File-based mailbox between sessions. SC began as a fork of it. No push since 2026-03-28. |
| [claude-context-sync](https://www.npmjs.com/package/claude-context-sync) | npm only | Real-time alert when parallel Claude Code sessions edit the same file. |
| [Tower](https://github.com/Rohanxmalik/Tower) | 2 | Collision checks over MCP before an edit. |

Claude Code's agent-teams documentation offers no file-conflict detection.
Anthropic's answer is worktree isolation, which moves contention to merge time
and narrows `/standup`'s premise to checkouts that several sessions share.

## Platform features

### Anthropic: Claude Code

| Feature | Since | What it covers | Overlap with SC |
|---|---|---|---|
| [Auto memory](https://code.claude.com/docs/en/memory) | Shared across worktrees since v2.1.63 | Agent-written notes, per repository, shared across worktrees | Category 1. Makes worktree attribution commodity |
| CLAUDE.md, or AGENTS.md when a project has no CLAUDE.md | AGENTS.md since v2.1.277 | Hand-written instructions | None; SC indexes and does not replace them |
| Memory stores | Team stores (`CLAUDE_MEMORY_STORES`) by v2.1.172. Managed Agents memory stores in public beta from 2026-04-23 ([SD Times](https://sdtimes.com/ai/anthropic-adds-memory-to-claude-managed-agents/)) | Shared and team memory | Category 1 |
| [Agent view](https://code.claude.com/docs/en/agent-view) | v2.1.139 (research preview); `claude agents --json` v2.1.145 | Live list of sessions, with state and PR labels | Category 5 |
| Cross-session `SendMessage` / `ListAgents` | Same machine by v2.1.162; across machines v2.1.224 | Sessions discover and message each other | Category 5; overlaps `/standup`'s roster |
| `/insights` | Early 2026 (third-party reports); auto-mode recommendation v2.1.281 | LLM-written analysis of session history | Category 3 |
| [`/auto-mode-setup`](https://code.claude.com/docs/en/auto-mode-config) | Documented; not named in the public changelog | Drafts `autoMode.environment` from git remotes, the hosts, buckets and commands of recent sessions, and optionally shell history | Replaces most of `/trustmap` |
| 30-day transcript cleanup | Default; referenced in v2.1.181 and v2.1.248 | Session transcripts are deleted after 30 days | SC keeps its own event record, which outlives it |
| [Resume picker](https://code.claude.com/docs/en/sessions) | | Searches titles and PR URLs, not message bodies | Small |
| Desktop transcript search | Observed 2026-10-16 | The Claude desktop app exposes a `search_session_transcripts` tool: full-text search across its session transcripts, tool output included | Category 2, for desktop sessions. Not found in public documentation |

The March survey listed "Auto Dream" and "Session Memory" as native features.
This refresh did not re-check either.

### OpenAI: Codex and ChatGPT

| Feature | Since | What it covers |
|---|---|---|
| [Codex memories](https://learn.chatgpt.com/docs/customization/memories) | Preview around 2026-04; off by default | Background memory files written by LLM extraction from idle chats (`extract_model`, `consolidation_model`) |
| Chronicle | 2026-04-20 | Built memories from screenshots on the Mac ([The Next Web](https://thenextweb.com/news/openai-codex-chronicle-screen-context-mac)). Replaced by Computer History |
| Computer History | 2026-08-13 | A Mac activity timeline from accessibility events, shared by ChatGPT and Codex ([TechRepublic](https://www.techrepublic.com/article/ews-openai-computer-history-chatgpt-mac-activity/)) |

### Cursor

Cursor removed its memories UI in 2.1.x and offers an export to `.mdc` rules
([forum](https://forum.cursor.com/t/are-my-memories-gone/144057)).

## What is unique to SC, re-scored

Earlier positioning described seven features as SC's own. Against the field as
of 2026-10-16:

| SC feature | Status | What remains SC's own | Who else does it |
|---|---|---|---|
| 1. [Facts](FACTS.md): counts kept separate from ranking, each bucket carrying sample `event_id`s, and a `delta` cursor over log position | **Partly unique** | The arrival-order delta cursor, which stays correct when backfills append old timestamps, and labelled z-scores (`z_status`) | Counting with drill-down: [cass](https://github.com/Dicklesworthstone/coding_agent_session_search) `timeline --json` and `--aggregate`. Totals only: claude-mem `/api/stats`. LLM-written: Claude Code `/insights` |
| 2. Exact served → used recall telemetry ([`recall-join.js`](../scripts/recall-join.js)) | **Mechanism unique; question not** | The explicit `(call_id, event_id)` join between a served result and a use mark | [deja-vu `stats --impact`](https://github.com/vshulcz/deja-vu/blob/main/cmd/deja/stats_impact.go), since 2026-07-21, infers use from later transcripts; its code reads "Served is not used". SC's served log landed 2026-07-22, so neither has priority. [mem0](https://github.com/mem0ai/mem0) has an explicit feedback API |
| 3. `/standup`: file contention between live sessions, and commit → session attribution | **Not unique** | Passive, cross-provider detection inside one shared checkout | Contention: [claude-context-sync](https://www.npmjs.com/package/claude-context-sync), [Tower](https://github.com/Rohanxmalik/Tower), [mcp_agent_mail](https://github.com/Dicklesworthstone/mcp_agent_mail) leases, Entire's uncommitted-work warning. Attribution: [Entire](https://github.com/entireio/cli), [git-ai](https://github.com/git-ai-project/git-ai), [brain0](https://github.com/Brain0-ai/brain0), deja-vu `blame`, agentmemory `memory_commit_lookup` |
| 4. Day digest that checks each logged commit against git | **Partly unique** | The per-commit status: landed, moved, rewritten, or missing | [brain0](https://github.com/Brain0-ai/brain0) `today` with its drift check |
| 5. Diff review bounded by a session's commits | **Not unique** | Bounding by time inside a checkout that several sessions share | [Entire](https://github.com/entireio/cli) checkpoints, brain0 per-prompt diffs, [agentacct](https://github.com/mikehasa/agentacct) receipts, [Tessera](https://github.com/horang-labs/tessera) and [agentglass](https://github.com/SirAllap/agentglass) worktree diffs |
| 6. `/trustmap` | **Not unique: the platform ships it** | Codex data, weighting by use across the whole corpus, re-runs that propose only the delta, no LLM | Claude Code [`/auto-mode-setup`](https://code.claude.com/docs/en/auto-mode-config) |
| 7. Worktree → repository attribution | **Commodity** | Nothing | Claude Code [auto memory](https://code.claude.com/docs/en/memory) ("shared across worktrees"); claude-mem [`WorktreeAdoption`](https://github.com/thedotmack/claude-mem/blob/main/src/services/infrastructure/WorktreeAdoption.ts), which also adopts merged worktrees, which SC does not; agentmemory via the git common dir; claude-code-history-viewer [worktree grouping](https://github.com/jhlee0409/claude-code-history-viewer/blob/main/src/utils/worktreeUtils.ts) |

Two properties the original list left out:

| Property | Status | Notes |
|---|---|---|
| Cross-provider capture, with no LLM at capture and nothing leaving the machine | **Not unique among third parties; durable against the platforms** | Funes, cass and deja-vu also index several agents' sessions. Neither Anthropic nor OpenAI is likely to index the other's transcripts. |
| Long-horizon history | **Not unique; durable against the platforms** | Any tool that keeps its own copy outlives Claude Code's 30-day transcript cleanup. SC's event logs do. Its semantic index embeds only the first 1,200 characters of each turn, though, and full context still means reading the original transcript, which the cleanup can delete. |

## Where SC fits now

- **Category 2, with read-only reach into 4 and 5.** The closest neighbor is
  deja-vu, not Funes as the March survey said: deja-vu covers recall, commit blame
  and recall-use telemetry across 42 harnesses.
- **Frame:** measured memory for multi-agent work. The claim rests on mechanisms
  the field lacks (rows 1, 2 and 4 above), not on features others also ship.
- **Integrate rather than compete (not built).** Read-only source adapters for
  claude-mem's SQLite store and agentmemory's store, on the
  [`hermes-source.js`](../scripts/hermes-source.js) pattern, would let SC measure
  memory people already run instead of asking them to replace it.

### What the leaders do better

- **Install.** `npx claude-mem install` sets up its whole stack. SC's keyword
  recall needs no server, but semantic search needs Qdrant and an embedding server
  set up by hand.
- **Memory with no user action.** claude-mem injects recent notes at session start
  by default. SC's start note is opt-in.
- **A public evaluation harness.** agentmemory pins the dataset SHA and commits
  per-question results. SC evaluates against a small internal truth set that
  is not published.
- **Lifecycle.** agentmemory supersedes, forgets and resolves contradictions. SC
  does not; [LONGMEMEVAL.md](LONGMEMEVAL.md) lists this as a gap.
- **Breadth.** claude-mem supports about 15 hosts and deja-vu 42. SC supports
  three.

### SC's own gaps

As of 2026-10-16, SC had the same class of silent defect it criticizes above:

- Recency decay ran before the score cutoff and pushed most known items older than
  90 days out of the top 10. A fix, with an age-curve gate on both engines, is in
  progress.
- Concurrent appends over 1 KB could interleave on macOS, and six milestone rows
  were torn. Single-write appends behind a lock are in progress.
- `/api/health` reported `ok` even when a log failed to load. A fix is in progress.

## Method and limits

- **Who read what.** Three analysts read GitHub and the web: one on claude-mem
  (at `b6f9742`), one on agentmemory (at `6a182c4`), and one on the rest of the
  field. No third-party code was cloned or run, so runtime behaviour, performance
  and retrieval quality are unchecked for every competitor.
- **Re-checked by the review:** star counts and creation dates; deja-vu's
  "Served is not used" comment; `/auto-mode-setup` and "shared across worktrees"
  in the Claude Code docs; agentmemory's metrics, recomputed with `jq` from its
  committed per-question file; claude-mem's defaults, read from source (observer
  model, redaction off, 90-day search window); claude-mem issues #4770 and #4807.
- **Re-checked for this refresh:** every star count and push date in this file
  (`gh api`); Claude Code version numbers against the public changelog;
  "shared across worktrees", `/auto-mode-setup` and the agent-teams overwrite
  warning in the live docs; that each linked third-party file exists; the first
  commits of deja-vu's `stats_impact.go` (2026-07-21) and SC's served log
  (2026-07-22).
- **Analyst-reported, not re-checked:** Entire's funding; npm download counts;
  agentmemory's storage internals and its environment-key behaviour; deja-vu's
  benchmark; claude-context-sync's behaviour; the `/insights` launch date; the
  Codex memories, Chronicle and Computer History dates.
- **Not covered:** low-star entrants (searches were ranked by stars); Windsurf,
  Cline, Copilot, Gemini CLI and Antigravity memory features; Codex cloud tasks.

## References

- [Claude Code memory docs](https://code.claude.com/docs/en/memory),
  [agent view](https://code.claude.com/docs/en/agent-view),
  [auto mode config](https://code.claude.com/docs/en/auto-mode-config),
  [changelog](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md)
- [LongMemEval](https://arxiv.org/abs/2410.10813) (Wu et al.) and its
  [retrieval metrics script](https://github.com/xiaowu0162/LongMemEval/blob/main/src/evaluation/print_retrieval_metrics.py)
- [Fixing Claude Code's amnesia](https://blog.fsck.com/2025/10/23/episodic-memory/):
  Jesse Vincent on building episodic-memory
- [Session Bridge origin story](https://blog.shreyaspatil.dev/session-bridge-i-made-two-claude-code-sessions-talk-to-each-other):
  Shreyas Patil
- [Feature request: persistent memory](https://github.com/anthropics/claude-code/issues/14227)
  and [episodic vs procedural memory](https://github.com/anthropics/claude-code/issues/8209):
  community discussion

---

## March 2026 positioning (superseded)

> **Superseded on 2026-10-16** by the sections above. Kept as written on
> 2026-03-26, with additions through 2026-09-23, so the history stays visible.
> The March category tables are folded into the five categories above. These
> claims below are no longer true:
>
> - "No new databases, no background services": Turbo now runs as an optional
>   warm search service, and semantic search uses a local Qdrant.
> - "Nobody else is building the cartography layer": deja-vu, cass, Entire and
>   brain0 each cover part of it.
> - "Current `/remember` uses grep": it is BM25 in awk, fused with semantic results
>   by RRF.
> - Funes as the closest neighbor: deja-vu is now closer.
> - The embedding upgrade path was settled on Qdrant.

### Where Session-Cartographer Fits

**What we have now** (from the CCSB fork):
- `/remember` — keyword search (grep+jq) across changelog, milestones, research log, transcripts
- Unified changelog spec with event IDs and deep links
- Energy visualization dashboard
- Cooperative listening + peer auto-discovery (bridge features)
- Deep link metadata for claude-code-history-viewer integration

**What makes it different from everything above:**

1. **Session mapping, not just memory.** Most projects store facts. We map the *topology* of sessions — which projects were touched, what energy went where, how sessions relate to each other over time.

2. **Event-centric, not memory-centric.** The changelog spec treats session activity as a stream of events with IDs, deep links, and cross-references. This is closer to an activity log than a knowledge base.

3. **Navigation over storage.** Deep links, history viewer integration, energy viz — the goal is helping you find and revisit past work, not stuffing context into the next session.

4. **Lightweight infrastructure.** Shell scripts + JSONL + existing Qdrant (when we add embeddings). No new databases, no background services, no subscriptions.

**Closest neighbors:**
- **[claude-memory-context](https://github.com/malbers/claude-memory-context)** (Michael Albers) — A complementary write-forward memory practice. Its `current.md` handoffs, short memory index, typed files, `/savestate` verification, and explicit decision statuses offer useful lifecycle patterns for Cartographer's native-memory import and future handoffs. The two projects keep distinct storage and session-navigation models.
- **[Funes](https://github.com/huggingface/funes)** — Closest retrieval-substrate neighbor: deterministic local ingestion across several agent formats, stored-block reconstruction, progressive indexing tiers, and hybrid reranking. Cartographer's advantage is the layer above retrieval: structured work events with stable IDs and deep links, project/time/type facets, user-to-next-user turn units, cross-project topology, a human Explorer, exact-use telemetry, and evidence-backed strategic promotion. Borrow its storage and adapter mechanics without collapsing Cartographer into transcript-only memory.
- **episodic-memory** (obra) — Also does cross-session transcript search with embeddings. But it's memory-focused, not navigation-focused. No event IDs, no deep links, no energy viz.
- **claude-history** (raine) — Also navigates past sessions. But it's a standalone TUI, not an agent skill. No semantic search.
- **claude-code-history-viewer** — Complementary, not competitive. We generate the deep links and events it renders.

**Relevant lifecycle reference:** Tree Ring Memory is not a drop-in provider or close product competitor. Its useful overlap is memory hygiene: evidence-backed promotion, stale/sensitive/contradictory-memory audits, explicit supersession/redaction/deletion, and distinct treatment of durable lessons, failed approaches, and unresolved seeds. Those ideas are prior art for Cartographer's event-lifecycle, `/wrapup`, and future audit work. Cartographer should retain its own strengths—passive cross-provider capture, append-only event provenance, transcript navigation, and continuous salience/decay/reuse ranking—rather than importing the ring hierarchy or a parallel SQLite/FTS store wholesale.

**The gap we fill:** Nobody else is building the *cartography layer* — the map of where you've been, what you found, and how to get back there. The memory projects store knowledge. The viewers display transcripts. We connect the two with addressable events and navigable topology.

### Potential Embedding Upgrade Path

Current `/remember` uses grep. Upgrading to semantic search:

| Option | Pros | Cons |
|--------|------|------|
| **Qdrant (notes2025 infra)** | Already running locally (port 6333), embedding server at 8890, proven with 21k+ browsing items | Couples to notes2025 runtime |
| **sqlite-vec (episodic-memory pattern)** | Self-contained, no external services | Less capable than Qdrant, another DB to maintain |
| **Transformers.js (local)** | No server dependency | Slower, M3 resource concerns |
| **memsearch approach (Milvus)** | Battle-tested hybrid search | Heavy infrastructure for this use case |

Recommended: **Qdrant as a service dependency, not a code dependency.** Call the existing embedding server at 8890, store in a dedicated Qdrant collection (`session-cartographer`). Keep notes2025 as infrastructure, not imported code.
