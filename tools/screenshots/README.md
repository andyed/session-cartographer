# Explorer screenshots

Capture the real Explorer with a frozen copy of real activity and seeded name
replacements. This is a JavaScript development tool; it does not change the
Explorer, source logs, native transcripts, or files.

From the repository root, install the locked dependencies and Chromium once:

```bash
npm ci --no-audit --no-fund
npm ci --prefix explorer --no-audit --no-fund
npx --no-install playwright install chromium
```

With a compatible Turbo service already running:

```bash
node tools/screenshots/capture.js --seed autumn --hours 24
```

The tool reads `GET /api/memory/state` once from `http://127.0.0.1:2526`, then
starts an isolated Explorer on a free loopback port. The temporary UI uses an
empty corpus and renders the obfuscated snapshot through its existing components.
Browser API writes and unexpected endpoints are blocked. The temporary UI and
browser stop when capture finishes.

Five PNGs, a local HTML gallery, and a manifest go to `.carto/screenshots/` (gitignored): tasks, files
(when present), activity, concurrent timeline, and mobile tasks. The manifest
records the seed, window, replacement counts, and image dimensions. Raw data
and the replacement dictionary are not exported.

Options:

| Option | Purpose |
| --- | --- |
| `--seed autumn` | Repeat the same names for the same snapshot; omit for a fresh random seed |
| `--hours 72` | Read a larger window, from 1 to 2160 hours |
| `--api http://127.0.0.1:2526` | Use another existing loopback API |
| `--input /private/path/state.json` | Use a previously saved Memory state response without contacting an API |
| `--out .carto/screenshots/launch` | Choose the output directory |
| `--replacements /private/path/names.json` | Add or override literal replacements |

A replacement file can be a plain object or the same wrapper as the existing
demo sanitizer:

```json
{"replacements": {"Internal nickname": "Example project", "Person Name": "Demo author"}}
```

Keep that file private. Matching is case-insensitive, longest first, with token
boundaries; replacements are applied in one pass so aliases do not cascade.
Automatic replacements cover recorded project names, file basenames (preserving
extensions), distinctive file stems, session IDs, and home-directory owners.
They apply to identity-map keys and display values together so file/session joins
and canvas labels remain consistent. Schema keys and provider/type labels stay
intact. Dates, event IDs, counts, and token samples are retained; captures display
dates in UTC.

This is **name obfuscation, not full anonymization**. Free-form prose, URLs,
commit hashes, unrecognized nicknames, and other directory names can retain
identifying information. Inspect the PNGs before sharing and use the replacement
file for additional terms. The tool does not publish or copy images into the
README automatically.

Verification:

```bash
node --test tests/unit/screenshot-obfuscation.test.js
```

The capture itself checks for populated results, runtime errors, unexpected
network calls, horizontal overflow, and painted activity canvases. This covers
the screenshot journey, not the complete Explorer regression suite.
