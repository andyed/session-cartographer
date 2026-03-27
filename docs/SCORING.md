# Scoring Guide

How to read the scores in `/remember` output.

## Keyword search (RRF)

Reciprocal Rank Fusion scores are computed as `1/(60 + rank)` per source, summed across sources where the same event appears.

| Score | Meaning | Example |
|-------|---------|---------|
| 0.033 | Top result in two sources | Event matched as #1 in both changelog and research log: `1/61 + 1/61 = 0.033` |
| 0.016 | Top result in one source | Event matched as #1 in one source only: `1/61 = 0.016` |
| 0.014 | Second result, one source | `1/62 = 0.014` |
| 0.008 | Result #60+ in one source | Tail of a long match list |

**Rules of thumb:**
- Scores above 0.020 appeared in multiple sources — high confidence, worth reading.
- Scores 0.014-0.020 are strong single-source hits (top 5 in that source).
- Scores below 0.010 are deep in one list — scan the summary, don't chase the transcript unless the excerpt looks relevant.
- RRF scores don't measure relevance to your query. They measure rank position. A score of 0.016 means "first match in one file" — the match quality depends on whether grep found it because of a core keyword or a tangential mention.

## Semantic search (Qdrant cosine similarity)

When Qdrant is running, scores are cosine similarity between query and event embeddings.

| Score | Meaning |
|-------|---------|
| 0.80+ | Strong match — the event is about the same topic as your query |
| 0.65-0.80 | Related — shares concepts or vocabulary |
| 0.50-0.65 | Tangential — some overlap, likely a different topic that mentions similar terms |
| < 0.50 | Noise — shouldn't appear with reasonable limits |

Semantic scores ARE relevance measures, unlike RRF. A 0.85 hit for "foveated rendering" genuinely discusses foveated rendering. A 0.60 hit might discuss rendering in a different context.

## Source labels

Results show which source(s) contributed:

| Label | Source |
|-------|--------|
| `[changelog]` | Unified event index |
| `[research]` | WebFetch/WebSearch log |
| `[milestones]` | Session lifecycle events |
| `[transcript:user]` | User message from a past session |
| `[transcript:assistant]` | Agent response from a past session |
| `[changelog+research]` | Appeared in both — boosted score |
