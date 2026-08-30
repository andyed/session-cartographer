---
name: turbo
description: Enable, disable, or inspect Session Cartographer Turbo Mode, the optional shared warm recall backend for Claude Code and Codex. Use when the user asks about Turbo Mode, faster recall, or the global recall backend.
allowed-tools:
  - Bash
  - Read
---

# Turbo

Manage Session Cartographer's provider-neutral Turbo preference and its single
managed warm-recall service. The setting applies to ordinary `/remember`
queries from both Claude Code and Codex; it is not a provider-specific toggle.

Resolve `ROOT` from `CARTOGRAPHER_ROOT`, `CLAUDE_PLUGIN_ROOT`, or
`PLUGIN_ROOT`. If none is set, derive the plugin root from this skill's reported
base directory (`../..` from `skills/turbo`); use the conventional checkout only
as a legacy fallback. Verify that `$ROOT/scripts/cartographer-turbo.js` exists.

## Choose the action from the request

- Explicit **enable**, **turn on**, or **opt in**: run `enable`.
- Explicit **disable**, **turn off**, or **opt out**: run `disable`.
- **Status**, **is it running**, questions about Turbo, or an invocation with no
  clear mutation request: run `status`. Do not change the preference merely
  because the user asked about performance.

```bash
ROOT="${CARTOGRAPHER_ROOT:-${CLAUDE_PLUGIN_ROOT:-${PLUGIN_ROOT:-$HOME/Documents/dev/session-cartographer}}}"
node "$ROOT/scripts/cartographer-turbo.js" status   # or enable / disable
```

Use the controller rather than editing the config, launching the server
directly, or killing a PID. It verifies ownership before stopping a process and
keeps the setting in `~/.config/session-cartographer/config.json` (or
`CARTOGRAPHER_CONFIG`).

Afterward, report whether the global preference is enabled, whether its managed
service is running and compatible, and which transport the receipt names. When
enabled, ordinary recall starts or reuses the warm service automatically and
falls back to the portable CLI if it is unavailable. `--no-turbo` bypasses it
for one search; exact fetch, touch, thread, intent-only, and raw-transcript
operations remain portable by design.
