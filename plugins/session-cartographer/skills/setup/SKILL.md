---
name: setup
description: Diagnose or enable Session Cartographer semantic search in Codex, including least-privilege localhost access to local Qdrant and the embedding server. Use when setup, Qdrant health, localhost reachability, sandbox network denial, or semantic indexing is in question.
allowed-tools:
  - Bash
  - Read
---

# Setup

Diagnose Session Cartographer semantic-search prerequisites and, only with an
explicit request to enable or fix them, configure Codex command-network access
for the local Qdrant and embedding services.

Resolve `ROOT` from `CARTOGRAPHER_ROOT`, `CLAUDE_PLUGIN_ROOT`, or
`PLUGIN_ROOT`. If none is set, derive the plugin root from this skill's reported
base directory (`../..` from `skills/setup`); use the conventional checkout only
as a legacy fallback. Verify that
`$ROOT/scripts/codex-loopback-setup.js` exists.

## Diagnose first

Run the doctor without modifying user configuration:

```bash
node "$ROOT/scripts/codex-loopback-setup.js" doctor --json
```

Treat `sandbox_network_denied` as a Codex permission/configuration state, not as
evidence that Qdrant or the embedder stopped. If the current task reports
network disabled, a host-side HTTP 200 and an in-task connection failure are
consistent: the service is healthy but unreachable from this task.

## Apply only with consent

Run `apply` only when the user explicitly asks to enable, configure, or fix
access. It updates the user's Codex config, so use the normal approval path when
the file is outside the writable workspace:

```bash
node "$ROOT/scripts/codex-loopback-setup.js" apply --json
```

The updater:

- preserves the active Codex permission model instead of mixing legacy sandbox
  settings with permission profiles;
- enables command networking behind Codex's network proxy;
- adds only exact `localhost` and `127.0.0.1` allow rules while preserving
  existing domain policy;
- creates a timestamped backup before changing an existing config; and
- refuses ambiguous or mixed configuration instead of rewriting it.

Never edit `config.toml` directly or silently broaden the allowlist. After a
successful update, tell the user to restart Codex and start a fresh task;
permissions are fixed when the task starts. In that fresh task, rerun `doctor`
and require HTTP success for both Qdrant `/healthz` and the embedder `/health`
before reporting semantic search ready. Keyword-only recall does not require
this setup.
