# MCP server

`scripts/cartographer-mcp.js` exposes Cartographer's recall to agents as typed
MCP tools over stdio. The plugin registers it for Claude Code and Codex, so the
tools appear in the agent's tool list without a skill being loaded.

## Why

Measured 2026-10-15 over 30 days, 21% of Claude sessions recalled at all,
nearly all on their first turn. Of 59 Codex sessions that saw the startup
nudge, 1 ever recalled. Recall was already fast (Turbo p90 377 ms, 1.7%
fallback), so speed was not the problem. Reaching it was. Through a skill, an
agent had to decide to load the skill, resolve the plugin root, and assemble a
`cartographer-search.sh` command line, and agents got the argument order wrong
(`--project X query` searched for the literal `--project`). A typed tool sits in
every MCP client's tool list, with a description that says when to call it, and
its arguments cannot be put in the wrong order.

## Tools

| Tool | What it answers | Runs | Cost | Writes |
|---|---|---|---|---|
| `recall(query, project?, since?, before?, limit?, intent?, include_seen?)` | What earlier sessions did about this | `cartographer-search.sh --format jsonl` | 0.3–1 s on Turbo, 10–20 s portable | served + search-call rows |
| `get(event_ids, call_id?)` | The full records behind ids, with transcript paths | `cartographer-search.sh --get` | ~0.1 s | `result_fetched` access rows |
| `mark_used(event_ids, call_id)` | Records that a hit informed the answer | `cartographer-search.sh --touch` | ~0.1 s | `result_used` access rows |
| `thread(event_id)` | The work arc around one event | `cartographer-search.sh --thread` | 10–20 s on a 180k-event changelog | nothing |
| `orient(project)` | Recent state of one project | the `/remember --project` recipe | 1–3 s | served + search-call rows |
| `facts(verb, …)` | Counts: census, tempo, delta | `cartographer-facts.js --format json` | 0.1–0.5 s, needs Turbo | nothing |
| `standup(window?, project?, commit?)` | Who else is working, which files collide | `cartographer-standup.js` | ~0.2 s | nothing |

Every answer is compact text for the model, one line per hit
(`date · project · agent · event type · summary · event_id`), and always names
the `call_id`. From protocol 2025-06-18 on, the same answer also comes back as
`structuredContent`, with transcript paths, session ids and the
keyword/semantic source mix.

The workflow the descriptions teach is the `/remember` workflow: `recall`, then
`get` with the recall's `call_id`, then read the transcript if the record is not
enough, then `mark_used` for the hits that actually informed the answer.

