# Migrating native Codex memory into Session Cartographer

Version 0.7.8 adds a read-only import of Codex's curated memory. It reads the
Codex memory registry, overview, and rollout summaries from
`~/.codex/memories/` and appends searchable events to Cartographer's existing
`changelog.jsonl`. Codex's source files remain authoritative. Existing Claude
memory events, session transcripts, hooks, and Qdrant points are not rewritten.

## Upgrade an existing installation

Install 0.7.8 or later from the unified marketplace archive using its README. An existing
local marketplace can use
`codex plugin add session-cartographer@session-cartographer` to refresh its
managed copy; Claude Code uses
`claude plugin update session-cartographer@session-cartographer --scope user`
for a user-scope installation. Start a fresh agent session after updating. If
the new release changes a Codex hook definition, review it in `/hooks`.

The upgrade does not import memory by itself. From the extracted release
archive, run:

```bash
node plugins/session-cartographer/scripts/backfill-codex-memories.js --dry-run
node plugins/session-cartographer/scripts/backfill-codex-memories.js
```

The importer reports current entries, appended changes, and stale versions.
Running it again with unchanged source files appends nothing. The existing
`bash plugins/session-cartographer/scripts/backfill-memories.sh` command also
runs this importer after its Claude Code memory pass, so one command can refresh
both sources. It skips the
Codex pass when the native directory is absent.

For optional semantic recall, start local Qdrant and the embedding server, then
run:

```bash
node plugins/session-cartographer/scripts/backfill-codex-memories.js --index
```

Keyword recall works without those services. `--index` retries every current
Codex memory entry; it reports failures and exits nonzero if any could not be
indexed. If you use Turbo, refresh its managed process with `/turbo` in Claude
Code or `$session-cartographer:turbo` in Codex after updating the plugin. A
client restart alone does not replace a detached Turbo server.

## Keeping recall current

Rerun the importer after Codex native memory changes. This release has no file
watcher or automatic Codex memory ingestion. New content becomes searchable
after import; the optional semantic leg needs another `--index` run. The
importer records changed entries as new events and writes a derived
`.carto/codex-memory-stale-ids.txt` beside the changelog. The 0.7.8 CLI and
Explorer/Turbo API read that list to suppress replaced or removed versions
before ranking. Older installed plugin copies do not understand the list, so
refresh every copy used for recall before relying on revision suppression.

For a project-specific refresh, pass `--project <name>` to the importer. The
stale-id list still covers the whole imported history. `--dry-run` previews
changes without touching the event log or sidecar. If a previously imported
source tree becomes unreadable or empty, the importer refuses to retire its
entries; `--allow-empty` is reserved for an intentional removal.

To check the result, search for a distinctive current claim with `/remember`
or `cartographer-search.sh`, then check that a replaced claim no longer appears.
Keep the old event log: its superseded rows are the audit trail. Restore a
working plugin copy and rerun the importer after correcting a failed upgrade;
do not edit the append-only log or native Codex memory as a migration step.

`/standup` needs no data migration. In 0.7.8 it scopes commit lookup to the
requested time window, retains workspace-root edits in project views, and maps
verified Codex worktrees through Git. It reports activity from logged events,
not process liveness or membership in a shared goal.
