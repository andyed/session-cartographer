# Releasing Session Cartographer

Use the repository's unified marketplace archive and tag-triggered
`.github/workflows/release.yml`. Building a local archive does not publish or
install it. Publication requires an explicit release request.

## Prepare the candidate

1. Integrate the intended upstream changes and review the whole candidate diff.
   Keep the source checkout and `plugins/session-cartographer` mirror identical
   with `bash scripts/copy-plugin-runtime.sh plugins/session-cartographer`.
2. Update `package.json`, both root `package-lock.json` version fields, both
   plugin manifests, and `.claude-plugin/marketplace.json`; synchronize the plugin
   package copy. Run `node scripts/check-release-version.js`.
3. Keep the changelog entry marked Unreleased until publishing. Prepare
   `docs/releases/v<version>.md`; the release workflow uses that file as its notes.
   Keep `docs/RELEASE_INSTALL.md` current because it becomes the archive README.
4. Use Node 22 and run the unit, Explorer build/browser, and package checks in
   [TESTING.md](TESTING.md). Complete an authorized dependency advisory check
   separately. A skipped or blocked check is unresolved, not passing.
5. Review and commit the candidate. Record its full commit SHA and version.

Version 0.7.6 is the current candidate. The historical local `v0.7.5` tag points
to `7091b18` and is not this candidate; preserve it rather than retargeting it.
Confirm the intended new tag is unused locally and remotely before publishing.

## Verify an exact source snapshot

The builder packages its current files. To prove a particular commit without
including unrelated working-tree changes, export it and run the canonical smoke
from that isolated copy:

```bash
candidate=$(git rev-parse HEAD)
candidate_dir=$(mktemp -d "${TMPDIR:-/tmp}/carto-release.XXXXXX")
git archive "$candidate" | tar -x -C "$candidate_dir"
bash "$candidate_dir/tests/release-smoke.sh"
```

The smoke checks source/mirror parity, archive contents, hook resolution, and a
hermetic keyword query. Where installed, Codex and Claude CLI plugin installs use
temporary configuration roots. Those CLIs may contact their services; obtain any
required permission before that check. Hosted CI usually lacks the CLIs and
therefore does not prove managed installation.

Verify the generated checksum from the snapshot's `dist/release` directory and
record it with the source SHA. The Explorer is distributed as source with a
lockfile; its dependencies are installed by the user, as documented in the bundle.

## Publish only the verified candidate

Immediately before an authorized tag push, confirm the working tree is clean,
the candidate commit is the intended release source, all declared versions match,
and the release notes describe that source. If a tag already exists elsewhere,
stop and reconcile it; never silently move or overwrite it.

The release workflow checks versions, runs the Node 22 units and package smoke,
waits for the Explorer build/browser workflow, and publishes the archive plus its
checksum. A failed mandatory gate stops publication. Verify the completed run,
release tag commit, expected assets, and checksum of a fresh download before
calling the release shipped. Verify each requested agent installation and the
managed Turbo runtime separately from publication.