Tool descriptions are the product. Claude Code's tool search loads only tool
names and the server's `instructions` at session start and fetches a schema on
demand, matching against the head of a description. So each description leads
with the words a model would search for, and the server `instructions` (under
Claude Code's 4,096-character cap) carry the recall cues: "did we…", "I thought
we fixed…", "last time", "which agent tried…". `recall` also sets
`_meta["anthropic/alwaysLoad"]`, so its schema loads up front: the problem being
fixed is that agents do not reach for recall at all. The other six load on
demand.

## Design rules

**`cartographer-search.sh` stays the single writer of retrieval telemetry.**
`recall`, `get`, `mark_used`, `thread` and `orient` shell out to it. The script
selects Turbo itself, so a warm recall is still warm. Calling Turbo's
`/api/recall` from the server would have been less code and would have bypassed
delta serving, the served log and the access ledger in one move. `facts` and
`standup` call their own CLIs, which write nothing.

**One purpose, `mcp`, for every serving tool.** `--touch` and `--get` join a
mark to its serve on `(session, purpose, call_id)`. If `orient` served under the
skill's `focus` purpose, a `mark_used` from this server could never join it. So
every call from the server runs as `mcp`, and adoption reads directly off the
logs:

```bash
node scripts/hit-rate-report.js --purpose mcp
jq -r 'select(.purpose=="mcp") | [.timestamp, .provider, .attribution_status, .query] | @tsv' \
  ~/Documents/dev/.carto/search-calls.jsonl | tail
```

`cartographer-search.sh` accepted only `remember|focus|feed|eval|audit|manual`.
This change adds `mcp` to that list.

**Identity comes from the client, never from the model.** Children inherit the
server's environment, so the script resolves the session chain
(`CARTOGRAPHER_SESSION_ID → CLAUDE_SESSION_ID → CLAUDE_CODE_SESSION_ID →
CODEX_SESSION_ID`, first value `sentinels.js` accepts) exactly as it does for a
Bash call. No tool takes a session, provider or purpose argument, and the server
refuses any argument its schema does not declare. A model that could name the
session could attribute marks to any session whose id it had seen.

The client's `initialize` names the client (`clientInfo.name`). That is a fact
about which agent is calling, not which session. So when nothing else names the
provider (no chain variable, or only `CARTOGRAPHER_SESSION_ID`), the server sets
`CARTOGRAPHER_PROVIDER` from it: `claude`, `codex` or `hermes` by substring.
Codex rows then read `provider: codex, attribution_status: no_session`, not
`unknown` twice.

**No dependency.** The protocol surface is initialize, ping, tools/list,
tools/call, cancellation and batches: newline-delimited JSON-RPC, a few hundred
lines, matching the zero-dependency runtime (`bm25-search.awk` is the
exemplar). `@modelcontextprotocol/sdk` would have added the plugin's first
`node_modules`, for nothing this surface uses.

**Input errors are tool errors.** A bad argument comes back as an `isError`
result naming the fix, so the model can retry. An unparseable `since` carries
the CLI's own message. `standup` refuses a window it cannot parse
(`1w`) because the CLI silently reads it as 6h. An unknown tool is a JSON-RPC
`-32602`.

**Standup never guesses "you" without a session.** The standup CLI falls back
to "whoever logged the freshest event". That is sound for a Bash call the tool
hook just logged, and wrong for an MCP call, which no hook logs: the guess
claims a peer as the caller and drops it from the roster. With no session the
server passes `--me unknown`, the pipeline's own spelling of absence.

## What each client gives an MCP server

Measured 2026-10-15 on macOS by reading the environment of live MCP server
processes (`ps eww`, variable names only), and in an isolated `CODEX_HOME` with
a probe server.

| Client | Version | Environment the server receives | Session | Rows say |
|---|---|---|---|---|
| Claude Code (desktop app) | 2.1.299 | the parent environment plus `CLAUDE_CODE_SESSION_ID`, `CLAUDE_PROJECT_DIR`, `CLAUDECODE` and other `CLAUDE_CODE_*` variables | yes: each session's MCP children carry that session's id, matching what its Bash calls see | `session`, provider `claude` |
| Claude Code (CLI) | 2.1.277 | same; plugin servers also get `CLAUDE_PLUGIN_ROOT` and `CLAUDE_PLUGIN_DATA` (documented) | yes | `session`, provider `claude` |
| Codex | 0.160.0 | an allowlist: `HOME LOGNAME PATH SHELL USER TMPDIR __CF_USER_TEXT_ENCODING`, plus `LANG` and `TERM` when set, plus any `env` the server entry configures. The app-server parent itself exports no Codex session or thread id, so forwarding cannot help either. | none | `no_session`, provider `codex` from `clientInfo` `codex-mcp-client` |
| Hermes | (live gateway) | an allowlist: `HOME LOGNAME PATH SHELL USER TMPDIR __CF_USER_TEXT_ENCODING LC_CTYPE`, plus `~/.hermes/.env` | none | `no_session`; provider `hermes` only if its `clientInfo.name` says so (not measured) |

Handshakes observed with `CARTOGRAPHER_MCP_TRACE`:

- Codex 0.160.0 sends `initialize` at protocol `2025-06-18` with
  `clientInfo {name: "codex-mcp-client", title: "Codex"}`, then
  `notifications/initialized`, then `tools/list`.
- Claude Code 2.1.277 first sends `server/discover` (protocol revision
  2026-07-28). On this server's `-32601` it falls back to `initialize` at
  `2025-11-25`, with `clientInfo {name: "claude-code"}`.

## Known limitations

- **No session under Codex or Hermes.** Their rows say
  `attribution_status: "no_session"`. A `mark_used` is still recorded, but
  without a `call_id`, because an empty session is never used to join a mark to
  a serve. Delta serving is off, since there is no session to hold the served
  list. Recall still works; what is lost is the measurement and the
  repeat-suppression. The fix belongs in the clients: an MCP client that put
  its session id in the server's environment, or in request `_meta`, would
  close it.
- **The Claude Code id is the spawn-time id.** Claude Code documents that an MCP
  server "retains the ID it was spawned with", and that on `--continue` or
  `--resume` it may get the initial startup id. After `/clear`, calls are
  attributed to the earlier id until the server restarts.
- **Codex strips `CARTOGRAPHER_*` settings.** A non-default corpus
  (`CARTOGRAPHER_DEV_DIR`), Turbo URL or log path set in your shell does not
  reach the server under Codex. Set them in the server entry's `env` (below).
- **`thread` is slow.** It is one awk pass over the whole changelog: 10.7 s on
  109 MB / 178k rows, measured. Turbo holds the same corpus resident and could
  answer it in milliseconds; that is a follow-up, not part of this server.
- **`facts` needs Turbo.** It has no portable fallback. When Turbo is enabled
  with auto-start, the server starts it the way a recall would. Otherwise the
  tool says how to enable it.
- **`readOnlyHint` on `recall`, `get` and `orient`.** These append retrieval
  telemetry the way a GET appends an access log, and change nothing the user or
  the repository can see. `mark_used` is the one tool marked as a write.

## Registration

### Claude Code

The plugin declares the server in `plugins/session-cartographer/.mcp.json`:

```json
{ "mcpServers": { "cartographer": { "command": "node",
  "args": ["${CLAUDE_PLUGIN_ROOT}/scripts/cartographer-mcp.js"] } } }
```

Claude Code starts plugin MCP servers when the plugin is enabled. The tools are
named `mcp__plugin_session-cartographer_cartographer__recall` and so on. Claude
Code runs the plugin from its cache, so the server appears after the plugin is
updated (`/plugin` → update, or reinstall from the marketplace). To check
without changing any settings:

```bash
claude --plugin-dir plugins/session-cartographer mcp list
```

Expect `plugin:session-cartographer:cartographer … ✔ Connected`.

Without the plugin, register the checkout directly at user scope:

```bash
claude mcp add --scope user cartographer -- node ~/Documents/dev/session-cartographer/scripts/cartographer-mcp.js
```

### Codex

Codex reads the plugin-root `.mcp.json` too, but it does not expand
`${CLAUDE_PLUGIN_ROOT}` or `${PLUGIN_ROOT}` in `args` (verified on 0.160.0: a
probe received both literally). It starts the server in the session's working
directory, and it refuses a `cwd` of `${PLUGIN_ROOT}`. So the Codex manifest
declares its own entry, which takes precedence over `.mcp.json` there:

```json
"mcpServers": {
  "cartographer": { "command": "node", "args": ["./scripts/cartographer-mcp.js"], "cwd": "./" }
}
```

`cwd: "./"` resolves to the installed plugin root. Verified in an isolated
`CODEX_HOME`: `codex plugin add` installs it, `codex mcp list` shows
`cartographer … enabled`, and a session completes the handshake. As with
Claude Code, the server appears after the plugin cache is updated.

Without the plugin, or to pass settings Codex would otherwise strip, add an
entry to `~/.codex/config.toml` yourself:

```toml
[mcp_servers.cartographer]
command = "node"
args = ["/Users/you/Documents/dev/session-cartographer/scripts/cartographer-mcp.js"]

[mcp_servers.cartographer.env]
# Only needed when these differ from the defaults; Codex passes the server no
# shell environment beyond a small allowlist.
CARTOGRAPHER_DEV_DIR = "/Users/you/Documents/dev"
```

The plugin installs nothing into `config.toml` and never edits it.

### Hermes

Not registered by this repository. A Hermes MCP entry for the same command
works, with the session limitation above. A wrapper cannot fix it, because
Hermes binds `HERMES_SESSION_ID` only into terminal-tool subprocesses
(docs/SETUP.md).

## Debugging

Drive the server by hand. Redirect telemetry so the probe does not land in the
live logs (docs/TESTING.md):

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"shell","version":"0"}}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"recall","arguments":{"query":"payload indexes","limit":3}}}' \
  | CARTOGRAPHER_SERVED_LOG=/dev/null CARTOGRAPHER_ACCESS_LEDGER=/dev/null CARTOGRAPHER_SEARCH_CALL_LOG=/dev/null \
    node scripts/cartographer-mcp.js
```

`CARTOGRAPHER_MCP_TRACE=<file>` appends one line per request: method, tool
name, and for `initialize` the requested protocol, `clientInfo` and session
attribution. It records no tool arguments. Under Codex, set it in the server
entry's `env`; Codex will not pass it through from your shell.

## Tests

`tests/unit/mcp-server.test.js` drives the server over stdio against a fixture
corpus with the semantic leg and Turbo pinned off. Its assertions are about
composition: recall hits fetch back through `get` untruncated; `mark_used`
writes an access row with the recall's `call_id` and purpose `mcp`; an `orient`
hit can be marked from the same server; the session the client gave the server
reaches the rows and delta serving, while a `session_id` argument is refused;
a client with no session gets `no_session` rows with its provider named from
`clientInfo`; standup does not claim a fresh peer as the caller; and a `facts`
census through a real fixture Turbo matches an independent count. Each of the
guards was checked by removing it and watching its test fail.
