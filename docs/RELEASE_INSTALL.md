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

Start a new Codex task after installation so its skill catalog and hooks load
from the new plugin snapshot.

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

## Verify the download

The GitHub release includes a matching `.sha256` file:

```bash
shasum -a 256 -c session-cartographer-*.tar.gz.sha256
```
