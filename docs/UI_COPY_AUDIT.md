# Rendered repeated-copy audit

2026-10-29 · isolated browser fixture · local, uncommitted source.

Metric: excess repeated interface words / rendered interface words, using exact phrases of two or more words. Source content and values are separate. The page-state gate is ≤5%. See [definition and limits](UI_REVIEW_GUARDS.md).

| Page type | Excess / interface words | Repeated-copy rate |
|---|---:|---:|
| Event Feed | 8 / 257 | 3.11% |
| Sessions | 0 / 68 | 0.00% |
| Conversation | 0 / 135 | 0.00% |
| Session summary | 0 / 28 | 0.00% |
| Concurrent | 0 / 53 | 0.00% |
| Search results | 0 / 35 | 0.00% |
| Empty search | 0 / 12 | 0.00% |
| Memory entry | 0 / 21 | 0.00% |
| Memory tasks | 0 / 119 | 0.00% |
| Memory field | 0 / 51 | 0.00% |
| File review | 2 / 86 | 2.33% |
| Recall | 6 / 191 | 3.14% |
| Day | 0 / 190 | 0.00% |
| Internals | 14 / 332 | 4.22% |

All 20 cold/warm and page-state checks passed the copy gate. Each row above uses the higher rate when cold and warm states differ.

Icon-only controls: 79 observations across those states; no missing accessible names or targets below 44×44px. Repeated observations are not unique controls.

These checks detect mechanical defects, not comprehension or task success. The report retains repeated source content for review rather than charging it as UI boilerplate. Single-word labels and paraphrased repetition remain outside the v1 penalty.

Reproduce with `npm run build --prefix explorer` and `node tests/browser/memory-entry.cjs --preview`. Detailed phrases, DOM locations, data classification and icon dimensions are written to `carto-memory-browser-artifacts/repeated-copy.json` under the OS temporary directory.

Real-session check: the reported Obama Ohio transcript scored **0.00%** (0 / 74 interface words) in Summary and **2.51%** (10 / 399) in the secondary Conversation state. Its two recorded WebFetch attempts are bundled under their matching search links; one contains retrieved text and one explicitly reports HTTP 403. Original records remain reachable. The 390px/581px layout, source jumps and artifact checks passed. This is a separate real-session observation, not a claim that every historical transcript has been audited.
