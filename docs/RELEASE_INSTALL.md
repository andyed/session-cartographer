# Session Cartographer unified release bundle

This archive is a self-contained local marketplace for Claude Code and Codex.
It is the same artifact for both agents; install only the section you use, or
install both to give them one shared history.
Keep the extracted directory in a stable location; the agents copy the plugin
into their own managed cache when it is installed.

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

## Claude Code

From the extracted directory:

```bash
claude plugin marketplace add "$PWD"
claude plugin install session-cartographer@session-cartographer
```

Start a new Claude Code session after installation.

## Explorer

The search and logging features require no service. The optional web Explorer
needs its JavaScript dependencies installed once:

```bash
cd plugins/session-cartographer/explorer
npm install
npm run dev
```

The Explorer binds to `127.0.0.1` on ports 2526 and 2527.

## Optional global Turbo Mode

Turbo Mode is off by default and does not require Explorer's npm dependencies.
After starting a fresh session, enable it through the installed skill:

- Claude Code: invoke `/turbo enable`.
- Codex: invoke `$session-cartographer:turbo` and ask it to enable Turbo.

The same skill accepts `status` and `disable`; users do not need to find the
agent's managed plugin cache or run a script from the extracted marketplace.

The provider-neutral preference in
`~/.config/session-cartographer/config.json` applies to ordinary `/remember`
queries in all future Claude Code and Codex sessions. A zero-dependency
headless process starts on demand; if a sandbox blocks loopback HTTP, the same
process serves a private file request channel. Queries fall back to the
portable CLI when the warm service is unavailable.

Before uninstalling, invoke the skill with `disable` to opt out and stop the
verified managed process.

## Verify the download

The GitHub release includes a matching `.sha256` file:

```bash
shasum -a 256 -c session-cartographer-*.tar.gz.sha256
```
