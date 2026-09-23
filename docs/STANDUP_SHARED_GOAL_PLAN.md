# Shared-goal briefing for `/standup`

Planning baseline: September 23, 2026. This document specifies a future coordination layer. The current `/standup` is a read-only view of logged sessions, commits, and file overlap; it does not know which sessions share an objective or send messages between them.

## Job to be done

An agent starting or resuming work should be able to answer: **What are we trying to finish together, who is doing which part, what can I use or unblock, and what needs coordination before integration?** A project roster and a collision warning answer only the last question. The July [Claude–Codex assessment](assessment-2026-07.md) identified a recency handoff as the next cross-provider opportunity, and the [Memory work desk](WORK_DESK.md) already distinguishes observed activity from an explicit handoff.

The shared goal is an explicit grouping decision. Same repository, matching files, similar prompts, or simultaneous activity may suggest related work, but cannot create goal membership. A session can have no goal, and a user may link sessions in different repositories to one goal.

## Briefing contract

Given an optional `--goal <id>`, `/standup` should lead with:

1. **Goal:** its short objective, source, and last stated update. Show `unknown` when no explicit goal exists.
2. **Lanes:** each linked session's bounded deliverable, stated status, last observed activity, relevant artifact or commit, and branch/worktree when verified. Use distinct full identities behind display labels.
3. **Next coordination:** explicit handoffs awaiting pickup, stated blockers another lane can address, deliverables ready for integration, and unclaimed work from a recorded plan. Each recommendation names the source event and the agent that can act. Do not infer an unclaimed task from silence.
4. **Contention:** same-file overlap and project proximity, with the checkout distinction and latest touch per session. A peer on another worktree calls for inspecting that peer's changes; a peer on the same checkout calls for rereading the shared file.

Without a goal ID, keep the current peer view. It may offer **possible related sessions** based on project and time, clearly labeled as suggestions; it must not present them as teammates or claim an objective for them.

Example shape (illustrative, not generated today):

```text
GOAL g-42 · Ship the Android Now Playing adapter
  Claimed: native listener + permission flow — Codex task A · update 8m ago
  Claimed: renderer contract tests — Claude task B · commit abc123 · 15m ago
  Waiting: task B needs the native event shape from task A [handoff event]

NEXT
  Task A: post the event shape and test result for task B to consume.
  Integrator: review both branches after the contract test passes.

CONTENTION
  media-host-android.js — both lanes touched it; inspect their separate diffs.
```

## Capture and authority

Keep the event log append-only and provider-neutral. A separate, explicit write path records compact coordination events; `/standup` remains a reader. The initial event vocabulary can be:

| Event | Required meaning |
| --- | --- |
| `goal_join` | Session joins a user- or parent-supplied goal ID and records a short objective. |
| `task_claim` | Session states one bounded deliverable and any dependency. A claim is coordination context, not an exclusive file lock. |
| `task_progress` | Session states progress and cites a commit, test receipt, file, or decision when available. |
| `task_blocked` | Session states the blocker and the action or input needed. |
| `task_handoff` | Session offers a concrete artifact or decision to a named lane or to the goal's integrator. |
| `task_release` | Session marks a claim complete, withdrawn, or transferred. |

Each record needs `event_id`, timestamp, `goal_id`, full `session_id`, provider, project or repository identity, short text, and source identity. Handoffs also need a target or `unassigned` and an evidence link. Updates supersede earlier statements by event order; they do not rewrite history. A session can change deliverables during a long task. The latest human prompt and transcript title are useful context, but neither silently changes a claim: Explorer currently uses a custom title or the first meaningful prompt as a task title, which can become stale after steering.

The projection distinguishes **stated** status from **observed** evidence. A commit is recorded work, not a merge or release. Recent activity is not process liveness; quiet is not completion. Stale claims retain their timestamp and become `needs confirmation` after a configurable interval. An expired claim does not block another agent indefinitely.

Goal IDs should be passed explicitly in parent instructions, a user task brief, or a shared issue/PR reference. When none exists, an agent can propose a new goal link for the user's review; repository co-location alone never joins sessions. Sending a message to another task remains a separate authorized action. The briefing can point to a Memory Desk permalink or a native task link without requiring the Explorer server to be running.

## Delivery sequence

1. **Projection prototype:** build a pure fold over fixture coordination events plus the existing session/file evidence. Keep it read-only and measure its output against hand-labeled multi-session examples. Include same-project unrelated sessions and cross-project shared goals.
2. **Explicit capture:** add one portable writer with validation, stable IDs, atomic append, and a small CLI or skill workflow for join, claim, block, handoff, and release. Reuse the shared config and event envelope; avoid provider-specific competing stores. Keep private prompt text out of the default briefing.
3. **Standup output:** add `--goal`, source-linked lane summaries, pending handoffs, and action-oriented ordering. Preserve the current global/project roster and `--json` contract. Use the same projection for the Explorer if a visual view is later needed.
4. **Agent guidance:** run at goal join or resume, before taking a claimed deliverable, when a dependency lands or a blocker is reported, and before integration. Do not run on every tool call. A claim or handoff should be written only when the underlying task actually changes.

## Acceptance evidence

- Two independent Codex/Claude sessions given the same goal ID see each other's distinct deliverables and a handoff within one command run; a third session in the same repository with a different goal remains outside the briefing.
- A delivered artifact points to the recorded commit, test, or file; a stated completion without such evidence is labeled as stated only.
- A stale or stopped session does not appear as currently running or hold an exclusive claim. A superseded claim and its previous handoff remain auditable.
- Main-checkout, Claude worktree, and Codex worktree edits to one repo file group together when repository identity is verified; project scoping retains edits made from a workspace-root session.
- In a small observed trial, an agent can identify a useful peer handoff or a duplicate-work risk and take the correct next action. Count those successful actions and wrong turns, not just briefings printed.

The current command's reliability fixes are the prerequisite. Shared-goal capture and briefing remain unimplemented until the projection and acceptance examples are reviewed against real coordination work.
