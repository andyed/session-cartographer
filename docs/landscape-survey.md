# Claude Code Memory & Session Augmentation Landscape

*Survey date: 2026-03-26. Context: positioning session-cartographer (née CCSB fork) against existing projects.*

## The Problem Space

Claude Code has a session-scoped memory problem. Each conversation starts fresh. Built-in mitigations (CLAUDE.md, MEMORY.md, auto-dream, session summaries) help but don't solve cross-session recall, multi-session coordination, or session navigation. A wave of community projects has emerged to fill these gaps.

## Categories

### 1. Persistent Memory (Write-Forward)

These capture context during sessions and inject it into future ones. The dominant pattern.

| Project | Stars | Approach | Storage | Key Differentiator |
|---------|-------|----------|---------|-------------------|
| [claude-mem](https://github.com/thedotmack/claude-mem) | ~40k | 5 lifecycle hooks, auto-capture of edits/commands/decisions | SQLite + ChromaDB | Market leader. Fully automatic, web UI, 3-layer progressive disclosure. |
| [cortex](https://github.com/hjertefolger/cortex) | 167 | MCP server (11 tools), auto-save at 5% context intervals | SQLite + Nomic Embed v1.5 | Zero cloud. Hybrid search (60/40 vector/keyword). Statusline integration. |
| [claude-supermemory](https://github.com/supermemoryai/claude-supermemory) | 2.4k | Plugin, keyword-triggered capture ("remember", "decision") | Supermemory SaaS | Team/shared memory. Requires subscription. |
| [claude-diary](https://github.com/rlancemartin/claude-diary) | 346 | Shell scripts, PreCompact hook, three-tier (observe → reflect → retrieve) | Pure markdown → CLAUDE.md | No database. Inspired by Generative Agents paper (Park et al.). |
| [claude-code-auto-memory](https://github.com/severity1/claude-code-auto-memory) | Low | Plugin hooks on Edit/Write/Bash, isolated agent at end of turn | CLAUDE.md | Minimal — just keeps CLAUDE.md updated. |
| [context-keeper](https://github.com/sreedhargs89/context-keeper) | Low | Plugin, auto-inject on session start | Filesystem | Simple "never lose your place" restoration. |
| [flashbacker](https://github.com/agentsea/flashbacker) | 55 | 20 specialist sub-agents, REMEMBER.md + WORKING_PLAN.md | Filesystem | Persona system (architecture, security, DB agents). Cognitive framework, not just memory. |
| [memory-store-plugin](https://github.com/julep-ai/memory-store-plugin) | 7 | Queue-based (`.memory-queue.jsonl`), MCP backend | JSONL + CLAUDE.md | **Archived.** Was attempting team CLAUDE.md sync. |

### 2. Cross-Session Search & Recall

These let you find things from past sessions. The gap session-cartographer targets.

| Project | Stars | Approach | Storage | Key Differentiator |
|---------|-------|----------|---------|-------------------|
| [episodic-memory](https://github.com/obra/episodic-memory) | 313 | Indexes transcripts with local embeddings, MCP server + CLI | SQLite + sqlite-vec + Transformers.js | By Jesse Vincent. Fully local/offline. The "why did we decide X?" tool. Exclusion markers for sensitive sessions. |
| [claude-history](https://github.com/raine/claude-history) | 109 | Rust TUI, fuzzy word matching over transcripts | Direct file reads | Speed (Rust). Rich TUI with tool call cycling, thinking toggles. Can fork/resume from viewer. |
| [recall](https://github.com/joseairosa/recall) | 162 | MCP server, 7 embedding providers, named threads | Redis/Valkey or SaaS | Cloud + self-hosted. Team sharing. AES-256-GCM encryption. Subscription tiers. |
| [claude-sessions](https://github.com/tradchenko/claude-sessions) | 0 | TUI, 3-layer memory extraction (instant/background-LLM/originals) | JSONL | Multi-agent support (Claude, Codex, Qwen, Gemini). 11-language i18n. |

### 3. Session Visualization & Analytics

These render session activity for human comprehension.

| Project | Stars | Approach | Key Differentiator |
|---------|-------|----------|--------------------|
| [claude-code-history-viewer](https://github.com/jhlee0409/claude-code-history-viewer) | 726 | Tauri desktop app, React UI | Most full-featured viewer. SessionBoard multi-lane timeline (Andy contributed), zoom levels, analytics. |
| [ccstat](https://github.com/ktny/ccstat) | 16 | TypeScript CLI, color-coded timeline blocks | Lightweight. No desktop app. Git integration for project grouping. |
| [claude-history-explorer](https://github.com/adewale/claude-history-explorer) | 18 | Python CLI, rich terminal, narrative generation | "Wrapped" yearly stats. Detects concurrent instances. |
| [claude-code-otel](https://github.com/ColeMurray/claude-code-otel) | Low | OTel Collector → Prometheus + Loki + Grafana | Enterprise observability stack. Real-time dashboards. |
| [claude-code-analytics](https://github.com/spences10/claude-code-analytics) | Low | SQLite, sparkline visualizations | Cost and performance tracking focus. |
| [claudelytics](https://github.com/nwiizo/claudelytics) | Low | Rust CLI, multi-format export | Fast. CSV/JSON export for further analysis. |

### 4. Knowledge Graphs & Semantic Infrastructure

These add structured knowledge representation beyond flat memory.

| Project | Stars | Approach | Storage | Key Differentiator |
|---------|-------|----------|---------|-------------------|
| [memsearch](https://github.com/zilliztech/memsearch) | ~1k | Markdown-first, hybrid BM25 + semantic, file watcher | Milvus + markdown files | "Markdown is source of truth." Human-readable, git-friendly, zero lock-in. Smart dedup via SHA-256. |
| [mcp-memory-service](https://github.com/doobidoo/mcp-memory-service) | 1.6k | MCP + REST, typed relationship knowledge graph, D3.js viz | ONNX embeddings + SQLite-vec | Full web dashboard (8 tabs). D3.js knowledge graph. Multi-agent via X-Agent-ID. 5ms retrieval. |
| [mcp-knowledge-graph](https://github.com/shaneholloman/mcp-knowledge-graph) | 818 | MCP server, entities/relations/observations, .aim directory convention | JSONL | AIM (AI Memory) system with safety markers. Named databases for topic separation. |
| [claude-code-memory](https://github.com/gajakannan/claude-code-memory) | 2 | Tree-sitter AST parsing + Qdrant, Memory Guard hook | Qdrant + Voyage AI | Code-structure-aware (9+ languages). Memory Guard prevents duplicate implementations. |
| [git-notes-memory](https://github.com/zircote/git-notes-memory) | Low | Git notes as storage, sentence-transformer embeddings | Git itself | Zero additional infrastructure. Memories sync with push/pull. Branch-aware. |

### 5. Cognitive Architectures

These model how memory *should work* rather than just storing things.

| Project | Stars | Approach | Key Differentiator |
|---------|-------|----------|--------------------|
| [claude-cognitive](https://github.com/GMaN1911/claude-cognitive) | 443 | Attention-scored tiers (HOT/WARM/COLD), decay + co-activation | Most neuroscience-inspired. Validated on 1M+ line codebases with 8 concurrent instances. 64-95% token savings. |
| [cog](https://github.com/marciopuga/cog) | 134 | Pure markdown conventions, three-tier (Hot/Warm/Glacier), Zettelkasten threads | Zero dependencies, zero code. Teaches Claude self-maintenance. Philosophically interesting. |
| [Continuous-Claude-v3](https://github.com/parcadei/Continuous-Claude-v3) | 3.6k | 109 skills, 32 agents, 30 hooks, 5-layer AST/call-graph analysis | Most ambitious framework. PostgreSQL + pgvector. 95% token savings via TLDR code analysis. |

### 6. Cross-Session Coordination

Live communication between concurrent sessions.

| Project | Stars | Approach | Key Differentiator |
|---------|-------|----------|--------------------|
| [claude-code-session-bridge](https://github.com/PatilShreyas/claude-code-session-bridge) | 18 | Bash + jq, file-based mailbox, 3s polling | The pioneer. Zero runtime deps. Cooperative + dedicated listening modes. |

### 7. Native Claude Code Features

For reference — what ships with Claude Code itself.

| Feature | What It Does | Limitation |
|---------|-------------|------------|
| **CLAUDE.md** | User-written instructions loaded at session start | Manual maintenance, no search |
| **MEMORY.md** | Auto-written notes from corrections/preferences | Flat file, 200-line truncation, no semantic search |
| **Auto Dream** | Background consolidation of memory files between sessions | Server-side flag, rolling out in v2.1.59+ |
| **Session Memory** | Auto-summaries stored per session | Recalled at start, but no cross-session search |

---

## Where Session-Cartographer Fits

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
- **episodic-memory** (obra) — Also does cross-session transcript search with embeddings. But it's memory-focused, not navigation-focused. No event IDs, no deep links, no energy viz.
- **claude-history** (raine) — Also navigates past sessions. But it's a standalone TUI, not an agent skill. No semantic search.
- **claude-code-history-viewer** — Complementary, not competitive. We generate the deep links and events it renders.

**The gap we fill:** Nobody else is building the *cartography layer* — the map of where you've been, what you found, and how to get back there. The memory projects store knowledge. The viewers display transcripts. We connect the two with addressable events and navigable topology.

---

## Potential Embedding Upgrade Path

Current `/remember` uses grep. Upgrading to semantic search:

| Option | Pros | Cons |
|--------|------|------|
| **Qdrant (interests2025 infra)** | Already running locally (port 6333), embedding server at 8890, proven with 21k+ browsing items | Couples to interests2025 runtime |
| **sqlite-vec (episodic-memory pattern)** | Self-contained, no external services | Less capable than Qdrant, another DB to maintain |
| **Transformers.js (local)** | No server dependency | Slower, M3 resource concerns |
| **memsearch approach (Milvus)** | Battle-tested hybrid search | Heavy infrastructure for this use case |

Recommended: **Qdrant as a service dependency, not a code dependency.** Call the existing embedding server at 8890, store in a dedicated Qdrant collection (`session-cartographer`). Keep interests2025 as infrastructure, not imported code.

---

## References

- [Fixing Claude Code's amnesia](https://blog.fsck.com/2025/10/23/episodic-memory/) — Jesse Vincent on building episodic-memory
- [Session Bridge origin story](https://blog.shreyaspatil.dev/session-bridge-i-made-two-claude-code-sessions-talk-to-each-other) — Shreyas Patil
- [Claude Code memory docs](https://code.claude.com/docs/en/memory) — Official documentation
- [Feature Request: Persistent Memory](https://github.com/anthropics/claude-code/issues/14227) — Community discussion
- [Episodic vs procedural memory](https://github.com/anthropics/claude-code/issues/8209) — Known issue with Claude's memory prioritization
