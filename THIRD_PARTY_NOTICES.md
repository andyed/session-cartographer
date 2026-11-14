# Third-Party Notices

This project incorporates portions of third-party software, all under the MIT
License. Portions are derived from claude-code-session-bridge by Shreyas Patil,
portions are adapted from claude-devtools by matt1398, and the session map's
drawing is forked from lot-map by Aleksei Volodin. Full license texts are
reproduced below. The project's own license is in [LICENSE](LICENSE).

---

## claude-devtools

**Source:** https://github.com/matt1398/claude-devtools
**License:** MIT
**Files adapted:**

| Source file (claude-devtools) | Adapted into |
|---|---|
| `src/main/utils/jsonl.ts` | `src/lib/devtools-adapted/session-parser.js` |
| `src/main/utils/toolExtraction.ts` | `src/lib/devtools-adapted/session-parser.js` |
| `src/main/types/messages.ts` | `src/lib/devtools-adapted/session-parser.js` |
| `src/main/types/jsonl.ts` | `src/lib/devtools-adapted/session-parser.js` |
| `src/main/constants/messageTags.ts` | `src/lib/devtools-adapted/session-parser.js` |
| `src/main/services/parsing/SessionParser.ts` | `src/lib/devtools-adapted/session-parser.js` |
| `src/renderer/utils/contextTracker.ts` | `src/lib/devtools-adapted/token-attribution.js` |
| `src/renderer/types/contextInjection.ts` | `src/lib/devtools-adapted/token-attribution.js` |
| `src/main/utils/tokenizer.ts` | `src/lib/devtools-adapted/token-attribution.js` |
| `src/main/utils/sessionStateDetection.ts` | `src/lib/devtools-adapted/compaction-detector.js` |
| `src/main/utils/jsonl.ts` (compaction section) | `src/lib/devtools-adapted/compaction-detector.js` |

**What was changed:**

- Translated TypeScript to plain ESM JavaScript (no build step required)
- Removed Electron IPC, FileSystemProvider abstraction, and SSH support
- Removed React/Redux coupling from token attribution (renderer-only concern)
- Removed UI navigation IDs and per-turn display logic from context tracker
- Added `enumerateSessions()` for scanning `~/.claude/projects/` (cartographer-specific)
- Added `analyzeSession()` convenience wrapper combining all three modules
- Added `DEVTOOLS_PARSER_ENABLED` feature flag

**MIT License (claude-devtools):**

```
MIT License

Copyright (c) matt1398

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## claude-code-session-bridge

**Source:** https://github.com/PatilShreyas/claude-code-session-bridge, by Shreyas Patil
**License:** MIT
**What was derived:** the original search, which began as a fork of this project
(see Credits in the README).

**MIT License (claude-code-session-bridge):**

```
MIT License

Copyright (c) 2026 Shreyas Patil

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## lot-map

**Source:** https://github.com/alexeyw/lot-map, by Aleksei Volodin
**License:** MIT
**What was derived:** the session map in the Explorer. `explorer/shared/workmap/`
(`classify.js`, `draw.js`, `feed.js`, `palette.js`, `setup.js`, `text.js`) is a
fork of lot-map 0.6.0 at commit d3102bf, converted from TypeScript. Changed here:
the palette, the option that leaves unused stations undrawn, and the exported
station geometry. The Explorer's map is drawn from recorded transcripts, not
from lot-map's live events.

The sidebar pane, `plugins/session-cartographer/hooks/carto-map/`, is also a fork of
lot-map 0.6.0: its hooks module, classifier, feed, terminal picture and tests,
kept in TypeScript. `NOTICE.md` in that folder says what was changed, and
`LICENSE-lot-map` beside it is lot-map's licence text.

**MIT License (lot-map):**

```
MIT License

Copyright (c) 2026 Aleksei Volodin

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
