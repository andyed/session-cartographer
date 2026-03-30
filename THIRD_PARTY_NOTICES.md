# Third-Party Notices

This project incorporates portions of third-party software. Full license texts are
reproduced below.

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

**Source:** by Shreyas Patil
**License:** MIT
*(See LICENSE file for full text)*
