# Session Cartographer unified release bundle

Plugin hooks require Node.js 22 or newer on PATH, Bash (Git for Windows on
Windows), and jq. After updating, restart the agent and review the changed
hook commands; every registration invokes `node` and `run-hook.cjs`.

This archive is a self-contained local marketplace and plugin bundle for Claude
Code, Codex, and Antigravity. It is the same artifact for all three agents;
install only the sections you use, or install multiple to give them one shared
history.
Keep the extracted directory in a stable location; Claude Code and Codex copy
the plugin into their own managed cache when it is installed.

## Codex

From the extracted directory:

```bash
codex plugin marketplace add "$PWD"
codex plugin add session-cartographer@session-cartographer
```

Codex skips new or changed command hooks until you approve their exact
definitions. Review is currently CLI-only: launch `codex`, type `/hooks`, select
**Session Cartographer**, and approve its hooks. If you use only the macOS
desktop app, launch its bundled CLI with
`/Applications/ChatGPT.app/Contents/Resources/codex`. Then start a fresh Codex
task so the approved hooks and updated skill catalog load. Repeat the review
after any release that changes hook definitions.

Keyword recall works without command-network access. To enable the optional
local Qdrant + embedding path, invoke `$session-cartographer:setup` and ask it
to enable semantic search. The skill first diagnoses the current task, then—on
that explicit request—backs up and updates the user's Codex config with exact
`localhost` and `127.0.0.1` allow rules. Restart Codex and start another fresh
task afterward, then invoke the skill again to verify both local health
endpoints. A sandbox-denied probe is a configuration result, not proof that a
service is down.

## Claude Code

From the extracted directory:

```bash
claude plugin marketplace add "$PWD"
claude plugin install session-cartographer@session-cartographer
```

Start a new Claude Code session after installation.

## Antigravity

On macOS or Linux, run these commands from the extracted release directory for
a first install. The copy places the plugin manifest, hooks, MCP server, and
skills together where Antigravity discovers them.

```bash
mkdir -p ~/.gemini/config/plugins
cp -R "$PWD/plugins/session-cartographer" ~/.gemini/config/plugins/
```

Or register the extracted `plugins/` directory through
`~/.gemini/config/plugins.json`, or run `agy plugin install ./plugins/session-cartographer`
where the `agy` CLI is installed.

Start a new Antigravity chat. If you already use Cartographer in Claude Code or
Codex, point Antigravity at the same history directory (`CARTOGRAPHER_DEV_DIR`,
default `~/Documents/dev`). Ask “Use Cartographer to remember why we chose
<distinctive project term>, and show me the original record.” Use a term from
work you have already captured. On a fresh history, ask for a standup after a
few turns to check that Antigravity activity is appearing.

Antigravity discovers these components:

- **MCP tools (`cartographer`):** `recall`, `get`, `mark_used`, `thread`,
  `orient`, `facts`, and `standup`, plus the bundled skills (`/remember`,
  `/standup`, `/carto`, `/turbo`, `/setup`, `/wrapup`, `/investigate`, `/trustmap`).
- **Live capture hooks (`hooks.json`):** `SessionStart`, `PreInvocation`
  (deduplicated per user turn), `PreToolUse` collision checks, `PostToolUse`
  tool/research capture (`run_command`, `edit_file`, `write_file`, `search_web`),
  and `Stop` turn milestones, all tagged `provider: "antigravity"`.
- **Older conversations.** With local semantic search configured, run
  `bash plugins/session-cartographer/scripts/retro-index.sh --provider antigravity`
  from the extracted directory to index retained transcript turns. For older
  conversations held only in Antigravity’s SQLite store, preview available history
  with `node plugins/session-cartographer/scripts/antigravity-source.js --backfill`.
  Add `--write` to index those records. Coverage depends on what Antigravity retained.

## Explorer

The search and logging features require no service. The optional web Explorer
needs its JavaScript dependencies installed once:

```bash
cd plugins/session-cartographer/explorer
npm install
npm run dev
```

The full web app binds to `127.0.0.1:2527`. Timeline, search, sessions, and
transcripts work without Turbo and coexist with it when it is running.

For the Flow map, open `http://127.0.0.1:2527/flow` and select a recorded
Antigravity, Claude Code, or Codex session to replay its recorded activity. In the Claude Code desktop app, use `/carto-flow` for the live pane.

For the live working-memory view, use `npm run memory` from the same Explorer
directory and open `http://127.0.0.1:2527/memory`. Both launch commands serve the
whole web app; they do not occupy Turbo's API port. **Enable Turbo**, **Start Turbo**,
or **Refresh Turbo** uses the shared managed controller when needed; opening the
page alone does not start a service or change the preference.

Select a session for activity and token traces, then an edited file for review.
**Copy link** preserves the selected session, file, view, axes, and replay time.
Older session links reopen their last recorded window. File review always shows
the current local file and working-tree changes, not a historical file snapshot.

## Optional global Turbo Mode

Turbo Mode is off by default and does not require Explorer's npm dependencies.
After starting a fresh session, enable it through the installed skill:

- Claude Code or Antigravity: ask the Turbo skill to enable Turbo.
- Codex: invoke `$session-cartographer:turbo` and ask it to enable Turbo.

The same skill accepts `status` and `disable`; users do not need to find the
agent's managed plugin cache or run a script from the extracted marketplace.

The provider-neutral preference in
`~/.config/session-cartographer/config.json` applies to ordinary `/remember`
queries in future Antigravity, Claude Code, and Codex sessions. A zero-dependency
headless process starts on demand; if a sandbox blocks loopback HTTP, the same
process serves a private file request channel. Queries fall back to the
portable CLI when the warm service is unavailable.

Before uninstalling, invoke the skill with `disable` to opt out and stop the
verified managed process.

## Upgrading from an earlier release

After updating the installed plugin, follow the
[Codex memory migration guide](MIGRATION_CODEX_MEMORY.md)
to import native Codex memory, optionally index it for semantic recall, and
refresh a running Turbo process. Import is on demand; installing the plugin
does not modify native memory files. The 0.7.8 standup improvements require no
data migration.

## Verify the download

The GitHub release includes a matching `.sha256` file:

```bash
shasum -a 256 -c session-cartographer-*.tar.gz.sha256
```
