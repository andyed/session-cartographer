# Cloud Turbo recall — private shared agent memory

Status: proposal / investigation · 2026-11-25

## Motivation

Make the user's approximately 1 GB Turbo index available to authorized agents even when the development machines (cylon and BIGFU) are asleep. A concrete acceptance case is asking ChatGPT to `/remember Audio Lab` and recovering the actual Psychodeli development history without copying results manually or granting remote shell access.

The existing [Turbo Mode](TURBO_MODE_SPEC.md) and [MCP server](MCP.md) are the starting points. This is a deployment and synchronization proposal, not a new retrieval engine.

## Proposed first slice

- Keep local ingestion/indexing authoritative; publish versioned, encrypted snapshots to a private cloud service. Establish what the reported 1 GB actually contains before choosing the snapshot format.
- Run a warm headless Turbo backend and expose authenticated remote MCP (investigate Streamable HTTP and client-specific authorization requirements). Reuse existing ranking, facets and typed recall tools rather than inventing a second search implementation.
- Begin with recall and bounded evidence retrieval; add thread/orient where their dependencies are available. No arbitrary shell, local file paths as remotely callable capabilities, or remote agent execution.
- Validate snapshot integrity/schema version, atomically switch generations, retain a rollback generation, and report corpus coverage and freshness. Start with one machine, then merge multi-machine data with stable source/event identities and deduplication.

## Important dependency audit

Turbo currently accelerates the standard query phase; the wrapper owns call IDs, delta serving, telemetry and control operations. The MCP server currently uses stdio and delegates to that wrapper. Do not assume a memory-resident index is a portable, complete evidence store. Inventory event JSONL, semantic index/embedding dependencies, exact records, transcript excerpts and access ledgers needed for recall/get/thread/orient. Full transcripts may remain local; return explicit evidence-unavailable status when offline, or replicate only approved excerpts. Never silently substitute summaries for full evidence.

Preserve exact call attribution and the single-writer telemetry boundary. A retrieval-only service may still write scoped served/access telemetry; define ownership and client/session isolation before synchronizing promote-on-reuse across machines.

## Security

Private by default: authenticated per-client access, TLS, encryption at rest, least privilege, revocation, rate limits, auditability and explicit corpus selection. Session histories can contain secrets, private conversations and proprietary source. Inspect/redact before upload, avoid public endpoints or raw transcript exposure, and define deletion propagation and backup retention. Cloud hosting does not eliminate disclosure to the authorized model provider receiving search results.

## Sizing and validation

Initial hypothesis: a 2-vCPU instance with 4–8 GB RAM and 20–40 GB persistent storage, roughly $10–25/month before backups, embedding services or egress. These are unverified planning estimates; measure actual peak RSS during reload, corpus size, cold/warm latency and cloud costs.

Acceptance: an authorized remote client can recover a known historical decision while the source machine is offline, fetch supporting evidence with provenance, report snapshot age and missing evidence honestly, and reject unauthorized requests. Compare retrieval utility and time to first use against local Turbo; test interrupted sync, rollback, duplicate events, revocation and deletion.

## Strategic direction

Prioritize shared recall over remote Mac execution. A private cloud index plus MCP could make Cartographer a shared memory layer for heterogeneous agents (ChatGPT, Claude Code, Codex and others), without making the service a general remote execution gateway. Verify each client's remote MCP support before claiming interoperability. Later investigate incremental sync, portable skills and delegated tasks as separate extensions.

No implementation or hosting-provider commitment yet.
