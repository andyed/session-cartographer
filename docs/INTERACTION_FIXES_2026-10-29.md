# Interaction fixes · 2026-10-29

Local implementation following the [interaction audit](INTERACTION_AUDIT_2026-10-29.md).
The original captures remain the before-state; this document records repairs and
verification. Work is uncommitted and has not been released.

## Changes

| Finding | Implementation | Proof / remaining limit |
| --- | --- | --- |
| IA-01 | The entire commit header is a native summary for multiple sources, or a direct anchor for one source. Expanded named sources remain separate links. | Title, whitespace, glyph, Enter and Space operate the same disclosure; the measured target grew from 3.7% to 98.4% of the closed row (the remainder is its border). Two expanded neighbors fit at 390px. |
| IA-02 | Artifacts lead the summary. Explicit Findings, Decisions, Validation and Next steps sections are indexed across main-agent responses with exact provenance. Exact repeated sections retain their latest source. | Fixtures recover earlier findings and plans beyond the final response; unit tests exclude sidechains, fenced example headings and unlabelled speculation. **Human acceptance remains open.** This is extraction of attributed statements, not generated synthesis or a determination of current resolution. |
| IA-03 | Local Retry file reuses the request owner and its abort behavior. File/contributor/mode stay in the route; completion restores focus to the file heading, repeated failure to Retry. | Fault-injected file failure → local Retry → rendered document with the same URL and heading focus. |
| IA-04 | Summary/Conversation is stored as `reader` in the existing URL. Exact UUID/highlight destinations select Conversation. Browser Back restores modes; the reader's Back control returns to its source page. | Mode selection, reload, browser Back and the existing source-return journey. |
| IA-05 | Shared directory, outcome baseline, offsets and exact-time detail use at least 16px / weight 500. | Computed styles for directory and offset; narrow rendering and existing text-contrast checks. |
| IA-06 | Exact-time detail uses an explicit focus/hover/tap control. First Escape hides the detail and keeps focus; next Escape reaches the inspector. | Keyboard dismissal with retained inspector and control focus, then parent dismissal. Physical-device testing remains separate. |
| IA-07 | File-result titles and row space are real canonical anchors; plain activation keeps the in-place review behavior. | Modified-click opens the file in a new tab without changing the source page; ordinary review and return remain covered. |
| IA-08 | The shared workspace loader subscribes to SSE. Bursts coalesce into a refresh after 2.5 seconds, allowing the backend's two-second snapshot cache to expire. New-record counts derive from scoped results, not raw incoming messages. | Relevant/irrelevant appended records produce exactly one scoped new record, with fixed URL and keyboard focus retained. Pointer range gestures still pass. Polling remains the fallback for records not streamed. |

## Ownership

No new state store or router. Commit actions remain in `SessionArtifacts`;
retry in `MemoryInspector`; timestamp detail in `MemorySession`; reader mode in
`TranscriptViewer`; canonical file hrefs in `WorkingMemory`; live requests in
`useFocusWorkspace`. `Timeline` counts the existing scope projection and retains
its established order until the user refreshes that order.

Unrelated recall/tooling edits already in the worktree were preserved. No commit,
push or deployment was performed.

## Verification

- Explorer production build passed. Vite still reports its advisory bundle-size
  warning (main JavaScript approximately 505 kB before gzip).
- BIGFU: 20 scope, route and summary checks passed; an earlier focused run passed
  10 path, bundle, transcript-navigation and summary checks.
- Isolated artifact browser journey: whole-row activation, source navigation,
  reader mode persistence, useful earlier sections, optional-category absence,
  file safety and 390/581px layouts passed.
- Isolated pointer proof: horizontal and vertical range gestures passed.
- Full workspace browser journey passed, including local file failure/retry with
  focus restoration, native modified-click file navigation, reader return,
  timestamp dismissal, scoped SSE updates and stream interruption/recovery.
- All 20 sampled page states stayed below the 5% repeated-copy gate (maximum
  4.22%; file review 0%). No browser page errors were reported.
- Final local build: `index-pH1avXK4.js` / `index-B80ymmI9.css`, based on dirty
  worktree `ee078ce`; this records a local build, not a release.

Post-fix evidence (synthetic fixtures; images inspected):

- [Whole commit header](assets/interaction-fixes-2026-10-29/whole-commit-row.png)
- [Two expanded rows at 390px](assets/interaction-fixes-2026-10-29/expanded-commits-390.png)
- [Local file retry](assets/interaction-fixes-2026-10-29/file-retry.png)
- [Artifact probes](assets/interaction-fixes-2026-10-29/artifact-probes.json)
- [Workspace probes](assets/interaction-fixes-2026-10-29/workspace-probes.json)

The summary's broader usefulness still needs human review. Section extraction
intentionally leaves unlabelled conclusions alone and preserves historical plans
without claiming they remain unresolved. Browser evidence establishes the exercised
paths, not universal comprehension, screen-reader or physical-touch acceptance.
