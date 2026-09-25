---
name: focus
description: Retired. Project orientation moved to the remember skill (`/remember --project <name>` with no query). Use remember instead.
allowed-tools:
  - Bash
  - Read
---

# Focus (retired)

This skill was retired after 0.7.9 and will be removed in a later release.
Claude Code now ships a built-in `/focus` view, which shadows a skill of the
same name, and orientation already shares everything with recall.

Do what the user asked through the `remember` skill's **Orientation** section:
recent activity for the project, plus the `--related` and `--maneuvers` lenses.

```
/focus widget   →   /remember --project widget
```
