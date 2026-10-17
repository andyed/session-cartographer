# Coding-Agent Memory: Landscape Survey

*Updated 2026-10-16; first written 2026-03-26. Star counts and push dates come
from the GitHub API (2026-10-17 03:23 UTC), platform features from the vendors'
docs and the public
[Claude Code changelog](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md).
See [Sources](#sources).*

## Summary

- **Five kinds of tool** help coding agents carry context between sessions:
  memory the agent writes, passive recall of what sessions did, viewers and
  analytics, commit provenance, and live coordination of concurrent sessions.
- **Session Cartographer (SC) is passive recall for reinstating context.** Hooks
  in Claude Code and Codex, plus a read-only adapter for Hermes, record what each
  session did into local logs, with no LLM at capture. `/remember` and the
  Explorer bring earlier reasoning back when a question calls for it.
- **Alongside recall, SC answers questions about the work itself:** counts that
  carry the event ids behind them, whether served recall got used, which logged
  commits landed in git, and which live sessions are editing the same files.
- **Nearby tools:** claude-mem and agentmemory are the largest passive-recall
  projects; deja-vu, cass and Funes search sessions across several agents;
  Entire and git-ai link commits to sessions.
- **The platforms** ship memory and session tooling for their own agent. History
  that spans Claude Code and Codex, and outlasts Claude Code's 30-day transcript
  cleanup, is left to tools like SC.

## The five categories

| # | Category | What it does | Examples | Crowding |
|---|---|---|---|---|
| 1 | Agent-written or LLM-distilled memory | The agent, or an LLM, decides what to keep and writes notes | Claude Code and Codex memories, mem0, Letta, Zep/Graphiti, basic-memory | Most crowded; the platforms own it |
| 2 | Passive transcript recall | Index what sessions did without asking the agent to save anything, then search it | claude-mem, agentmemory, deja-vu, cass, Funes, episodic-memory, **SC** | Crowded and growing fast |
| 3 | Viewers, analytics, observability | Show people what sessions did and what they cost | claude-code-history-viewer, agenttrail, agentacct, `/insights` | Moderate |
| 4 | Code provenance | Link commits and lines to the sessions that wrote them | Entire, git-ai, brain0, deja-vu `blame` | Few players; Entire is funded |
| 5 | Live multi-agent operations | Run, watch and coordinate concurrent sessions | Claude Code agent view, `SendMessage`/`ListAgents`, vibe-kanban, claude-squad | Led by the platforms |

SC's core is category 2. `/standup` and the day digest reach into 4 and 5 without
writing to either.

Star counts in parentheses are from March 2026.

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
  (at `6a182c4`), `recall_all@5` is 82.1% and `recall_all@10` is 93.4%; see also
  agentmemory's
  [2026-10-09 baseline document](https://github.com/rohitg00/agentmemory/blob/main/docs/benchmarks/2026-10-09-evaluation-baseline.md).
  deja-vu reports 97.2% R@5 on the same split (not checked). LongMemEval is chat
  history, with no tool events, commits, project scopes or counting questions;
  [LONGMEMEVAL.md](LONGMEMEVAL.md) covers what a run would and would not show
  for SC.
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

### OpenAI: Codex and ChatGPT

| Feature | Since | What it covers |
|---|---|---|
| [Codex memories](https://learn.chatgpt.com/docs/customization/memories) | Preview around 2026-04; off by default | Background memory files written by LLM extraction from idle chats (`extract_model`, `consolidation_model`) |
| Chronicle | 2026-04-20 | Built memories from screenshots on the Mac ([The Next Web](https://thenextweb.com/news/openai-codex-chronicle-screen-context-mac)). Replaced by Computer History |
| Computer History | 2026-08-13 | A Mac activity timeline from accessibility events, shared by ChatGPT and Codex ([TechRepublic](https://www.techrepublic.com/article/ews-openai-computer-history-chatgpt-mac-activity/)) |

### Cursor

Cursor removed its memories UI in 2.1.x and offers an export to `.mdc` rules
([forum](https://forum.cursor.com/t/are-my-memories-gone/144057)).

## How SC compares

| What you want to do | Session Cartographer | Related tools |
|---|---|---|
| Recall earlier work across agents | Hooks in Claude Code and Codex and a read-only Hermes adapter record raw events locally, with no LLM at capture; BM25 and semantic search fused with RRF | claude-mem (an LLM observer, about 15 hosts), agentmemory, deja-vu (42 harnesses), cass, Funes |
| Count what happened | [Facts](FACTS.md): census, tempo and delta, each count carrying sample `event_id`s; delta follows log arrival order, so backfilled history does not read as new | cass `timeline --json` and `--aggregate`; Claude Code `/insights` (an LLM-written report) |
| See whether recall gets used | Each served result joins to its use mark by `(call_id, event_id)` ([`recall-join.js`](../scripts/recall-join.js)) | [deja-vu `stats --impact`](https://github.com/vshulcz/deja-vu/blob/main/cmd/deja/stats_impact.go) infers use from later transcripts; [mem0](https://github.com/mem0ai/mem0) has a feedback API |
| Know who else is working | `/standup`: live sessions, files two sessions both edit, the session behind a commit | [Entire](https://github.com/entireio/cli), [git-ai](https://github.com/git-ai-project/git-ai), [mcp_agent_mail](https://github.com/Dicklesworthstone/mcp_agent_mail), [claude-context-sync](https://www.npmjs.com/package/claude-context-sync), Claude Code agent view |
| Review a day's work | Day digest that checks each logged commit against git: landed, moved, rewritten or missing | [brain0](https://github.com/Brain0-ai/brain0) `today` and its drift check |
| Review one session's changes | Memory Desk diffs bounded by the session's commits | Entire checkpoints, brain0 per-prompt diffs, [Tessera](https://github.com/horang-labs/tessera) |
| Configure auto mode from real usage | `/trustmap`, weighted by use across Claude Code and Codex, re-runnable as a delta | Claude Code [`/auto-mode-setup`](https://code.claude.com/docs/en/auto-mode-config) |

## Sources

- Star counts and push dates: the GitHub API, read 2026-10-17 03:23 UTC.
- Platform features: the vendors' docs and the Claude Code changelog.
- Project details: each project's repository and docs; claude-mem at `b6f9742`
  and agentmemory at `6a182c4`. No third-party code was run, so runtime
  behaviour and retrieval quality were not measured.
- Not covered: low-star projects, and the memory features of Windsurf, Cline,
  Copilot, Gemini CLI and Antigravity.

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
