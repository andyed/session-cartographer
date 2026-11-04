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

## README gallery

`gallery.js` captures the screenshots in the main README from the running
Explorer over your real corpus: eleven views of one day, at 2×, with names
rewritten where they render. It drives the Explorer already serving
`http://127.0.0.1:2527` and changes nothing in it.

Names are rewritten in the page itself, by an init script that runs in every
frame before the app does. Text nodes, visible attributes, form values, and
canvas text all pass through one dictionary: seeded aliases for project and
file names, any replacements from `demo-sanitize.json`, and real names only for
the repositories you list as public. Image lists are cut to the projects you
allow, and any other image request receives a placeholder. Before each capture
the page audits what it paints, and a shot that would show an original name, a
denied term, or a real home directory is not written.

The private config lives at `~/.config/session-cartographer/screenshots.json`:

```json
{
  "keep": ["my-public-repo"],
  "imageProjects": ["^my-art-project"],
  "deny": ["Client name"],
  "replacements": {"Internal tool": "Analytics"},
  "shots": {
    "day": "2026-11-03",
    "review": {"session": "<session id>", "file": "/abs/path/to/a/file.js"},
    "transcript": {"path": "/abs/path/to/session.jsonl", "uuid": "<message uuid>"},
    "query": "a search that shows real results"
  }
}
```

`deny` terms of five or more characters match anywhere, including inside
longer words. Choose the review, transcript, and search targets deliberately:
remapping replaces names, not subject matter.

On macOS, an optional OCR pass reads every PNG back and deletes any that still
shows a protected term:

```bash
swiftc -O tools/screenshots/ocr.swift -o .carto/ocr
node tools/screenshots/gallery.js --ocr .carto/ocr
node tools/screenshots/gallery.js --only timeline-feed,search --ocr .carto/ocr
```

PNGs, `manifest.json`, and a review page (`index.html`) go to
`.carto/screenshots/gallery/`. The README uses 1440-pixel WebP copies: lossless
for interface-only views, lossy for views carrying artwork.

```bash
G=.carto/screenshots/gallery
cwebp -lossless -z 9 -resize 1440 0 $G/search.png -o docs/screenshots/search.webp
cwebp -q 90 -m 6 -sharp_yuv -resize 1440 0 $G/timeline-feed.png -o docs/screenshots/timeline-feed.webp
```

Read every image before it ships.
